use crate::document_delivery::{html_reference_spans, reference_parser_options};
use otterdive_core::fs::workspace_entry_filter;
use pulldown_cmark::{Event, LinkType, Parser, Tag};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize)]
pub struct ReferenceDirectory {
    directories: Vec<PathBuf>,
    files: Vec<PathBuf>,
    excluded: usize,
    warnings: Vec<String>,
    limited: bool,
}

// One bounded directory per request allows the caller to stop before traversing more.
fn list_directory(
    path: &Path,
    include_hidden: bool,
    skip_dirs: &str,
) -> Result<ReferenceDirectory, String> {
    let includes = workspace_entry_filter(include_hidden, skip_dirs);
    let mut result = ReferenceDirectory::default();
    for (index, entry) in fs::read_dir(path).map_err(|e| e.to_string())?.enumerate() {
        if index == 8192 {
            result.limited = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                result.warnings.push(error.to_string());
                continue;
            }
        };
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(error) => {
                result
                    .warnings
                    .push(format!("{}：{error}", entry.path().display()));
                continue;
            }
        };
        if !includes(&entry.file_name().to_string_lossy(), kind.is_dir()) || kind.is_symlink() {
            result.excluded += 1;
        } else if kind.is_dir() {
            result.directories.push(entry.path());
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "md" | "markdown" | "mdx" | "rmd"
                    )
                })
        {
            result.files.push(entry.path());
        }
    }
    result.files.sort();
    result.directories.sort();
    Ok(result)
}

#[tauri::command]
pub async fn list_markdown_reference_directory(
    path: PathBuf,
    include_hidden: bool,
    skip_dirs: String,
) -> Result<ReferenceDirectory, String> {
    tauri::async_runtime::spawn_blocking(move || list_directory(&path, include_hidden, &skip_dirs))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct ReferenceLocation {
    href: String,
    line: usize,
    column: usize,
}

#[derive(Default, Serialize)]
pub struct ReferenceLocations {
    items: Vec<ReferenceLocation>,
    limited: bool,
}

fn local_href(href: &str) -> bool {
    if href.is_empty() || href.starts_with("//") {
        return false;
    }
    let Some((scheme, rest)) = href.split_once(':') else {
        return true;
    };
    scheme.eq_ignore_ascii_case("file")
        || (scheme.len() == 1 && rest.starts_with(['/', '\\']))
        || !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

fn reference_locations(text: &str) -> ReferenceLocations {
    // Normalize line breaks for both CommonMark and Monaco before computing UTF-16 columns.
    let normalized;
    let text = if text.contains('\r') {
        normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        &normalized
    } else {
        text
    };
    let mut result = ReferenceLocations::default();
    let mut offset = 0;
    let (mut line, mut column) = (1, 1);
    let mut href_bytes = 0;
    let mut record = |start: usize, href: &str| {
        let href = href.trim();
        if !local_href(href) {
            return true;
        }
        href_bytes += href.len();
        if result.items.len() >= 500 || href_bytes > 256 * 1024 {
            result.limited = true;
            return false;
        }
        if start < offset {
            (offset, line, column) = (0, 1, 1);
        }
        for ch in text[offset..start].chars() {
            if ch == '\n' {
                line += 1;
                column = 1;
            } else {
                column += ch.len_utf16();
            }
        }
        offset = start;
        result.items.push(ReferenceLocation {
            href: href.into(),
            line,
            column,
        });
        true
    };
    let mut raw_html_tag = None;
    for (event, span) in Parser::new_ext(text, reference_parser_options()).into_offset_iter() {
        match event {
            Event::Start(Tag::Link {
                link_type: LinkType::Email,
                ..
            }) => {}
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. })
                if raw_html_tag.is_none() =>
            {
                if !record(span.start, &dest_url) {
                    break;
                }
            }
            Event::Html(_) | Event::InlineHtml(_) => {
                let mut attributes = Vec::new();
                html_reference_spans(text, span, &mut raw_html_tag, &mut attributes, true);
                if !attributes
                    .iter()
                    .all(|attr| record(attr.range.start, &attr.destination))
                {
                    break;
                }
            }
            _ => {}
        }
    }
    result
}

#[tauri::command]
pub async fn markdown_reference_locations(text: String) -> Result<ReferenceLocations, String> {
    tauri::async_runtime::spawn_blocking(move || reference_locations(&text))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_reference_uses_and_nested_images_at_utf16_source_positions() {
        let text = "# Title\r\n\r\n😀 [one][ref] and [ref][]\r\n[![logo][img]](guide.md#part-1)\r\n\r\n[ref]: guide.md#part\r\n[img]: missing.png\r\n\r\n`[example](bad.md)`\r\n";
        let result = reference_locations(text);
        let actual: Vec<_> = result
            .items
            .iter()
            .map(|item| (item.href.as_str(), item.line, item.column))
            .collect();
        assert_eq!(
            actual,
            [
                ("guide.md#part", 3, 4),
                ("guide.md#part", 3, 19),
                ("guide.md#part-1", 4, 1),
                ("missing.png", 4, 2)
            ]
        );
        assert!(!result.limited);
    }

    #[test]
    fn reports_limits_and_omits_external_links_code_and_unused_definitions() {
        let text = "<somebody@example.org> [web](https://example.org)\n\n[unused]: gone.md\n\n"
            .to_owned()
            + &"[x](local.md) ".repeat(501);
        let result = reference_locations(&text);
        assert!(result.limited);
        assert_eq!(result.items.len(), 500);
        assert!(result.items.iter().all(|i| i.href == "local.md"));
    }

    #[test]
    fn html_links_and_images_ignore_lookalike_attributes_and_code() {
        let text = r#"<a title="fake href='wrong.md'" href="a.md#part">a</a> <img data-src="fake.png" src="real.png">
<pre><a href="hidden.md">example</a></pre>"#;
        let items = reference_locations(text).items;
        assert_eq!(
            items
                .iter()
                .map(|item| item.href.as_str())
                .collect::<Vec<_>>(),
            ["a.md#part", "real.png"]
        );
        for item in items {
            assert!(
                text.lines().nth(item.line - 1).unwrap()[item.column - 1..].starts_with(&item.href)
            );
        }
    }

    #[test]
    fn lists_markdown_and_subdirectories_using_workspace_exclusions() {
        let root = std::env::temp_dir().join(format!("otterdive-ref-scan-{}", std::process::id()));
        fs::create_dir_all(root.join("VENDOR")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join(".hidden.md"), "").unwrap();
        fs::write(root.join("README.MDX"), "").unwrap();
        fs::write(root.join("image.png"), "").unwrap();
        let entries = list_directory(&root, false, "target;vendor").unwrap();
        assert_eq!(entries.files, [root.join("README.MDX")]);
        assert_eq!(entries.directories, [root.join("docs")]);
        assert_eq!(entries.excluded, 2);
        assert!(list_directory(&root.join("gone"), true, "").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
