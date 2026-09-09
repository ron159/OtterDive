//! cargo run -p otterdive-core --release --example benchmark_full_load -- /path/to/file
//! Compare complete read + decode + newline detection, alternating both paths.
use otterdive_core::{
    LineEnding,
    fs::{decode_bytes, decode_owned_bytes},
};
use std::{hint::black_box, time::Instant};

fn main() {
    let path = std::env::args_os().nth(1).expect("file path required");
    let mut copied = Vec::new();
    let mut reused = Vec::new();
    for round in 0..12 {
        for reuse in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let started = Instant::now();
            let bytes = std::fs::read(&path).unwrap();
            let decoded = if reuse {
                decode_owned_bytes(bytes)
            } else {
                decode_bytes(&bytes)
            };
            black_box(LineEnding::detect(&decoded.text));
            black_box(&decoded.text);
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            if round >= 2 {
                (if reuse { &mut reused } else { &mut copied }).push(elapsed);
            }
        }
    }
    copied.sort_by(f64::total_cmp);
    reused.sort_by(f64::total_cmp);
    println!("Full-file read/decode/newline detection (10 measured rounds, warm cache)");
    println!(
        "bytes={} copied_median_ms={:.2} reused_median_ms={:.2}",
        std::fs::metadata(path).unwrap().len(),
        (copied[4] + copied[5]) / 2.0,
        (reused[4] + reused[5]) / 2.0
    );
}
