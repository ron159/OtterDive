use crate::app::{
    DocumentDto, encoding_label, language_from_path, line_ending_label, parse_encoding,
};
use otterdive_core::{EncodingKind, large_file::LargeFile};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

type FileCache = HashMap<String, Arc<Mutex<LargeFile>>>;
#[derive(Default, Clone)]
pub struct LargeFileService(Arc<Mutex<FileCache>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDto {
    pub text: String,
    pub start_line: usize,
    pub next_line: usize,
    pub eof: bool,
    pub truncated: bool,
}

impl LargeFileService {
    fn file(
        &self,
        path: &str,
        encoding: Option<EncodingKind>,
        reload: bool,
    ) -> Result<Arc<Mutex<LargeFile>>, String> {
        let key = format!("{path}:{encoding:?}");
        let mut cache = self.0.lock().map_err(|e| e.to_string())?;
        if !reload {
            if let Some(file) = cache.get(&key) {
                return Ok(file.clone());
            }
        }
        let file = Arc::new(Mutex::new(
            LargeFile::open(Path::new(path), encoding).map_err(|e| e.to_string())?,
        ));
        if cache.len() >= 16 {
            cache.clear();
        }
        cache.insert(key, file.clone());
        Ok(file)
    }

    pub fn open_document(
        &self,
        path: &str,
        encoding: Option<EncodingKind>,
    ) -> Result<DocumentDto, String> {
        let revision = crate::file_revision::revision(Path::new(path))?;
        let file = self.file(path, encoding, true)?;
        let mut file = file.lock().map_err(|e| e.to_string())?;
        let page = page_dto(file.read_page(1).map_err(|e| e.to_string())?);
        crate::file_revision::ensure_revision(Path::new(path), &revision)?;
        Ok(DocumentDto {
            disk_revision: Some(revision),
            title: Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: Some(path.to_owned()),
            text: page.text.clone(),
            encoding: encoding_label(file.encoding).to_owned(),
            line_ending: line_ending_label(file.line_ending).to_owned(),
            file_size: file.size as usize,
            read_only: true,
            read_only_reason: Some(
                "大文件分页浏览（只读）；查找仅针对当前页，全文规则分析请使用 Analyse".to_owned(),
            ),
            language: language_from_path(Some(Path::new(path))),
            large_file: true,
            large_page: Some(page),
        })
    }
}

fn page_dto(page: otterdive_core::large_file::LargePage) -> PageDto {
    PageDto {
        text: page.text,
        start_line: page.start_line,
        next_line: page.next_line,
        eof: page.eof,
        truncated: page.truncated,
    }
}

#[tauri::command]
pub async fn read_large_file_page(
    path: String,
    line: usize,
    encoding: Option<String>,
    reload: bool,
    service: tauri::State<'_, LargeFileService>,
) -> Result<PageDto, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let file = service.file(&path, encoding.as_deref().map(parse_encoding), reload)?;
        let mut file = file.lock().map_err(|e| e.to_string())?;
        file.read_page(line)
            .map(page_dto)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufWriter, Write};

    #[test]
    fn opening_large_document_returns_only_a_read_only_page() {
        let path = std::env::temp_dir().join(format!("otterdive-large-dto-{}", std::process::id()));
        let mut temp = BufWriter::new(std::fs::File::create(&path).unwrap());
        for _ in 0..450_000 {
            temp.write_all(b"2026-09-07 INFO request completed in 10 milliseconds\n")
                .unwrap();
        }
        temp.flush().unwrap();
        drop(temp);
        let service = LargeFileService::default();
        let dto = service.open_document(path.to_str().unwrap(), None).unwrap();
        assert!(dto.read_only && dto.large_file);
        assert!(dto.file_size > 20_000_000);
        assert!(dto.text.len() < 300_000);
        let page = dto.large_page.unwrap();
        assert_eq!(page.start_line, 1);
        assert_eq!(page.next_line, 2001);
        assert!(!page.eof);
        std::fs::remove_file(path).unwrap();
    }
}
