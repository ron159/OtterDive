//! A revision-bound byte index. Only headings and bounded shared definitions cross IPC.
use crate::{file_revision::ensure_revision, paged_document::PagedDocumentService};
use otterdive_core::analyse::CancellationToken;
use pulldown_cmark::{Event, Parser, Tag};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
};

const SECTION_BYTES: usize = 256 * 1024;
const SCAN_BYTES: usize = 32 * 1024;
const MAX_HEADINGS: usize = 16_384;
const MAX_CONTEXT: usize = 64 * 1024;
const MAX_DEFINITIONS: usize = 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Section {
    title: String,
    level: u8,
    line: usize,
    start: u64,
    end: u64,
}

#[derive(Debug, Serialize)]
struct Definition {
    offset: u64,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionIndex {
    sections: Vec<Section>,
    definitions: Vec<Definition>,
    section_limit: usize,
    #[serde(skip)]
    context_bytes: usize,
}

impl SectionIndex {
    fn definition(&mut self, offset: u64, text: &str) -> Result<(), String> {
        let text = text.trim_end();
        self.context_bytes += text.len() + 2;
        if self.context_bytes > MAX_CONTEXT || self.definitions.len() >= MAX_DEFINITIONS {
            return Err("全文件引用定义超过 64 KiB 或 1024 项，请使用源码分块阅读".into());
        }
        self.definitions.push(Definition {
            offset,
            text: text.to_owned(),
        });
        Ok(())
    }

    fn heading(&mut self, title: String, level: u8, line: usize, start: u64) -> Result<(), String> {
        if self.sections.len() >= MAX_HEADINGS {
            return Err("章节索引超过 16384 项，请使用源码分块阅读".into());
        }
        if let Some(last) = self.sections.last_mut() {
            if start == last.start || (line == 1 && last.line == 1) {
                last.title = title;
                last.level = level;
                return Ok(());
            }
            last.end = start;
        }
        self.sections.push(Section {
            title,
            level,
            line,
            start,
            end: start,
        });
        Ok(())
    }
}

fn checked(cancel: &CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("读取已取消".into())
    } else {
        Ok(())
    }
}

// Retain at most one bounded group of blocks. The parser supplies real heading and
// definition spans, including Setext headings and multiline reference destinations.
#[derive(Default)]
struct Block {
    text: String,
    start: u64,
    line: usize,
    interesting: bool,
    oversized: bool,
}

impl Block {
    fn push(&mut self, line: &str, offset: u64, number: usize, long: bool) {
        if self.text.is_empty() {
            self.start = offset;
            self.line = number;
        }
        let trimmed = line.trim_start();
        let marker = trimmed.as_bytes().first().copied();
        let setext = matches!(marker, Some(b'-' | b'='))
            && trimmed.trim_end().bytes().all(|b| Some(b) == marker);
        self.interesting |= atx(line.trim_end()) || setext || line.contains("]:");
        if long || self.text.len() + line.len() > SECTION_BYTES {
            self.oversized = true;
        }
        if !self.oversized {
            self.text.push_str(line);
        }
    }

    fn finish(&mut self, index: &mut SectionIndex) -> Result<(), String> {
        if self.interesting {
            if self.oversized {
                return Err("连续 Markdown 块超过 256 KiB，无法可靠确定标题或引用边界".into());
            }
            let parser = Parser::new(&self.text);
            let mut definitions: Vec<_> = parser
                .reference_definitions()
                .iter()
                .map(|(_, def)| def.span.clone())
                .collect();
            let mut depth = 0;
            let mut heading = None;
            let mut title = String::new();
            for (event, span) in parser.into_offset_iter() {
                match event {
                    Event::Start(tag) => {
                        if let (0, Tag::Heading { level, .. }) = (depth, tag) {
                            heading = Some((span.start, level as u8));
                            title.clear();
                        }
                        depth += 1;
                    }
                    Event::Text(text) | Event::Code(text) if heading.is_some() => {
                        title.push_str(&text);
                    }
                    Event::SoftBreak | Event::HardBreak if heading.is_some() => title.push(' '),
                    Event::End(_) => {
                        depth -= 1;
                        if depth == 0 {
                            if let Some((start, level)) = heading.take() {
                                let line = self.line
                                    + self.text[..start].bytes().filter(|b| *b == b'\n').count();
                                let label = if title.is_empty() {
                                    "无标题"
                                } else {
                                    &title
                                };
                                index.heading(
                                    label.chars().take(96).collect(),
                                    level,
                                    line,
                                    self.start + start as u64,
                                )?;
                            }
                        }
                    }
                    _ => {}
                }
            }
            definitions.sort_by_key(|r| r.start);
            for range in definitions {
                let text = self.text[range.clone()].trim_end();
                let prefix = self.text[..range.start].rsplit('\n').next().unwrap_or("");
                if !prefix.trim().is_empty()
                    || !text.trim_start().starts_with('[')
                    || text.trim_start().starts_with("[^")
                {
                    return Err("嵌套引用定义无法独立渲染".into());
                }
                index.definition(self.start + range.start as u64, text)?;
            }
        }
        self.text.clear();
        self.interesting = false;
        self.oversized = false;
        Ok(())
    }
}

fn fence(line: &str) -> Option<(u8, usize, &str)> {
    let text = line.trim_start_matches(' ');
    if line.len() - text.len() > 3 {
        return None;
    }
    let marker = *text.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let length = text.bytes().take_while(|b| *b == marker).count();
    (length >= 3).then_some((marker, length, &text[length..]))
}

fn atx(line: &str) -> bool {
    let trimmed = line.trim_start_matches(' ');
    let count = trimmed.bytes().take_while(|b| *b == b'#').count();
    line.len() - trimmed.len() <= 3
        && (1..=6).contains(&count)
        && (trimmed.len() == count || trimmed[count..].starts_with([' ', '\t']))
}

// Match Muya's column-zero footnote extension. Its body can continue on ordinary
// non-indented lines until a blank line or another footnote, unlike CommonMark's rule.
fn footnote_start(line: &str) -> bool {
    let Some((id, _)) = line
        .strip_prefix("[^")
        .and_then(|rest| rest.split_once("]:"))
    else {
        return false;
    };
    !id.is_empty()
        && !id.ends_with('\\')
        && !id.contains(['^', '[', ']'])
        && !id.contains(char::is_whitespace)
}

fn build_index(reader: impl Read, cancel: &CancellationToken) -> Result<SectionIndex, String> {
    let mut reader = BufReader::with_capacity(SCAN_BYTES, reader);
    let mut index = SectionIndex {
        sections: Vec::new(),
        definitions: Vec::new(),
        section_limit: SECTION_BYTES,
        context_bytes: 0,
    };
    index.heading("文首".into(), 0, 1, 0)?;
    let mut bytes = Vec::new();
    let mut piece = Vec::with_capacity(SCAN_BYTES);
    let mut offset = 0u64;
    let mut number = 0;
    let mut block = Block::default();
    let mut note: Option<Definition> = None;
    let mut in_fence: Option<(u8, usize)> = None;
    let mut delimiter = None;
    let mut blank = true;
    loop {
        bytes.clear();
        let start = offset;
        // Bound both the line buffer and cancellation latency for newline-free input.
        loop {
            checked(cancel)?;
            piece.clear();
            let n = reader
                .by_ref()
                .take(SCAN_BYTES as u64)
                .read_until(b'\n', &mut piece)
                .map_err(|e| e.to_string())?;
            offset += n as u64;
            bytes.extend_from_slice(&piece[..n.min(SECTION_BYTES.saturating_sub(bytes.len()))]);
            if n == 0 || piece.ends_with(b"\n") {
                break;
            }
        }
        if start == offset {
            break;
        }
        number += 1;
        let long = offset - start > bytes.len() as u64;
        let valid = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(e) if long && e.error_len().is_none() => {
                std::str::from_utf8(&bytes[..e.valid_up_to()]).unwrap()
            }
            Err(_) => {
                return Err(format!(
                    "第 {number} 行包含无效 UTF-8 字节，请使用源码分块阅读"
                ));
            }
        };
        let line = if number == 1 {
            valid.trim_start_matches('\u{feff}')
        } else {
            valid
        };
        let line_offset = start + (valid.len() - line.len()) as u64;
        let body = line.strip_suffix('\n').unwrap_or(line);
        let body = body.strip_suffix('\r').unwrap_or(body);
        if body.contains(['\0', '\r']) {
            return Err("章节索引不支持二进制内容或单 CR 换行，请使用源码分块阅读".into());
        }
        if long && fence(body).is_some() {
            return Err(format!(
                "第 {number} 行的围栏标记超过 256 KiB，无法可靠确定边界"
            ));
        }
        if let Some((marker, width)) = in_fence {
            if !long
                && fence(body)
                    .is_some_and(|(m, n, tail)| m == marker && n >= width && tail.trim().is_empty())
            {
                in_fence = None;
                blank = true;
            }
            continue;
        }
        if let Some(end) = delimiter {
            if body.trim() == end {
                delimiter = None;
                blank = true;
            }
            continue;
        }
        let starts_note = footnote_start(body);
        if let Some(active) = &mut note {
            if !starts_note && (!blank || body.trim().is_empty() || body.starts_with("    ")) {
                if active.text.len() + line.len() > MAX_CONTEXT {
                    return Err("跨章节脚注超过 64 KiB，请使用源码分块阅读".into());
                }
                active.text.push_str(line);
                blank = body.trim().is_empty();
                continue;
            }
            index.definition(active.offset, &active.text)?;
            note = None;
        }
        if starts_note {
            block.finish(&mut index)?;
            if line.len() > MAX_CONTEXT {
                return Err("跨章节脚注超过 64 KiB，请使用源码分块阅读".into());
            }
            note = Some(Definition {
                offset: line_offset,
                text: line.to_string(),
            });
            blank = false;
            continue;
        }
        if number == 1 || body.trim() == "$$" {
            delimiter = match body.trim() {
                "---" if number == 1 => Some("---"),
                "+++" if number == 1 => Some("+++"),
                ";;;" if number == 1 => Some(";;;"),
                "{" if number == 1 => Some("}"),
                "$$" => Some("$$"),
                _ => None,
            };
            if delimiter.is_some() {
                block.finish(&mut index)?;
                continue;
            }
        }
        if let Some((marker, width, tail)) = fence(body) {
            if marker != b'`' || !tail.contains('`') {
                block.finish(&mut index)?;
                in_fence = Some((marker, width));
                continue;
            }
        }
        let trimmed = body.trim_start();
        if trimmed.starts_with('<')
            && Parser::new(body).any(|event| matches!(event, Event::Start(Tag::HtmlBlock)))
        {
            return Err(format!(
                "第 {number} 行含原始 HTML 块，无法可靠确定章节边界"
            ));
        }
        // A nonindented heading starts a new root block. Indented headings may
        // belong to a list and must be classified together with their container.
        if (!body.starts_with([' ', '\t']) && !trimmed.is_empty()) && (blank || atx(body)) {
            block.finish(&mut index)?;
        }
        blank = trimmed.is_empty();
        if long && body.starts_with('#') && atx(body) {
            let level = body.bytes().take_while(|b| *b == b'#').count();
            let label = body[level..].trim().chars().take(96).collect();
            index.heading(label, level as u8, number, line_offset)?;
            continue;
        }
        block.push(line, line_offset, number, long);
        if body.starts_with('#') && atx(body) {
            block.finish(&mut index)?;
        }
    }
    if let Some(note) = note {
        index.definition(note.offset, &note.text)?;
    }
    if delimiter.is_some() {
        return Err("文件头元数据或数学块缺少结束标记，无法可靠确定章节边界".into());
    }
    block.finish(&mut index)?;
    index.sections.last_mut().unwrap().end = offset;
    checked(cancel)?;
    Ok(index)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionRequest {
    path: String,
    revision: String,
    encoding: String,
    request_id: String,
}

fn open(request: &SectionRequest) -> Result<File, String> {
    if !matches!(request.encoding.as_str(), "UTF-8" | "UTF-8-BOM") {
        return Err(format!(
            "章节索引目前支持 UTF-8；此文件为 {}，请使用源码分块阅读",
            request.encoding
        ));
    }
    ensure_revision(Path::new(&request.path), &request.revision)?;
    File::open(&request.path).map_err(|e| e.to_string())
}

async fn run<T: Send + 'static>(
    service: tauri::State<'_, Arc<PagedDocumentService>>,
    request: SectionRequest,
    work: impl FnOnce(File, &CancellationToken) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let id = request.request_id.clone();
    let cancel = service.begin(&id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        checked(&cancel)?;
        let value = work(open(&request)?, &cancel)?;
        ensure_revision(Path::new(&request.path), &request.revision)?;
        checked(&cancel)?;
        Ok(value)
    })
    .await
    .map_err(|e| e.to_string());
    service.finish(&id);
    result?
}

#[tauri::command]
pub async fn index_markdown_sections(
    request: SectionRequest,
    service: tauri::State<'_, Arc<PagedDocumentService>>,
) -> Result<SectionIndex, String> {
    run(service, request, |file, cancel| {
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        build_index(file.take(size), cancel)
    })
    .await
}

fn read_range(
    mut file: File,
    start: u64,
    end: u64,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let len = end.checked_sub(start).ok_or("无效章节范围")?;
    if len > SECTION_BYTES as u64 {
        return Err("本节超过 256 KiB 渲染上限，请使用源码分块阅读".into());
    }
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0; len as usize];
    for part in buf.chunks_mut(SCAN_BYTES) {
        checked(cancel)?;
        file.read_exact(part).map_err(|e| e.to_string())?;
    }
    String::from_utf8(buf).map_err(|_| "章节包含无效 UTF-8 字节，请使用源码分块阅读".into())
}

#[tauri::command]
pub async fn read_markdown_section(
    request: SectionRequest,
    start: u64,
    end: u64,
    service: tauri::State<'_, Arc<PagedDocumentService>>,
) -> Result<String, String> {
    run(service, request, move |file, cancel| {
        read_range(file, start, end, cancel)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufWriter, Write};
    use std::time::Instant;

    fn parse(input: &str) -> SectionIndex {
        build_index(input.as_bytes(), &CancellationToken::new()).unwrap()
    }

    #[test]
    fn indexes_utf8_offsets_real_headings_duplicates_and_shared_definitions() {
        let source = "\u{feff}# **重复**\r\n\r\n[查阅][手册]，见脚注[^注]。\r\n\r\n````md\r\n# 伪标题\r\n```\r\n[伪]: fake\r\n````\r\n~~~\n假标题\n===\n~~~\n\n> # 引用中的标题\n\n重复\n====\n\n[手册]: <manual.md>\n  \"说明\"\n\n[^注]: 注释首行\n    第二行\n";
        let index = parse(source);
        assert_eq!(
            index
                .sections
                .iter()
                .map(|s| s.title.as_str())
                .collect::<Vec<_>>(),
            ["重复", "重复"]
        );
        let second = &index.sections[1];
        assert_eq!(index.sections[0].start, 0);
        assert_eq!(index.sections[0].end, second.start);
        assert!(source[second.start as usize..].starts_with("重复\n===="));
        assert_eq!(
            second.line,
            source[..second.start as usize].lines().count() + 1
        );
        assert_eq!(second.end, source.len() as u64);
        assert_eq!(index.definitions.len(), 2);
        assert_eq!(index.definitions[0].text, "[手册]: <manual.md>\n  \"说明\"");
        assert_eq!(index.definitions[1].text, "[^注]: 注释首行\n    第二行");
    }

    #[test]
    fn unsupported_encoding_and_stale_revision_fail_before_section_io() {
        let mut request = SectionRequest {
            path: "missing-section-test.fixture".into(),
            encoding: "UTF-16 Little Endian".into(),
            revision: "outdated".into(),
            request_id: "test".into(),
        };
        assert!(open(&request).unwrap_err().contains("UTF-16"));
        request.encoding = "UTF-8".into();
        assert!(open(&request).unwrap_err().contains("修改"));
    }

    #[test]
    fn ambiguous_or_excessive_context_reports_source_fallback() {
        assert!(
            build_index(
                b"# first\n\n<!--\n# inside HTML\n-->".as_slice(),
                &CancellationToken::new()
            )
            .unwrap_err()
            .contains("HTML")
        );
        let long = format!("# one\n\n[manual]: /{}\n", "a".repeat(MAX_CONTEXT));
        assert!(
            build_index(long.as_bytes(), &CancellationToken::new())
                .unwrap_err()
                .contains("64 KiB")
        );
        let huge_heading = format!("# {}\n# 尾章\n", "字".repeat(SECTION_BYTES));
        let huge = parse(&huge_heading);
        assert_eq!(huge.sections.len(), 2);
        assert_eq!(huge.sections[0].title.chars().count(), 96);
        assert_eq!(huge.sections[1].title, "尾章");
        assert_eq!(parse("<a@example.org>\n\n# A\n").sections.len(), 2);
        assert_eq!(parse("前言\n\n# A\n").sections[0].title, "文首");
        assert_eq!(parse("---\n# metadata\n---\n\n# 真标题").sections.len(), 2);
    }

    #[test]
    fn footnote_body_follows_the_preview_renderer_across_markdown_blocks() {
        let source = "# A\n\n[^n]: 定义\n# 脚注内标题\n非缩进行\n\n    缩进续段\n\n# B\n";
        let index = parse(source);
        assert_eq!(index.sections.len(), 2);
        assert_eq!(index.sections[1].title, "B");
        assert_eq!(
            index.definitions[0].text,
            "[^n]: 定义\n# 脚注内标题\n非缩进行\n\n    缩进续段"
        );
    }

    #[test]
    fn cancellation_interrupts_scanning_inside_a_newline_free_line() {
        struct SlowLine {
            reads: usize,
            cancel: CancellationToken,
        }
        impl Read for SlowLine {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                assert!(self.reads <= 3, "cancelled scan continued reading");
                if self.reads == 3 {
                    self.cancel.cancel();
                }
                buf.fill(b'x');
                Ok(buf.len())
            }
        }
        let cancel = CancellationToken::new();
        assert!(
            build_index(
                SlowLine {
                    reads: 0,
                    cancel: cancel.clone()
                },
                &cancel
            )
            .unwrap_err()
            .contains("取消")
        );
    }

    // Reproduce with cargo test -p otterdive-app large_chinese_section_file -- --nocapture.
    // Set OTTERDIVE_SECTION_FIXTURE_DIR to an empty scratch directory to retain the
    // same fixture and its actual Rust index for the browser workflow test.
    #[test]
    fn large_chinese_section_file() {
        let retained =
            std::env::var_os("OTTERDIVE_SECTION_FIXTURE_DIR").map(std::path::PathBuf::from);
        let dir = retained.clone().unwrap_or_else(|| {
            std::env::temp_dir().join(format!("otterdive-section-test-{}", std::process::id()))
        });
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("章节验证.md");
        let mut file = BufWriter::new(File::create_new(&path).unwrap());
        writeln!(
            file,
            "# 重复\n\n查阅[后文][手册]和脚注[^注]。[去第二个同名标题](#重复-1)。\n\n````\n# 伪标题\n```\n````\n"
        )
        .unwrap();
        let paragraph = "中文正文用于验证按需章节阅读。".repeat(24);
        for i in 0..240 {
            writeln!(file, "## 小节 {i}\n").unwrap();
            for _ in 0..80 {
                writeln!(file, "{paragraph}\n").unwrap();
            }
        }
        writeln!(file, "# 超长章\n{}", "长".repeat(SECTION_BYTES)).unwrap();
        writeln!(file, "# 重复\n\n尾部唯一命中词\n\n[手册]: https://example.org/manual\n\n[^注]: 跨章节脚注正文\n").unwrap();
        drop(file);
        let dto = crate::app::load_path(path.clone()).unwrap();
        assert!(
            dto.file_size > otterdive_core::document::EDITABLE_FILE_LIMIT_BYTES as usize
                && dto.paged
                && dto.read_only
                && dto.text.is_empty()
        );
        let cancel = CancellationToken::new();
        let t0 = Instant::now();
        let index = build_index(File::open(&path).unwrap(), &cancel).unwrap();
        let elapsed = t0.elapsed();
        assert_eq!(index.sections.len(), 243);
        assert_eq!(index.definitions.len(), 2);
        let oversized = &index.sections[241];
        assert!(
            read_range(
                File::open(&path).unwrap(),
                oversized.start,
                oversized.end,
                &cancel
            )
            .unwrap_err()
            .contains("256 KiB")
        );
        let last = index.sections.last().unwrap();
        let t1 = Instant::now();
        let tail = read_range(File::open(&path).unwrap(), last.start, last.end, &cancel).unwrap();
        let read_elapsed = t1.elapsed();
        assert!(tail.contains("尾部唯一命中词"));
        let mut lines = Vec::new();
        let mut reports = Vec::new();
        otterdive_core::fs::search_file_stream(
            &path,
            "尾部唯一命中词",
            &Default::default(),
            None,
            &cancel,
            |batch| {
                lines.extend(
                    batch
                        .hits
                        .iter()
                        .flat_map(|hit| hit.matches.iter().map(|m| m.line)),
                );
                reports.push(crate::app::search_report_to_dto(batch));
                true
            },
        )
        .unwrap();
        assert_eq!(lines, [last.line + 2]);
        let json = serde_json::to_vec(&index).unwrap();
        eprintln!(
            "file={} B, sections={}, index={} B, scan={elapsed:?}, tail={} B, seek+read={read_elapsed:?}, full-file match line={}",
            dto.file_size,
            index.sections.len(),
            json.len(),
            tail.len(),
            lines[0]
        );
        if retained.is_some() {
            use crate::paged_document::{PageRequest, PagedDocumentService};
            let pager = PagedDocumentService::default();
            let page = |line| {
                pager
                    .read(
                        &PageRequest {
                            path: path.display().to_string(),
                            encoding: dto.encoding.clone(),
                            revision: dto.disk_revision.clone().unwrap(),
                            request_id: "fixture".into(),
                            line: Some(line),
                            column: Some(1),
                            offset: None,
                        },
                        &cancel,
                    )
                    .unwrap()
            };
            let capture = serde_json::json!({ "document": dto, "firstPage": page(1),
                "lastPage": page(lines[0]), "search": reports[0], "index": index });
            std::fs::write(
                dir.join("native.json"),
                serde_json::to_vec(&capture).unwrap(),
            )
            .unwrap();
        } else {
            std::fs::remove_file(path).unwrap();
            std::fs::remove_dir(dir).unwrap();
        }
    }
}
