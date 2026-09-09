use serde::Serialize;
use std::{fs, io, path::Path, time::UNIX_EPOCH};

// Metadata checks keep polling cheap even for multi-gigabyte log files.
pub fn revision(path: &Path) -> Result<String, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(error) => return Err(error.to_string()),
    };
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    let modified = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos());
    Ok(format!(
        "{}:{modified}:{created:?}:{}",
        metadata.len(),
        metadata.permissions().readonly()
    ))
}

pub fn ensure_revision(path: &Path, expected: &str) -> Result<(), String> {
    if revision(path)? != expected {
        return Err("文件已被外部修改，请重新载入或确认覆盖后再保存".into());
    }
    Ok(())
}

#[derive(Serialize)]
pub struct FileRevision {
    path: String,
    revision: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn file_revisions(paths: Vec<String>) -> Result<Vec<FileRevision>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let result = revision(Path::new(&path));
                FileRevision {
                    path,
                    revision: result.as_ref().ok().cloned(),
                    error: result.err(),
                }
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_edits_replacement_deletion_and_recreation() {
        let path = std::env::temp_dir().join(format!("otterdive-revision-{}", std::process::id()));
        fs::write(&path, "before").unwrap();
        let initial = revision(&path).unwrap();
        assert_eq!(revision(&path).unwrap(), initial);
        // Same-length edits must be detected by timestamp, not just size.
        fs::write(&path, "edited").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1234567890)),
            )
            .unwrap();
        assert!(ensure_revision(&path, &initial).is_err());
        let edited = revision(&path).unwrap();
        let replacement = path.with_extension("replacement");
        fs::write(&replacement, "replacement contents").unwrap();
        fs::remove_file(&path).unwrap();
        fs::rename(replacement, &path).unwrap();
        assert!(ensure_revision(&path, &edited).is_err());
        fs::remove_file(&path).unwrap();
        assert_eq!(revision(&path).unwrap(), "missing");
        fs::write(&path, "recreated").unwrap();
        assert!(ensure_revision(&path, "missing").is_err());
        fs::remove_file(path).unwrap();
    }
}
