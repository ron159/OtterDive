# Changelog

## 0.8.7 — 2026-10-23

### Fixed

- Reopened tabs retain disk revisions, source encodings, and pending metadata so external-change conflict protection remains active. Failed paged-file reopens remain retryable.
- Auto-save is rescheduled for edits made during a slow save. First saves and Save As retain document bookmarks.
- Saving through a symbolic link updates its target while preserving the link. Existing directories and devices are rejected before any replacement is attempted.
- Search and replacement locations now agree with editor CR/CRLF/LF lines and UTF-16 columns. Filename globs respect ordering and anchors, including compound suffixes and single-character wildcards. Explicitly selected hidden root directories remain searchable.
- Fixed relative links and images in Markdown files at the filesystem root, and named capture replacement involving emoji, Unicode properties, and Chinese whole-word matches.
- SQL formatting preserves comments, multiline strings, and quoted identifiers instead of compacting their contents or swallowing projection fields into a comment.

## 0.8.6 — 2026-10-22

### Fixes

- Make pinned comparisons a compact floating strip below the filters, spanning the top of the results list. It stays visible while scrolling search results without increasing the height of the results or editor area. Collapse, reopen, remove individual items or clear all pins.
- Align pinned rows with the search results' line-number column, text start and font. Horizontal scrolling is synchronized in both directions between pins and search results, preserving alignment at either end, when changing font size and when extracting secondary results. Long pins retained from previous searches share the scroll range with shorter results; pins remain independently browsable after clearing the search.
- Fix Analyse actions such as Pin and Copy being pushed outside the clickable area in WebKit when the results area is short.

## 0.8.5 — 2026-10-22

### Improvements

- Add **Edit → Optimize Chinese/English spacing** for selections or complete Markdown and plain-text documents. Insert spaces between Han characters and English letters or digits while preserving line breaks, indentation and existing whitespace. Protect Markdown code, link destinations, reference identifiers, metadata, HTML and math. The changes can be undone.
- Move pinned comparisons into a floating panel at the top of the result content, with collapse and reopen controls. Multiple pins, source information and independent snapshots remain available without increasing the results area's height or occupying an extra layout row.

### Fixes

- Remove gradient glows, blurred panel backgrounds and outer card glows from dark settings pages while retaining selection borders and colors. Applies to dark system appearance and all dark color presets.
- Fix Markdown instant editing highlighting matches while the find bar still reports zero results. Safely skip result groups without detail rows so counts and previous/next navigation update correctly.
- Unify whole-word boundaries in instant editing and source search. Fix missed Chinese matches, false positives for English adjacent to Chinese, incorrect boundaries around regex alternatives, and false positives next to Unicode supplementary-plane letters and digits.

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
