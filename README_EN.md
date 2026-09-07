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
  <img src="https://img.shields.io/badge/Monaco-0.53-007acc.svg" alt="Monaco Editor" />
</p>

OtterDive is a local-first desktop tool for text, logs, Markdown, and source code. It brings fast opening and editing, workspace search, regular expressions, Analyse rule processing, and structured result browsing into one workflow: dive into large bodies of text and bring the relevant content back to the surface.

## Why OtterDive

Large logs, cross-file searches, and complex rule analysis often force you to jump between an editor and command-line tools. OtterDive keeps editing, search, regular expressions, Analyse, and result browsing in one window, with local-first file processing.

## ✨ Feature Highlights

- 📂 **Files and workspaces**: Open content in single-file or workspace mode by selecting or dragging files and folders.
- ✍️ **Monaco editing experience**: Detect dozens of languages by file name and extension, with syntax highlighting, completion, folding, bracket matching, and multiple cursors; files above 20 MiB use a dedicated read-only viewer with on-demand pages and navigation by original line number.
- 🧹 **Local code formatting**: Format JavaScript, TypeScript, JSX, TSX, JSON, JSONC, Markdown, TOML, Python, and Dockerfile content with bundled dprint WASM plugins, plus dedicated SQL formatting, without runtime network access.
- ⌨️ **Familiar keybindings**: Choose the built-in VS Code or Notepad++ profile, browse commands by group, and customize bindings.
- 📝 **Complete Markdown workflow**: Use instant editing, source and split-preview modes, outlines, tables, task lists, math, remote images, Mermaid, PlantUML, and Vega diagrams.
- 🔎 **Multi-scope search**: Search the current file, all open documents, or an entire workspace with normal, extended, and regular-expression modes, result navigation, and replacement previews. Workspace searches deliver batches and can be cancelled while keeping partial results.
- 🧮 **Analyze search results**: Chain inclusion/exclusion filters, capture-group extraction and deduplication over current or historical results, with undo, CSV/JSON export and preserved source locations.
- 🧩 **Analyse rule processing**: Import compatible XML profiles, run Normal, Escaped, Regex, and multiline Regex rules, and generate merged results, styles, bookmarks, HTML, and RTF output.
- 🔤 **Encoding and line endings**: Detect and convert UTF-8, UTF-8 BOM, UTF-16, and ANSI encodings, with LF, CRLF, and CR support.
- 💾 **Session restoration**: Restore drafts, open tabs, window placement, workspaces, search history, Analyse settings, and editor preferences.
- 🎨 **Consistent desktop experience**: Use custom window chrome, light and dark themes, file-type icons, and configurable editor appearance.

In large-file mode, editor search covers the current page; use Analyse for full-file rule processing. The first jump to a distant line builds a sparse index on demand. Very long lines preview their first 64 KiB. Workspace search skips files above 20 MiB and retains up to 50,000 matches or 32 MiB of result text per run, explicitly reporting cancellation, limits and skipped files. Result history keeps the five most recent searches.

## Project Status

OtterDive is under active development. GitHub Releases provide Windows x64, macOS ARM64, and Linux x64 packages. 

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
