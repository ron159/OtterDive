<p align="center">
  <img src="crates/otterdive-app/icons/icon-source.png" width="144" height="144" alt="OtterDive icon" />
</p>

<h1 align="center">OtterDive</h1>

<p align="center">Dive into massive text. Surface what matters.</p>

<p align="center"><a href="README.md">简体中文</a> · English</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2563eb.svg" alt="Windows, macOS and Linux" />
  <img src="https://img.shields.io/badge/Tauri-2-24c8db.svg" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/Monaco-0.57.0-007acc.svg" alt="Monaco Editor" />
</p>

OtterDive is a local-first desktop tool for text, logs, Markdown, and source code. It brings fast opening and editing, workspace search, regular expressions, Analyse rule processing, and structured result browsing into one workflow: dive into large bodies of text and bring the relevant content back to the surface.

## Why OtterDive

Large logs, cross-file searches, and complex rule analysis often force you to jump between an editor and command-line tools. OtterDive keeps editing, search, regular expressions, Analyse, and result browsing in one window, with local-first file processing.

## ✨ Feature Highlights

- 📂 **Files and workspaces**: Open content in single-file or workspace mode by selecting or dragging files and folders.
- ✍️ **Monaco editing experience**: Detect dozens of languages by file name and extension, with syntax highlighting, completion, folding, bracket matching, and multiple cursors; normal Open automatically uses background on-demand reading above 20 MiB. Monaco loads neighboring chunks during continuous scrolling and retains a bounded window. The existing read-only protection remains.
- 🧹 **Local code formatting**: Format JavaScript, TypeScript, JSX, TSX, JSON, JSONC, Markdown, TOML, Python, and Dockerfile content with bundled dprint WASM plugins, plus dedicated SQL formatting, without runtime network access.
- ⌨️ **Familiar keybindings**: Choose the built-in VS Code or Notepad++ profile, browse commands by group, and customize bindings.
- 📝 **Complete Markdown workflow**: Use instant editing, source and split-preview modes, outlines, tables, task lists, math, remote images, Mermaid, PlantUML, and Vega diagrams.
- 🗂️ **Safe document organization**: Move deleted workspace entries to the system trash. Preview and update Markdown links and image references when renaming or moving files and folders.
- 📖 **Continuous reading**: Restore Markdown reading positions and navigate back and forward after following document links.
- 📋 **Templates and snippets**: Create documents from templates, insert snippets, save the current document as a template, and manage local templates with title, date, and time variables.
- 📦 **Portable document bundles**: Export the current Markdown, linked documents, images, and local attachments as a ZIP with relative links, reporting missing or out-of-scope resources.
- 🔎 **Multi-scope search**: Search the current file, all open documents, or an entire workspace with normal, extended, and regular-expression modes, result navigation, and replacement previews. Workspace searches deliver batches and can be cancelled while keeping partial results.
- 📌 **Pin a result for comparison**: Append independent snapshots to a shared comparison area. Search supports selected rows; Analyse supports multiple lines and multiple selections, including complete analysis payloads. Each item retains its source and line/column. Repeated pins are deduplicated; scrolling, new searches, pane switches and source closure preserve pins. Remove one or clear all. Pins are not restored after restart.
- 🧮 **Analyze search results**: Chain inclusion/exclusion filters, capture-group extraction and deduplication over current or historical results, with undo, CSV/JSON export and preserved source locations.
- 🧩 **Analyse rule processing**: Import compatible XML profiles, run Normal, Escaped, Regex, and multiline Regex rules, and generate merged results, styles, bookmarks, HTML, and RTF output.
- 🔤 **Encoding and line endings**: Detect and convert UTF-8, UTF-8 BOM, UTF-16, and ANSI encodings, with LF, CRLF, and CR support.
- 💾 **Session restoration**: Restore drafts, open tabs, window placement, workspaces, search history, Analyse settings, and editor preferences.
- 🎨 **Consistent desktop experience**: Use custom window chrome, light and dark themes, file-type icons, and configurable editor appearance.

ZIP and binary files are rejected by the text editor. Normal Open automatically handles 32/33 MiB and larger text with approximately 256 KiB background reads, automatic forward/backward loading during scrolling, and at most three neighboring chunks retained. A whole-file position slider, source-line navigation, cancellation and immediate tab closure remain available. Files above 20 MiB are read-only: full editing, Save As and treating a partial window as a whole-document export are unavailable.

On-demand documents still search and Analyse the complete source file in the background, with global source line/column navigation. Full-file operations have a 512 MiB memory safety limit. Search returns up to 100,000 results per on-demand file with an explicit stop notice, and long-line previews are bounded to about 4 KiB without changing source locations. Analyse explicitly rejects a single result above 256 KiB; ordinary multiline payloads are preserved. Cross-page selection search and full-model comparisons are unavailable. Workspace search returns results in batches, supports cancellation, and no longer skips files above 20 MiB by default or applies the former 50,000-match / 32 MiB result limits. Workspace replacement still skips files above 20 MiB. Practical capacity and performance depend on available memory, file size, and search result volume. Search result history retains the five most recent searches.

## Project Status

The current release is **v0.8.4**. See the [English changelog](CHANGELOG_EN.md) or [中文更新日志](CHANGELOG.md). OtterDive is under active development. GitHub Releases provide Windows x64, macOS ARM64, and Linux x64 packages.

The known macOS bundle signing/notarization defect remains unresolved; Gatekeeper approval is not guaranteed. Updater signatures are distinct from Apple Developer ID signing and notarization.

## Local Development

Requirements:

- Rust stable
- Node.js 20.19 or later
- npm 8 or later
- Windows WebView2 Runtime

Install frontend dependencies:

```powershell
cd crates\otterdive-app\frontend
npm install
```

Start the desktop app in development mode:

```powershell
cd crates\otterdive-app
cargo tauri dev
```

Build a Windows installer:

```powershell
cd crates\otterdive-app
cargo tauri build
```

Build artifacts are written to `target\release\bundle`.

## Validation

```powershell
cargo test --workspace

cd crates\otterdive-app\frontend
npm run test:keybindings
npm run build
```

## Project Structure

```text
crates/otterdive-app/           Tauri desktop application and frontend
crates/otterdive-core/          Document, encoding, search, and filesystem core
crates/otterdive-app/frontend/  Monaco and Markdown editing experience
scripts/                        Upstream synchronization and development scripts
```

## Upstream Projects and Acknowledgements

OtterDive is released under the [MIT License](LICENSE).

OtterDive is a search-enhanced edition of the upstream [Notra](https://github.com/syscryer/Notra) project. It builds on Notra with a stronger focus on workspace search, regular expressions, Analyse, logs, and large-text workflows. We thank the original Notra authors and contributors for the product and engineering foundation.

The instant Markdown experience evolves from the [MarkText](https://github.com/marktext/marktext) Muya editor. Its pinned upstream revision and licenses are kept in `crates/otterdive-app/frontend/vendor/marktext-muya`. Code editing is powered by [Monaco Editor](https://github.com/microsoft/monaco-editor), with multi-language formatting provided by [dprint](https://dprint.dev/) WASM plugins. We thank these upstream projects and their contributors; all third-party dependencies remain subject to their respective licenses.
