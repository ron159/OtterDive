//! User templates live beside recovery/history, never in the document workspace.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MAX_TEMPLATE_BYTES: usize = 2 * 1024 * 1024;
static NEXT_TEMPLATE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTemplate {
    pub id: String,
    pub title: String,
    pub text: String,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct SaveTemplateRequest {
    pub id: Option<String>,
    pub title: String,
    pub text: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn next_id() -> String {
    format!(
        "user-{}-{}-{}",
        std::process::id(),
        now_ms(),
        NEXT_TEMPLATE.fetch_add(1, Ordering::Relaxed)
    )
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("workbench.db"))
        .map_err(|error| error.to_string())
}

fn db_error(error: rusqlite::Error) -> String {
    format!("模板数据库操作失败：{error}")
}

fn connection(path: &Path) -> Result<Connection, String> {
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
        CREATE TABLE IF NOT EXISTS document_templates (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            text TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
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

fn validate_id(id: &str) -> Result<(), String> {
    if id.starts_with("user-")
        && id.len() <= 100
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err("自定义模板标识无效".to_owned())
    }
}

fn list_templates(path: &Path) -> Result<Vec<DocumentTemplate>, String> {
    let connection = connection(path)?;
    let mut statement = connection.prepare("SELECT id, title, text, updated_at FROM document_templates ORDER BY updated_at DESC, title COLLATE NOCASE, id").map_err(db_error)?;
    statement
        .query_map([], |row| {
            Ok(DocumentTemplate {
                id: row.get(0)?,
                title: row.get(1)?,
                text: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

fn save_template(path: &Path, request: SaveTemplateRequest) -> Result<DocumentTemplate, String> {
    let title = request.title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("模板名称须为 1 到 200 个字符".to_owned());
    }
    if request.text.len() > MAX_TEMPLATE_BYTES {
        return Err("模板内容不能超过 2 MiB".to_owned());
    }
    if let Some(id) = &request.id {
        validate_id(id)?;
    }
    let connection = connection(path)?;
    let updated_at = now_ms();
    let id = if let Some(id) = request.id {
        let changed = connection.execute("UPDATE document_templates SET title = ?1, text = ?2, updated_at = ?3 WHERE id = ?4", params![title, request.text, updated_at, id]).map_err(db_error)?;
        if changed == 0 {
            return Err("模板已不存在，请重新打开模板列表".to_owned());
        }
        id
    } else {
        let id = next_id();
        connection.execute("INSERT INTO document_templates (id, title, text, updated_at) VALUES (?1, ?2, ?3, ?4)", params![id, title, request.text, updated_at]).map_err(db_error)?;
        id
    };
    Ok(DocumentTemplate {
        id,
        title: title.to_owned(),
        text: request.text,
        updated_at,
    })
}

fn delete_template(path: &Path, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let deleted = connection(path)?
        .execute("DELETE FROM document_templates WHERE id = ?1", params![id])
        .map_err(db_error)?;
    if deleted == 0 {
        return Err("模板已不存在，请重新打开模板列表".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn template_list(app: tauri::AppHandle) -> Result<Vec<DocumentTemplate>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_templates(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn template_save(
    app: tauri::AppHandle,
    request: SaveTemplateRequest,
) -> Result<DocumentTemplate, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_template(&path, request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn template_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || delete_template(&path, &id))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> (PathBuf, PathBuf) {
        let directory = std::env::temp_dir().join(format!("otterdive-template-test-{}", next_id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("workbench.db");
        (directory, path)
    }

    fn request(id: Option<String>, title: &str, text: &str) -> SaveTemplateRequest {
        SaveTemplateRequest {
            id,
            title: title.to_owned(),
            text: text.to_owned(),
        }
    }

    #[test]
    fn save_reopen_update_and_delete_preserve_exact_template_content() {
        let (directory, path) = database();
        assert!(list_templates(&path).unwrap().is_empty());
        let raw = "  # {{title}}\r\n\r\n<script>literal</script>\n{{unknown}}\n";
        let saved = save_template(&path, request(None, "  自定义模板  ", raw)).unwrap();
        assert_eq!(saved.title, "自定义模板");
        assert_eq!(saved.text, raw);
        assert_eq!(list_templates(&path).unwrap()[0].text, raw);
        let updated = save_template(
            &path,
            request(Some(saved.id.clone()), "已编辑", "{{date}}\n"),
        )
        .unwrap();
        assert_eq!(updated.id, saved.id);
        assert_eq!(list_templates(&path).unwrap().len(), 1);
        assert_eq!(list_templates(&path).unwrap()[0].text, "{{date}}\n");
        delete_template(&path, &saved.id).unwrap();
        assert!(list_templates(&path).unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_and_missing_identifiers_do_not_modify_existing_templates() {
        let (directory, path) = database();
        let saved = save_template(&path, request(None, "保持", "important")).unwrap();
        assert!(
            save_template(&path, request(Some("../../outside".into()), "攻击", "bad")).is_err()
        );
        assert!(delete_template(&path, "../../outside").is_err());
        assert!(save_template(&path, request(Some("user-missing".into()), "丢失", "bad")).is_err());
        assert!(delete_template(&path, "user-missing").is_err());
        let remaining = list_templates(&path).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, saved.id);
        assert_eq!(remaining[0].text, "important");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn empty_titles_and_oversized_templates_are_rejected_without_touching_saved_data() {
        let (directory, path) = database();
        save_template(&path, request(None, "原文", "safe")).unwrap();
        assert!(save_template(&path, request(None, " \n ", "text")).is_err());
        assert!(save_template(&path, request(None, &"字".repeat(201), "text")).is_err());
        assert!(
            save_template(
                &path,
                request(None, "过大", &"x".repeat(MAX_TEMPLATE_BYTES + 1))
            )
            .is_err()
        );
        assert_eq!(list_templates(&path).unwrap()[0].text, "safe");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn template_queries_treat_titles_and_content_as_data() {
        let (directory, path) = database();
        let title = "'); DROP TABLE document_templates; --";
        let saved = save_template(
            &path,
            request(None, title, "{{title}}\n'\"<img src=x onerror=alert(1)>"),
        )
        .unwrap();
        assert_eq!(list_templates(&path).unwrap()[0].title, title);
        assert_eq!(list_templates(&path).unwrap()[0].text, saved.text);
        save_template(&path, request(None, "仍可使用", "safe")).unwrap();
        assert_eq!(list_templates(&path).unwrap().len(), 2);
        fs::remove_dir_all(directory).unwrap();
    }
}
