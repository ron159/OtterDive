use otterdive_core::{SearchOptions, analyse::CancellationToken, fs::search_directory_stream};
use std::fs;

#[test]
fn batches_arrive_before_completion_and_cancellation_preserves_partial_results() {
    let dir = std::env::temp_dir().join(format!("otterdive-stream-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("log.txt"), "error here\n".repeat(2000)).unwrap();
    let cancel = CancellationToken::new();
    let mut count = 0;
    let summary = search_directory_stream(
        &dir,
        "error",
        &SearchOptions::default(),
        &cancel,
        10000,
        |batch| {
            let size: usize = batch.hits.iter().map(|hit| hit.matches.len()).sum();
            assert!(size <= 128);
            count += size;
            if count >= 128 {
                cancel.cancel();
            }
            true
        },
    )
    .unwrap();
    assert!(summary.cancelled);
    assert_eq!(count, 128);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn result_limit_stops_dense_matches_and_preserves_locations() {
    let dir = std::env::temp_dir().join(format!("otterdive-stream-limit-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("log.txt"), "中文 error\n".repeat(100)).unwrap();
    let mut matches = Vec::new();
    let summary = search_directory_stream(
        &dir,
        "error",
        &SearchOptions::default(),
        &CancellationToken::new(),
        10,
        |batch| {
            matches.extend(batch.hits.into_iter().flat_map(|hit| hit.matches));
            true
        },
    )
    .unwrap();
    assert!(summary.truncated);
    assert_eq!(matches.len(), 10);
    assert_eq!(matches[9].line, 10);
    assert_eq!(matches[0].column, 4);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn pre_cancelled_search_does_not_scan_and_oversize_files_are_reported() {
    let dir = std::env::temp_dir().join(format!("otterdive-stream-skip-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("log.txt"), "error".repeat(100)).unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let summary = search_directory_stream(
        &dir,
        "error",
        &SearchOptions::default(),
        &cancel,
        100,
        |_| panic!("pre-cancel must not emit"),
    )
    .unwrap();
    assert!(summary.cancelled);
    assert_eq!(summary.files_scanned, 0);
    let mut skipped = Vec::new();
    let options = SearchOptions {
        max_file_size: 10,
        ..Default::default()
    };
    search_directory_stream(
        &dir,
        "error",
        &options,
        &CancellationToken::new(),
        100,
        |batch| {
            skipped.extend(batch.skipped);
            true
        },
    )
    .unwrap();
    assert_eq!(skipped.len(), 1);
    assert!(skipped[0].contains("log.txt"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn large_file_search_keeps_more_than_fifty_thousand_short_results() {
    let dir = std::env::temp_dir().join(format!("otterdive-stream-full-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let line = format!("中文 error\n{}\n", "x".repeat(700));
    fs::write(dir.join("log.txt"), line.repeat(50_001)).unwrap();
    let options = SearchOptions {
        max_file_size: u64::MAX,
        ..Default::default()
    };
    let mut count = 0;
    let mut last_line = 0;
    let summary = search_directory_stream(
        &dir,
        "error",
        &options,
        &CancellationToken::new(),
        usize::MAX,
        |batch| {
            assert!(batch.skipped.is_empty());
            for file in batch.hits {
                assert!(file.matches.len() <= 128);
                for hit in file.matches {
                    count += 1;
                    last_line = hit.line;
                    assert_eq!(hit.column, 4);
                }
            }
            true
        },
    )
    .unwrap();
    fs::remove_dir_all(dir).unwrap();
    assert!(!summary.truncated && !summary.cancelled);
    assert_eq!(summary.files_scanned, 1);
    assert_eq!(count, 50_001);
    assert_eq!(last_line, 100_001);
}

#[test]
fn directory_search_bounds_long_line_previews_and_preserves_full_match_endpoints() {
    let dir = std::env::temp_dir().join(format!("otterdive-stream-preview-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let text = format!("{}{}\nend", "甲😀 ".repeat(8_000), "X".repeat(3_000));
    fs::write(dir.join("log.txt"), &text).unwrap();
    let options = SearchOptions {
        mode: otterdive_core::SearchMode::Regex,
        ..Default::default()
    };
    let mut hits = Vec::new();
    search_directory_stream(
        &dir,
        r"X+\nend",
        &options,
        &CancellationToken::new(),
        100,
        |batch| {
            hits.extend(batch.hits.into_iter().flat_map(|file| file.matches));
            true
        },
    )
    .unwrap();
    let hit = &hits[0];
    assert_eq!((hit.line, hit.column), (1, 32_001));
    assert_eq!(hit.end_position, Some((2, 4)));
    assert!(hit.line_text_start_column > 1);
    assert!(hit.line_text.len() <= 4096 && hit.matched_text.len() <= 2048);
    assert_eq!(hit.range.end, text.len());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn directory_preview_byte_budget_is_shared_across_files_and_reported_by_both_apis() {
    let dir = std::env::temp_dir().join(format!("otterdive-stream-bytes-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let text = format!("{}{}", "hit ".repeat(4300), "x".repeat(4096));
    for name in ["first.json", "second.json"] {
        fs::write(dir.join(name), &text).unwrap();
    }
    let options = SearchOptions::default();
    let mut bytes = 0;
    let mut count = 0;
    let summary = search_directory_stream(
        &dir,
        "hit",
        &options,
        &CancellationToken::new(),
        usize::MAX,
        |report| {
            for hit in report.hits.into_iter().flat_map(|file| file.matches) {
                bytes += hit.line_text.len() + hit.matched_text.len();
                count += 1;
            }
            true
        },
    )
    .unwrap();
    assert!(summary.truncated && !summary.cancelled);
    assert_eq!(summary.files_scanned, 2);
    assert!(count > 4300 && count < 8600);
    assert!(bytes <= 32 * 1024 * 1024 && bytes + 4099 > 32 * 1024 * 1024);
    let report = otterdive_core::search_directory(&dir, "hit", &options).unwrap();
    assert!(report.truncated);
    assert_eq!(report.hits.len(), 2);
    assert_eq!(
        report
            .hits
            .iter()
            .map(|hit| hit.matches.len())
            .sum::<usize>(),
        count
    );
    fs::remove_dir_all(dir).unwrap();
}
