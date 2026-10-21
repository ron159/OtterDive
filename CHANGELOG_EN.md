# Changelog

## 0.8.4 — 2026-10-21

### Improvements

- Pin multiple independent search results by clicking rows or selecting several rows. Appending no longer replaces an existing pin. Duplicate results are deduplicated; remove one item or clear all.
- Analyse supports multiple lines and multiple selections. A multiline analysis item retains its complete actual payload, Pattern/style data and provenance. Search and Analyse share the comparison area; scrolling, new searches, pane switches and source-tab closure preserve pins. Pins are not restored after restart.
- Normal Open automatically handles 32/33 MiB and larger text. Above 20 MiB, background reads fetch approximately 256 KiB and continuous scrolling loads neighboring chunks while retaining at most three chunks. Whole-file position navigation, global source-line navigation, cancellation and closing in-flight reads are supported without manually switching readers.
- Retain ZIP/binary rejection, safe Chinese/emoji/UTF-16/GBK and CRLF chunk boundaries, and bounded long-line browsing. Full-file search and Analyse still read the entire source, with global result positions and disk-version checks before and after reading.

### Current limits and validation boundaries

- Files above 20 MiB remain read-only, consistent with the previous protection. Full editing, Save As, exporting the current window as a complete document, cross-page selection search and full-model comparison are unavailable.
- Background full-file search/Analyse for on-demand documents has a 512 MiB memory safety limit; exceeding it produces an explicit error, never a partial-file search. Search returns at most 100,000 results per on-demand file with an explicit stop notice. Long-line previews are about 4 KiB, matched-text previews about 2 KiB, and complete source locations remain available. Analyse explicitly rejects a single item above 256 KiB; ordinary multiline items remain complete. Full-file operations still require memory proportional to the source and results.
- Local validation: 186 Rust tests passed with one existing ignored test; 265 frontend tests passed, along with type checking, production build and macOS ARM64 compilation. Actual 32/33 MiB opening, continuous scrolling, tail search/Analyse, mixed pins, cancellation/closure, ZIP rejection and compact layout were exercised. Native WKWebView end-to-end behavior and final batch-selection gestures were not fully tested.
- **The known macOS bundle signing/notarization defect is not fixed in this release; Gatekeeper approval is not claimed.** Tauri updater signatures are distinct from Apple Developer ID signing and notarization. This release does not change system security settings.
