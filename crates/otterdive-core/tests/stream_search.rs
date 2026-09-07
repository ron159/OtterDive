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
