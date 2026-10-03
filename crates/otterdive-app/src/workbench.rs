//! Persistent recovery/history and bounded I/O for the document workbench.
//! These operations do not change the editor's session or overwrite source files.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use encoding_rs::{BIG5, GBK, SHIFT_JIS, WINDOWS_1252};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MAX_SNAPSHOT_BYTES: usize = 40 * 1024 * 1024;
const SNAPSHOT_BUDGET: usize = 128 * 1024 * 1024;
const MAX_ASSET_BYTES: usize = 25 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 1024 * 1024;
static NONCE: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn unique_name(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}-{}",
        std::process::id(),
        now_ms(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("workbench.db"))
        .map_err(|error| error.to_string())
}

fn db_error(error: rusqlite::Error) -> String {
    format!("恢复与历史数据库操作失败：{error}")
}

fn snapshot_connection(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         CREATE TABLE IF NOT EXISTS snapshots (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             kind TEXT NOT NULL CHECK(kind IN ('recovery', 'history')),
             document_key TEXT NOT NULL,
             title TEXT NOT NULL,
             path TEXT,
             encoding TEXT NOT NULL,
             text TEXT NOT NULL,
             metadata TEXT,
             created_at INTEGER NOT NULL,
             byte_length INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS snapshot_document ON snapshots(kind, document_key, id DESC);",
        )
        .map_err(db_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(connection)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotKind {
    Recovery,
    History,
}

impl SnapshotKind {
    fn label(self) -> &'static str {
        match self {
            Self::Recovery => "recovery",
            Self::History => "history",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnapshotRequest {
    pub kind: SnapshotKind,
    pub key: String,
    pub title: String,
    pub path: Option<String>,
    pub text: String,
    pub encoding: String,
    /// Editor-owned JSON: savedText, diskRevision, lineEnding, language, etc.
    pub metadata: Option<String>,
    pub retention_days: Option<u32>,
    pub max_entries: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSnapshotsRequest {
    pub kind: SnapshotKind,
    pub key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SnapshotIdRequest {
    pub id: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: i64,
    pub kind: String,
    pub key: String,
    pub title: String,
    pub path: Option<String>,
    pub encoding: String,
    pub metadata: Option<String>,
    pub created_at: i64,
    pub byte_length: usize,
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    #[serde(flatten)]
    pub info: SnapshotInfo,
    pub text: String,
}

fn info_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SnapshotInfo> {
    Ok(SnapshotInfo {
        id: row.get(0)?,
        kind: row.get(1)?,
        key: row.get(2)?,
        title: row.get(3)?,
        path: row.get(4)?,
        encoding: row.get(5)?,
        metadata: row.get(6)?,
        created_at: row.get(7)?,
        byte_length: row.get::<_, i64>(8)? as usize,
    })
}

fn read_snapshot_from(connection: &Connection, id: i64) -> Result<Option<Snapshot>, String> {
    connection.query_row(
        "SELECT id, kind, document_key, title, path, encoding, metadata, created_at, byte_length, text
         FROM snapshots WHERE id = ?1", [id],
        |row| Ok(Snapshot { info: info_from_row(row)?, text: row.get(9)? }),
    ).optional().map_err(db_error)
}

pub(crate) fn save_snapshot_at(
    path: &Path,
    request: SaveSnapshotRequest,
) -> Result<Snapshot, String> {
    let byte_length = request.text.len() + request.metadata.as_ref().map_or(0, String::len);
    if request.key.is_empty() || request.key.len() > 8192 || request.title.len() > 8192 {
        return Err("快照文档标识或标题无效".into());
    }
    if byte_length > MAX_SNAPSHOT_BYTES {
        return Err("恢复快照超过 40 MiB 限制".into());
    }
    if let Some(metadata) = &request.metadata {
        serde_json::from_str::<serde_json::Value>(metadata)
            .map_err(|error| format!("快照元数据无效：{error}"))?;
    }
    let mut connection = snapshot_connection(path)?;
    let transaction = connection.transaction().map_err(db_error)?;
    // Repeated autosave ticks must not exhaust the user's history quota.
    let previous_id: Option<i64> = transaction
        .query_row(
            "SELECT id FROM snapshots WHERE kind = ?1 AND document_key = ?2
         AND text = ?3 AND encoding = ?4 AND metadata IS ?5 AND path IS ?6 AND title = ?7
         ORDER BY id DESC LIMIT 1",
            params![
                request.kind.label(),
                request.key,
                request.text,
                request.encoding,
                request.metadata,
                request.path,
                request.title
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let newest_id: Option<i64> = transaction.query_row(
        "SELECT id FROM snapshots WHERE kind = ?1 AND document_key = ?2 ORDER BY id DESC LIMIT 1",
        params![request.kind.label(), request.key], |row| row.get(0),
    ).optional().map_err(db_error)?;
    if previous_id.is_some() && previous_id == newest_id {
        return read_snapshot_from(&transaction, previous_id.unwrap())?
            .ok_or_else(|| "快照已不存在".into());
    }
    transaction.execute(
        "INSERT INTO snapshots(kind, document_key, title, path, encoding, text, metadata, created_at, byte_length)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![request.kind.label(), request.key, request.title, request.path, request.encoding,
            request.text, request.metadata, now_ms(), byte_length as i64],
    ).map_err(db_error)?;
    let id = transaction.last_insert_rowid();
    let keep = if request.kind == SnapshotKind::Recovery {
        1
    } else {
        request.max_entries.unwrap_or(50).clamp(1, 200)
    };
    transaction.execute(
        "DELETE FROM snapshots WHERE kind = ?1 AND document_key = ?2 AND id NOT IN
         (SELECT id FROM snapshots WHERE kind = ?1 AND document_key = ?2 ORDER BY id DESC LIMIT ?3)",
        params![request.kind.label(), request.key, keep as i64],
    ).map_err(db_error)?;
    let cutoff =
        now_ms() - i64::from(request.retention_days.unwrap_or(30).clamp(1, 365)) * 86_400_000;
    transaction
        .execute(
            "DELETE FROM snapshots WHERE kind = ?1 AND created_at < ?2",
            params![request.kind.label(), cutoff],
        )
        .map_err(db_error)?;
    let max_total = if request.kind == SnapshotKind::Recovery {
        100
    } else {
        500
    };
    let records: Vec<(i64, usize)> = {
        let mut statement = transaction
            .prepare("SELECT id, byte_length FROM snapshots WHERE kind = ?1 ORDER BY id DESC")
            .map_err(db_error)?;
        statement
            .query_map([request.kind.label()], |row| {
                Ok((row.get(0)?, row.get::<_, i64>(1)? as usize))
            })
            .map_err(db_error)?
            .collect::<Result<_, _>>()
            .map_err(db_error)?
    };
    let mut used = 0;
    for (index, (record_id, bytes)) in records.into_iter().enumerate() {
        used += bytes;
        if index >= max_total || used > SNAPSHOT_BUDGET {
            transaction
                .execute("DELETE FROM snapshots WHERE id = ?1", [record_id])
                .map_err(db_error)?;
        }
    }
    let snapshot = read_snapshot_from(&transaction, id)?.ok_or("快照保存失败")?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn save_snapshot(
    app: tauri::AppHandle,
    request: SaveSnapshotRequest,
) -> Result<SnapshotInfo, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut info = save_snapshot_at(&path, request)?.info;
        // Autosave only needs the key and id; don't echo megabytes over IPC.
        info.metadata = None;
        Ok(info)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_snapshots(
    app: tauri::AppHandle,
    request: ListSnapshotsRequest,
) -> Result<Vec<SnapshotInfo>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = snapshot_connection(&path)?;
        let mut statement = connection.prepare(
            "SELECT id, kind, document_key, title, path, encoding, NULL, created_at, byte_length
             FROM snapshots WHERE kind = ?1 AND (?2 IS NULL OR document_key = ?2) ORDER BY id DESC"
        ).map_err(db_error)?;
        statement
            .query_map(params![request.kind.label(), request.key], info_from_row)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_snapshot(
    app: tauri::AppHandle,
    request: SnapshotIdRequest,
) -> Result<Option<Snapshot>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        read_snapshot_from(&snapshot_connection(&path)?, request.id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_snapshot(
    app: tauri::AppHandle,
    request: SnapshotIdRequest,
) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        snapshot_connection(&path)?
            .execute("DELETE FROM snapshots WHERE id = ?1", [request.id])
            .map_err(db_error)?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreAssetRequest {
    pub document_path: Option<String>,
    pub draft_key: Option<String>,
    pub source: String,
    pub file_name: Option<String>,
    pub directory: Option<String>,
    #[serde(default)]
    pub allow_remote: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAsset {
    pub path: String,
    pub relative_path: String,
}

fn image_extension(mime: &str) -> Option<&'static str> {
    match mime.split(';').next().unwrap_or("").trim() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        "image/avif" => Some("avif"),
        "image/heic" | "image/heif" => Some("heic"),
        "image/tiff" => Some("tiff"),
        _ => None,
    }
}

fn permitted_image_name(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "svg"
                    | "bmp"
                    | "ico"
                    | "avif"
                    | "heic"
                    | "heif"
                    | "tif"
                    | "tiff"
            )
        })
}

fn clean_file_name(value: &str, fallback_extension: &str) -> String {
    let name = value.rsplit(['/', '\\']).next().unwrap_or("");
    let name: String = name
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() || !permitted_image_name(name) {
        format!("image.{fallback_extension}")
    } else {
        name.chars().take(180).collect()
    }
}

fn asset_directory(document: &Path, custom: Option<&str>) -> Result<PathBuf, String> {
    if !document.is_absolute() {
        return Err("请先保存文档，再存储图片附件".into());
    }
    let parent = document.parent().ok_or("文档路径无效")?;
    let path = match custom.filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            let value = Path::new(value);
            if value.is_absolute() {
                value.to_owned()
            } else {
                parent.join(value)
            }
        }
        None => parent.join(format!(
            "{}.assets",
            document
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("document")
        )),
    };
    fs::create_dir_all(&path).map_err(|error| format!("创建附件目录失败：{error}"))?;
    fs::canonicalize(path).map_err(|error| error.to_string())
}

fn relative_path(target: &Path, base: &Path) -> String {
    let target_parts: Vec<_> = target.components().collect();
    let base_parts: Vec<_> = base.components().collect();
    let mut common = 0;
    while common < target_parts.len()
        && common < base_parts.len()
        && target_parts[common] == base_parts[common]
    {
        common += 1;
    }
    if common == 0 {
        return target.to_string_lossy().replace('\\', "/");
    }
    let mut relative = PathBuf::new();
    for component in &base_parts[common..] {
        if matches!(component, Component::Normal(_)) {
            relative.push("..");
        }
    }
    for component in &target_parts[common..] {
        relative.push(component.as_os_str());
    }
    relative.to_string_lossy().replace('\\', "/")
}

fn resource_url_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~:".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn display_file_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
            return format!("\\\\{unc}");
        }
        if let Some(drive) = value.strip_prefix("\\\\?\\") {
            return drive.to_owned();
        }
    }
    value.into_owned()
}

fn write_asset(
    request: &StoreAssetRequest,
    bytes: &[u8],
    suggested_name: &str,
    extension: &str,
) -> Result<StoredAsset, String> {
    if bytes.is_empty() || bytes.len() > MAX_ASSET_BYTES {
        return Err("图片为空或超过 25 MiB 限制".into());
    }
    let document = Path::new(request.document_path.as_deref().ok_or("缺少附件存储位置")?);
    let directory = asset_directory(document, request.directory.as_deref())?;
    let name = clean_file_name(
        request.file_name.as_deref().unwrap_or(suggested_name),
        extension,
    );
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or(extension);
    for suffix in 0..10_000 {
        let candidate = directory.join(if suffix == 0 {
            name.clone()
        } else {
            format!("{stem}-{suffix}.{extension}")
        });
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建图片附件失败：{error}")),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&candidate);
            return Err(format!("保存图片附件失败：{error}"));
        }
        let parent = fs::canonicalize(document.parent().ok_or("文档路径无效")?)
            .map_err(|error| error.to_string())?;
        return Ok(StoredAsset {
            relative_path: resource_url_path(&relative_path(&candidate, &parent)),
            path: display_file_path(&candidate),
        });
    }
    Err("同名图片过多，请指定其他文件名".into())
}

#[tauri::command]
pub async fn store_markdown_asset(
    app: tauri::AppHandle,
    mut request: StoreAssetRequest,
) -> Result<StoredAsset, String> {
    if request.document_path.is_none() {
        let key = request
            .draft_key
            .as_deref()
            .ok_or("未保存文档需要草稿标识")?;
        if key.is_empty() || key.len() > 8192 {
            return Err("草稿标识无效".into());
        }
        let mut hash = 0xcbf29ce484222325_u64;
        for byte in key.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        let document = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("draft-assets")
            .join(format!("{hash:016x}"))
            .join("Untitled.md");
        request.document_path = Some(document.to_string_lossy().into_owned());
    }
    if request.source.starts_with("https://") || request.source.starts_with("http://") {
        if !request.allow_remote {
            return Err("远程图片下载需要明确授权".into());
        }
        let client = asset_http_client()?;
        let mut response = client
            .get(&request.source)
            .send()
            .await
            .map_err(|error| format!("下载图片失败：{error}"))?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ASSET_BYTES as u64)
        {
            return Err("远程图片超过 25 MiB 限制".into());
        }
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let extension = image_extension(mime)
            .ok_or("远程资源没有受支持的图片类型")?
            .to_owned();
        let name = response
            .url()
            .path_segments()
            .and_then(|segments| segments.last())
            .unwrap_or("image")
            .to_owned();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if bytes.len() + chunk.len() > MAX_ASSET_BYTES {
                return Err("远程图片超过 25 MiB 限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        return tauri::async_runtime::spawn_blocking(move || {
            write_asset(&request, &bytes, &name, &extension)
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || store_local_asset(request))
        .await
        .map_err(|error| error.to_string())?
}

fn asset_http_client() -> Result<reqwest::Client, String> {
    // Match the updater's existing Ring provider; image download can happen
    // before the updater has initialized it.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())
}

fn store_local_asset(request: StoreAssetRequest) -> Result<StoredAsset, String> {
    if request.source.starts_with("data:") {
        if request.source.len() > MAX_ASSET_BYTES * 4 / 3 + 1024 {
            return Err("图片超过 25 MiB 限制".into());
        }
        let (header, payload) = request.source.split_once(',').ok_or("图片 data URL 无效")?;
        let mime = header
            .strip_prefix("data:")
            .and_then(|value| value.strip_suffix(";base64"))
            .ok_or("仅支持 Base64 图片 data URL")?;
        let extension = image_extension(mime).ok_or("不支持的图片类型")?;
        let bytes = STANDARD
            .decode(payload)
            .map_err(|error| format!("图片数据无效：{error}"))?;
        return write_asset(&request, &bytes, &format!("image.{extension}"), extension);
    }
    let source = local_asset_path(&request.source)?;
    if !source.is_file() || !permitted_image_name(&source.to_string_lossy()) {
        return Err("请选择受支持的本地图片文件".into());
    }
    let file = File::open(&source).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_ASSET_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image.png");
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("png");
    write_asset(&request, &bytes, name, extension)
}

fn local_asset_path(source: &str) -> Result<PathBuf, String> {
    if source.to_ascii_lowercase().starts_with("file:") {
        reqwest::Url::parse(source)
            .map_err(|error| error.to_string())?
            .to_file_path()
            .map_err(|_| "图片文件 URL 无效".into())
    } else {
        Ok(PathBuf::from(source))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateAssetsRequest {
    pub old_document_path: String,
    pub new_document_path: String,
    pub sources: Vec<String>,
    pub directory: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratedAsset {
    pub source: String,
    pub path: Option<String>,
    pub relative_path: Option<String>,
    pub warning: Option<String>,
}

#[tauri::command]
pub async fn migrate_markdown_assets(
    request: MigrateAssetsRequest,
) -> Result<Vec<MigratedAsset>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.sources.len() > 1000 {
            return Err("单次最多迁移 1000 个图片附件".into());
        }
        let old_parent = Path::new(&request.old_document_path)
            .parent()
            .ok_or("原文档路径无效")?;
        let mut result = Vec::new();
        for source in request.sources {
            let migrated = (|| {
                let source_path = local_asset_path(&source)?;
                let source_path = if source_path.is_absolute() {
                    source_path
                } else {
                    old_parent.join(&source_path)
                };
                store_local_asset(StoreAssetRequest {
                    document_path: Some(request.new_document_path.clone()),
                    draft_key: None,
                    source: source_path.to_string_lossy().into_owned(),
                    file_name: None,
                    directory: request.directory.clone(),
                    allow_remote: false,
                })
            })();
            // A broken image reference must not prevent the document itself from saving.
            result.push(match migrated {
                Ok(asset) => MigratedAsset {
                    source,
                    path: Some(asset.path),
                    relative_path: Some(asset.relative_path),
                    warning: None,
                },
                Err(warning) => MigratedAsset {
                    source,
                    path: None,
                    relative_path: None,
                    warning: Some(warning),
                },
            });
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadChunkRequest {
    pub path: String,
    pub offset: Option<u64>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub tail: bool,
    pub encoding: Option<String>,
    pub previous_size: Option<u64>,
    pub previous_identity: Option<String>,
    pub previous_revision: Option<String>,
    pub previous_fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub text: String,
    pub start_offset: u64,
    pub next_offset: u64,
    pub size: u64,
    pub identity: String,
    pub revision: String,
    pub fingerprint: String,
    pub reset: bool,
    pub has_more: bool,
    pub encoding: String,
    pub warning: Option<String>,
}

fn file_identity(metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{:?}", metadata.created().ok())
    }
}

fn chunk_revision(metadata: &fs::Metadata) -> String {
    format!(
        "{}:{}:{:?}",
        file_identity(metadata),
        metadata.len(),
        metadata.modified().ok()
    )
}

fn read_range(file: &mut File, start: u64, length: usize) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(length);
    file.take(length as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn cursor_fingerprint(file: &mut File, offset: u64) -> Result<String, String> {
    let start = offset.saturating_sub(128);
    let bytes = read_range(file, start, (offset - start) as usize)?;
    // FNV is an inexpensive change detector, not an authenticity check.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(format!("{start}:{offset}:{hash:016x}"))
}

fn normal_encoding(label: Option<&str>, prefix: &[u8]) -> Result<(&'static str, usize), String> {
    let bom = if prefix.starts_with(&[0xff, 0xfe]) {
        ("UTF-16 LE", 2)
    } else if prefix.starts_with(&[0xfe, 0xff]) {
        ("UTF-16 BE", 2)
    } else if prefix.starts_with(&[0xef, 0xbb, 0xbf]) {
        ("UTF-8 BOM", 3)
    } else {
        ("UTF-8", 0)
    };
    let encoding = match label.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "auto" => return Ok(bom),
        "utf-8" | "utf8" => "UTF-8",
        "utf-8 bom" | "utf8bom" => "UTF-8 BOM",
        "utf-16 le" | "utf-16le" | "utf16le" => "UTF-16 LE",
        "utf-16 be" | "utf-16be" | "utf16be" => "UTF-16 BE",
        "ansi" | "gbk" => "GBK",
        "big5" => "Big5",
        "shift_jis" | "shift-jis" | "shift jis" => "Shift_JIS",
        "windows-1252" | "windows1252" => "Windows-1252",
        _ => return Err("不支持的分块读取编码".into()),
    };
    let skip = if encoding == bom.0 || (encoding == "UTF-8" && bom.0 == "UTF-8 BOM") {
        bom.1
    } else {
        0
    };
    Ok((encoding, skip))
}

fn legacy_encoding(encoding: &str) -> &'static encoding_rs::Encoding {
    match encoding {
        "Big5" => BIG5,
        "Shift_JIS" => SHIFT_JIS,
        "Windows-1252" => WINDOWS_1252,
        _ => GBK,
    }
}

fn legacy_character_length(byte: u8, encoding: &str) -> usize {
    if encoding == "Windows-1252" {
        return 1;
    }
    let lead = if encoding == "Shift_JIS" {
        (0x81..=0x9f).contains(&byte) || (0xe0..=0xfc).contains(&byte)
    } else {
        (0x81..=0xfe).contains(&byte)
    };
    if lead { 2 } else { 1 }
}

fn complete_utf8_prefix(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let mut start = bytes.len() - 1;
    while start > 0 && bytes.len() - start < 4 && bytes[start] & 0xc0 == 0x80 {
        start -= 1;
    }
    let expected = match bytes[start] {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 1,
    };
    if bytes.len() - start < expected {
        start
    } else {
        bytes.len()
    }
}

fn read_chunk(request: ReadChunkRequest) -> Result<FileChunk, String> {
    let mut file = File::open(&request.path).map_err(|error| format!("读取文件失败：{error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("分块阅读只支持普通文件".into());
    }
    let size = metadata.len();
    let identity = file_identity(&metadata);
    let revision = chunk_revision(&metadata);
    // Enough room for a complete character even when a caller passes a tiny limit.
    let limit = request
        .limit
        .unwrap_or(256 * 1024)
        .clamp(8, MAX_CHUNK_BYTES);
    let mut reset = request
        .previous_identity
        .as_ref()
        .is_some_and(|previous| previous != &identity)
        || request
            .previous_size
            .is_some_and(|previous| previous > size)
        || request.previous_size == Some(size)
            && request
                .previous_revision
                .as_ref()
                .is_some_and(|previous| previous != &revision);
    if !reset
        && let (Some(offset), Some(previous)) =
            (request.offset, request.previous_fingerprint.as_ref())
    {
        reset = cursor_fingerprint(&mut file, offset.min(size))? != *previous;
    }
    let prefix = read_range(&mut file, 0, 4)?;
    let (encoding, bom_length) = normal_encoding(request.encoding.as_deref(), &prefix)?;
    let mut start = if request.tail {
        size.saturating_sub(limit as u64)
    } else if reset {
        0
    } else {
        request.offset.unwrap_or(0).min(size)
    };
    start = start.max(bom_length as u64).min(size);
    let mut warning = None;
    if encoding.starts_with("UTF-16") {
        let base = bom_length as u64;
        if (start - base) % 2 != 0 {
            start = (start + 1).min(size);
        }
        let next = read_range(&mut file, start, 2)?;
        if next.len() == 2 {
            let unit = if encoding == "UTF-16 LE" {
                u16::from_le_bytes([next[0], next[1]])
            } else {
                u16::from_be_bytes([next[0], next[1]])
            };
            if start > bom_length as u64 && (0xdc00..=0xdfff).contains(&unit) {
                start = (start + 2).min(size);
            }
        }
    } else if encoding.starts_with("UTF-8") {
        if start > bom_length as u64 {
            let next = read_range(&mut file, start, 4)?;
            start += next
                .iter()
                .take_while(|byte| (**byte & 0xc0) == 0x80)
                .count() as u64;
        }
    } else if start > 0 && encoding != "Windows-1252" {
        // Locate a known single-byte boundary before a random page/tail offset.
        // Sequential reads supply our fingerprint and already start at a boundary.
        if request.previous_fingerprint.is_none() || request.tail {
            let context_start = start.saturating_sub(64 * 1024);
            let context = read_range(&mut file, context_start, (start - context_start) as usize)?;
            let anchor = context
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .or(if context_start == 0 { Some(0) } else { None });
            if let Some(mut position) = anchor {
                while context_start + (position as u64) < start {
                    position += legacy_character_length(context[position], encoding);
                }
                start = (context_start + position as u64).min(size);
            } else {
                let after = read_range(&mut file, start, limit)?;
                if let Some(index) = after.iter().position(|byte| *byte == b'\n') {
                    start += index as u64 + 1;
                } else {
                    warning = Some("超长行没有可定位的编码边界；建议从文件开头连续阅读".into());
                }
            }
        }
    }
    let mut bytes = read_range(&mut file, start, limit)?;
    let text = if encoding.starts_with("UTF-8") {
        let complete = complete_utf8_prefix(&bytes);
        if complete != bytes.len() {
            bytes.truncate(complete);
            warning = Some("读取边界包含未完成的字符，下次读取将继续处理".into());
        }
        if std::str::from_utf8(&bytes).is_err() {
            warning = Some("内容包含无效 UTF-8 字节，请选择正确编码".into());
        }
        String::from_utf8_lossy(&bytes).into_owned()
    } else if encoding.starts_with("UTF-16") {
        // Keep odd final bytes pending: the writer may still be appending a code unit.
        if bytes.len() % 2 != 0 {
            warning = Some("读取边界包含未完成的 UTF-16 字符，下次读取将继续处理".into());
        }
        bytes.truncate(bytes.len() / 2 * 2);
        let little = encoding == "UTF-16 LE";
        let mut units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| {
                if little {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        if units
            .last()
            .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
        {
            units.pop();
            bytes.truncate(bytes.len().saturating_sub(2));
            warning = Some("读取边界包含未完成的 UTF-16 字符，下次读取将继续处理".into());
        }
        match String::from_utf16(&units) {
            Ok(text) => text,
            Err(_) => {
                warning = Some("内容包含无效 UTF-16 序列".into());
                String::from_utf16_lossy(&units)
            }
        }
    } else {
        let codec = legacy_encoding(encoding);
        let mut position = 0;
        while position < bytes.len() {
            let length = legacy_character_length(bytes[position], encoding);
            if position + length > bytes.len() {
                bytes.truncate(position);
                break;
            }
            position += length;
        }
        let (text, errors) = codec.decode_without_bom_handling(&bytes);
        if errors {
            warning = Some(format!("内容包含无效 {encoding} 字节，请检查编码"));
        }
        text.into_owned()
    };
    let next_offset = start + bytes.len() as u64;
    let fingerprint = cursor_fingerprint(&mut file, next_offset)?;
    Ok(FileChunk {
        text,
        start_offset: start,
        next_offset,
        size,
        identity,
        revision,
        fingerprint,
        reset,
        has_more: next_offset < size && !bytes.is_empty(),
        encoding: encoding.into(),
        warning,
    })
}

#[tauri::command]
pub async fn read_file_chunk(request: ReadChunkRequest) -> Result<FileChunk, String> {
    tauri::async_runtime::spawn_blocking(move || read_chunk(request))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PandocStatus {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

fn pandoc_command() -> Command {
    let executable = if cfg!(windows) {
        "pandoc.exe"
    } else {
        "pandoc"
    };
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    #[cfg(target_os = "macos")]
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    #[cfg(windows)]
    for variable in ["ProgramFiles", "LOCALAPPDATA"] {
        if let Some(directory) = std::env::var_os(variable) {
            directories.push(PathBuf::from(directory).join("Pandoc"));
        }
    }
    let executable = directories
        .into_iter()
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(executable));
    let command = Command::new(executable);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    };
    command
}

/// Capture output to bounded files rather than pipe buffers, so a verbose converter
/// cannot deadlock while we wait. Timeout always kills and reaps the child.
fn run_pandoc(
    mut command: Command,
    timeout: Duration,
    directory: &Path,
) -> Result<(String, String), String> {
    let stdout_path = directory.join(unique_name("stdout"));
    let stderr_path = directory.join(unique_name("stderr"));
    let stdout = File::create(&stdout_path).map_err(|error| error.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|error| error.to_string())?;
    command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法运行 Pandoc，请先安装并添加到 PATH：{error}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
        let output_too_large = [&stdout_path, &stderr_path]
            .iter()
            .any(|path| fs::metadata(path).is_ok_and(|metadata| metadata.len() > 2 * 1024 * 1024))
            || fs::metadata(directory.join("output"))
                .is_ok_and(|metadata| metadata.len() > 64 * 1024 * 1024);
        if started.elapsed() > timeout || output_too_large {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if output_too_large {
                "Pandoc 输出超过限制"
            } else {
                "Pandoc 转换超时"
            }
            .into());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let output =
        String::from_utf8_lossy(&read_bounded_file(&stdout_path, 2 * 1024 * 1024)?).into_owned();
    let errors =
        String::from_utf8_lossy(&read_bounded_file(&stderr_path, 2 * 1024 * 1024)?).into_owned();
    let _ = fs::remove_file(stdout_path);
    let _ = fs::remove_file(stderr_path);
    if !status.success() {
        return Err(format!(
            "Pandoc 转换失败：{}",
            errors.chars().take(2000).collect::<String>()
        ));
    }
    Ok((output, errors))
}

struct TemporaryDirectory(PathBuf);
impl TemporaryDirectory {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(unique_name("otterdive-convert"));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|error| error.to_string())?;
        Ok(Self(path))
    }
}
impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn read_bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| error.to_string())?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err(format!("文件超过 {} MiB 限制", limit / 1024 / 1024));
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn pandoc_status() -> Result<PandocStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let directory = TemporaryDirectory::new()?;
        let mut command = pandoc_command();
        command.arg("--version");
        match run_pandoc(command, Duration::from_secs(5), &directory.0) {
            Ok((output, _)) => Ok(PandocStatus {
                available: true,
                version: output.lines().next().map(str::to_owned),
                error: None,
            }),
            Err(error) => Ok(PandocStatus {
                available: false,
                version: None,
                error: Some(error),
            }),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertDocumentRequest {
    /// "import" reads sourcePath; "export" writes outputPath from Markdown text.
    pub direction: String,
    pub format: String,
    pub text: Option<String>,
    pub source_path: Option<String>,
    pub output_path: Option<String>,
    /// Saved Markdown path; relative image resources resolve from its directory.
    pub document_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedDocument {
    pub text: Option<String>,
    pub output_path: Option<String>,
    pub warnings: String,
}

fn converter_format(format: &str, importing: bool) -> Result<&'static str, String> {
    match format.to_ascii_lowercase().as_str() {
        "docx" => Ok("docx"),
        "epub" | "epub3" => Ok("epub"),
        "html" | "html5" => Ok("html"),
        "odt" => Ok("odt"),
        "rtf" if !importing => Ok("rtf"),
        "latex" | "tex" => Ok("latex"),
        "rst" => Ok("rst"),
        "markdown" | "md" => Ok("markdown"),
        "gfm" => Ok("gfm"),
        "plain" | "txt" if !importing => Ok("plain"),
        _ => Err("不支持的 Pandoc 转换格式".into()),
    }
}

fn write_export_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or("请选择绝对导出路径")?;
    if !path.is_absolute() {
        return Err("请选择绝对导出路径".into());
    }
    if fs::metadata(path).is_ok_and(|metadata| metadata.permissions().readonly()) {
        return Err("目标文件为只读".into());
    }
    let temporary_path = parent.join(unique_name(".otterdive-export"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| error.to_string())?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(temporary_path);
        return Err(format!("写入导出文件失败：{error}"));
    }
    // Windows rename cannot replace a destination. Preserve it until the new
    // export has been flushed, then restore the backup if replacement fails.
    #[cfg(windows)]
    {
        let backup = parent.join(unique_name(".otterdive-export-backup"));
        let existed = path.exists();
        if existed && let Err(error) = fs::rename(path, &backup) {
            let _ = fs::remove_file(&temporary_path);
            return Err(error.to_string());
        }
        if let Err(error) = fs::rename(&temporary_path, path) {
            if existed {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(&temporary_path);
            return Err(error.to_string());
        }
        if existed {
            let _ = fs::remove_file(backup);
        }
    }
    #[cfg(not(windows))]
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error.to_string());
    }
    Ok(())
}

fn convert_with_pandoc(
    request: ConvertDocumentRequest,
    imported_assets: &Path,
) -> Result<ConvertedDocument, String> {
    let importing = match request.direction.as_str() {
        "import" => true,
        "export" => false,
        _ => return Err("转换方向必须为 import 或 export".into()),
    };
    let format = converter_format(&request.format, importing)?;
    let directory = TemporaryDirectory::new()?;
    let input = directory.0.join("input");
    let output = directory.0.join("output");
    let mut command = pandoc_command();
    // No shell, filters, executable options, or caller-supplied arguments.
    // Imported files cannot follow include directives outside their own content.
    // Explicit export resolves the saved document's linked image resources.
    if importing {
        command.arg("--sandbox");
    }
    let resource_directory = request
        .document_path
        .as_deref()
        .and_then(|path| Path::new(path).parent())
        .filter(|path| path.is_dir())
        .map(Path::to_owned);
    if let Some(parent) = &resource_directory {
        command.current_dir(parent);
        command.arg("--resource-path").arg(parent);
    }
    if importing {
        let source = PathBuf::from(request.source_path.as_deref().ok_or("请选择导入文件")?);
        let bytes = read_bounded_file(&source, 64 * 1024 * 1024)?;
        fs::write(&input, bytes).map_err(|error| error.to_string())?;
        command.arg("--from").arg(format).arg("--to").arg("gfm");
        command
            .arg("--extract-media")
            .arg(directory.0.join("media"));
    } else {
        let text = request
            .text
            .as_deref()
            .ok_or("缺少需要导出的 Markdown 内容")?;
        if text.len() > 40 * 1024 * 1024 {
            return Err("导出内容超过 40 MiB 限制".into());
        }
        fs::write(&input, text).map_err(|error| error.to_string())?;
        command
            .arg("--from")
            .arg("markdown+tex_math_dollars+footnotes+yaml_metadata_block")
            .arg("--to")
            .arg(format)
            .arg("--standalone");
    }
    command.arg("--output").arg(&output).arg(&input);
    let (_, warnings) = run_pandoc(command, Duration::from_secs(60), &directory.0)?;
    let bytes = read_bounded_file(&output, 64 * 1024 * 1024)?;
    if importing {
        let mut text =
            String::from_utf8(bytes).map_err(|error| format!("转换结果不是有效 UTF-8：{error}"))?;
        let media = directory.0.join("media");
        if media.is_dir() {
            let destination = imported_assets.join(unique_name("import"));
            let mut total = 0;
            if let Err(error) = copy_imported_media(&media, &destination, &mut total) {
                let _ = fs::remove_dir_all(destination);
                return Err(error);
            }
            let from = media.to_string_lossy().replace('\\', "/");
            let to = resource_url_path(&destination.to_string_lossy().replace('\\', "/"));
            text = text
                .replace(&from, &to)
                .replace(&from.replace(' ', "%20"), &to);
        }
        Ok(ConvertedDocument {
            text: Some(text),
            output_path: None,
            warnings,
        })
    } else {
        let path = PathBuf::from(request.output_path.ok_or("请选择导出位置")?);
        write_export_file(&path, &bytes)?;
        Ok(ConvertedDocument {
            text: None,
            output_path: Some(path.to_string_lossy().into_owned()),
            warnings,
        })
    }
}

#[tauri::command]
pub async fn convert_document(
    app: tauri::AppHandle,
    request: ConvertDocumentRequest,
) -> Result<ConvertedDocument, String> {
    let imported_assets = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("imported-assets");
    tauri::async_runtime::spawn_blocking(move || convert_with_pandoc(request, &imported_assets))
        .await
        .map_err(|error| error.to_string())?
}

fn copy_imported_media(source: &Path, destination: &Path, total: &mut u64) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            return Err("导入附件包含符号链接".into());
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_imported_media(&entry.path(), &target, total)?;
        } else if file_type.is_file() {
            *total += entry.metadata().map_err(|error| error.to_string())?.len();
            if *total > 64 * 1024 * 1024 {
                return Err("导入附件总大小超过 64 MiB 限制".into());
            }
            fs::copy(entry.path(), target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTextRequest {
    pub path: String,
    pub text: String,
}

#[tauri::command]
pub async fn export_document_text(request: ExportTextRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.text.len() > 64 * 1024 * 1024 {
            return Err("导出内容超过 64 MiB 限制".into());
        }
        write_export_file(Path::new(&request.path), request.text.as_bytes())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBytesRequest {
    pub path: String,
    pub bytes: Vec<u8>,
}

fn export_bytes(request: ExportBytesRequest) -> Result<(), String> {
    if request.bytes.is_empty() || request.bytes.len() > 32 * 1024 * 1024 {
        return Err("导出数据为空或超过 32 MiB 限制".into());
    }
    write_export_file(Path::new(&request.path), &request.bytes)
}

#[tauri::command]
pub async fn export_document_bytes(request: ExportBytesRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || export_bytes(request))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(text: &str, kind: SnapshotKind) -> SaveSnapshotRequest {
        SaveSnapshotRequest { kind, key: "/notes/测试.md".into(), title: "测试.md".into(),
            path: Some("/notes/测试.md".into()), text: text.into(), encoding: "UTF-8".into(),
            metadata: Some(r#"{"savedText":"original","diskRevision":"1:2","lineEnding":"LF","language":"markdown"}"#.into()),
            retention_days: None, max_entries: None }
    }

    fn chunk_request(path: &Path) -> ReadChunkRequest {
        ReadChunkRequest {
            path: path.to_string_lossy().into_owned(),
            offset: None,
            limit: Some(8),
            tail: false,
            encoding: None,
            previous_size: None,
            previous_identity: None,
            previous_revision: None,
            previous_fingerprint: None,
        }
    }

    fn follow_request(path: &Path, previous: &FileChunk) -> ReadChunkRequest {
        ReadChunkRequest {
            offset: Some(previous.next_offset),
            previous_size: Some(previous.size),
            previous_identity: Some(previous.identity.clone()),
            previous_revision: Some(previous.revision.clone()),
            previous_fingerprint: Some(previous.fingerprint.clone()),
            ..chunk_request(path)
        }
    }

    #[test]
    fn recovery_replaces_only_its_own_document_and_preserves_base_metadata() {
        let directory = TemporaryDirectory::new().unwrap();
        let database = directory.0.join("test.db");
        let first = save_snapshot_at(&database, snapshot("first", SnapshotKind::Recovery)).unwrap();
        let mut second_document = snapshot("other", SnapshotKind::Recovery);
        second_document.key = "untitled:123".into();
        second_document.path = None;
        save_snapshot_at(&database, second_document).unwrap();
        let latest =
            save_snapshot_at(&database, snapshot("latest", SnapshotKind::Recovery)).unwrap();
        let connection = snapshot_connection(&database).unwrap();
        assert!(
            read_snapshot_from(&connection, first.info.id)
                .unwrap()
                .is_none()
        );
        assert_eq!(latest.text, "latest");
        assert!(latest.info.metadata.unwrap().contains("diskRevision"));
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM snapshots", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn history_deduplicates_identical_ticks_and_keeps_requested_latest_count() {
        let directory = TemporaryDirectory::new().unwrap();
        let database = directory.0.join("test.db");
        let first = save_snapshot_at(&database, snapshot("one", SnapshotKind::History)).unwrap();
        let repeated = save_snapshot_at(&database, snapshot("one", SnapshotKind::History)).unwrap();
        assert_eq!(first.info.id, repeated.info.id);
        for value in ["two", "three", "four"] {
            let mut request = snapshot(value, SnapshotKind::History);
            request.max_entries = Some(2);
            save_snapshot_at(&database, request).unwrap();
        }
        let connection = snapshot_connection(&database).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM snapshots", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(
            read_snapshot_from(&connection, first.info.id)
                .unwrap()
                .is_none()
        );
        assert!(
            save_snapshot_at(
                &database,
                SaveSnapshotRequest {
                    metadata: Some("invalid JSON".into()),
                    ..snapshot("bad", SnapshotKind::History)
                }
            )
            .is_err()
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM snapshots", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn recovery_and_history_quotas_are_independent() {
        let directory = TemporaryDirectory::new().unwrap();
        let database = directory.0.join("test.db");
        save_snapshot_at(&database, snapshot("history", SnapshotKind::History)).unwrap();
        save_snapshot_at(&database, snapshot("recovery", SnapshotKind::Recovery)).unwrap();
        let connection = snapshot_connection(&database).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM snapshots", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn snapshot_prunes_expired_records_when_new_content_arrives() {
        let directory = TemporaryDirectory::new().unwrap();
        let database = directory.0.join("test.db");
        let old = save_snapshot_at(&database, snapshot("old", SnapshotKind::History)).unwrap();
        let connection = snapshot_connection(&database).unwrap();
        connection
            .execute("UPDATE snapshots SET created_at = 1", [])
            .unwrap();
        save_snapshot_at(&database, snapshot("new", SnapshotKind::History)).unwrap();
        assert!(
            read_snapshot_from(&connection, old.info.id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn image_data_urls_use_document_assets_and_never_overwrite_a_collision() {
        let directory = TemporaryDirectory::new().unwrap();
        let document = directory.0.join("中文 note.md");
        fs::write(&document, "").unwrap();
        let request = || StoreAssetRequest {
            document_path: Some(document.to_string_lossy().into_owned()),
            draft_key: None,
            source: "data:image/png;base64,aGVsbG8=".into(),
            file_name: Some("test.png".into()),
            directory: None,
            allow_remote: false,
        };
        let first = store_local_asset(request()).unwrap();
        let second = store_local_asset(request()).unwrap();
        assert!(
            first
                .relative_path
                .ends_with("%E4%B8%AD%E6%96%87%20note.assets/test.png")
        );
        assert!(second.relative_path.ends_with("test-1.png"));
        assert_eq!(fs::read(first.path).unwrap(), b"hello");
        assert_eq!(fs::read(second.path).unwrap(), b"hello");
        assert!(
            store_local_asset(StoreAssetRequest {
                source: "data:text/html;base64,aGVsbG8=".into(),
                ..request()
            })
            .is_err()
        );
    }

    #[test]
    fn relative_assets_preserve_case_and_resolve_parent_directories() {
        let base = Path::new("/work/Notes");
        assert_eq!(
            relative_path(Path::new("/work/notes/image.png"), base),
            "../notes/image.png"
        );
        assert_eq!(clean_file_name("../../a.png", "png"), "a.png");
        assert_eq!(clean_file_name("evil.exe", "png"), "image.png");
        assert_eq!(
            resource_url_path("assets/100% #1.png"),
            "assets/100%25%20%231.png"
        );
    }

    #[test]
    fn utf8_paging_roundtrips_cjk_and_emoji_without_replacement_characters() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("utf8.log");
        let original = "abcd中文🙂efgh\n你好🙂 end\n";
        fs::write(&path, original).unwrap();
        let mut result = String::new();
        let mut request = chunk_request(&path);
        loop {
            let chunk = read_chunk(request).unwrap();
            result.push_str(&chunk.text);
            if !chunk.has_more {
                break;
            }
            request = follow_request(&path, &chunk);
        }
        assert_eq!(result, original);
    }

    #[test]
    fn tail_waits_for_an_incomplete_utf8_character_before_advancing() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("pending.log");
        fs::write(&path, [b'A', 0xe4, 0xbd]).unwrap();
        let first = read_chunk(chunk_request(&path)).unwrap();
        assert_eq!(first.text, "A");
        assert_eq!(first.next_offset, 1);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[0xa0, b'B'])
            .unwrap();
        let next = read_chunk(follow_request(&path, &first)).unwrap();
        assert!(!next.reset);
        assert_eq!(next.text, "你B");
    }

    #[test]
    fn utf16_paging_preserves_surrogate_pairs_and_ignores_bom() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("utf16.log");
        let original = "abc🙂中文🙂def";
        for little in [true, false] {
            let mut bytes = if little {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for unit in original.encode_utf16() {
                bytes.extend_from_slice(&if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            fs::write(&path, bytes).unwrap();
            let mut request = chunk_request(&path);
            let mut result = String::new();
            loop {
                let chunk = read_chunk(request).unwrap();
                result.push_str(&chunk.text);
                if !chunk.has_more {
                    break;
                }
                request = follow_request(&path, &chunk);
            }
            assert_eq!(result, original);
        }
    }

    #[test]
    fn legacy_encoding_pages_do_not_split_multibyte_characters() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("gbk.log");
        let original = "abc中文def测试ghi\n";
        fs::write(&path, GBK.encode(original).0.as_ref()).unwrap();
        let mut request = ReadChunkRequest {
            encoding: Some("GBK".into()),
            ..chunk_request(&path)
        };
        let mut result = String::new();
        loop {
            let chunk = read_chunk(request).unwrap();
            result.push_str(&chunk.text);
            if !chunk.has_more {
                break;
            }
            request = ReadChunkRequest {
                encoding: Some("GBK".into()),
                ..follow_request(&path, &chunk)
            };
        }
        assert_eq!(result, original);
    }

    #[test]
    fn detects_truncation_rotation_and_regrowth_but_not_normal_append() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("rotation.log");
        fs::write(&path, "original").unwrap();
        let first = read_chunk(chunk_request(&path)).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b" appended")
            .unwrap();
        let appended = read_chunk(follow_request(&path, &first)).unwrap();
        assert!(!appended.reset);
        assert_eq!(appended.text, " appende");
        fs::write(&path, "new file contents larger").unwrap();
        let rewritten = read_chunk(follow_request(&path, &appended)).unwrap();
        assert!(rewritten.reset);
        assert_eq!(rewritten.start_offset, 0);
        fs::rename(&path, directory.0.join("rotated.log")).unwrap();
        fs::write(&path, "rotation").unwrap();
        assert!(read_chunk(follow_request(&path, &rewritten)).unwrap().reset);
        fs::write(&path, "x").unwrap();
        assert!(read_chunk(follow_request(&path, &first)).unwrap().reset);
    }

    #[test]
    fn chunk_reads_are_bounded_and_tail_is_read_only() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("large.log");
        fs::write(&path, vec![b'x'; MAX_CHUNK_BYTES * 2]).unwrap();
        let chunk = read_chunk(ReadChunkRequest {
            limit: Some(usize::MAX),
            tail: true,
            ..chunk_request(&path)
        })
        .unwrap();
        assert_eq!(chunk.text.len(), MAX_CHUNK_BYTES);
        assert_eq!(chunk.start_offset, MAX_CHUNK_BYTES as u64);
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            (MAX_CHUNK_BYTES * 2) as u64
        );
    }

    #[test]
    fn export_uses_complete_replacement_and_format_allowlist() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("export.html");
        fs::write(&path, "before").unwrap();
        write_export_file(&path, "after 中文".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "after 中文");
        assert!(converter_format("--lua-filter=evil", false).is_err());
        assert!(converter_format("pdf", false).is_err());
        assert_eq!(converter_format("docx", false).unwrap(), "docx");
    }

    #[test]
    fn binary_export_preserves_bytes_and_rejects_oversize_without_overwriting() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("diagram.png");
        let bytes: Vec<u8> = (0..=255).collect();
        export_bytes(ExportBytesRequest {
            path: path.to_string_lossy().into_owned(),
            bytes: bytes.clone(),
        })
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(
            export_bytes(ExportBytesRequest {
                path: path.to_string_lossy().into_owned(),
                bytes: vec![0; 32 * 1024 * 1024 + 1]
            })
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(
            export_bytes(ExportBytesRequest {
                path: path.to_string_lossy().into_owned(),
                bytes: Vec::new()
            })
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn snapshot_budget_evicts_oldest_records_across_document_keys() {
        let directory = TemporaryDirectory::new().unwrap();
        let database = directory.0.join("test.db");
        let first = save_snapshot_at(&database, snapshot("old", SnapshotKind::History)).unwrap();
        let connection = snapshot_connection(&database).unwrap();
        connection
            .execute(
                "UPDATE snapshots SET byte_length = ?1 WHERE id = ?2",
                params![SNAPSHOT_BUDGET as i64, first.info.id],
            )
            .unwrap();
        let mut request = snapshot("new", SnapshotKind::History);
        request.key = "another document".into();
        let newest = save_snapshot_at(&database, request).unwrap();
        assert!(
            read_snapshot_from(&connection, first.info.id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            read_snapshot_from(&connection, newest.info.id)
                .unwrap()
                .unwrap()
                .text,
            "new"
        );
    }

    #[test]
    fn invalid_earlier_bytes_do_not_consume_an_incomplete_trailing_character() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("invalid.log");
        fs::write(&path, [0xff, b'A', 0xe4, 0xbd]).unwrap();
        let first = read_chunk(chunk_request(&path)).unwrap();
        assert_eq!(first.next_offset, 2);
        assert!(first.warning.unwrap().contains("无效 UTF-8"));
        assert_eq!(complete_utf8_prefix(&[0xff, 0xe4, 0xbd]), 1);
        assert_eq!(complete_utf8_prefix(&[0xf0, 0x9f, 0x99, 0x82]), 4);
    }

    #[test]
    fn utf8_bom_does_not_enter_legacy_boundary_alignment() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("bom.log");
        fs::write(&path, b"\xef\xbb\xbfabc").unwrap();
        let chunk = read_chunk(chunk_request(&path)).unwrap();
        assert_eq!(chunk.text, "abc");
        assert_eq!(chunk.start_offset, 3);
        assert_eq!(chunk.encoding, "UTF-8 BOM");
    }

    #[test]
    fn legacy_random_page_keeps_a_newline_at_the_requested_offset() {
        let directory = TemporaryDirectory::new().unwrap();
        let path = directory.0.join("gbk-newline.log");
        fs::write(&path, GBK.encode("a中\nb").0.as_ref()).unwrap();
        let chunk = read_chunk(ReadChunkRequest {
            offset: Some(3),
            encoding: Some("GBK".into()),
            ..chunk_request(&path)
        })
        .unwrap();
        assert_eq!(chunk.text, "\nb");
        assert_eq!(chunk.start_offset, 3);
    }

    #[test]
    fn remote_asset_client_reuses_the_existing_tls_provider() {
        assert!(asset_http_client().is_ok());
    }

    #[test]
    fn imported_media_survives_temporary_conversion_cleanup() {
        let source = TemporaryDirectory::new().unwrap();
        let output = TemporaryDirectory::new().unwrap();
        fs::create_dir_all(source.0.join("media/sub")).unwrap();
        fs::write(source.0.join("media/sub/test.png"), b"image").unwrap();
        let destination = output.0.join("persistent");
        let mut total = 0;
        copy_imported_media(&source.0.join("media"), &destination, &mut total).unwrap();
        drop(source);
        assert_eq!(
            fs::read(destination.join("sub/test.png")).unwrap(),
            b"image"
        );
        assert_eq!(total, 5);
    }

    #[test]
    #[ignore = "requires an installed or standalone Pandoc executable on PATH"]
    fn pandoc_docx_and_epub_roundtrip_text_tables_math_and_local_images() {
        let directory = TemporaryDirectory::new().unwrap();
        let markdown_path = directory.0.join("source doc.md");
        let markdown = "# 中文标题\n\nRoundtrip text with **bold** and $x^2$.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![像素](<pixel space.png>)\n";
        fs::write(&markdown_path, markdown).unwrap();
        fs::write(directory.0.join("pixel space.png"), STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap()).unwrap();
        let imported_assets = directory.0.join("persistent imported images");
        for format in ["docx", "epub"] {
            let output = directory.0.join(format!("converted.{format}"));
            let exported = convert_with_pandoc(
                ConvertDocumentRequest {
                    direction: "export".into(),
                    format: format.into(),
                    text: Some(markdown.into()),
                    source_path: None,
                    output_path: Some(output.to_string_lossy().into_owned()),
                    document_path: Some(markdown_path.to_string_lossy().into_owned()),
                },
                &imported_assets,
            )
            .unwrap();
            assert!(exported.output_path.is_some());
            let bytes = fs::read(&output).unwrap();
            assert!(bytes.starts_with(b"PK"));
            assert!(
                !exported.warnings.contains("Could not fetch resource"),
                "{}",
                exported.warnings
            );
            let imported = convert_with_pandoc(
                ConvertDocumentRequest {
                    direction: "import".into(),
                    format: format.into(),
                    text: None,
                    source_path: Some(output.to_string_lossy().into_owned()),
                    output_path: None,
                    document_path: None,
                },
                &imported_assets,
            )
            .unwrap();
            let text = imported.text.unwrap();
            assert!(text.contains("中文标题"), "{format}: {text}");
            assert!(text.contains("Roundtrip text"), "{format}: {text}");
            assert!(text.contains("像素"), "{format}: {text}");
            assert!(
                text.contains("persistent%20imported%20images"),
                "{format}: {text}"
            );
        }
        assert_eq!(fs::read_dir(imported_assets).unwrap().count(), 2);
    }

    #[test]
    fn asset_migration_keeps_successes_around_a_missing_image() {
        let directory = TemporaryDirectory::new().unwrap();
        fs::write(directory.0.join("first.png"), b"first").unwrap();
        fs::write(directory.0.join("last.png"), b"last").unwrap();
        let migrated =
            tauri::async_runtime::block_on(migrate_markdown_assets(MigrateAssetsRequest {
                old_document_path: directory.0.join("old.md").to_string_lossy().into_owned(),
                new_document_path: directory.0.join("new.md").to_string_lossy().into_owned(),
                sources: vec!["first.png".into(), "missing.png".into(), "last.png".into()],
                directory: None,
            }))
            .unwrap();
        let result = serde_json::to_value(migrated).unwrap();
        assert_eq!(result[0]["source"], "first.png");
        assert_eq!(result[0]["relativePath"], "new.assets/first.png");
        assert_eq!(result[1]["source"], "missing.png");
        assert!(result[1]["relativePath"].is_null());
        assert!(
            result[1]["warning"]
                .as_str()
                .is_some_and(|warning| !warning.is_empty())
        );
        assert_eq!(result[2]["source"], "last.png");
        assert_eq!(result[2]["relativePath"], "new.assets/last.png");
        assert_eq!(
            fs::read(directory.0.join("new.assets/first.png")).unwrap(),
            b"first"
        );
        assert_eq!(
            fs::read(directory.0.join("new.assets/last.png")).unwrap(),
            b"last"
        );
    }

    #[test]
    fn local_drop_assets_and_save_as_migration_preserve_original_images() {
        let directory = TemporaryDirectory::new().unwrap();
        let source_dir = directory.0.join("来源 图片");
        fs::create_dir(&source_dir).unwrap();
        let source = source_dir.join("照片 #1%.png");
        fs::write(&source, [0x89, b'P', b'N', b'G', 0, 255]).unwrap();
        let document = directory.0.join("旧笔记.md");
        fs::write(&document, "").unwrap();
        let source_url = reqwest::Url::from_file_path(&source).unwrap().to_string();
        let request = || StoreAssetRequest {
            document_path: Some(document.to_string_lossy().into_owned()),
            draft_key: None,
            source: source_url.clone(),
            file_name: None,
            directory: None,
            allow_remote: false,
        };
        let first = store_local_asset(request()).unwrap();
        let collision = store_local_asset(request()).unwrap();
        assert_ne!(first.path, collision.path);
        assert!(first.relative_path.contains("%23"));
        assert!(first.relative_path.contains("%25"));
        assert_eq!(fs::read(&first.path).unwrap(), fs::read(&source).unwrap());
        let new_document = directory.0.join("另一目录/新笔记.md");
        let migrated =
            tauri::async_runtime::block_on(migrate_markdown_assets(MigrateAssetsRequest {
                old_document_path: document.to_string_lossy().into_owned(),
                new_document_path: new_document.to_string_lossy().into_owned(),
                sources: vec![
                    reqwest::Url::from_file_path(&first.path)
                        .unwrap()
                        .to_string(),
                ],
                directory: None,
            }))
            .unwrap();
        assert_eq!(migrated.len(), 1);
        assert_eq!(
            fs::read(migrated[0].path.as_ref().unwrap()).unwrap(),
            fs::read(&source).unwrap()
        );
        assert!(Path::new(&first.path).is_file());
        assert!(source.is_file());
    }
}
