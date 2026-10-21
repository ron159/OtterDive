//! Bounded editor pages. Only positions/fingerprints are cached, never full file text.
use crate::workbench::{FileChunk, ReadChunkRequest, read_chunk};
use otterdive_core::{EncodingKind, LineEnding, analyse::CancellationToken};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const PAGE_BYTES: usize = 256 * 1024;
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Position {
    line: usize,
    column: usize,
    after_cr: bool,
}
impl Position {
    fn start() -> Self {
        Self {
            line: 1,
            column: 1,
            after_cr: false,
        }
    }
    fn advance(&self, text: &str) -> Self {
        let mut p = self.clone();
        for c in text.chars() {
            match c {
                '\r' => {
                    p.line += 1;
                    p.column = 1;
                    p.after_cr = true;
                }
                '\n' => {
                    if !p.after_cr {
                        p.line += 1;
                    }
                    p.column = 1;
                    p.after_cr = false;
                }
                _ => {
                    p.column += c.len_utf16();
                    p.after_cr = false;
                }
            }
        }
        p
    }
    fn before(&self, line: usize, column: usize) -> bool {
        (self.line, self.column) <= (line, column)
    }
}
#[derive(Clone)]
struct Checkpoint {
    offset: u64,
    position: Position,
    previous: Option<(u64, String, String, String)>,
}
impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            offset: 0,
            position: Position::start(),
            previous: None,
        }
    }
}
#[derive(Default)]
pub struct PagedDocumentService {
    positions: Mutex<HashMap<String, BTreeMap<u64, Checkpoint>>>,
    runs: Mutex<HashMap<String, CancellationToken>>,
    cancelled: Mutex<VecDeque<String>>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub path: String,
    pub encoding: String,
    pub revision: String,
    pub request_id: String,
    pub offset: Option<u64>,
    pub line: Option<usize>,
    pub column: Option<usize>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    pub text: String,
    pub start_offset: u64,
    pub next_offset: u64,
    pub size: u64,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub has_more: bool,
    pub warning: Option<String>,
}

pub fn metadata(
    path: &Path,
    forced: Option<EncodingKind>,
) -> Result<crate::app::DocumentDto, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("只能打开普通文本文件".into());
    }
    let mut sample = Vec::new();
    file.by_ref()
        .take(64 * 1024)
        .read_to_end(&mut sample)
        .map_err(|e| e.to_string())?;
    // A probe can end within an otherwise valid UTF-8 character or UTF-16 surrogate pair.
    if meta.len() > sample.len() as u64 {
        if let Err(error) = std::str::from_utf8(&sample) {
            if error.error_len().is_none() {
                sample.truncate(error.valid_up_to());
            }
        }
        let little = sample.starts_with(&[0xff, 0xfe]) || forced == Some(EncodingKind::Utf16Le);
        let big = sample.starts_with(&[0xfe, 0xff]) || forced == Some(EncodingKind::Utf16Be);
        if little || big {
            sample.truncate(sample.len() / 2 * 2);
            if sample.len() >= 2 {
                let pair = [sample[sample.len() - 2], sample[sample.len() - 1]];
                let unit = if little {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                };
                if (0xd800..=0xdbff).contains(&unit) {
                    sample.truncate(sample.len() - 2);
                }
            }
        }
    }
    let decoded =
        otterdive_core::fs::inspect_text_sample(sample, forced).map_err(|e| e.to_string())?;
    Ok(crate::app::DocumentDto {
        decode_had_errors: decoded.had_errors,
        disk_revision: None,
        title: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: Some(path.to_string_lossy().into_owned()),
        text: String::new(),
        encoding: crate::app::encoding_label(decoded.encoding).into(),
        line_ending: crate::app::line_ending_label(LineEnding::detect(&decoded.text)).into(),
        file_size: meta.len() as usize,
        read_only: true,
        read_only_reason: Some("大文件按需读取（只读）；全文搜索和 Analyse 仍覆盖整个文件".into()),
        language: "plaintext".into(),
        large_file: true,
        paged: true,
    })
}

impl PagedDocumentService {
    pub(crate) fn begin(&self, id: &str) -> Result<CancellationToken, String> {
        // Registration and cancellation use the same lock order, including pre-cancelled requests.
        let mut runs = self.runs.lock().map_err(|e| e.to_string())?;
        let mut queue = self.cancelled.lock().map_err(|e| e.to_string())?;
        let token = CancellationToken::new();
        if let Some(index) = queue.iter().position(|pending| pending == id) {
            queue.remove(index);
            token.cancel();
        }
        runs.insert(id.into(), token.clone());
        Ok(token)
    }
    pub(crate) fn cancel(&self, id: String) {
        if let Ok(runs) = self.runs.lock() {
            if let Some(token) = runs.get(&id) {
                token.cancel();
                return;
            }
            if let Ok(mut queue) = self.cancelled.lock() {
                queue.push_back(id);
                while queue.len() > 256 {
                    queue.pop_front();
                }
            }
        }
    }
    pub(crate) fn read(
        &self,
        request: &PageRequest,
        cancel: &CancellationToken,
    ) -> Result<DocumentPage, String> {
        let path = PathBuf::from(&request.path);
        crate::file_revision::ensure_revision(&path, &request.revision)?;
        let info = metadata(&path, Some(crate::app::parse_encoding(&request.encoding)))?;
        let key = format!("{}|{}|{}", request.path, request.encoding, request.revision);
        let target = (
            request.line.unwrap_or(1).max(1),
            request.column.unwrap_or(1).max(1),
        );
        let mut checkpoint = self
            .positions
            .lock()
            .map_err(|e| e.to_string())?
            .get(&key)
            .and_then(|positions| {
                positions
                    .values()
                    .rev()
                    .find(|entry| {
                        if request.line.is_some() {
                            entry.position.before(target.0, target.1)
                        } else {
                            entry.offset <= request.offset.unwrap_or(0)
                                && entry.offset < info.file_size as u64
                        }
                    })
                    .cloned()
            })
            .unwrap_or_default();
        loop {
            if cancel.is_cancelled() {
                return Err("读取已取消".into());
            }
            let previous = checkpoint.previous.as_ref();
            let chunk = read_chunk(ReadChunkRequest {
                path: request.path.clone(),
                offset: Some(checkpoint.offset),
                limit: Some(PAGE_BYTES),
                tail: false,
                encoding: Some(crate::app::chunk_encoding(&request.encoding).into()),
                previous_size: previous.map(|p| p.0),
                previous_identity: previous.map(|p| p.1.clone()),
                previous_revision: previous.map(|p| p.2.clone()),
                previous_fingerprint: previous.map(|p| p.3.clone()),
            })?;
            if chunk.reset {
                return Err("文件已变化，请重新打开".into());
            }
            if chunk.text.contains('\0') {
                return Err("不支持将二进制内容作为文本读取".into());
            }
            if chunk.next_offset <= checkpoint.offset && chunk.has_more {
                return Err("编码边界未前进，请重新选择文件编码".into());
            }
            let end = checkpoint.position.advance(&chunk.text);
            let contains = if request.line.is_some() {
                !end.before(target.0, target.1) || !chunk.has_more
            } else {
                request.offset.unwrap_or(0) < chunk.next_offset || !chunk.has_more
            };
            self.remember(&key, &chunk, end.clone())?;
            if contains {
                if cancel.is_cancelled() {
                    return Err("读取已取消".into());
                }
                crate::file_revision::ensure_revision(&path, &request.revision)?;
                let text = if checkpoint.position.after_cr {
                    chunk
                        .text
                        .strip_prefix('\n')
                        .unwrap_or(&chunk.text)
                        .to_owned()
                } else {
                    chunk.text
                };
                return Ok(DocumentPage {
                    text,
                    start_offset: chunk.start_offset,
                    next_offset: chunk.next_offset,
                    size: chunk.size,
                    start_line: checkpoint.position.line,
                    start_column: checkpoint.position.column,
                    end_line: end.line,
                    end_column: end.column,
                    has_more: chunk.has_more,
                    warning: chunk.warning,
                });
            }
            checkpoint = Checkpoint {
                offset: chunk.next_offset,
                position: end,
                previous: Some((
                    chunk.size,
                    chunk.identity,
                    chunk.revision,
                    chunk.fingerprint,
                )),
            };
        }
    }
    fn remember(&self, key: &str, chunk: &FileChunk, position: Position) -> Result<(), String> {
        let mut all = self.positions.lock().map_err(|e| e.to_string())?;
        if !all.contains_key(key) && all.len() >= 16 {
            all.clear();
        }
        let positions = all.entry(key.into()).or_default();
        if positions.len() >= 4096 {
            positions.clear();
        }
        positions.insert(
            chunk.next_offset,
            Checkpoint {
                offset: chunk.next_offset,
                position,
                previous: Some((
                    chunk.size,
                    chunk.identity.clone(),
                    chunk.revision.clone(),
                    chunk.fingerprint.clone(),
                )),
            },
        );
        Ok(())
    }
}

#[tauri::command]
pub async fn read_document_page(
    request: PageRequest,
    service: tauri::State<'_, std::sync::Arc<PagedDocumentService>>,
) -> Result<DocumentPage, String> {
    let service = std::sync::Arc::clone(service.inner());
    let cancel = service.begin(&request.request_id)?;
    let id = request.request_id.clone();
    let worker_service = service.clone();
    let outcome =
        tauri::async_runtime::spawn_blocking(move || worker_service.read(&request, &cancel))
            .await
            .map_err(|e| e.to_string());
    if let Ok(mut runs) = service.runs.lock() {
        runs.remove(&id);
    }
    outcome?
}
#[tauri::command]
pub fn cancel_document_page(
    request_id: String,
    service: tauri::State<'_, std::sync::Arc<PagedDocumentService>>,
) {
    service.cancel(request_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    struct Temp(PathBuf);
    impl Temp {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "otterdive-page-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            Self(path)
        }
        fn request(&self, encoding: &str) -> PageRequest {
            PageRequest {
                path: self.0.to_string_lossy().into(),
                encoding: encoding.into(),
                revision: crate::file_revision::revision(&self.0).unwrap(),
                request_id: "test".into(),
                offset: Some(0),
                line: None,
                column: None,
            }
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    #[test]
    fn cancellation_and_registration_are_atomic_in_both_orders() {
        let service = std::sync::Arc::new(PagedDocumentService::default());
        for n in 0..128 {
            let id = format!("race-{n}");
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let other = service.clone();
            let other_id = id.clone();
            let other_barrier = barrier.clone();
            let thread = std::thread::spawn(move || {
                other_barrier.wait();
                other.cancel(other_id);
            });
            barrier.wait();
            let token = service.begin(&id).unwrap();
            thread.join().unwrap();
            assert!(token.is_cancelled());
            service.runs.lock().unwrap().remove(&id);
        }
    }
    #[test]
    fn normal_open_32_33_and_128_mib_is_metadata_only_and_tail_is_reachable() {
        for mib in [32, 33, 128] {
            let file = Temp::new(&format!("{mib}m"));
            let mut writer = File::create(&file.0).unwrap();
            let block = b"normal text line\r\n".repeat(4096);
            let mut written = 0;
            while written < mib * 1024 * 1024 {
                writer.write_all(&block).unwrap();
                written += block.len();
            }
            writer.write_all(b"TAIL_TARGET\r\n").unwrap();
            drop(writer);
            let started = std::time::Instant::now();
            let info = metadata(&file.0, None).unwrap();
            assert!(info.paged && info.read_only && info.text.is_empty());
            assert!(info.file_size >= mib * 1024 * 1024);
            let service = PagedDocumentService::default();
            let cancel = CancellationToken::new();
            let mut request = file.request("UTF-8");
            let first = service.read(&request, &cancel).unwrap();
            assert!(first.text.len() <= PAGE_BYTES);
            request.offset = Some(info.file_size as u64 - 1);
            let tail = service.read(&request, &cancel).unwrap();
            assert!(tail.text.contains("TAIL_TARGET"));
            assert!(!tail.has_more);
            assert!(tail.text.len() <= PAGE_BYTES);
            eprintln!(
                "{mib} MiB metadata + first/tail page {:?}; page bytes {}",
                started.elapsed(),
                tail.text.len()
            );
        }
    }
    #[test]
    fn utf8_utf16_and_gbk_survive_page_boundaries_crlf_and_long_lines() {
        for (encoding, text) in [
            ("UTF-8", "甲😀乙\r\n".repeat(50_000)),
            ("UTF-16 Little Endian", "甲😀乙\r\n".repeat(50_000)),
            ("GBK", "甲乙丙\r\n".repeat(70_000)),
        ] {
            let file = Temp::new("encoding");
            let bytes = match encoding {
                "UTF-16 Little Endian" => [
                    vec![0xff, 0xfe],
                    text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
                ]
                .concat(),
                "GBK" => encoding_rs::GBK.encode(&text).0.into_owned(),
                _ => text.as_bytes().to_vec(),
            };
            std::fs::write(&file.0, &bytes).unwrap();
            let mut request = file.request(encoding);
            let service = PagedDocumentService::default();
            let cancel = CancellationToken::new();
            let mut combined = String::new();
            loop {
                let page = service.read(&request, &cancel).unwrap();
                combined.push_str(&page.text);
                if !page.has_more {
                    break;
                }
                request.offset = Some(page.next_offset);
            }
            // A CRLF split is one source newline, not a phantom extra source line.
            assert_eq!(
                combined.replace("\r\n", "\n").replace('\r', "\n"),
                text.replace("\r\n", "\n")
            );
            request.line = Some(45_000);
            request.column = Some(2);
            request.offset = None;
            let page = service.read(&request, &cancel).unwrap();
            assert!(page.start_line <= 45_000 && page.end_line >= 45_000);
        }
        let file = Temp::new("longline");
        std::fs::write(&file.0, "甲😀".repeat(200_000)).unwrap();
        let service = PagedDocumentService::default();
        let mut req = file.request("UTF-8");
        let a = service.read(&req, &CancellationToken::new()).unwrap();
        req.offset = Some(a.next_offset);
        let b = service.read(&req, &CancellationToken::new()).unwrap();
        assert_eq!(b.start_line, 1);
        assert_eq!(b.start_column, a.end_column);
        assert!(b.text.len() <= PAGE_BYTES);
        assert!(!b.text.contains('\u{fffd}'));
    }
    #[test]
    fn cancelled_or_changed_source_never_returns_a_page_and_zip_remains_rejected() {
        let file = Temp::new("cancel");
        std::fs::write(&file.0, b"normal text\n").unwrap();
        let request = file.request("UTF-8");
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            PagedDocumentService::default()
                .read(&request, &cancel)
                .unwrap_err()
                .contains("取消")
        );
        std::fs::write(&file.0, b"source changed\n").unwrap();
        assert!(
            PagedDocumentService::default()
                .read(&request, &CancellationToken::new())
                .is_err()
        );
        std::fs::write(&file.0, b"PK\x05\x06\0\0\0\0").unwrap();
        assert!(metadata(&file.0, None).is_err());
        assert!(metadata(&file.0, Some(EncodingKind::Utf16Le)).is_err());
    }
}
