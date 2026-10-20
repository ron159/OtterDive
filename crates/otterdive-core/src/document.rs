use crate::fs::{decode_owned_bytes, decode_owned_bytes_with_encoding, encode_text};
use crate::search::{ReplaceOutcome, SearchOptions, apply_replace_all};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

pub const EDITABLE_FILE_LIMIT_BYTES: u64 = 20 * 1024 * 1024;
/// Bound both disk input and decoded IPC/model payloads. Larger logs use the chunk reader.
pub const DOCUMENT_FILE_LIMIT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodingKind {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Gbk,
    Big5,
    ShiftJis,
    Windows1252,
}

impl EncodingKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf8Bom => "UTF-8 BOM",
            Self::Utf16Le => "UTF-16 LE",
            Self::Utf16Be => "UTF-16 BE",
            Self::Gbk => "GBK",
            Self::Big5 => "Big5",
            Self::ShiftJis => "Shift-JIS",
            Self::Windows1252 => "Windows-1252",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
    Cr,
}

impl LineEnding {
    pub fn detect(text: &str) -> Self {
        if text.contains("\r\n") {
            Self::Crlf
        } else if text.contains('\r') {
            Self::Cr
        } else {
            Self::Lf
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Lf => "LF",
            Self::Crlf => "CRLF",
            Self::Cr => "CR",
        }
    }
}

#[derive(Debug, Clone)]
pub struct DocumentMeta {
    pub decode_had_errors: bool,
    pub path: Option<PathBuf>,
    pub encoding: EncodingKind,
    pub line_ending: LineEnding,
    pub file_size: usize,
    pub read_only: bool,
    pub read_only_reason: Option<String>,
}

impl Default for DocumentMeta {
    fn default() -> Self {
        Self {
            decode_had_errors: false,
            path: None,
            encoding: EncodingKind::Utf8,
            line_ending: LineEnding::Lf,
            file_size: 0,
            read_only: false,
            read_only_reason: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Document {
    pub title: String,
    pub text: String,
    pub meta: DocumentMeta,
    dirty: bool,
    saved_text: String,
    undo_stack: Vec<String>,
    redo_stack: Vec<String>,
}

#[derive(Debug)]
pub struct LoadedDocument {
    pub title: String,
    pub text: String,
    pub meta: DocumentMeta,
}

impl LoadedDocument {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        Self::open_with_encoding(path, None)
    }

    pub fn open_with_encoding(
        path: impl AsRef<Path>,
        encoding: Option<EncodingKind>,
    ) -> io::Result<Self> {
        let path = path.as_ref();
        let metadata = fs::metadata(path)?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "只能打开普通文本文件",
            ));
        }
        ensure_document_size(metadata.len())?;
        let file = fs::File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "只能打开普通文本文件",
            ));
        }
        ensure_document_size(metadata.len())?;
        // A file can grow after metadata is read. Never use an unbounded fs::read here.
        let mut bytes = Vec::new();
        file.take(DOCUMENT_FILE_LIMIT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        ensure_document_size(bytes.len() as u64)?;
        let forced_utf16 = matches!(
            encoding,
            Some(EncodingKind::Utf16Le | EncodingKind::Utf16Be)
        );
        if crate::fs::has_binary_signature(&bytes)
            || (!forced_utf16 && crate::fs::is_probably_binary(&bytes))
        {
            return Err(binary_document_error());
        }
        let file_size = bytes.len();
        let decoded = match encoding {
            Some(encoding) => decode_owned_bytes_with_encoding(bytes, encoding),
            None => decode_owned_bytes(bytes),
        };
        ensure_document_size(decoded.text.len() as u64)?;
        // Check the complete decoded text, including UTF-16 and binary tails beyond the sample.
        if decoded.text.contains('\0') {
            return Err(binary_document_error());
        }
        let title = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_owned();
        let line_ending = LineEnding::detect(&decoded.text);
        let (mut read_only, mut read_only_reason) = read_only_state(
            metadata.permissions().readonly(),
            file_size as u64,
            EDITABLE_FILE_LIMIT_BYTES,
        );
        if decoded.had_errors {
            read_only = true;
            read_only_reason =
                Some("解码含有无效字符，请选择正确编码重新打开；禁止覆盖原文件".to_owned());
        }
        Ok(Self {
            title,
            text: decoded.text,
            meta: DocumentMeta {
                decode_had_errors: decoded.had_errors,
                path: Some(path.to_path_buf()),
                encoding: decoded.encoding,
                line_ending,
                file_size,
                read_only,
                read_only_reason,
            },
        })
    }
}

fn ensure_document_size(size: u64) -> io::Result<()> {
    if size > DOCUMENT_FILE_LIMIT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "文件或解码后的文本超过 32 MiB 安全载入上限；请使用“文件 → 打开大文件 / 实时日志…”分块阅读",
        ));
    }
    Ok(())
}

fn binary_document_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "不支持将 ZIP 或二进制文件作为文本打开；原文件未修改",
    )
}

impl Document {
    pub fn untitled(index: usize) -> Self {
        Self {
            title: format!("Untitled-{index}"),
            text: String::new(),
            meta: DocumentMeta::default(),
            dirty: false,
            saved_text: String::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let loaded = LoadedDocument::open(path)?;
        let saved_text = loaded.text.clone();
        Ok(Self {
            title: loaded.title,
            saved_text,
            text: loaded.text,
            meta: loaded.meta,
            dirty: false,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        })
    }

    pub fn save(&mut self) -> io::Result<()> {
        if self.meta.read_only {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                self.read_only_reason(),
            ));
        }
        let Some(path) = self.meta.path.clone() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "document has no path",
            ));
        };
        self.save_as(path)
    }

    pub fn save_as(&mut self, path: impl AsRef<Path>) -> io::Result<()> {
        let path = path.as_ref();
        if self.meta.decode_had_errors {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "解码含有无效字符，请选择正确编码重新打开；原文件未修改",
            ));
        }
        let bytes = encode_text(&self.text, self.meta.encoding)?;
        if path.exists() {
            crate::fs::write_text_atomically(path, &self.text, self.meta.encoding)?;
        } else {
            fs::write(path, &bytes)?;
        }
        self.meta.path = Some(path.to_path_buf());
        self.meta.file_size = bytes.len();
        self.meta.line_ending = LineEnding::detect(&self.text);
        let file_read_only = fs::metadata(path)
            .map(|metadata| metadata.permissions().readonly())
            .unwrap_or(false);
        let (read_only, read_only_reason) = read_only_state(
            file_read_only,
            bytes.len() as u64,
            EDITABLE_FILE_LIMIT_BYTES,
        );
        self.meta.read_only = read_only;
        self.meta.read_only_reason = read_only_reason;
        self.title = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_owned();
        self.saved_text = self.text.clone();
        self.dirty = false;
        Ok(())
    }

    pub fn mark_changed(&mut self, previous: String) {
        if self.meta.read_only {
            if previous != self.text {
                self.text = previous;
            }
            return;
        }
        if previous != self.text {
            self.undo_stack.push(previous);
            self.redo_stack.clear();
            self.dirty = self.text != self.saved_text;
            self.meta.line_ending = LineEnding::detect(&self.text);
        }
    }

    pub fn set_text(&mut self, text: String) {
        let previous = std::mem::replace(&mut self.text, text);
        self.mark_changed(previous);
    }

    pub fn replace_all(
        &mut self,
        query: &str,
        replacement: &str,
        options: &SearchOptions,
    ) -> Result<ReplaceOutcome, crate::search::SearchError> {
        if self.meta.read_only {
            return Err(crate::search::SearchError::ReadOnlyDocument(
                self.read_only_reason(),
            ));
        }
        let previous = self.text.clone();
        let outcome = apply_replace_all(&self.text, query, replacement, options)?;
        if outcome.count > 0 {
            self.text = outcome.text.clone();
            self.mark_changed(previous);
        }
        Ok(outcome)
    }

    pub fn undo(&mut self) -> bool {
        if self.meta.read_only {
            return false;
        }
        let Some(prev) = self.undo_stack.pop() else {
            return false;
        };
        self.redo_stack
            .push(std::mem::replace(&mut self.text, prev));
        self.dirty = self.text != self.saved_text;
        self.meta.line_ending = LineEnding::detect(&self.text);
        true
    }

    pub fn redo(&mut self) -> bool {
        if self.meta.read_only {
            return false;
        }
        let Some(next) = self.redo_stack.pop() else {
            return false;
        };
        self.undo_stack
            .push(std::mem::replace(&mut self.text, next));
        self.dirty = self.text != self.saved_text;
        self.meta.line_ending = LineEnding::detect(&self.text);
        true
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn read_only_reason(&self) -> String {
        self.meta
            .read_only_reason
            .clone()
            .unwrap_or_else(|| "文件处于只读保护".to_owned())
    }

    pub fn line_count(&self) -> usize {
        self.text.lines().count().max(1)
    }

    pub fn char_count(&self) -> usize {
        self.text.chars().count()
    }

    pub fn byte_size(&self) -> usize {
        self.text.len()
    }
}

fn read_only_state(
    file_read_only: bool,
    file_size: u64,
    editable_limit: u64,
) -> (bool, Option<String>) {
    let mut reasons = Vec::new();
    if file_read_only {
        reasons.push("文件系统只读".to_owned());
    }
    if file_size > editable_limit {
        reasons.push(format!(
            "超过 {} MB 编辑保护阈值",
            editable_limit / 1024 / 1024
        ));
    }
    if reasons.is_empty() {
        (false, None)
    } else {
        (true, Some(reasons.join("；")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input_fixture(label: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "otterdive-open-{}-{}-{label}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn document_open_rejects_zip_and_binary_even_with_a_text_extension() {
        for bytes in [
            b"PK\x05\x06\0\0\0\0".as_slice(),
            b"plain\0binary".as_slice(),
        ] {
            let path = input_fixture("binary.txt", bytes);
            let result = LoadedDocument::open(&path);
            fs::remove_file(path).unwrap();
            assert!(result.is_err(), "binary input was accepted as a document");
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn document_open_rejects_oversized_files_before_loading() {
        let path = input_fixture("oversize", b"");
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(32 * 1024 * 1024 + 1)
            .unwrap();
        let result = LoadedDocument::open(&path);
        fs::remove_file(path).unwrap();
        assert!(result.is_err(), "oversized file was fully loaded");
        assert!(result.unwrap_err().to_string().contains("分块阅读"));
    }

    #[test]
    fn explicit_encoding_cannot_bypass_binary_or_size_guards() {
        let zip = input_fixture("zip", b"PK\x03\x04\0\0\0\0");
        for encoding in [
            EncodingKind::Utf8,
            EncodingKind::Windows1252,
            EncodingKind::Utf16Le,
        ] {
            assert!(LoadedDocument::open_with_encoding(&zip, Some(encoding)).is_err());
        }
        fs::remove_file(zip).unwrap();
        let path = input_fixture("oversize-reopen", b"");
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(DOCUMENT_FILE_LIMIT_BYTES + 1)
            .unwrap();
        assert!(LoadedDocument::open_with_encoding(&path, Some(EncodingKind::Utf8)).is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn text_encodings_empty_files_and_misleading_extensions_remain_supported() {
        let text = "普通文本\n第二行\r\n";
        for encoding in [
            EncodingKind::Utf8,
            EncodingKind::Utf8Bom,
            EncodingKind::Utf16Le,
            EncodingKind::Utf16Be,
            EncodingKind::Gbk,
            EncodingKind::Big5,
        ] {
            let path = input_fixture("text.zip", &encode_text(&text, encoding).unwrap());
            let doc = LoadedDocument::open_with_encoding(&path, Some(encoding)).unwrap();
            assert_eq!(doc.text, text);
            assert!(!doc.meta.read_only);
            if matches!(
                encoding,
                EncodingKind::Utf8
                    | EncodingKind::Utf8Bom
                    | EncodingKind::Utf16Le
                    | EncodingKind::Utf16Be
            ) {
                assert_eq!(LoadedDocument::open(&path).unwrap().text, text);
            }
            fs::remove_file(path).unwrap();
        }
        // Explicit UTF-16 is also used to recover text without a BOM.
        let path = input_fixture("utf16-no-bom", b"h\0i\0");
        assert_eq!(
            LoadedDocument::open_with_encoding(&path, Some(EncodingKind::Utf16Le))
                .unwrap()
                .text,
            "hi"
        );
        fs::remove_file(path).unwrap();
        let empty = input_fixture("empty", b"");
        assert_eq!(LoadedDocument::open(&empty).unwrap().text, "");
        fs::remove_file(empty).unwrap();
    }

    #[test]
    fn binary_tail_and_utf16_binary_are_rejected_after_decoding() {
        let mut bytes = vec![b'a'; 8192];
        bytes.push(0);
        for bytes in [bytes, vec![0xff, 0xfe, b'a', 0, 0, 0]] {
            let path = input_fixture("binary-tail", &bytes);
            assert!(LoadedDocument::open(&path).is_err());
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn decoded_size_is_bounded_even_when_utf16_expands() {
        let text = "汉".repeat(12 * 1024 * 1024);
        let path = input_fixture(
            "expanding",
            &encode_text(&text, EncodingKind::Utf16Le).unwrap(),
        );
        assert!(fs::metadata(&path).unwrap().len() < DOCUMENT_FILE_LIMIT_BYTES);
        let error = LoadedDocument::open(&path).unwrap_err();
        assert!(error.to_string().contains("32 MiB"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn non_regular_files_are_rejected_without_reading() {
        assert_eq!(
            LoadedDocument::open(std::env::temp_dir())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        #[cfg(unix)]
        assert_eq!(
            LoadedDocument::open("/dev/zero").unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn loaded_document_reads_a_dto_ready_snapshot() {
        let path = std::env::temp_dir().join(format!(
            "otterdive-loaded-document-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, "first\r\nsecond").unwrap();

        let loaded = LoadedDocument::open(&path).unwrap();

        assert_eq!(loaded.title, path.file_name().unwrap().to_string_lossy());
        assert_eq!(loaded.text, "first\r\nsecond");
        assert_eq!(loaded.meta.line_ending, LineEnding::Crlf);
        assert_eq!(loaded.meta.file_size, 13);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn undo_back_to_saved_text_clears_dirty_flag() {
        let mut doc = Document::untitled(1);
        doc.set_text("abc".to_owned());
        assert!(doc.is_dirty());
        assert!(doc.undo());
        assert!(!doc.is_dirty());
    }

    #[test]
    fn redo_after_clean_undo_marks_dirty_again() {
        let mut doc = Document::untitled(1);
        doc.set_text("abc".to_owned());
        assert!(doc.undo());
        assert!(!doc.is_dirty());
        assert!(doc.redo());
        assert!(doc.is_dirty());
    }

    #[test]
    fn read_only_document_rejects_replace() {
        let mut doc = Document::untitled(1);
        doc.meta.read_only = true;
        doc.meta.read_only_reason = Some("测试只读".to_owned());
        doc.text = "otterdive".to_owned();

        let err = doc
            .replace_all("otterdive", "OTTERDIVE", &SearchOptions::default())
            .unwrap_err();

        assert_eq!(err.to_string(), "文档只读：测试只读");
        assert_eq!(doc.text, "otterdive");
    }
}
