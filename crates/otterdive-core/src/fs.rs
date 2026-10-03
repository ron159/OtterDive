use crate::document::EncodingKind;
use crate::search::{
    ReplaceOutcome, SearchError, SearchMatcher, SearchOptions, TextMatch,
    bounded_replace_with_matcher,
};
use encoding_rs::{BIG5, GBK, SHIFT_JIS, UTF_8, WINDOWS_1252};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone)]
pub struct DecodedText {
    pub had_errors: bool,
    pub text: String,
    pub encoding: EncodingKind,
}

#[derive(Debug, Clone)]
pub struct FileHit {
    pub path: PathBuf,
    pub matches: Vec<TextMatch>,
    pub encoding: EncodingKind,
}

#[derive(Debug, Clone)]
pub struct FileReplacePreview {
    pub original_bytes: Vec<u8>,
    pub original_text: String,
    pub path: PathBuf,
    pub outcome: ReplaceOutcome,
    pub encoding: EncodingKind,
}

#[derive(Debug, Default, Clone)]
pub struct DirectorySearchReport {
    pub hits: Vec<FileHit>,
    pub skipped: Vec<String>,
    pub files_scanned: usize,
    pub elapsed_ms: u64,
}

/// Reuse the file buffer for ordinary UTF-8 instead of copying the entire file.
/// BOMs and legacy encodings keep the same decoding behavior as `decode_bytes`.
pub fn decode_owned_bytes(bytes: Vec<u8>) -> DecodedText {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
    {
        return decode_bytes(&bytes);
    }
    match String::from_utf8(bytes) {
        Ok(text) => DecodedText {
            text,
            encoding: EncodingKind::Utf8,
            had_errors: false,
        },
        Err(error) => decode_bytes(error.as_bytes()),
    }
}

pub fn decode_owned_bytes_with_encoding(bytes: Vec<u8>, encoding: EncodingKind) -> DecodedText {
    if matches!(encoding, EncodingKind::Utf8 | EncodingKind::Utf8Bom)
        && !bytes.starts_with(&[0xEF, 0xBB, 0xBF])
    {
        match String::from_utf8(bytes) {
            Ok(text) => DecodedText {
                text,
                encoding,
                had_errors: false,
            },
            Err(error) => decode_bytes_with_encoding(error.as_bytes(), encoding),
        }
    } else {
        decode_bytes_with_encoding(&bytes, encoding)
    }
}

pub fn decode_bytes(bytes: &[u8]) -> DecodedText {
    let encoding = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        EncodingKind::Utf8Bom
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        EncodingKind::Utf16Le
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        EncodingKind::Utf16Be
    } else if std::str::from_utf8(bytes).is_ok() {
        EncodingKind::Utf8
    } else {
        EncodingKind::Gbk
    };
    decode_bytes_with_encoding(bytes, encoding)
}

pub fn decode_bytes_with_encoding(bytes: &[u8], encoding: EncodingKind) -> DecodedText {
    let (text, had_errors) = match encoding {
        EncodingKind::Utf16Le | EncodingKind::Utf16Be => {
            let little_endian = encoding == EncodingKind::Utf16Le;
            let bom: &[u8] = if little_endian {
                &[0xFF, 0xFE]
            } else {
                &[0xFE, 0xFF]
            };
            decode_utf16(bytes.strip_prefix(bom).unwrap_or(bytes), little_endian)
        }
        _ => {
            let bytes = if matches!(encoding, EncodingKind::Utf8 | EncodingKind::Utf8Bom) {
                bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
            } else {
                bytes
            };
            // Explicit selection must not be silently overridden by another BOM.
            let (text, errors) = codec(encoding).decode_without_bom_handling(bytes);
            (text.into_owned(), errors)
        }
    };
    DecodedText {
        text,
        encoding,
        had_errors,
    }
}

fn codec(encoding: EncodingKind) -> &'static encoding_rs::Encoding {
    match encoding {
        EncodingKind::Gbk => GBK,
        EncodingKind::Big5 => BIG5,
        EncodingKind::ShiftJis => SHIFT_JIS,
        EncodingKind::Windows1252 => WINDOWS_1252,
        _ => UTF_8,
    }
}

/// Refuse legacy-encoding substitutions rather than silently writing HTML entities.
pub fn encode_text(text: &str, encoding: EncodingKind) -> io::Result<Vec<u8>> {
    let bytes = match encoding {
        EncodingKind::Utf8 => text.as_bytes().to_vec(),
        EncodingKind::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            out
        }
        EncodingKind::Utf16Le | EncodingKind::Utf16Be => {
            let little_endian = encoding == EncodingKind::Utf16Le;
            let mut out = if little_endian {
                vec![0xFF, 0xFE]
            } else {
                vec![0xFE, 0xFF]
            };
            for unit in text.encode_utf16() {
                out.extend_from_slice(&if little_endian {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            out
        }
        _ => {
            let (bytes, _, had_errors) = codec(encoding).encode(text);
            if had_errors {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "内容包含 {} 无法表示的字符；请选择 UTF-8 后保存，原文件未修改",
                        encoding.label()
                    ),
                ));
            }
            bytes.into_owned()
        }
    };
    Ok(bytes)
}

pub fn search_directory(
    root: impl AsRef<Path>,
    query: &str,
    options: &SearchOptions,
) -> Result<DirectorySearchReport, SearchError> {
    let started = Instant::now();
    let root = root.as_ref();
    let mut report = DirectorySearchReport::default();
    let matcher = SearchMatcher::new(query, options)?;
    let file_glob = FileGlobMatcher::new(&options.file_glob);
    let skip_dirs = parse_list(&options.skip_dirs);
    let mut walker = WalkDir::new(root);
    if !options.recursive {
        walker = walker.max_depth(1);
    }
    for entry in walker
        .into_iter()
        .filter_entry(|entry| should_visit(entry, options, &skip_dirs))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                report.skipped.push(err.to_string());
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !file_glob.matches(path) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(err) => {
                report.skipped.push(format!("{}: {err}", path.display()));
                continue;
            }
        };
        if metadata.len() > options.max_file_size {
            report
                .skipped
                .push(format!("{}: file too large", path.display()));
            continue;
        }
        report.files_scanned += 1;
        match read_text(path) {
            Ok(decoded) => {
                let matches = matcher.find_all(&decoded.text);
                if !matches.is_empty() {
                    report.hits.push(FileHit {
                        path: path.to_path_buf(),
                        matches,
                        encoding: decoded.encoding,
                    });
                }
            }
            Err(err) => report.skipped.push(format!("{}: {err}", path.display())),
        }
    }
    report.elapsed_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
    Ok(report)
}

/// Batches contain only new hits/skips; counters are cumulative. Returning false stops delivery.
#[derive(Debug, Default)]
pub struct StreamSearchSummary {
    pub cancelled: bool,
    pub truncated: bool,
    pub files_scanned: usize,
    pub elapsed_ms: u64,
}

pub fn search_directory_stream(
    root: impl AsRef<Path>,
    query: &str,
    options: &SearchOptions,
    cancel: &crate::analyse::CancellationToken,
    max_results: usize,
    mut emit: impl FnMut(DirectorySearchReport) -> bool,
) -> Result<StreamSearchSummary, SearchError> {
    let started = Instant::now();
    let matcher = SearchMatcher::new(query, options)?;
    let file_glob = FileGlobMatcher::new(&options.file_glob);
    let skip_dirs = parse_list(&options.skip_dirs);
    let mut walker = WalkDir::new(root);
    if !options.recursive {
        walker = walker.max_depth(1);
    }
    let mut summary = StreamSearchSummary::default();
    let mut total = 0;
    for entry in walker
        .into_iter()
        .filter_entry(|entry| should_visit(entry, options, &skip_dirs))
    {
        if cancel.is_cancelled() || summary.truncated {
            break;
        }
        let mut batch = DirectorySearchReport::default();
        let path = match entry {
            Ok(entry) if entry.file_type().is_file() && file_glob.matches(entry.path()) => {
                entry.into_path()
            }
            Ok(_) => continue,
            Err(error) => {
                batch.skipped.push(error.to_string());
                if !emit(batch) {
                    cancel.cancel();
                }
                continue;
            }
        };
        let decoded = fs::metadata(&path).and_then(|meta| {
            if meta.len() > options.max_file_size {
                Err(io::Error::other("文件超过搜索大小限制"))
            } else {
                read_search_text(&path, options.max_file_size, cancel)
            }
        });
        if cancel.is_cancelled() {
            break;
        }
        summary.files_scanned += 1;
        match decoded {
            Err(error) => batch.skipped.push(format!("{}: {error}", path.display())),
            Ok(decoded) => {
                let mut matches = Vec::new();
                matcher.visit_matches(&decoded.text, |hit| {
                    if cancel.is_cancelled() {
                        return false;
                    }
                    if total >= max_results {
                        summary.truncated = true;
                        return false;
                    }
                    matches.push(hit);
                    total += 1;
                    if matches.len() == 128 {
                        let report = DirectorySearchReport {
                            hits: vec![FileHit {
                                path: path.clone(),
                                encoding: decoded.encoding,
                                matches: std::mem::take(&mut matches),
                            }],
                            files_scanned: summary.files_scanned,
                            elapsed_ms: started.elapsed().as_millis() as u64,
                            ..Default::default()
                        };
                        if !emit(report) {
                            cancel.cancel();
                        }
                    }
                    !cancel.is_cancelled()
                });
                if !matches.is_empty() {
                    batch.hits.push(FileHit {
                        path,
                        encoding: decoded.encoding,
                        matches,
                    });
                }
            }
        }
        batch.files_scanned = summary.files_scanned;
        batch.elapsed_ms = started.elapsed().as_millis() as u64;
        if !emit(batch) {
            cancel.cancel();
        }
    }
    summary.cancelled = cancel.is_cancelled();
    summary.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(summary)
}

fn read_search_text(
    path: &Path,
    limit: u64,
    cancel: &crate::analyse::CancellationToken,
) -> io::Result<DecodedText> {
    let mut file = fs::File::open(path)?.take(limit.saturating_add(1));
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "搜索已取消"));
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() as u64 > limit {
            return Err(io::Error::other("文件超过搜索大小限制"));
        }
    }
    if is_probably_binary(&bytes) {
        return Err(io::Error::other("跳过二进制文件"));
    }
    Ok(decode_owned_bytes(bytes))
}

pub fn preview_directory_replace(
    root: impl AsRef<Path>,
    query: &str,
    replacement: &str,
    options: &SearchOptions,
) -> Result<(Vec<FileReplacePreview>, Vec<String>), SearchError> {
    let matcher = SearchMatcher::new(query, options)?;
    let file_glob = FileGlobMatcher::new(&options.file_glob);
    let skip_dirs = parse_list(&options.skip_dirs);
    let mut walker = WalkDir::new(root);
    if !options.recursive {
        walker = walker.max_depth(1);
    }
    let mut previews = Vec::new();
    let mut skipped = Vec::new();
    let mut retained_bytes = 0usize;
    let mut retained_matches = 0usize;
    for entry in walker
        .into_iter()
        .filter_entry(|entry| should_visit(entry, options, &skip_dirs))
    {
        let path = match entry {
            Ok(entry) if entry.file_type().is_file() && file_glob.matches(entry.path()) => {
                entry.into_path()
            }
            Ok(_) => continue,
            Err(error) => {
                skipped.push(error.to_string());
                continue;
            }
        };
        match fs::metadata(&path) {
            Ok(metadata) if metadata.permissions().readonly() => {
                skipped.push(format!("{}: read-only file", path.display()));
                continue;
            }
            Ok(metadata) if metadata.len() > options.max_file_size.min(20 * 1024 * 1024) => {
                skipped.push(format!("{}: file too large", path.display()));
                continue;
            }
            Ok(_) => {}
            Err(err) => {
                skipped.push(format!("{}: {err}", path.display()));
                continue;
            }
        }
        let limit = options.max_file_size.min(20 * 1024 * 1024);
        let snapshot = fs::File::open(&path).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
            Ok(bytes)
        });
        match snapshot {
            Ok(original_bytes) => {
                if original_bytes.len() as u64 > limit || is_probably_binary(&original_bytes) {
                    skipped.push(format!(
                        "{}: 文件大小或类型已变化，请重新预览",
                        path.display()
                    ));
                    continue;
                }
                let decoded = decode_bytes(&original_bytes);
                if decoded.had_errors {
                    skipped.push(format!(
                        "{}: 解码含有无效字符，请先选择正确编码",
                        path.display()
                    ));
                    continue;
                }
                if encode_text(&decoded.text, decoded.encoding).ok().as_deref()
                    != Some(original_bytes.as_slice())
                {
                    skipped.push(format!(
                        "{}: 编码不能无损往返，请先转换为 UTF-8",
                        path.display()
                    ));
                    continue;
                }
                let remaining_bytes = (64usize * 1024 * 1024)
                    .saturating_sub(retained_bytes)
                    .saturating_sub(original_bytes.len())
                    .saturating_sub(decoded.text.len());
                let Some(outcome) = bounded_replace_with_matcher(
                    &decoded.text,
                    replacement,
                    options,
                    &matcher,
                    remaining_bytes,
                    100_000usize.saturating_sub(retained_matches),
                ) else {
                    skipped
                        .push("替换预览达到 64 MB 或 100000 项限制，请缩小范围后继续".to_owned());
                    break;
                };
                if outcome.count > 0 {
                    let size = original_bytes.len()
                        + decoded.text.len()
                        + outcome.text.len()
                        + outcome.replacements.iter().map(String::len).sum::<usize>()
                        + outcome
                            .matches
                            .iter()
                            .map(|mat| mat.line_text.len() + mat.matched_text.len())
                            .sum::<usize>();
                    retained_bytes = retained_bytes.saturating_add(size);
                    retained_matches = retained_matches.saturating_add(outcome.count);
                    if retained_bytes > 64 * 1024 * 1024 || retained_matches > 100_000 {
                        skipped.push(
                            "替换预览达到 64 MB 或 100000 项限制，请缩小范围后继续".to_owned(),
                        );
                        break;
                    }
                    previews.push(FileReplacePreview {
                        original_bytes,
                        original_text: decoded.text,
                        path,
                        outcome,
                        encoding: decoded.encoding,
                    });
                }
            }
            Err(err) => skipped.push(format!("{}: {err}", path.display())),
        }
    }
    Ok((previews, skipped))
}

#[derive(Debug, Clone)]
pub struct ReplaceSelection {
    pub file_id: usize,
    pub match_ids: Vec<usize>,
}

#[derive(Debug)]
pub struct ReplacedFile {
    pub path: PathBuf,
    pub original_bytes: Vec<u8>,
    pub replaced_bytes: Vec<u8>,
    pub count: usize,
}

#[derive(Debug, Default)]
pub struct ReplaceBatch {
    pub files: Vec<ReplacedFile>,
    pub failures: Vec<(PathBuf, String)>,
}

/// Apply only selected matches from an owned preview, never search a second time.
pub fn apply_selected_directory_replace(
    previews: &[FileReplacePreview],
    selections: &[ReplaceSelection],
) -> io::Result<ReplaceBatch> {
    let mut selected =
        std::collections::BTreeMap::<usize, std::collections::BTreeSet<usize>>::new();
    for selection in selections {
        let preview = previews
            .get(selection.file_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "替换文件编号无效"))?;
        for id in &selection.match_ids {
            if *id >= preview.outcome.matches.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "替换匹配编号无效",
                ));
            }
            selected.entry(selection.file_id).or_default().insert(*id);
        }
    }
    let mut batch = ReplaceBatch::default();
    for (file_id, matches) in selected {
        let preview = &previews[file_id];
        let result = (|| {
            let mut text = String::new();
            let mut last = 0;
            for id in &matches {
                let mat = &preview.outcome.matches[*id];
                text.push_str(&preview.original_text[last..mat.range.start]);
                text.push_str(&preview.outcome.replacements[*id]);
                last = mat.range.end;
            }
            text.push_str(&preview.original_text[last..]);
            let replaced_bytes = encode_text(&text, preview.encoding)?;
            replace_bytes_if_unchanged(&preview.path, &preview.original_bytes, &replaced_bytes)?;
            Ok::<_, io::Error>(ReplacedFile {
                path: preview.path.clone(),
                original_bytes: preview.original_bytes.clone(),
                replaced_bytes,
                count: matches.len(),
            })
        })();
        match result {
            Ok(file) => batch.files.push(file),
            Err(error) => batch
                .failures
                .push((preview.path.clone(), error.to_string())),
        }
    }
    Ok(batch)
}

/// Restore successful files only; conflicted files remain available for another undo attempt.
pub fn undo_directory_replace(batch: &mut ReplaceBatch) -> (usize, Vec<(PathBuf, String)>) {
    let mut restored = 0;
    let mut failures = Vec::new();
    batch.files.retain(|file| {
        match replace_bytes_if_unchanged(&file.path, &file.replaced_bytes, &file.original_bytes) {
            Ok(()) => {
                restored += 1;
                false
            }
            Err(error) => {
                failures.push((file.path.clone(), error.to_string()));
                true
            }
        }
    });
    (restored, failures)
}

fn replace_bytes_if_unchanged(path: &Path, expected: &[u8], bytes: &[u8]) -> io::Result<()> {
    if fs::read(path)? != expected {
        return Err(io::Error::other(
            "文件已被外部修改，未执行写入；请重新预览或处理差异",
        ));
    }
    replace_file_atomically(path, bytes)
}

pub fn apply_directory_replace(previews: &[FileReplacePreview]) -> io::Result<usize> {
    let selections = previews
        .iter()
        .enumerate()
        .map(|(file_id, preview)| ReplaceSelection {
            file_id,
            match_ids: (0..preview.outcome.count).collect(),
        })
        .collect::<Vec<_>>();
    let batch = apply_selected_directory_replace(previews, &selections)?;
    if !batch.failures.is_empty() {
        return Err(io::Error::other(format!(
            "部分替换未完成：{}",
            batch
                .failures
                .iter()
                .map(|(path, error)| format!("{}: {error}", path.display()))
                .collect::<Vec<_>>()
                .join("；")
        )));
    }
    Ok(batch.files.iter().map(|file| file.count).sum())
}

pub fn write_text_atomically(path: &Path, text: &str, encoding: EncodingKind) -> io::Result<()> {
    let bytes = encode_text(text, encoding)?;
    replace_file_atomically(path, &bytes)
}

pub fn read_text(path: impl AsRef<Path>) -> io::Result<DecodedText> {
    let bytes = fs::read(path)?;
    if is_probably_binary(&bytes) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "binary file skipped",
        ));
    }
    Ok(decode_owned_bytes(bytes))
}

fn is_probably_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return true;
    }
    let control_count = sample
        .iter()
        .filter(|byte| byte.is_ascii_control() && !matches!(byte, b'\t' | b'\n' | b'\r' | 0x0C))
        .count();
    control_count * 100 > sample.len() * 30
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> (String, bool) {
    let units = bytes.chunks_exact(2).map(|chunk| {
        if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        }
    });
    let mut had_errors = bytes.len() % 2 != 0;
    let mut text: String = char::decode_utf16(units)
        .map(|unit| {
            unit.unwrap_or_else(|_| {
                had_errors = true;
                char::REPLACEMENT_CHARACTER
            })
        })
        .collect();
    if bytes.len() % 2 != 0 {
        text.push(char::REPLACEMENT_CHARACTER);
    }
    (text, had_errors)
}

fn replace_file_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let metadata = fs::metadata(path)?;
    if metadata.permissions().readonly() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "read-only file",
        ));
    }

    let tmp_path = unique_sibling_path(path, "otterdive-tmp");
    let backup_path = unique_sibling_path(path, "otterdive-bak");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::set_permissions(&tmp_path, metadata.permissions())?;

    if let Err(err) = fs::rename(path, &backup_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }

    match fs::rename(&tmp_path, path) {
        Ok(()) => {
            let _ = fs::remove_file(&backup_path);
            Ok(())
        }
        Err(err) => {
            let _ = fs::remove_file(&tmp_path);
            let _ = fs::rename(&backup_path, path);
            Err(err)
        }
    }
}

fn unique_sibling_path(path: &Path, tag: &str) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    for attempt in 0..1000 {
        let candidate = parent.join(format!(
            ".{file_name}.{tag}-{}-{attempt}.tmp",
            std::process::id()
        ));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!(".{file_name}.{tag}-{}.tmp", std::process::id()))
}

fn should_visit(entry: &DirEntry, options: &SearchOptions, skip_dirs: &[String]) -> bool {
    let name = entry.file_name().to_string_lossy();
    if !options.include_hidden && name.starts_with('.') {
        return false;
    }
    if entry.file_type().is_dir() {
        !skip_dirs.iter().any(|dir| dir.eq_ignore_ascii_case(&name))
    } else {
        true
    }
}

fn parse_list(input: &str) -> Vec<String> {
    input
        .split([';', ',', ' '])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

enum FileGlobPattern {
    Extension(String),
    ContainsAll(Vec<String>),
    NameOrExtension(String),
}

struct FileGlobMatcher {
    match_all: bool,
    patterns: Vec<FileGlobPattern>,
}

impl FileGlobMatcher {
    fn new(glob: &str) -> Self {
        let raw_patterns = parse_list(glob);
        let match_all = raw_patterns.is_empty()
            || raw_patterns
                .iter()
                .any(|pattern| pattern == "*.*" || pattern == "*");
        let patterns = if match_all {
            Vec::new()
        } else {
            raw_patterns
                .into_iter()
                .map(|pattern| pattern.to_ascii_lowercase())
                .map(|pattern| {
                    if let Some(extension) = pattern.strip_prefix("*.") {
                        FileGlobPattern::Extension(extension.to_owned())
                    } else if pattern.contains('*') {
                        FileGlobPattern::ContainsAll(
                            pattern
                                .split('*')
                                .filter(|part| !part.is_empty())
                                .map(ToOwned::to_owned)
                                .collect(),
                        )
                    } else {
                        FileGlobPattern::NameOrExtension(pattern)
                    }
                })
                .collect()
        };
        Self {
            match_all,
            patterns,
        }
    }

    fn matches(&self, path: &Path) -> bool {
        if self.match_all {
            return true;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        self.patterns.iter().any(|pattern| match pattern {
            FileGlobPattern::Extension(expected) => extension == *expected,
            FileGlobPattern::ContainsAll(parts) => {
                parts.iter().all(|part| file_name.contains(part))
            }
            FileGlobPattern::NameOrExtension(expected) => {
                file_name == *expected || extension == expected.trim_start_matches('.')
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_bom_roundtrip_keeps_bom() {
        let decoded = decode_bytes(&[0xEF, 0xBB, 0xBF, b'a']);
        assert_eq!(decoded.encoding, EncodingKind::Utf8Bom);
        assert_eq!(
            encode_text(&decoded.text, decoded.encoding).unwrap()[..3],
            [0xEF, 0xBB, 0xBF]
        );
    }

    #[test]
    fn non_recursive_directory_search_skips_nested_files() {
        let root = std::env::temp_dir().join(format!(
            "otterdive-non-recursive-test-{}",
            std::process::id()
        ));
        let nested = root.join("nested");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join("top.txt"), "otterdive").unwrap();
        fs::write(nested.join("inner.txt"), "otterdive").unwrap();

        let options = SearchOptions {
            recursive: false,
            file_glob: "*.txt".to_owned(),
            ..Default::default()
        };
        let report = search_directory(&root, "otterdive", &options).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(report.hits.len(), 1);
        assert!(report.hits[0].path.ends_with("top.txt"));
    }

    #[test]
    fn file_glob_matches_multiple_masks_without_case_sensitivity() {
        let matcher = FileGlobMatcher::new("*.rs; *.MD");

        assert!(matcher.matches(Path::new("main.RS")));
        assert!(matcher.matches(Path::new("README.md")));
        assert!(!matcher.matches(Path::new("package.json")));
    }

    #[test]
    fn directory_search_reports_scanned_files_and_elapsed_time() {
        let root = std::env::temp_dir().join(format!(
            "otterdive-search-report-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("hit.txt"), "otterdive").unwrap();
        fs::write(root.join("miss.txt"), "another editor").unwrap();
        fs::write(root.join("ignored.md"), "otterdive").unwrap();

        let options = SearchOptions {
            file_glob: "*.txt".to_owned(),
            ..Default::default()
        };
        let report = search_directory(&root, "otterdive", &options).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(report.files_scanned, 2);
        assert_eq!(report.hits.len(), 1);
        assert!(report.hits[0].path.ends_with("hit.txt"));
        assert!(report.elapsed_ms < 10_000);
    }

    #[test]
    fn read_text_rejects_probable_binary_files() {
        let path =
            std::env::temp_dir().join(format!("otterdive-binary-test-{}", std::process::id()));
        fs::write(&path, [0, 159, 146, 150, b't', b'e', b'x', b't']).unwrap();
        let err = read_text(&path).unwrap_err();
        fs::remove_file(&path).unwrap();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn replace_preview_skips_readonly_files() {
        let root = std::env::temp_dir().join(format!(
            "otterdive-readonly-preview-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("readonly.txt");
        fs::write(&path, "otterdive").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        let options = SearchOptions {
            file_glob: "*.txt".to_owned(),
            ..Default::default()
        };
        let (preview, skipped) =
            preview_directory_replace(&root, "otterdive", "OTTERDIVE", &options).unwrap();

        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert!(preview.is_empty());
        assert!(skipped.iter().any(|item| item.contains("read-only")));
    }

    #[test]
    fn directory_replace_writes_via_temp_file() {
        let root = std::env::temp_dir().join(format!(
            "otterdive-atomic-replace-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sample.txt");
        fs::write(&path, "hello otterdive").unwrap();

        let options = SearchOptions {
            file_glob: "*.txt".to_owned(),
            ..Default::default()
        };
        let (preview, skipped) =
            preview_directory_replace(&root, "otterdive", "OTTERDIVE", &options).unwrap();
        assert!(skipped.is_empty());

        let count = apply_directory_replace(&preview).unwrap();

        assert_eq!(count, 1);
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello OTTERDIVE");
        assert!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .contains("otterdive-tmp")
                    && !entry
                        .file_name()
                        .to_string_lossy()
                        .contains("otterdive-bak"))
        );

        fs::remove_dir_all(&root).unwrap();
    }
}
