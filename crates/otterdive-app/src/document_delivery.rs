use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::ops::Range;
use std::path::{Component, Path, PathBuf};

const MAX_MARKDOWN_BYTES: usize = 40 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES: usize = 256 * 1024 * 1024;
const MAX_BUNDLE_FILES: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceSpan {
    pub range: Range<usize>,
    pub destination: String,
}

/// Byte ranges cover destinations only; code, labels and Markdown formatting stay intact.
/// Destinations are Markdown-unescaped but keep URL percent encoding.
pub fn markdown_reference_spans(text: &str) -> Vec<ReferenceSpan> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS;
    let parser = Parser::new_ext(text, options);
    let mut references = Vec::new();
    for (_, definition) in parser.reference_definitions().iter() {
        let raw = &text[definition.span.clone()];
        let mut index = 0;
        while index + 1 < raw.len() {
            if raw.as_bytes()[index] == b'\\' {
                index += 2;
                continue;
            }
            if &raw.as_bytes()[index..index + 2] == b"]:" {
                break;
            }
            index += 1;
        }
        if index + 1 < raw.len() {
            if let Some((range, _)) = destination_range(raw, index + 2) {
                references.push(ReferenceSpan {
                    range: definition.span.start + range.start..definition.span.start + range.end,
                    destination: definition.dest.to_string(),
                });
            }
        }
    }
    let mut raw_html_tag = None;
    for (event, span) in parser.into_offset_iter() {
        if raw_html_tag.is_some() && !matches!(event, Event::Html(_) | Event::InlineHtml(_)) {
            continue;
        }
        match event {
            Event::Start(
                Tag::Link {
                    link_type: LinkType::Inline,
                    dest_url,
                    ..
                }
                | Tag::Image {
                    link_type: LinkType::Inline,
                    dest_url,
                    ..
                },
            ) => {
                let raw = &text[span.clone()];
                for (index, _) in raw.match_indices("](") {
                    let Some((range, after)) = destination_range(raw, index + 2) else {
                        continue;
                    };
                    let suffix = raw[after..].trim();
                    if !suffix.ends_with(')') {
                        continue;
                    }
                    let title = suffix[..suffix.len() - 1].trim();
                    if !title.is_empty()
                        && !((title.starts_with('"') && title.ends_with('"'))
                            || (title.starts_with('\'') && title.ends_with('\''))
                            || (title.starts_with('(') && title.ends_with(')')))
                    {
                        continue;
                    }
                    if decode_destination(&raw[range.clone()]) != dest_url.as_ref() {
                        continue;
                    }
                    references.push(ReferenceSpan {
                        range: span.start + range.start..span.start + range.end,
                        destination: dest_url.to_string(),
                    });
                    break;
                }
            }
            Event::Start(Tag::Link {
                link_type: LinkType::Autolink,
                dest_url,
                ..
            }) => {
                if text[span.clone()].starts_with('<') && text[span.clone()].ends_with('>') {
                    references.push(ReferenceSpan {
                        range: span.start + 1..span.end - 1,
                        destination: dest_url.to_string(),
                    });
                }
            }
            Event::Html(_) | Event::InlineHtml(_) => {
                html_reference_spans(text, span, &mut raw_html_tag, &mut references)
            }
            _ => {}
        }
    }
    references.sort_by_key(|reference| reference.range.start);
    references.dedup_by(|a, b| a.range == b.range);
    references
}

fn destination_range(raw: &str, mut start: usize) -> Option<(Range<usize>, usize)> {
    let bytes = raw.as_bytes();
    while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    if bytes.get(start) == Some(&b'<') {
        let mut end = start + 1;
        while end < bytes.len() {
            match bytes[end] {
                b'\\' => end += 2,
                b'>' => return Some((start + 1..end, end + 1)),
                b'\r' | b'\n' => return None,
                _ => end += 1,
            }
        }
        return None;
    }
    let mut end = start;
    let mut depth = 0usize;
    while end < bytes.len() {
        match bytes[end] {
            b'\\' => end = (end + 2).min(bytes.len()),
            b'(' => {
                depth += 1;
                end += 1;
            }
            b')' if depth == 0 => break,
            b')' => {
                depth -= 1;
                end += 1;
            }
            byte if byte.is_ascii_whitespace() => break,
            _ => end += 1,
        }
    }
    (end > start).then_some((start..end, end))
}

fn decode_destination(raw: &str) -> String {
    let markdown = format!("[x](<{}>)", raw.replace('>', "\\>"));
    for event in Parser::new(&markdown) {
        if let Event::Start(Tag::Link { dest_url, .. }) = event {
            return dest_url.to_string();
        }
    }
    raw.to_owned()
}

fn html_reference_spans(
    text: &str,
    span: Range<usize>,
    raw_html_tag: &mut Option<String>,
    references: &mut Vec<ReferenceSpan>,
) {
    // Only inspect actual attribute names, never `data-src` or HTML/script text.
    static ATTRIBUTES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r#"(?i)(?:^|\s)(?:href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
        )
        .unwrap()
    });
    let raw = &text[span.clone()];
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if let Some(tag) = raw_html_tag.as_ref() {
            let closing = if tag == "!--" {
                "-->".into()
            } else {
                format!("</{tag}")
            };
            let lower = raw[index..].to_ascii_lowercase();
            let mut search = 0;
            let mut closed_at = None;
            while let Some(found) = lower[search..].find(&closing) {
                let after = search + found + closing.len();
                if tag == "!--"
                    || lower
                        .as_bytes()
                        .get(after)
                        .is_some_and(|byte| *byte == b'>' || byte.is_ascii_whitespace())
                {
                    closed_at = Some(after);
                    break;
                }
                search = after;
            }
            let Some(end) = closed_at else {
                break;
            };
            index += end;
            *raw_html_tag = None;
            continue;
        }
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        if raw[index..].starts_with("<!--") {
            index += 4;
            *raw_html_tag = Some("!--".into());
            continue;
        }
        let start = index;
        index += 1;
        let name_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_alphanumeric) {
            index += 1;
        }
        if index == name_start {
            continue;
        }
        let tag = raw[name_start..index].to_ascii_lowercase();
        let mut quote = None;
        while index < bytes.len() {
            let byte = bytes[index];
            if quote == Some(byte) {
                quote = None;
            } else if quote.is_none() && (byte == b'\'' || byte == b'"') {
                quote = Some(byte);
            } else if quote.is_none() && byte == b'>' {
                break;
            }
            index += 1;
        }
        if index == bytes.len() {
            break;
        }
        for captures in ATTRIBUTES.captures_iter(&raw[start..index]) {
            if let Some(value) = captures
                .get(1)
                .or_else(|| captures.get(2))
                .or_else(|| captures.get(3))
            {
                references.push(ReferenceSpan {
                    range: span.start + start + value.start()..span.start + start + value.end(),
                    destination: decode_destination(value.as_str()),
                });
            }
        }
        index += 1;
        if ["script", "style", "textarea", "pre", "code"].contains(&tag.as_str())
            && !raw[start..index - 1].trim_end().ends_with('/')
        {
            *raw_html_tag = Some(tag);
        }
    }
}

/// Never fall back to permanent removal when the platform cannot use its trash.
pub fn trash_workspace_entry(root: &Path, path: &Path) -> Result<(), String> {
    trash_workspace_entry_with(root, path, |path| {
        trash::delete(path).map_err(|error| format!("移入系统回收站失败，文件未永久删除：{error}"))
    })
}

fn trash_workspace_entry_with(
    root: &Path,
    path: &Path,
    trash: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|error| format!("工作区不可用：{error}"))?;
    if !root.is_dir() || !path.is_absolute() {
        return Err("请选择工作区中的绝对路径".into());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("无法读取待删除条目：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("请在系统文件管理器中处理符号链接，未删除任何文件".into());
    }
    let path = fs::canonicalize(path).map_err(|error| format!("待删除条目不可用：{error}"))?;
    if path == root {
        return Err("不能移除工作区根目录".into());
    }
    if !path.starts_with(&root) {
        return Err("待删除条目不在工作区中".into());
    }
    trash(&path)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownBundleRequest {
    pub text: String,
    pub document_path: Option<String>,
    pub workspace_root: Option<String>,
    pub output_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownBundleResult {
    pub path: String,
    pub file_count: usize,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn export_markdown_bundle(
    request: MarkdownBundleRequest,
) -> Result<MarkdownBundleResult, String> {
    tauri::async_runtime::spawn_blocking(move || build_bundle(request))
        .await
        .map_err(|error| error.to_string())?
}

struct BundleFile {
    path: Option<PathBuf>,
    name: String,
    bytes: Vec<u8>,
}

fn build_bundle(request: MarkdownBundleRequest) -> Result<MarkdownBundleResult, String> {
    if request.text.len() > MAX_MARKDOWN_BYTES {
        return Err("Markdown 超过 40 MiB 打包限制".into());
    }
    let output = PathBuf::from(&request.output_path);
    if !output.is_absolute()
        || !output
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("请选择绝对路径并以 .zip 结尾".into());
    }
    if fs::symlink_metadata(&output).is_ok() {
        return Err("输出文件已存在，请选择新的 ZIP 文件名，原文件未修改".into());
    }
    let parent = output.parent().ok_or("输出目录无效")?;
    if !parent.is_dir() {
        return Err("输出目录不存在".into());
    }
    let workspace = request
        .workspace_root
        .as_deref()
        .map(fs::canonicalize)
        .transpose()
        .map_err(|error| format!("工作区不可用：{error}"))?;
    if workspace.as_ref().is_some_and(|root| !root.is_dir()) {
        return Err("工作区路径不是目录".into());
    }
    let document = request
        .document_path
        .as_deref()
        .map(Path::new)
        .map(|path| {
            if !path.is_absolute() {
                return Err("文档路径必须是绝对路径".to_owned());
            }
            let directory = fs::canonicalize(path.parent().ok_or("文档目录无效")?)
                .map_err(|error| format!("文档目录不可用：{error}"))?;
            Ok(directory.join(path.file_name().ok_or("文档名称无效")?))
        })
        .transpose()?;
    let boundary = match (&document, &workspace) {
        (Some(path), Some(root)) if path.starts_with(root) => Some(root.clone()),
        (Some(path), _) => path.parent().map(Path::to_owned),
        (None, root) => root.clone(),
    };
    let first_name = document
        .as_ref()
        .map(|path| bundle_name(path, boundary.as_ref().unwrap()))
        .transpose()?
        .unwrap_or_else(|| "document.md".into());
    let mut files = vec![BundleFile {
        path: document.clone(),
        name: first_name,
        bytes: request.text.into_bytes(),
    }];
    let mut known = HashMap::new();
    if let Some(path) = document {
        known.insert(path, 0usize);
    }
    let mut names = HashSet::from([files[0].name.to_lowercase()]);
    let mut pending = VecDeque::from([0usize]);
    let mut total_bytes = files[0].bytes.len();
    let mut warnings = Vec::new();
    while let Some(index) = pending.pop_front() {
        let text = String::from_utf8(files[index].bytes.clone())
            .map_err(|_| "Markdown 内容不是有效 UTF-8")?;
        let mut replacements = Vec::new();
        for reference in markdown_reference_spans(&text) {
            let Some((raw_path, suffix)) = local_reference(&reference.destination) else {
                continue;
            };
            let resource = resolve_bundle_resource(
                &raw_path,
                files[index].path.as_deref(),
                boundary.as_deref(),
            );
            let path = match resource {
                Ok(path) => path,
                Err(error) => {
                    warnings.push(format!(
                        "{}：{}（{error}）",
                        files[index].name, reference.destination
                    ));
                    continue;
                }
            };
            let target_index = if let Some(existing) = known.get(&path) {
                *existing
            } else {
                if files.len() >= MAX_BUNDLE_FILES {
                    return Err("引用文件超过 2000 个，已取消打包".into());
                }
                let bytes = match read_attachment(&path) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        warnings.push(format!(
                            "{}：{}（{error}）",
                            files[index].name, reference.destination
                        ));
                        continue;
                    }
                };
                let name =
                    unique_bundle_name(&bundle_name(&path, boundary.as_ref().unwrap())?, &names);
                names.insert(name.to_lowercase());
                let is_markdown = path.extension().is_some_and(|extension| {
                    ["md", "markdown", "mdown", "mkd", "mkdn", "mdx"]
                        .iter()
                        .any(|expected| extension.eq_ignore_ascii_case(expected))
                });
                let bytes = if is_markdown {
                    if bytes.len() > MAX_MARKDOWN_BYTES {
                        return Err(format!("Markdown 超过 40 MiB：{}", path.display()));
                    }
                    let decoded = otterdive_core::fs::decode_bytes(&bytes);
                    if decoded.had_errors {
                        return Err(format!("无法无损解码 Markdown：{}", path.display()));
                    }
                    if decoded.text.len() > MAX_MARKDOWN_BYTES {
                        return Err(format!("解码后的 Markdown 超过 40 MiB：{}", path.display()));
                    }
                    decoded.text.into_bytes()
                } else {
                    bytes
                };
                total_bytes = total_bytes
                    .checked_add(bytes.len())
                    .ok_or("附件总大小溢出")?;
                if total_bytes > MAX_BUNDLE_BYTES {
                    return Err("文档与附件合计超过 256 MiB，已取消打包".into());
                }
                let next = files.len();
                files.push(BundleFile {
                    path: Some(path.clone()),
                    name,
                    bytes,
                });
                known.insert(path, next);
                if is_markdown {
                    pending.push_back(next);
                }
                next
            };
            let relative = relative_bundle_path(&files[index].name, &files[target_index].name);
            let replacement = format!("{relative}{suffix}");
            let attribute = text[..reference.range.start]
                .trim_end()
                .as_bytes()
                .last()
                .is_some_and(|byte| [b'=', b'\'', b'"'].contains(byte));
            let replacement = if attribute {
                replacement
                    .replace('&', "&amp;")
                    .replace('"', "&quot;")
                    .replace('\'', "&#39;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
            } else {
                replacement
            };
            replacements.push((reference.range, replacement));
        }
        let mut rewritten = text;
        for (range, replacement) in replacements.into_iter().rev() {
            rewritten.replace_range(range, &replacement);
        }
        files[index].bytes = rewritten.into_bytes();
    }
    // create_new prevents accidental overwrite even if a file appears during collection.
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .map_err(|error| format!("无法创建 ZIP，输出路径可能已存在：{error}"))?;
    let result = write_bundle(file, &files);
    if let Err(error) = result {
        let _ = fs::remove_file(&output);
        return Err(error);
    }
    warnings.sort();
    warnings.dedup();
    Ok(MarkdownBundleResult {
        path: output.to_string_lossy().into_owned(),
        file_count: files.len(),
        warnings,
    })
}

fn local_reference(destination: &str) -> Option<(String, String)> {
    let destination = destination.trim();
    if destination.is_empty()
        || destination.starts_with('#')
        || destination.starts_with('?')
        || destination.starts_with("//")
        || destination.starts_with("\\\\")
    {
        return None;
    }
    let split = destination.find(['?', '#']).unwrap_or(destination.len());
    let (path, suffix) = destination.split_at(split);
    let windows_drive = path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    if !windows_drive
        && path.split_once(':').is_some_and(|(scheme, _)| {
            scheme
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ['+', '-', '.'].contains(&ch))
        })
    {
        if !path.to_ascii_lowercase().starts_with("file:") {
            return None;
        }
        return Some((path.into(), suffix.into()));
    }
    Some((path.into(), suffix.into()))
}

fn resolve_bundle_resource(
    source: &str,
    document: Option<&Path>,
    boundary: Option<&Path>,
) -> Result<PathBuf, String> {
    let boundary = boundary.ok_or("请先保存文档或打开工作区，再收集本地附件")?;
    let path = if source.to_ascii_lowercase().starts_with("file:") {
        let url = url::Url::parse(source).map_err(|_| "本地文件 URL 无效")?;
        if url
            .host_str()
            .is_some_and(|host| !host.eq_ignore_ascii_case("localhost"))
        {
            return Err("不支持远程文件共享 URL".into());
        }
        url.to_file_path().map_err(|_| "不支持远程文件共享 URL")?
    } else {
        let decoded = percent_decode_str(source)
            .decode_utf8()
            .map_err(|_| "路径包含无效 UTF-8 编码")?;
        if decoded.contains('\0') {
            return Err("路径包含空字符".into());
        }
        let path = PathBuf::from(decoded.replace('\\', "/"));
        if path.is_absolute() {
            path
        } else {
            document
                .and_then(Path::parent)
                .unwrap_or(boundary)
                .join(path)
        }
    };
    let path =
        fs::canonicalize(path).map_err(|error| format!("本地资源不存在或不可读：{error}"))?;
    if !path.starts_with(boundary) {
        return Err("资源位于文档目录或所选工作区之外，未收集".into());
    }
    if !fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("目录链接不会递归打包整个目录".into());
    }
    Ok(path)
}

fn bundle_name(path: &Path, root: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|_| "文件不在打包范围内")?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("附件路径含有非法目录跳转".into());
        };
        let part = part.to_str().ok_or("附件名称不是有效 Unicode")?;
        let safe: String = part
            .chars()
            .map(|ch| {
                if ch.is_control() || ['<', '>', ':', '"', '\\', '|', '?', '*'].contains(&ch) {
                    '_'
                } else {
                    ch
                }
            })
            .collect();
        let safe = safe.trim_end_matches(['.', ' ']);
        let stem = safe.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"))
                .is_some_and(|suffix| {
                    suffix.len() == 1 && (b'1'..=b'9').contains(&suffix.as_bytes()[0])
                });
        parts.push(if safe.is_empty() || reserved {
            format!("_{safe}")
        } else {
            safe.into()
        });
    }
    if parts.is_empty() {
        return Err("附件路径缺少文件名".into());
    }
    Ok(parts.join("/"))
}

fn relative_bundle_path(source: &str, target: &str) -> String {
    let directory: Vec<_> = source
        .split('/')
        .take(source.split('/').count() - 1)
        .collect();
    let target: Vec<_> = target.split('/').collect();
    let common = directory
        .iter()
        .zip(&target)
        .take_while(|(a, b)| a == b)
        .count();
    std::iter::repeat_n("..".to_owned(), directory.len() - common)
        .chain(target[common..].iter().map(|part| {
            utf8_percent_encode(part, NON_ALPHANUMERIC)
                .to_string()
                .replace("%2E", ".")
                .replace("%2D", "-")
                .replace("%5F", "_")
                .replace("%7E", "~")
        }))
        .collect::<Vec<_>>()
        .join("/")
}

fn unique_bundle_name(original: &str, names: &HashSet<String>) -> String {
    let conflicts = |candidate: &str| {
        let candidate = candidate.to_lowercase();
        names.iter().any(|known| {
            *known == candidate
                || known.starts_with(&format!("{candidate}/"))
                || candidate.starts_with(&format!("{known}/"))
        })
    };
    if !conflicts(original) {
        return original.into();
    }
    let (head, tail) = original
        .split_once('/')
        .map(|(head, tail)| (head, format!("/{tail}")))
        .unwrap_or((original, String::new()));
    let head = Path::new(head);
    let stem = head.file_stem().unwrap_or_default().to_string_lossy();
    let extension = head
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    for suffix in 2.. {
        let name = format!("{stem}-{suffix}{extension}{tail}");
        if !conflicts(&name) {
            return name;
        }
    }
    unreachable!()
}

fn read_attachment(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("附件不是普通文件".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err("单个附件超过 64 MiB，未收集".into());
    }
    Ok(bytes)
}

fn write_bundle(file: File, files: &[BundleFile]) -> Result<(), String> {
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for file in files {
        writer
            .start_file(&file.name, options)
            .map_err(|error| format!("写入 ZIP 条目失败：{error}"))?;
        writer
            .write_all(&file.bytes)
            .map_err(|error| format!("写入 ZIP 内容失败：{error}"))?;
    }
    writer
        .finish()
        .map_err(|error| format!("完成 ZIP 失败：{error}"))?
        .sync_all()
        .map_err(|error| format!("刷新 ZIP 失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs::{self, File};
    use std::io::Read;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "otterdive-delivery-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }
        fn request(&self, text: &str) -> MarkdownBundleRequest {
            self.write("文档.md", "saved version");
            MarkdownBundleRequest {
                text: text.into(),
                document_path: Some(self.0.join("文档.md").to_string_lossy().into_owned()),
                workspace_root: Some(self.0.to_string_lossy().into_owned()),
                output_path: self.0.join("delivery.zip").to_string_lossy().into_owned(),
            }
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn read_bundle(path: &str) -> BTreeMap<String, Vec<u8>> {
        let mut zip = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        let mut entries = BTreeMap::new();
        for index in 0..zip.len() {
            let mut file = zip.by_index(index).unwrap();
            assert!(
                file.enclosed_name().is_some(),
                "ZIP must contain no escaping paths"
            );
            let name = file.name().to_owned();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            assert!(entries.insert(name, bytes).is_none());
        }
        entries
    }

    #[test]
    fn references_exclude_code_and_keep_exact_destination_spans() {
        let text = "前言 ![a](<图片/a b.png> \"title\") [nested](a\\(b\\).md#h)\n![ref][key]\n\n[key]: <files/图.png> \"hello\"\n\n`![fake](secret.txt)`\n```md\n[bad](private.txt)\n```\n    [bad](indented.txt)\n<a href=\"docs/a&amp;b.pdf\">附件</a>\n";
        let spans = markdown_reference_spans(text);
        let raw: Vec<_> = spans.iter().map(|span| &text[span.range.clone()]).collect();
        assert_eq!(
            raw,
            [
                "图片/a b.png",
                "a\\(b\\).md#h",
                "files/图.png",
                "docs/a&amp;b.pdf"
            ]
        );
        assert_eq!(spans[1].destination, "a(b).md#h");
        assert_eq!(spans[3].destination, "docs/a&b.pdf");
    }

    #[test]
    fn bundle_keeps_live_markdown_unicode_assets_remote_urls_and_cyclic_notes() {
        let dir = TestDirectory::new();
        dir.write("图片/图 片.png", [1, 2, 3]);
        dir.write(
            "notes/child.md",
            "[back](../文档.md#top) ![nested](../图片/图%20片.png)",
        );
        dir.write("files/report.pdf", b"pdf");
        let text = "# live unsaved edit\n![image](图片/图%20片.png)\n[child](notes/child.md)\n[attachment][r]\n\n[r]: files/report.pdf\n\n![remote](https://example.invalid/never-fetch.png)\n";
        let result = build_bundle(dir.request(text)).unwrap();
        let entries = read_bundle(&result.path);
        assert_eq!(result.file_count, 4);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let current = String::from_utf8(entries["文档.md"].clone()).unwrap();
        assert!(current.contains("# live unsaved edit"));
        assert!(current.contains("https://example.invalid/never-fetch.png"));
        assert_eq!(entries["图片/图 片.png"], [1, 2, 3]);
        assert_eq!(entries["files/report.pdf"], b"pdf");
        assert!(
            String::from_utf8(entries["notes/child.md"].clone())
                .unwrap()
                .contains("../%E6%96%87%E6%A1%A3.md#top")
        );
    }

    #[test]
    fn bundle_warns_for_missing_and_escaping_resources_without_collecting_them() {
        let parent = TestDirectory::new();
        let root = parent.0.join("workspace");
        fs::create_dir(&root).unwrap();
        let doc = root.join("readme.md");
        fs::write(&doc, "saved").unwrap();
        parent.write("private.txt", "private");
        let text = "[missing](missing.pdf) [escape](../private.txt) [dir](.)";
        let result = build_bundle(MarkdownBundleRequest {
            text: text.into(),
            document_path: Some(doc.to_string_lossy().into_owned()),
            workspace_root: Some(root.to_string_lossy().into_owned()),
            output_path: parent.0.join("package.zip").to_string_lossy().into_owned(),
        })
        .unwrap();
        let entries = read_bundle(&result.path);
        assert_eq!(entries.len(), 1);
        assert_eq!(result.warnings.len(), 3);
        assert_eq!(entries["readme.md"], text.as_bytes());
    }

    #[test]
    fn bundle_refuses_existing_outputs_and_never_damages_sources() {
        let dir = TestDirectory::new();
        let request = dir.request("![a](data.bin)");
        dir.write("data.bin", "asset");
        dir.write("delivery.zip", "existing zip");
        assert!(build_bundle(request).unwrap_err().contains("已存在"));
        assert_eq!(
            fs::read(dir.0.join("delivery.zip")).unwrap(),
            b"existing zip"
        );
        assert_eq!(fs::read(dir.0.join("data.bin")).unwrap(), b"asset");
    }

    #[test]
    fn bundle_does_not_merge_case_colliding_asset_names() {
        let dir = TestDirectory::new();
        dir.write("one/same.png", "one");
        dir.write("two/same.png", "two");
        let result = build_bundle(dir.request("![a](one/same.png) ![b](two/same.png)")).unwrap();
        let entries = read_bundle(&result.path);
        assert_eq!(entries["one/same.png"], b"one");
        assert_eq!(entries["two/same.png"], b"two");
    }

    #[test]
    fn unsaved_document_with_no_root_exports_text_and_warns_for_local_assets() {
        let dir = TestDirectory::new();
        let result = build_bundle(MarkdownBundleRequest {
            text: "![a](image.png)".into(),
            document_path: None,
            workspace_root: None,
            output_path: dir.0.join("draft.zip").to_string_lossy().into_owned(),
        })
        .unwrap();
        assert_eq!(result.file_count, 1);
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(read_bundle(&result.path)["document.md"], b"![a](image.png)");
    }

    #[cfg(unix)]
    #[test]
    fn bundle_never_follows_a_symlink_outside_the_workspace() {
        let dir = TestDirectory::new();
        let outside = TestDirectory::new();
        let secret = outside.write("secret.txt", "private");
        std::os::unix::fs::symlink(secret, dir.0.join("leak.txt")).unwrap();
        let result = build_bundle(dir.request("[link](leak.txt)")).unwrap();
        assert_eq!(result.file_count, 1);
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn trash_rejects_workspace_root_and_outside_paths_without_removing_them() {
        let root = TestDirectory::new();
        let outside = TestDirectory::new();
        let file = outside.write("keep.txt", "keep");
        assert!(trash_workspace_entry(&root.0, &root.0).is_err());
        assert!(trash_workspace_entry(&root.0, &file).is_err());
        assert!(root.0.exists());
        assert!(file.exists());
    }

    #[test]
    fn trash_backend_failure_keeps_the_file_and_never_permanently_removes_it() {
        let root = TestDirectory::new();
        let file = root.write("keep.txt", "important");
        let error = trash_workspace_entry_with(&root.0, &file, |_| Err("trash unavailable".into()))
            .unwrap_err();
        assert_eq!(error, "trash unavailable");
        assert_eq!(fs::read(&file).unwrap(), b"important");
        let destination = root.0.join("simulated-trash.txt");
        trash_workspace_entry_with(&root.0, &file, |path| {
            fs::rename(path, &destination).map_err(|error| error.to_string())
        })
        .unwrap();
        assert!(!file.exists());
        assert_eq!(fs::read(destination).unwrap(), b"important");
    }

    #[test]
    fn references_do_not_treat_frontmatter_or_raw_html_code_as_links() {
        let text = "---\nexample: '[private](secrets.txt)'\n---\n<script>\nconst example = '<img src=\"secrets.txt\">';\n</script>\n<pre>\n</prelude>\n<img src=\"secrets.txt\">\n</pre>\n<!--\n<img src=\"secrets.txt\">\n-->\n\n<code/>\n\n![shown](visible.png)\n";
        let references = markdown_reference_spans(text);
        assert_eq!(
            references
                .iter()
                .map(|reference| reference.destination.as_str())
                .collect::<Vec<_>>(),
            ["visible.png"]
        );
    }

    #[test]
    fn references_keep_nested_images_titles_and_escaped_reference_labels() {
        let text = "[![alt](image.png)](note.md \"title ](fake)\")\n[a][x\\]:label]\n\n[x\\]:label]: <file.pdf>\n";
        let references = markdown_reference_spans(text);
        assert_eq!(
            references
                .iter()
                .map(|reference| reference.destination.as_str())
                .collect::<Vec<_>>(),
            ["image.png", "note.md", "file.pdf"]
        );
        assert_eq!(
            references
                .iter()
                .map(|reference| &text[reference.range.clone()])
                .collect::<Vec<_>>(),
            ["image.png", "note.md", "file.pdf"]
        );
    }

    #[test]
    fn remote_file_urls_are_rejected_before_reading_network_shares() {
        let dir = TestDirectory::new();
        let error = resolve_bundle_resource("file://server/share/secret.txt", None, Some(&dir.0))
            .unwrap_err();
        assert!(error.contains("远程文件共享"), "{error}");
    }

    #[test]
    fn bundle_keeps_html_query_entities_and_attribute_quotes_valid() {
        let dir = TestDirectory::new();
        dir.write("report.pdf", "pdf");
        let result =
            build_bundle(dir.request("<a href=\"report.pdf?a=1&amp;b=2#top\">report</a>\n"))
                .unwrap();
        let text = String::from_utf8(read_bundle(&result.path)["文档.md"].clone()).unwrap();
        assert!(text.contains("report.pdf?a=1&amp;b=2#top"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn bundle_prevents_sanitized_file_and_directory_name_collisions() {
        let dir = TestDirectory::new();
        dir.write("one:name", "attachment");
        dir.write("one_name/pic.png", "image");
        let result =
            build_bundle(dir.request("[file](one%3Aname) ![image](one_name/pic.png)")).unwrap();
        let entries = read_bundle(&result.path);
        for name in entries.keys() {
            assert!(
                !entries.keys().any(|other| other
                    .to_lowercase()
                    .starts_with(&format!("{}/", name.to_lowercase()))),
                "file {name} collides with a directory"
            );
        }
        assert_eq!(result.file_count, 3);
    }
}
