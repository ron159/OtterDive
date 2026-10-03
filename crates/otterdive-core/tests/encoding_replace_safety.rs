use otterdive_core::fs::{
    ReplaceSelection, apply_selected_directory_replace, decode_bytes_with_encoding, encode_text,
    preview_directory_replace, undo_directory_replace, write_text_atomically,
};
use otterdive_core::{Document, EncodingKind, SearchMode, SearchOptions};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{fs, path::PathBuf};

static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "otterdive-safe-replace-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn explicit_legacy_encodings_roundtrip() {
    for (encoding, text) in [
        (EncodingKind::Gbk, "简体中文"),
        (EncodingKind::Big5, "繁體中文"),
        (EncodingKind::ShiftJis, "日本語"),
        (EncodingKind::Windows1252, "café €"),
    ] {
        let bytes = encode_text(text, encoding).unwrap();
        let decoded = decode_bytes_with_encoding(&bytes, encoding);
        assert!(!decoded.had_errors);
        assert_eq!(decoded.text, text);
    }
}

#[test]
fn malformed_sequences_are_reported_including_odd_utf16() {
    for (encoding, bytes) in [
        (EncodingKind::Utf8, vec![0xFF]),
        (EncodingKind::Gbk, vec![0x81]),
        (EncodingKind::Big5, vec![0x81]),
        (EncodingKind::ShiftJis, vec![0x81]),
        (EncodingKind::Utf16Le, vec![0x00, 0xD8]),
        (EncodingKind::Utf16Be, vec![0x00]),
    ] {
        assert!(
            decode_bytes_with_encoding(&bytes, encoding).had_errors,
            "{encoding:?}"
        );
    }
}

#[test]
fn lossy_saves_leave_original_bytes_untouched() {
    let dir = TestDir::new();
    let path = dir.0.join("document.txt");
    fs::write(&path, b"original").unwrap();
    for encoding in [
        EncodingKind::Gbk,
        EncodingKind::Big5,
        EncodingKind::ShiftJis,
        EncodingKind::Windows1252,
    ] {
        assert!(write_text_atomically(&path, "emoji 🦦", encoding).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
    }
    fs::write(&path, [0xEF, 0xBB, 0xBF, 0xFF]).unwrap();
    let mut doc = Document::open(&path).unwrap();
    assert!(doc.meta.decode_had_errors && doc.meta.read_only);
    assert!(doc.save_as(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), [0xEF, 0xBB, 0xBF, 0xFF]);
}

#[test]
fn selected_regex_matches_use_expanded_captures_and_preserve_other_matches() {
    let dir = TestDir::new();
    let path = dir.0.join("sample.txt");
    fs::write(&path, "one=12 two=34 three=56").unwrap();
    let options = SearchOptions {
        mode: SearchMode::Regex,
        ..Default::default()
    };
    let (preview, skipped) =
        preview_directory_replace(&dir.0, r"\b(\w+)=(\d+)\b", "$2:$1", &options).unwrap();
    assert!(skipped.is_empty());
    assert_eq!(
        preview[0].outcome.replacements,
        ["12:one", "34:two", "56:three"]
    );
    let mut batch = apply_selected_directory_replace(
        &preview,
        &[ReplaceSelection {
            file_id: 0,
            match_ids: vec![2, 0, 2],
        }],
    )
    .unwrap();
    assert_eq!(batch.files[0].count, 2);
    assert_eq!(fs::read_to_string(&path).unwrap(), "12:one two=34 56:three");
    assert_eq!(undo_directory_replace(&mut batch), (1, vec![]));
    assert_eq!(fs::read_to_string(&path).unwrap(), "one=12 two=34 three=56");
    assert!(batch.files.is_empty());
}

#[test]
fn stale_preview_and_stale_undo_never_overwrite_external_edits() {
    let dir = TestDir::new();
    let path = dir.0.join("sample.txt");
    fs::write(&path, "before").unwrap();
    let (preview, _) =
        preview_directory_replace(&dir.0, "before", "after", &SearchOptions::default()).unwrap();
    fs::write(&path, "external").unwrap();
    let selection = [ReplaceSelection {
        file_id: 0,
        match_ids: vec![0],
    }];
    let batch = apply_selected_directory_replace(&preview, &selection).unwrap();
    assert!(batch.files.is_empty());
    assert_eq!(batch.failures.len(), 1);
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    fs::write(&path, "before").unwrap();
    let mut batch = apply_selected_directory_replace(&preview, &selection).unwrap();
    fs::write(&path, "edited after replace").unwrap();
    let (restored, failures) = undo_directory_replace(&mut batch);
    assert_eq!(restored, 0);
    assert_eq!(failures.len(), 1);
    assert_eq!(batch.files.len(), 1);
    assert_eq!(fs::read_to_string(&path).unwrap(), "edited after replace");
}

#[test]
fn invalid_selection_is_validated_before_any_file_is_written() {
    let dir = TestDir::new();
    let path = dir.0.join("sample.txt");
    fs::write(&path, "before").unwrap();
    let (preview, _) =
        preview_directory_replace(&dir.0, "before", "after", &SearchOptions::default()).unwrap();
    let selections = [
        ReplaceSelection {
            file_id: 0,
            match_ids: vec![0],
        },
        ReplaceSelection {
            file_id: 9,
            match_ids: vec![0],
        },
    ];
    assert!(apply_selected_directory_replace(&preview, &selections).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "before");
}

#[test]
fn malformed_file_is_excluded_from_replacement_preview() {
    let dir = TestDir::new();
    let path = dir.0.join("sample.txt");
    fs::write(&path, [0xEF, 0xBB, 0xBF, b'a', 0xFF]).unwrap();
    let (preview, skipped) =
        preview_directory_replace(&dir.0, "a", "b", &SearchOptions::default()).unwrap();
    assert!(preview.is_empty());
    assert!(skipped.iter().any(|message| message.contains("解码")));
}

#[test]
fn partial_failure_remains_reversible_and_restores_original_encoding_bytes() {
    let dir = TestDir::new();
    let first = dir.0.join("first.txt");
    let second = dir.0.join("second.txt");
    let original = encode_text("中文 before\r\n", EncodingKind::Utf16Le).unwrap();
    fs::write(&first, &original).unwrap();
    fs::write(&second, "before").unwrap();
    let (preview, _) =
        preview_directory_replace(&dir.0, "before", "after", &SearchOptions::default()).unwrap();
    fs::write(&second, "external").unwrap();
    let selected = preview
        .iter()
        .enumerate()
        .map(|(file_id, _)| ReplaceSelection {
            file_id,
            match_ids: vec![0],
        })
        .collect::<Vec<_>>();
    let mut batch = apply_selected_directory_replace(&preview, &selected).unwrap();
    assert_eq!(batch.files.len(), 1);
    assert_eq!(batch.failures.len(), 1);
    assert_eq!(batch.failures[0].0, second);
    assert_eq!(undo_directory_replace(&mut batch), (1, vec![]));
    assert_eq!(fs::read(&first).unwrap(), original);
    assert_eq!(fs::read_to_string(&second).unwrap(), "external");
}

#[test]
fn nonrepresentable_workspace_replacement_reports_failure_without_mutation() {
    let dir = TestDir::new();
    let path = dir.0.join("legacy.txt");
    let original = encode_text("中文 before", EncodingKind::Gbk).unwrap();
    fs::write(&path, &original).unwrap();
    let (preview, _) =
        preview_directory_replace(&dir.0, "before", "🦦", &SearchOptions::default()).unwrap();
    let batch = apply_selected_directory_replace(
        &preview,
        &[ReplaceSelection {
            file_id: 0,
            match_ids: vec![0],
        }],
    )
    .unwrap();
    assert!(batch.files.is_empty());
    assert_eq!(batch.failures.len(), 1);
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn preview_bounds_repeated_long_line_storage() {
    let dir = TestDir::new();
    fs::write(dir.0.join("dense.txt"), "a".repeat(10_000)).unwrap();
    let (preview, skipped) =
        preview_directory_replace(&dir.0, "a", "b", &SearchOptions::default()).unwrap();
    assert!(preview.is_empty());
    assert!(skipped.iter().any(|message| message.contains("限制")));
}
