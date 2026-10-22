<p align="center">
  <img src="crates/otterdive-app/icons/icon-source.png" width="144" height="144" alt="OtterDive icon" />
</p>

<h1 align="center">OtterDive</h1>

<p align="center">潜入海量文本，捞出真正重要的内容。</p>

<p align="center">简体中文 · <a href="README_EN.md">English</a></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2563eb.svg" alt="Windows, macOS and Linux" />
  <img src="https://img.shields.io/badge/Tauri-2-24c8db.svg" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/Monaco-0.57.0-007acc.svg" alt="Monaco Editor" />
</p>

OtterDive 是一个面向文本、日志、Markdown 和代码的本地优先桌面工具。它把快速打开与编辑、工作区搜索、Regex、Analyse 规则分析和结构化结果浏览放进同一个工作流：潜入大量文本，再把真正相关的内容带回表面。

## 为什么选择 OtterDive

面对大型日志、跨文件搜索和复杂规则分析，在编辑器与命令行工具之间频繁切换会打断排查节奏。OtterDive 将编辑、搜索、Regex、Analyse 和结果浏览集中在同一个窗口中，并优先在本地处理文件。

## ✨ 功能亮点

- 📂 **文件与工作区**：以单文件或工作区模式打开内容，支持直接选择或拖放文件和目录。
- ✍️ **Monaco 编辑体验**：按文件名和扩展名识别数十种语言，提供高亮、代码提示、折叠、括号匹配和多光标；普通文本自动打开；超过 20 MiB 时后台按需读取，Monaco 连续滚动加载相邻分块并保留有限窗口，仍维持原有只读保护。
- 🧹 **本地代码格式化**：使用随应用打包的 dprint WASM 格式化 JavaScript、TypeScript、JSX、TSX、JSON、JSONC、Markdown、TOML、Python 与 Dockerfile，并提供 SQL 专用格式化；运行时无需联网。
- ⌨️ **熟悉的快捷键**：内置 VS Code 与 Notepad++ 两套方案，可按命令分组查看并自定义按键绑定。
- 📝 **完整的 Markdown 工作流**：支持即时编辑、源码与分屏预览，以及大纲、表格、任务列表、数学公式、网络图片、Mermaid、PlantUML 和 Vega 图表。
- 🗂️ **安全整理文档**：文件树删除移入系统回收站；重命名或移动文件、文件夹时预览并维护工作区中的 Markdown 链接和图片引用。
- 📖 **连续阅读**：记住 Markdown 阅读位置，支持文档链接跳转后的前进与后退。
- 📋 **模板与片段**：从模板新建、插入片段或保存当前文档为模板，支持标题、日期和时间变量，并可管理本地自定义模板。
- 📦 **文档与附件打包**：将当前 Markdown、引用的文档、图片和本地附件导出为 ZIP，维护包内相对路径；缺失或超出范围的资源会明确提示。
- 🔎 **多范围搜索**：搜索当前文件、全部已打开文档或整个工作区，支持普通、扩展和正则表达式模式、结果导航与替换预览；工作区搜索分批返回，可随时取消并保留已找到的结果。
- 📌 **结果固定对比**：点击结果行旁的图钉，将快照追加到共享固定区；搜索支持拖选多行，Analyse 支持多行和多选区。每项独立保留完整结果与文件来源、行列号，重复固定会去重；滚动、重新搜索、切换栏目或关闭来源标签后仍可对比。可逐项取消或清空全部；固定内容不跨重启保存。
- 🧮 **结果内二次分析**：对当前或历史搜索结果连续筛选、排除、提取捕获组与去重，支持撤销以及 CSV/JSON 导出，并保留来源位置。
- 🧩 **Analyse 规则分析**：导入兼容 XML 规则，运行 Normal、Escaped、Regex 与多行 Regex 分析，并生成合并结果、样式标记、书签、HTML 和 RTF 输出。
- 🔤 **编码与行尾处理**：识别并转换 UTF-8、UTF-8 BOM、UTF-16 和 ANSI 编码，可切换 LF、CRLF 与 CR 行尾。
- 💾 **会话恢复**：恢复临时文档、打开标签、窗口位置、工作区、搜索历史、Analyse 配置和编辑设置。
- 🎨 **一致的桌面体验**：提供自绘标题栏、亮色与深色主题、文件类型图标和可调整的编辑器外观。

ZIP 和二进制文件不会作为文本载入。正常“打开文件”入口会自动选择内部读取方案，32/33 MiB 等大文本无需手动切换：每次后台读取约 256 KiB，滚动时自动追加/回读，最多保留三个相邻分块；支持全文件位置滑块、源行号跳转、取消读取和直接关闭标签。超过 20 MiB 的文件仅支持只读浏览，不提供完整编辑、另存为或把当前窗口当作全文导出。

按需文档的全文查找和 Analyse 在后台读取完整源文件，结果按源文件行列定位，不会把查找范围缩成可见窗口。全文操作当前有 512 MiB 内存安全上限；每个按需文件的查找最多返回 100,000 项并明确提示停止，超长行搜索预览最多约 4 KiB，定位仍使用完整源行列。Analyse 单项超过 256 KiB 时明确报错，保留正常多行分析结果。跨分块选区查找和全模型比较暂不可用。工作区搜索分批返回并支持取消，不再默认跳过大文件或限制为 50,000 条 / 32 MiB 结果。工作区替换仍跳过超过 20 MiB 的文件。实际处理能力与性能仍受可用内存、文件大小和搜索结果量影响。搜索结果历史保留最近五次。

## 当前状态

当前发布版本为 **v0.8.6**，更新内容见[中文更新日志](CHANGELOG.md)与[English changelog](CHANGELOG_EN.md)。OtterDive 仍在持续开发中，GitHub Releases 提供 Windows x64、macOS ARM64 与 Linux x64 安装包。

macOS 整包签名与公证的已知缺陷尚未修复，不能保证通过 Gatekeeper；应用更新签名不等于 Apple Developer ID 签名或公证。

## 本地开发

需要以下环境：

- Rust stable
- Node.js 20.19 或更高版本
- npm 8 或更高版本
- Windows WebView2 Runtime

安装前端依赖：

```powershell
cd crates\otterdive-app\frontend
npm install
```

启动桌面开发模式：

```powershell
cd crates\otterdive-app
cargo tauri dev
```

构建 Windows 安装包：

```powershell
cd crates\otterdive-app
cargo tauri build
```

产物位于 `target\release\bundle`。

## 验证

```powershell
cargo test --workspace

cd crates\otterdive-app\frontend
npm run test:keybindings
npm run build
```

## 项目结构

```text
crates/otterdive-app/           Tauri 桌面应用与前端界面
crates/otterdive-core/          文档、编码、搜索和文件系统核心
crates/otterdive-app/frontend/  Monaco 与 Markdown 编辑体验
scripts/                        上游同步及开发脚本
```

## 上游项目与致谢

OtterDive 使用 [MIT License](LICENSE) 开源。

OtterDive 基于上游项目 [Notra](https://github.com/syscryer/Notra) 演进，是对原项目的搜索增强版本，重点加强了工作区搜索、Regex、Analyse、日志与大文本处理工作流。感谢 Notra 原作者和贡献者打下的产品与工程基础。

Markdown 即时编辑能力基于 [MarkText](https://github.com/marktext/marktext) 的 Muya 编辑器演进，固定的上游版本和许可证保留在 `crates/otterdive-app/frontend/vendor/marktext-muya`。代码编辑能力由 [Monaco Editor](https://github.com/microsoft/monaco-editor) 提供，多语言格式化基于 [dprint](https://dprint.dev/) WASM 插件。感谢这些上游项目及其贡献者；各第三方依赖继续遵循其各自许可证。
