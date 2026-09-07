use otterdive_core::{EncodingKind, large_file::LargeFile};
use std::fs;

fn fixture(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("otterdive-page-{}-{name}", std::process::id()));
    fs::write(&path, bytes).unwrap();
    path
}
#[test]
fn pages_and_sparse_seek_preserve_original_lines() {
    let text = (1..5001)
        .map(|i| format!("日志 {i}\r\n"))
        .collect::<String>();
    let path = fixture("utf8", text.as_bytes());
    let mut file = LargeFile::open(&path, None).unwrap();
    let page = file.read_page(1).unwrap();
    assert!(page.text.starts_with("日志 1\n"));
    assert!(!page.eof);
    assert!(page.next_line <= 2001);
    assert_eq!(file.read_page(4999).unwrap().text, "日志 4999\n日志 5000\n");
    assert!(file.read_page(9000).unwrap().eof);
    assert!(file.read_page(3).unwrap().text.starts_with("日志 3\n"));
    fs::remove_file(path).unwrap();
}
#[test]
fn utf16_and_cr_only_keep_encoding_and_line_numbers() {
    for (name, encoding) in [("le", EncodingKind::Utf16Le), ("be", EncodingKind::Utf16Be)] {
        let bytes = otterdive_core::fs::encode_text("你好\r第二行\r末尾", encoding);
        let path = fixture(name, &bytes);
        let mut file = LargeFile::open(&path, None).unwrap();
        assert_eq!(file.read_page(2).unwrap().text, "第二行\n末尾");
        fs::remove_file(path).unwrap();
    }
}
#[test]
fn giant_line_has_bounded_preview_and_next_line_remains_accessible() {
    let path = fixture("long", ("x".repeat(2 * 1024 * 1024) + "\nnext").as_bytes());
    let mut file = LargeFile::open(&path, None).unwrap();
    let page = file.read_page(1).unwrap();
    assert!(page.truncated);
    assert!(page.text.len() < 300_000);
    assert_eq!(file.read_page(2).unwrap().text, "next");
    fs::remove_file(path).unwrap();
}
#[test]
fn changed_files_require_reopening_instead_of_using_stale_offsets() {
    let path = fixture("changed", b"first\nsecond");
    let mut file = LargeFile::open(&path, None).unwrap();
    fs::write(&path, b"changed").unwrap();
    assert!(file.read_page(2).is_err());
    fs::remove_file(path).unwrap();
}
