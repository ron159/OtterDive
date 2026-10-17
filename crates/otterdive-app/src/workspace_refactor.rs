use crate::document_delivery::markdown_reference_spans;
use otterdive_core::fs::{decode_bytes, encode_text};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions, Permissions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMoveRequest {
    pub root: String,
    pub path: String,
    pub destination: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDocument {
    pub path: String,
    pub destination_path: String,
    pub reference_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMovePreview {
    pub token: String,
    pub root: String,
    pub path: String,
    pub destination: String,
    pub changed_documents: Vec<ChangedDocument>,
    pub reference_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMoveResult {
    pub root: String,
    pub path: String,
    pub destination: String,
    pub changed_documents: Vec<ChangedDocument>,
    pub reference_count: usize,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn preview_workspace_move(
    request: WorkspaceMoveRequest,
) -> Result<WorkspaceMovePreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_move(request))
        .await
        .map_err(|error| format!("移动预览任务失败：{error}"))?
}

#[tauri::command]
pub async fn apply_workspace_move(
    request: WorkspaceMoveRequest,
    token: String,
) -> Result<WorkspaceMoveResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply_move(request, token))
        .await
        .map_err(|error| format!("移动任务失败：{error}"))?
}

const MAX_PLAN_BYTES: usize = 256 * 1024 * 1024;
const PLAN_LIFETIME: Duration = Duration::from_secs(10 * 60);

struct MovePaths {
    root: PathBuf,
    source: PathBuf,
    destination: PathBuf,
}

struct FileSnapshot {
    bytes: Vec<u8>,
    permissions: Permissions,
}

#[derive(PartialEq, Eq)]
struct TreeEntry {
    path: PathBuf,
    directory: bool,
}

struct DocumentChange {
    path: PathBuf,
    destination: PathBuf,
    bytes: Vec<u8>,
    references: usize,
}

struct MovePlan {
    paths: MovePaths,
    markdown_paths: Vec<PathBuf>,
    source_entries: Vec<TreeEntry>,
    files: BTreeMap<PathBuf, FileSnapshot>,
    directories: BTreeMap<PathBuf, Permissions>,
    changes: Vec<DocumentChange>,
}

struct CachedPlan {
    token: String,
    created: Instant,
    plan: MovePlan,
}

static PLANS: OnceLock<Mutex<Vec<CachedPlan>>> = OnceLock::new();
static MOVE_LOCK: Mutex<()> = Mutex::new(());

pub fn preview_move(request: WorkspaceMoveRequest) -> Result<WorkspaceMovePreview, String> {
    let _guard = MOVE_LOCK
        .lock()
        .map_err(|_| "移动任务锁不可用".to_owned())?;
    let plan = build_plan(validate_paths(&request)?)?;
    let token = unique_id();
    let summary = WorkspaceMovePreview {
        token: token.clone(),
        root: display(&plan.paths.root),
        path: display(&plan.paths.source),
        destination: display(&plan.paths.destination),
        changed_documents: changed_documents(&plan),
        reference_count: plan.changes.iter().map(|change| change.references).sum(),
    };
    let mut cache = PLANS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|_| "移动预览缓存不可用".to_owned())?;
    cache.retain(|entry| entry.created.elapsed() < PLAN_LIFETIME);
    // Plans own the original bytes so confirmation cannot apply a different patch.
    let incoming_bytes = plan_memory(&plan);
    while !cache.is_empty()
        && (cache.len() >= 8
            || cache
                .iter()
                .map(|entry| plan_memory(&entry.plan))
                .sum::<usize>()
                + incoming_bytes
                > 512 * 1024 * 1024)
    {
        cache.remove(0);
    }
    cache.push(CachedPlan {
        token,
        created: Instant::now(),
        plan,
    });
    Ok(summary)
}

fn plan_memory(plan: &MovePlan) -> usize {
    plan.files
        .values()
        .map(|file| file.bytes.len())
        .sum::<usize>()
        + plan
            .changes
            .iter()
            .map(|change| change.bytes.len())
            .sum::<usize>()
}

pub fn apply_move(
    request: WorkspaceMoveRequest,
    token: String,
) -> Result<WorkspaceMoveResult, String> {
    let _guard = MOVE_LOCK
        .lock()
        .map_err(|_| "移动任务锁不可用".to_owned())?;
    let cached = {
        let mut cache = PLANS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .map_err(|_| "移动预览缓存不可用".to_owned())?;
        let index = cache
            .iter()
            .position(|entry| entry.token == token)
            .ok_or_else(|| "移动预览已失效，请重新预览".to_owned())?;
        cache.remove(index)
    };
    if cached.created.elapsed() >= PLAN_LIFETIME {
        return Err("移动预览已过期，请重新预览".to_owned());
    }
    let current = validate_paths(&request)?;
    let expected = &cached.plan.paths;
    if current.root != expected.root
        || current.source != expected.source
        || current.destination != expected.destination
    {
        return Err("移动请求与预览不一致，请重新预览".to_owned());
    }
    commit_plan(cached.plan, |_| Ok(()))
}

fn changed_documents(plan: &MovePlan) -> Vec<ChangedDocument> {
    plan.changes
        .iter()
        .map(|change| ChangedDocument {
            path: display(&change.path),
            destination_path: display(&change.destination),
            reference_count: change.references,
        })
        .collect()
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

fn unique_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{}-{time:x}-{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            Component::Prefix(prefix) => {
                #[cfg(windows)]
                match prefix.kind() {
                    std::path::Prefix::VerbatimDisk(drive) => {
                        result.push(format!("{}:", drive as char))
                    }
                    std::path::Prefix::VerbatimUNC(server, share) => result.push(format!(
                        "\\\\{}\\{}",
                        server.to_string_lossy(),
                        share.to_string_lossy()
                    )),
                    _ => result.push(prefix.as_os_str()),
                }
                #[cfg(not(windows))]
                result.push(prefix.as_os_str());
            }
            component => result.push(component.as_os_str()),
        }
    }
    result
}

fn request_path(root: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    normalize(&if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
}

fn protected(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".git" || name.starts_with(".otterdive-move-"))
}

fn ensure_plain_path(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "路径必须位于工作区内".to_owned())?;
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        cursor.push(component);
        if protected(&cursor) {
            return Err("不能移动版本库或内部恢复目录".to_owned());
        }
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|error| format!("无法检查 {}：{error}", cursor.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("不支持通过符号链接移动：{}", cursor.display()));
        }
    }
    Ok(())
}

fn validate_paths(request: &WorkspaceMoveRequest) -> Result<MovePaths, String> {
    let root = normalize(
        &fs::canonicalize(&request.root).map_err(|error| format!("无法打开工作区：{error}"))?,
    );
    if !root.is_dir() {
        return Err("工作区必须是文件夹".to_owned());
    }
    let requested_root = normalize(
        &std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(&request.root),
    );
    let map_path = |value: &str| {
        let input = Path::new(value);
        match input.strip_prefix(&requested_root) {
            Ok(relative) if input.is_absolute() => normalize(&root.join(relative)),
            _ => request_path(&root, value),
        }
    };
    let source = map_path(&request.path);
    let destination = map_path(&request.destination);
    if source == root
        || !source.starts_with(&root)
        || !destination.starts_with(&root)
        || destination == root
    {
        return Err("不能移动工作区根目录或工作区外的路径".to_owned());
    }
    if destination == source || destination.starts_with(&source) {
        return Err("目标不能是原路径或其子目录".to_owned());
    }
    ensure_plain_path(&root, &source)?;
    let source = normalize(&fs::canonicalize(&source).map_err(|error| error.to_string())?);
    let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("只支持普通文件和文件夹".to_owned());
    }
    ensure_plain_path(&root, destination.parent().ok_or("目标没有父目录")?)?;
    if !destination.parent().is_some_and(Path::is_dir) {
        return Err("目标父目录不存在".to_owned());
    }
    // Resolve filesystem case aliases before the cycle check (APFS/Windows).
    let destination = normalize(
        &fs::canonicalize(destination.parent().unwrap()).map_err(|error| error.to_string())?,
    )
    .join(destination.file_name().ok_or("目标名称为空")?);
    if destination == source || destination.starts_with(&source) {
        return Err("目标不能是原路径或其子目录".to_owned());
    }
    if protected(&destination) {
        return Err("不能使用内部保留目录作为目标".to_owned());
    }
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Err("目标已存在，不能覆盖；仅改大小写时可先改为临时名称".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查目标：{error}")),
    }
    Ok(MovePaths {
        root,
        source,
        destination,
    })
}

fn markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "mdx" | "markdown"
            )
        })
}

fn collect_markdown(directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("无法扫描 {}：{error}", directory.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if protected(&path) {
            continue;
        }
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            collect_markdown(&path, output)?;
        } else if kind.is_file() && markdown_file(&path) {
            output.push(path);
        }
    }
    Ok(())
}

fn collect_source(path: &Path, output: &mut Vec<TreeEntry>) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || (!metadata.is_file() && !metadata.is_dir())
        || protected(path)
    {
        return Err(format!(
            "移动内容包含不支持的文件或符号链接：{}",
            path.display()
        ));
    }
    output.push(TreeEntry {
        path: path.to_path_buf(),
        directory: metadata.is_dir(),
    });
    if metadata.is_dir() {
        let mut children = fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        children.sort();
        for child in children {
            collect_source(&child, output)?;
        }
    }
    Ok(())
}

fn relocated(path: &Path, paths: &MovePaths) -> PathBuf {
    let source: Vec<_> = paths.source.components().collect();
    let target: Vec<_> = path.components().collect();
    if target.len() >= source.len()
        && source
            .iter()
            .zip(&target)
            .all(|(a, b)| same_component(a, b))
    {
        if source.len() == target.len() {
            return paths.destination.clone();
        }
        return paths
            .destination
            .join(target[source.len()..].iter().collect::<PathBuf>());
    }
    path.to_path_buf()
}

fn same_component(left: &Component<'_>, right: &Component<'_>) -> bool {
    #[cfg(windows)]
    {
        left.as_os_str().to_string_lossy().to_lowercase()
            == right.as_os_str().to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn build_plan(paths: MovePaths) -> Result<MovePlan, String> {
    let mut markdown_paths = Vec::new();
    collect_markdown(&paths.root, &mut markdown_paths)?;
    markdown_paths.sort();
    let mut source_entries = Vec::new();
    collect_source(&paths.source, &mut source_entries)?;
    let mut files = BTreeMap::new();
    let mut directories = BTreeMap::new();
    let mut total_bytes = 0usize;
    for path in markdown_paths.iter().chain(
        source_entries
            .iter()
            .filter(|entry| !entry.directory)
            .map(|entry| &entry.path),
    ) {
        if files.contains_key(path) {
            continue;
        }
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err(format!("文件已变化，请重试：{}", path.display()));
        }
        total_bytes = total_bytes
            .checked_add(usize::try_from(metadata.len()).unwrap_or(usize::MAX))
            .ok_or("移动内容过大")?;
        if total_bytes > MAX_PLAN_BYTES {
            return Err("本次移动及引用维护超过 256 MiB，请分批移动".to_owned());
        }
        let bytes =
            fs::read(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
        files.insert(
            path.clone(),
            FileSnapshot {
                bytes,
                permissions: metadata.permissions(),
            },
        );
    }
    for entry in source_entries.iter().filter(|entry| entry.directory) {
        directories.insert(
            entry.path.clone(),
            fs::metadata(&entry.path)
                .map_err(|error| error.to_string())?
                .permissions(),
        );
    }
    let mut changes = Vec::new();
    for path in &markdown_paths {
        let snapshot = &files[path];
        let decoded = decode_bytes(&snapshot.bytes);
        if decoded.had_errors
            || encode_text(&decoded.text, decoded.encoding).map_err(|error| error.to_string())?
                != snapshot.bytes
        {
            return Err(format!(
                "无法无损读取 Markdown，未移动任何文件：{}",
                path.display()
            ));
        }
        let destination = relocated(path, &paths);
        let (text, references) = rewrite_references(&decoded.text, path, &destination, &paths)?;
        if references > 0 {
            if snapshot.permissions.readonly() {
                return Err(format!("引用文档为只读，无法维护：{}", path.display()));
            }
            let bytes = encode_text(&text, decoded.encoding)
                .map_err(|error| format!("无法保留原编码 {}：{error}", path.display()))?;
            changes.push(DocumentChange {
                path: path.clone(),
                destination,
                bytes,
                references,
            });
        }
    }
    Ok(MovePlan {
        paths,
        markdown_paths,
        source_entries,
        files,
        directories,
        changes,
    })
}

fn split_suffix(value: &str) -> (&str, &str) {
    value
        .find(['#', '?'])
        .map(|index| value.split_at(index))
        .unwrap_or((value, ""))
}

fn reference_suffix<'a>(raw: &'a str, destination: &str) -> (&'a str, String) {
    let (_, semantic_suffix) = split_suffix(destination);
    if semantic_suffix.is_empty() {
        return (raw, String::new());
    }
    // A '#' inside '&#35;' belongs to an HTML entity. Find the raw boundary
    // whose decoded tail is the semantic suffix, retaining entity/escape spelling.
    for (index, _) in raw
        .char_indices()
        .filter(|(_, ch)| matches!(ch, '#' | '?' | '&' | '\\'))
    {
        let markdown = format!("[x](<otterdive{}>)", raw[index..].replace('>', "\\>"));
        let decoded = pulldown_cmark::Parser::new(&markdown).find_map(|event| match event {
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::Link { dest_url, .. }) => {
                Some(dest_url.into_string())
            }
            _ => None,
        });
        if decoded
            .as_deref()
            .and_then(|value| value.strip_prefix("otterdive"))
            == Some(semantic_suffix)
        {
            return (&raw[..index], raw[index..].to_owned());
        }
    }
    let mut suffix = String::new();
    for ch in semantic_suffix.chars() {
        if ch == '&' {
            suffix.push_str("&amp;");
        } else if ch.is_control() || matches!(ch, '\'' | '"' | '<' | '>') {
            for byte in ch.to_string().as_bytes() {
                suffix.push_str(&format!("%{byte:02X}"));
            }
        } else {
            suffix.push(ch);
        }
    }
    (raw, suffix)
}

fn local_path(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.starts_with(['#', '?']) || value.starts_with("//") {
        return None;
    }
    if value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
    {
        return url::Url::parse(value).ok()?.to_file_path().ok();
    }
    if let Some((scheme, _)) = value.split_once(':') {
        if scheme
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
            && !Path::new(value).is_absolute()
        {
            return None;
        }
    }
    let (path, _) = split_suffix(value);
    let bytes = path.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let decoded = String::from_utf8(decoded).ok()?;
    if decoded.contains('\0') {
        return None;
    }
    Some(PathBuf::from(decoded.replace('\\', "/")))
}

fn relative_path(from: &Path, to: &Path) -> Result<String, String> {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(a, b)| same_component(a, b))
        .count();
    if common == 0 {
        return Ok(display(&to.iter().collect::<PathBuf>()).replace('\\', "/"));
    }
    let mut result = vec!["..".to_owned(); from.len() - common];
    for component in &to[common..] {
        result.push(
            component
                .as_os_str()
                .to_str()
                .ok_or("链接路径包含无效字符")?
                .to_owned(),
        );
    }
    Ok(if result.is_empty() {
        ".".to_owned()
    } else {
        result.join("/")
    })
}

fn encode_destination(path: &str, original: &str, angle: bool) -> String {
    let percent_unicode = original.contains('%');
    let escape_parens = original.contains("\\(") || original.contains("\\)");
    let mut output = String::new();
    for ch in path.chars() {
        if !angle && escape_parens && matches!(ch, '(' | ')') {
            output.push('\\');
            output.push(ch);
        } else if ch.is_control()
            || matches!(ch, '%' | '#' | '?' | '<' | '>' | '"' | '\'' | '&')
            || (!angle && (ch.is_whitespace() || matches!(ch, '(' | ')' | '&' | '\\')))
            || (percent_unicode && !ch.is_ascii())
        {
            for byte in ch.to_string().as_bytes() {
                output.push_str(&format!("%{byte:02X}"));
            }
        } else {
            output.push(ch);
        }
    }
    output
}

fn rewrite_references(
    text: &str,
    source: &Path,
    destination: &Path,
    paths: &MovePaths,
) -> Result<(String, usize), String> {
    let mut edits = Vec::new();
    for reference in markdown_reference_spans(text) {
        let Some(link_path) = local_path(&reference.destination) else {
            continue;
        };
        let old_target = normalize(&if link_path.is_absolute() {
            link_path.clone()
        } else {
            source.parent().unwrap().join(&link_path)
        });
        let new_target = relocated(&old_target, paths);
        if old_target == new_target && source.parent() == destination.parent() {
            continue;
        }
        let mut new_path = if link_path.is_absolute() {
            display(&new_target).replace('\\', "/")
        } else {
            relative_path(destination.parent().unwrap(), &new_target)?
        };
        let original = text
            .get(reference.range.clone())
            .ok_or("Markdown 引用定位无效")?;
        let (original_path, suffix) = reference_suffix(original, &reference.destination);
        if reference
            .destination
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
        {
            let url = url::Url::from_file_path(&new_target).map_err(|_| "无法创建本地文件链接")?;
            let replacement = format!("{url}{suffix}");
            if replacement != original {
                edits.push((reference.range, replacement));
            }
            continue;
        }
        if original_path.starts_with("./") && !new_path.starts_with('.') {
            new_path.insert_str(0, "./");
        }
        if original_path.ends_with('/') && !new_path.ends_with('/') {
            new_path.push('/');
        }
        let angle = reference.range.start > 0 && text.as_bytes()[reference.range.start - 1] == b'<';
        let replacement = format!(
            "{}{suffix}",
            encode_destination(&new_path, original_path, angle)
        );
        if replacement != original {
            edits.push((reference.range, replacement));
        }
    }
    edits.sort_by_key(|(range, _)| range.start);
    if edits.windows(2).any(|pair| pair[0].0.end > pair[1].0.start) {
        return Err("Markdown 引用范围重叠，未移动任何文件".to_owned());
    }
    let count = edits.len();
    let mut output = text.to_owned();
    for (range, replacement) in edits.into_iter().rev() {
        output.replace_range(range, &replacement);
    }
    Ok((output, count))
}

fn same_permissions(left: &Permissions, right: &Permissions) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        left.mode() == right.mode()
    }
    #[cfg(not(unix))]
    {
        left.readonly() == right.readonly()
    }
}

fn verify_file(path: &Path, snapshot: &FileSnapshot) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("文件已变化 {}：{error}", path.display()))?;
    if !metadata.is_file()
        || !same_permissions(&metadata.permissions(), &snapshot.permissions)
        || fs::read(path).map_err(|error| error.to_string())? != snapshot.bytes
    {
        return Err(format!(
            "文件在预览后被外部修改，请重新预览：{}",
            path.display()
        ));
    }
    Ok(())
}

fn verify_plan(plan: &MovePlan, destination_present: bool) -> Result<(), String> {
    let mut markdown = Vec::new();
    collect_markdown(&plan.paths.root, &mut markdown)?;
    if destination_present {
        markdown.retain(|path| !path.starts_with(&plan.paths.destination));
    }
    markdown.sort();
    if markdown != plan.markdown_paths {
        return Err("工作区 Markdown 文件列表已变化，请重新预览".to_owned());
    }
    let mut source = Vec::new();
    collect_source(&plan.paths.source, &mut source)?;
    if source != plan.source_entries {
        return Err("待移动内容已变化，请重新预览".to_owned());
    }
    for (path, snapshot) in &plan.files {
        ensure_plain_path(&plan.paths.root, path)?;
        verify_file(path, snapshot)?;
    }
    for (path, permissions) in &plan.directories {
        if !same_permissions(
            permissions,
            &fs::symlink_metadata(path)
                .map_err(|error| error.to_string())?
                .permissions(),
        ) {
            return Err(format!("目录权限已变化，请重新预览：{}", path.display()));
        }
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8], permissions: &Permissions) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("无法创建 {}：{error}", path.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法写入 {}：{error}", path.display()))?;
    file.set_permissions(permissions.clone())
        .map_err(|error| format!("无法设置文件权限：{error}"))
}

fn copy_destination(
    plan: &MovePlan,
    root_file: Option<fs::File>,
    completed: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    let mut root_file = root_file;
    for (index, entry) in plan.source_entries.iter().enumerate() {
        let target = relocated(&entry.path, &plan.paths);
        ensure_plain_path(&plan.paths.root, target.parent().ok_or("目标没有父目录")?)?;
        if entry.directory {
            if index > 0 {
                fs::create_dir(&target)
                    .map_err(|error| format!("无法创建目标目录 {}：{error}", target.display()))?;
            }
        } else {
            let original = &plan.files[&entry.path];
            let bytes = plan
                .changes
                .iter()
                .find(|change| change.path == entry.path)
                .map(|change| &change.bytes)
                .unwrap_or(&original.bytes);
            if index == 0 {
                let mut file = root_file.take().ok_or("目标文件未创建")?;
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .and_then(|_| file.set_permissions(original.permissions.clone()))
                    .map_err(|error| format!("无法写入目标文件：{error}"))?;
            } else {
                write_new(&target, bytes, &original.permissions)?;
            }
            completed.insert(target);
        }
    }
    for (path, permissions) in plan.directories.iter().rev() {
        fs::set_permissions(relocated(path, &plan.paths), permissions.clone())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn verify_source_backup(plan: &MovePlan, backup: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    collect_source(backup, &mut entries)?;
    if entries.len() != plan.source_entries.len()
        || entries
            .iter()
            .zip(&plan.source_entries)
            .any(|(actual, expected)| {
                actual.directory != expected.directory
                    || actual.path.strip_prefix(backup).ok()
                        != expected.path.strip_prefix(&plan.paths.source).ok()
            })
    {
        return Err("待移动目录在执行期间被修改".to_owned());
    }
    for entry in plan.source_entries.iter().filter(|entry| !entry.directory) {
        verify_file(
            &if entry.path == plan.paths.source {
                backup.to_path_buf()
            } else {
                backup.join(entry.path.strip_prefix(&plan.paths.source).unwrap())
            },
            &plan.files[&entry.path],
        )?;
    }
    Ok(())
}

fn verify_destination(plan: &MovePlan) -> Result<(), String> {
    let mut entries = Vec::new();
    collect_source(&plan.paths.destination, &mut entries)?;
    if entries.len() != plan.source_entries.len() {
        return Err("目标目录在执行期间被修改".to_owned());
    }
    for (entry, original) in entries.iter().zip(&plan.source_entries) {
        if entry.directory != original.directory
            || entry.path != relocated(&original.path, &plan.paths)
        {
            return Err("目标内容在执行期间被修改".to_owned());
        }
        if !entry.directory {
            let expected = plan
                .changes
                .iter()
                .find(|change| change.path == original.path)
                .map(|change| &change.bytes)
                .unwrap_or(&plan.files[&original.path].bytes);
            if fs::read(&entry.path).map_err(|error| error.to_string())? != *expected {
                return Err(format!(
                    "目标文件在执行期间被修改：{}",
                    entry.path.display()
                ));
            }
        }
    }
    Ok(())
}

// Rollback removes only bytes produced by this transaction. An external writer
// may have touched a published path after it was created; preserve those bytes.
fn destination_can_be_removed(plan: &MovePlan, completed: &BTreeSet<PathBuf>) -> bool {
    let mut actual = Vec::new();
    if collect_source(&plan.paths.destination, &mut actual).is_err() {
        return false;
    }
    actual.iter().all(|entry| {
        let Some(original) = plan
            .source_entries
            .iter()
            .find(|original| relocated(&original.path, &plan.paths) == entry.path)
        else {
            return false;
        };
        if original.directory != entry.directory {
            return false;
        }
        if entry.directory {
            return true;
        }
        let expected = plan
            .changes
            .iter()
            .find(|change| change.path == original.path)
            .map(|change| &change.bytes)
            .unwrap_or(&plan.files[&original.path].bytes);
        fs::read(&entry.path).is_ok_and(|bytes| {
            if completed.contains(&entry.path) {
                bytes == *expected
            } else {
                expected.starts_with(&bytes)
            }
        })
    })
}

fn remove_created(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|error| format!("无法清理 {}：{error}", path.display()))
}

fn restore_backup(backup: &Path, original: &Path) -> Result<(), String> {
    if fs::symlink_metadata(original).is_ok() {
        return Err(format!(
            "恢复路径已被占用；原文件保存在 {}",
            backup.display()
        ));
    }
    fs::rename(backup, original)
        .map_err(|error| format!("原文件保存在 {}，恢复失败：{error}", backup.display()))
}

fn commit_plan(
    plan: MovePlan,
    mut before_write: impl FnMut(usize) -> Result<(), String>,
) -> Result<WorkspaceMoveResult, String> {
    verify_plan(&plan, false)?;
    let transaction = plan
        .paths
        .source
        .parent()
        .unwrap()
        .join(format!(".otterdive-move-{}", unique_id()));
    fs::create_dir(&transaction).map_err(|error| format!("无法创建恢复目录：{error}"))?;
    let source_backup = transaction.join("source");
    let mut source_moved = false;
    let mut destination_created = false;
    let mut replaced: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut completed = BTreeSet::new();
    let operation = (|| {
        // Reserve the destination with create_new/create_dir, never rename over it.
        // A failure before reservation must not remove somebody else's target.
        ensure_plain_path(
            &plan.paths.root,
            plan.paths.destination.parent().ok_or("目标没有父目录")?,
        )?;
        let root_entry = &plan.source_entries[0];
        let root_file = if root_entry.directory {
            fs::create_dir(&plan.paths.destination)
                .map_err(|error| format!("目标已存在或无法创建：{error}"))?;
            None
        } else {
            Some(
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&plan.paths.destination)
                    .map_err(|error| format!("目标已存在或无法创建：{error}"))?,
            )
        };
        destination_created = true;
        copy_destination(&plan, root_file, &mut completed)?;
        // Recheck after copying: large images can take time, and originals must
        // not be removed if an editor saved during preparation.
        verify_plan(&plan, true)?;
        fs::rename(&plan.paths.source, &source_backup)
            .map_err(|error| format!("无法移动原路径：{error}"))?;
        source_moved = true;
        verify_source_backup(&plan, &source_backup)?;
        for (index, change) in plan
            .changes
            .iter()
            .filter(|change| !change.path.starts_with(&plan.paths.source))
            .enumerate()
        {
            before_write(index)?;
            ensure_plain_path(&plan.paths.root, &change.path)?;
            verify_file(&change.path, &plan.files[&change.path])?;
            let backup = transaction.join(format!("reference-{index}"));
            fs::rename(&change.path, &backup)
                .map_err(|error| format!("无法备份引用文档：{error}"))?;
            replaced.push((change.path.clone(), backup));
            write_new(
                &change.path,
                &change.bytes,
                &plan.files[&change.path].permissions,
            )?;
            completed.insert(change.path.clone());
        }
        verify_source_backup(&plan, &source_backup)?;
        verify_destination(&plan)?;
        for (path, backup) in &replaced {
            verify_file(backup, &plan.files[path])?;
            let expected = plan
                .changes
                .iter()
                .find(|change| &change.path == path)
                .unwrap();
            if !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
                || fs::read(path).map_err(|error| error.to_string())? != expected.bytes
            {
                return Err(format!("引用文档在执行期间被修改：{}", path.display()));
            }
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = operation {
        let mut rollback_errors = Vec::new();
        let mut preserved = Vec::new();
        for (index, (path, backup)) in replaced.iter().enumerate().rev() {
            if fs::symlink_metadata(path).is_ok() {
                let expected = &plan
                    .changes
                    .iter()
                    .find(|change| &change.path == path)
                    .unwrap()
                    .bytes;
                let own_bytes = fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
                    && fs::read(path).is_ok_and(|bytes| {
                        if completed.contains(path) {
                            bytes == *expected
                        } else {
                            expected.starts_with(&bytes)
                        }
                    });
                if !own_bytes {
                    let external = transaction.join(format!("external-change-{index}"));
                    if let Err(error) = fs::rename(path, &external) {
                        rollback_errors
                            .push(format!("无法保留外部修改 {}：{error}", path.display()));
                        continue;
                    }
                    preserved.push(display(&external));
                }
            }
            if let Err(error) = remove_created(path).and_then(|_| restore_backup(backup, path)) {
                rollback_errors.push(error);
            }
        }
        if source_moved {
            if let Err(error) = restore_backup(&source_backup, &plan.paths.source) {
                rollback_errors.push(error);
            }
        }
        if destination_created {
            if !destination_can_be_removed(&plan, &completed) {
                preserved.push(display(&plan.paths.destination));
            } else if let Err(error) = remove_created(&plan.paths.destination) {
                rollback_errors.push(error);
            }
        }
        if rollback_errors.is_empty() {
            if preserved.is_empty() {
                let _ = remove_created(&transaction);
            }
            return Err(format!(
                "移动失败，已恢复原文件：{error}{}",
                if preserved.is_empty() {
                    String::new()
                } else {
                    format!("；执行期间的外部修改已保留在 {}", preserved.join("、"))
                }
            ));
        }
        return Err(format!(
            "移动失败：{error}；恢复未完全完成：{}",
            rollback_errors.join("；")
        ));
    }
    let mut warnings = Vec::new();
    if let Err(error) = remove_created(&transaction) {
        warnings.push(format!(
            "移动已完成；旧内容的恢复副本保留在 {}：{error}",
            transaction.display()
        ));
    }
    Ok(WorkspaceMoveResult {
        root: display(&plan.paths.root),
        path: display(&plan.paths.source),
        destination: display(&plan.paths.destination),
        changed_documents: changed_documents(&plan),
        reference_count: plan.changes.iter().map(|change| change.references).sum(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use otterdive_core::{document::EncodingKind, fs::encode_text};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "otterdive-move-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }

        fn request(&self, path: &str, destination: &str) -> WorkspaceMoveRequest {
            WorkspaceMoveRequest {
                root: self.0.display().to_string(),
                path: self.0.join(path).display().to_string(),
                destination: self.0.join(destination).display().to_string(),
            }
        }

        fn move_entry(&self, path: &str, destination: &str) -> WorkspaceMoveResult {
            let request = self.request(path, destination);
            let preview = preview_move(request.clone()).unwrap();
            apply_move(request, preview.token).unwrap()
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn moving_a_folder_updates_inbound_links_and_moved_documents_outbound_links() {
        let dir = TestDirectory::new();
        dir.write(
            "readme.md",
            "[guide](docs/guide.md#intro)\n\n[ref]: docs/next.mdx 'title'\n",
        );
        dir.write(
            "docs/guide.md",
            "![x](../assets/p.png \"caption\")\n[next](next.mdx)\n",
        );
        dir.write("docs/next.mdx", "# next\n");
        dir.write("assets/p.png", [0, 1, 2, 3]);
        fs::create_dir(dir.0.join("archive")).unwrap();
        let result = dir.move_entry("docs", "archive/docs");
        assert_eq!(result.reference_count, 3);
        assert!(!dir.0.join("docs").exists());
        assert_eq!(
            fs::read_to_string(dir.0.join("readme.md")).unwrap(),
            "[guide](archive/docs/guide.md#intro)\n\n[ref]: archive/docs/next.mdx 'title'\n"
        );
        assert_eq!(
            fs::read_to_string(dir.0.join("archive/docs/guide.md")).unwrap(),
            "![x](../../assets/p.png \"caption\")\n[next](next.mdx)\n"
        );
        assert_eq!(fs::read(dir.0.join("assets/p.png")).unwrap(), [0, 1, 2, 3]);
    }

    #[test]
    fn only_reference_destinations_change_and_code_or_remote_urls_remain_exact() {
        let dir = TestDirectory::new();
        dir.write("old file.md", "# file\n");
        dir.write("index.markdown", "[a](old%20file.md#x \"a title\")\r\n\r\n[b]: <old file.md> 'b title'\r\n`[code](old%20file.md)`\r\n```md\r\n[code](old%20file.md)\r\n```\r\n[web](https://example.com/old%20file.md)\r\n");
        let result = dir.move_entry("old file.md", "new file.md");
        assert_eq!(result.reference_count, 2);
        assert_eq!(
            fs::read_to_string(dir.0.join("index.markdown")).unwrap(),
            "[a](new%20file.md#x \"a title\")\r\n\r\n[b]: <new file.md> 'b title'\r\n`[code](old%20file.md)`\r\n```md\r\n[code](old%20file.md)\r\n```\r\n[web](https://example.com/old%20file.md)\r\n"
        );
    }

    #[test]
    fn utf16_and_bom_and_line_endings_survive_link_updates() {
        for encoding in [
            EncodingKind::Utf8Bom,
            EncodingKind::Utf16Le,
            EncodingKind::Utf16Be,
            EncodingKind::Gbk,
        ] {
            let dir = TestDirectory::new();
            dir.write("旧.md", "# source\n");
            let original = "前言\r\n[链接](旧.md)\r\n";
            dir.write("index.md", encode_text(original, encoding).unwrap());
            dir.move_entry("旧.md", "新.md");
            assert_eq!(
                fs::read(dir.0.join("index.md")).unwrap(),
                encode_text("前言\r\n[链接](新.md)\r\n", encoding).unwrap()
            );
        }
    }

    #[test]
    fn stale_previews_reject_modified_or_new_markdown_files_without_moving_anything() {
        for add_file in [false, true] {
            let dir = TestDirectory::new();
            dir.write("a.md", "# a\n");
            dir.write("index.md", "[a](a.md)\n");
            let request = dir.request("a.md", "b.md");
            let preview = preview_move(request.clone()).unwrap();
            if add_file {
                dir.write("added.md", "[a](a.md)\n");
            } else {
                dir.write("index.md", "external edit\n");
            }
            assert!(apply_move(request, preview.token).is_err());
            assert!(dir.0.join("a.md").exists());
            assert!(!dir.0.join("b.md").exists());
        }
    }

    #[test]
    fn an_existing_target_and_root_escape_and_directory_cycles_are_rejected() {
        let dir = TestDirectory::new();
        dir.write("a.md", "# a");
        dir.write("b.md", "# b");
        fs::create_dir_all(dir.0.join("docs/child")).unwrap();
        for request in [
            dir.request("a.md", "b.md"),
            dir.request("a.md", "../escape.md"),
            dir.request(".", "renamed"),
            dir.request("docs", "docs/child/new"),
        ] {
            assert!(preview_move(request).is_err());
        }
        if dir.0.join("DOCS").is_dir() {
            assert!(preview_move(dir.request("docs", "DOCS/child/new")).is_err());
        }
        assert_eq!(fs::read_to_string(dir.0.join("b.md")).unwrap(), "# b");
    }

    #[test]
    fn a_midway_failure_restores_the_source_and_every_modified_reference() {
        let dir = TestDirectory::new();
        dir.write("source.md", "# source\n");
        dir.write("b.md", "[source](source.md)\n");
        dir.write("c.md", "[source](source.md)\n");
        let plan =
            build_plan(validate_paths(&dir.request("source.md", "target.md")).unwrap()).unwrap();
        let result = commit_plan(plan, |index| {
            if index == 1 {
                Err("injected second document write failure".to_owned())
            } else {
                Ok(())
            }
        });
        assert!(result.unwrap_err().contains("已恢复原文件"));
        assert_eq!(
            fs::read_to_string(dir.0.join("source.md")).unwrap(),
            "# source\n"
        );
        for path in ["b.md", "c.md"] {
            assert_eq!(
                fs::read_to_string(dir.0.join(path)).unwrap(),
                "[source](source.md)\n"
            );
        }
        assert!(!dir.0.join("target.md").exists());
        assert!(!fs::read_dir(&dir.0).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".otterdive-move-")
        }));
    }

    #[test]
    fn moved_binary_changes_invalidate_the_plan_and_tokens_are_single_use() {
        let dir = TestDirectory::new();
        dir.write("docs/a.md", "# a\n");
        dir.write("docs/picture.png", [0, 1, 2]);
        let request = dir.request("docs", "renamed");
        let preview = preview_move(request.clone()).unwrap();
        dir.write("docs/picture.png", [0, 1, 3]);
        assert!(apply_move(request.clone(), preview.token.clone()).is_err());
        assert!(apply_move(request.clone(), preview.token).is_err());
        assert!(dir.0.join("docs/a.md").exists());
        assert_eq!(fs::read(dir.0.join("docs/picture.png")).unwrap(), [0, 1, 3]);
        let preview = preview_move(request.clone()).unwrap();
        let token = preview.token;
        apply_move(request.clone(), token.clone()).unwrap();
        assert!(apply_move(request, token).is_err());
    }

    #[test]
    fn escaped_parentheses_and_suffixes_survive_renaming() {
        let dir = TestDirectory::new();
        dir.write("a(1).md", "# source\n");
        dir.write(
            "index.md",
            "[source](a\\(1\\).md?download=1&amp;x=2#heading \"caption\")\n",
        );
        dir.move_entry("a(1).md", "b(2).md");
        assert_eq!(
            fs::read_to_string(dir.0.join("index.md")).unwrap(),
            "[source](b\\(2\\).md?download=1&amp;x=2#heading \"caption\")\n"
        );
    }

    #[test]
    fn a_target_created_after_preview_is_never_overwritten() {
        let dir = TestDirectory::new();
        dir.write("a.md", "source");
        let request = dir.request("a.md", "b.md");
        let preview = preview_move(request.clone()).unwrap();
        dir.write("b.md", "external target");
        assert!(apply_move(request, preview.token).is_err());
        assert_eq!(fs::read_to_string(dir.0.join("a.md")).unwrap(), "source");
        assert_eq!(
            fs::read_to_string(dir.0.join("b.md")).unwrap(),
            "external target"
        );
    }

    #[test]
    fn rollback_preserves_external_edits_to_a_published_reference() {
        let dir = TestDirectory::new();
        dir.write("source.md", "# source\n");
        dir.write("b.md", "[source](source.md)\n");
        dir.write("c.md", "[source](source.md)\n");
        let plan =
            build_plan(validate_paths(&dir.request("source.md", "target.md")).unwrap()).unwrap();
        let result = commit_plan(plan, |index| {
            if index == 1 {
                dir.write("b.md", "external editor changes\n");
                Err("injected failure".to_owned())
            } else {
                Ok(())
            }
        });
        assert!(result.unwrap_err().contains("外部修改已保留"));
        assert_eq!(
            fs::read_to_string(dir.0.join("b.md")).unwrap(),
            "[source](source.md)\n"
        );
        assert!(dir.0.join("source.md").exists());
        assert!(!dir.0.join("target.md").exists());
        let recovery = fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| protected(path))
            .unwrap();
        assert_eq!(
            fs::read_to_string(recovery.join("external-change-0")).unwrap(),
            "external editor changes\n"
        );
    }

    #[test]
    fn rollback_does_not_delete_a_destination_modified_by_an_external_editor() {
        let dir = TestDirectory::new();
        dir.write("source.md", "# source\n");
        dir.write("index.md", "[source](source.md)\n");
        let plan =
            build_plan(validate_paths(&dir.request("source.md", "target.md")).unwrap()).unwrap();
        let result = commit_plan(plan, |_| {
            dir.write("target.md", "external destination edit\n");
            Err("injected failure".to_owned())
        });
        assert!(result.unwrap_err().contains("外部修改已保留"));
        assert_eq!(
            fs::read_to_string(dir.0.join("source.md")).unwrap(),
            "# source\n"
        );
        assert_eq!(
            fs::read_to_string(dir.0.join("target.md")).unwrap(),
            "external destination edit\n"
        );
        assert_eq!(
            fs::read_to_string(dir.0.join("index.md")).unwrap(),
            "[source](source.md)\n"
        );
    }

    #[test]
    fn rollback_preserves_external_truncation_even_when_it_matches_an_output_prefix() {
        let dir = TestDirectory::new();
        dir.write("source.md", "# source\n");
        dir.write("b.md", "[source](source.md)\n");
        dir.write("c.md", "[source](source.md)\n");
        let plan =
            build_plan(validate_paths(&dir.request("source.md", "target.md")).unwrap()).unwrap();
        let result = commit_plan(plan, |index| {
            if index == 1 {
                dir.write("b.md", "[source](");
                dir.write("target.md", "# source");
                Err("injected failure".to_owned())
            } else {
                Ok(())
            }
        });
        assert!(result.unwrap_err().contains("外部修改已保留"));
        assert_eq!(
            fs::read_to_string(dir.0.join("source.md")).unwrap(),
            "# source\n"
        );
        assert_eq!(
            fs::read_to_string(dir.0.join("target.md")).unwrap(),
            "# source"
        );
        assert_eq!(
            fs::read_to_string(dir.0.join("b.md")).unwrap(),
            "[source](source.md)\n"
        );
        let recovery = fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| protected(path))
            .unwrap();
        assert_eq!(
            fs::read_to_string(recovery.join("external-change-0")).unwrap(),
            "[source]("
        );
    }

    #[test]
    fn file_urls_keep_their_scheme_and_update_their_percent_encoded_target() {
        let dir = TestDirectory::new();
        dir.write("old file.md", "# source\n");
        let source = fs::canonicalize(dir.0.join("old file.md")).unwrap();
        let old_url = url::Url::from_file_path(&source).unwrap();
        dir.write(
            "index.md",
            format!("[source]({old_url}#heading \"title\")\n"),
        );
        dir.move_entry("old file.md", "new file.md");
        let new_url =
            url::Url::from_file_path(source.parent().unwrap().join("new file.md")).unwrap();
        assert_eq!(
            fs::read_to_string(dir.0.join("index.md")).unwrap(),
            format!("[source]({new_url}#heading \"title\")\n")
        );
    }

    #[test]
    fn markdown_backslash_separators_follow_the_frontend_resource_path_semantics() {
        let dir = TestDirectory::new();
        dir.write("assets/pic.png", [0, 1, 2]);
        dir.write("index.md", "![x](assets\\pic.png)\n");
        dir.move_entry("assets", "moved");
        assert_eq!(
            fs::read_to_string(dir.0.join("index.md")).unwrap(),
            "![x](moved/pic.png)\n"
        );
    }

    #[test]
    fn renaming_to_a_quote_character_keeps_html_attributes_valid() {
        let dir = TestDirectory::new();
        dir.write("a.md", "# source\n");
        dir.write("index.md", "[angle](<a.md>)\n\n<a href='a.md'>read</a>\n");
        dir.move_entry("a.md", "new&copy;'name.md");
        assert_eq!(
            fs::read_to_string(dir.0.join("index.md")).unwrap(),
            "[angle](<new%26copy;%27name.md>)\n\n<a href='new%26copy;%27name.md'>read</a>\n"
        );
    }

    #[test]
    fn html_entity_fragment_delimiters_preserve_their_original_semantics() {
        let dir = TestDirectory::new();
        dir.write("a.md", "# source\n");
        dir.write("index.md", "<a href=\"a.md&#35;heading\">read</a>\n");
        dir.move_entry("a.md", "final.md");
        assert_eq!(
            fs::read_to_string(dir.0.join("index.md")).unwrap(),
            "<a href=\"final.md&#35;heading\">read</a>\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_sources_and_destination_ancestors_cannot_escape_the_workspace() {
        use std::os::unix::fs::symlink;
        let dir = TestDirectory::new();
        let outside = TestDirectory::new();
        dir.write("a.md", "# a");
        symlink(&outside.0, dir.0.join("outside")).unwrap();
        assert!(preview_move(dir.request("a.md", "outside/a.md")).is_err());
        symlink(dir.0.join("a.md"), dir.0.join("alias.md")).unwrap();
        assert!(preview_move(dir.request("alias.md", "b.md")).is_err());
    }
}
