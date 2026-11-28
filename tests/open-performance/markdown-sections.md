# 超大 Markdown 章节阅读验证

大于 20 MiB 的 Markdown 在源码分块工具栏提供「按章节阅读」。UTF-8 和 UTF-8 BOM 文档按需扫描至文件末尾，目录保留标题、源行、字节范围以及跨章引用定义。筛选框支持全文件标题和节号。一次渲染一节，超过 256 KiB 的章节可以直接跳过或返回该节源码。脚注在本节内编号，图表围栏显示源码。切换标签、返回源码和取消读取都会使旧请求失效。

索引最多记录 16,384 项。引用上下文上限为 1,024 个定义、合计 64 KiB。目录控件最多挂载 41 个选项。遇到不支持的编码、原始 HTML 块或超出索引预算时，阅读区显示原因并提供查看源码的按钮。全文查找沿用磁盘搜索，点击结果定位到源码的全局行列。

## 复现

在仓库根目录执行以下命令。保留临时目录可将同一份原生输出交给浏览器验证。

```sh
export OTTERDIVE_SECTION_FIXTURE_DIR="$(mktemp -d)"
cargo test --locked -p otterdive-app large_chinese_section_file -- --nocapture
cd crates/otterdive-app/frontend
npm ci
npm test
npm run build
npm run preview
```

在第二个终端的前端目录执行下列命令，沿用前面的临时目录。脚本也接受指向 Playwright 模块入口的 `PLAYWRIGHT_MODULE`，以及指向本机 Chromium 的 `CHROME_EXECUTABLE`。

```sh
OTTERDIVE_SECTION_FIXTURE_DIR=/path/to/fixture \
MARKDOWN_QA_URL=http://127.0.0.1:1420 \
node scripts/verify-markdown-sections.mjs
```

Rust 测试通过正常打开路径生成元数据，扫描 21,564,556 字节的中文文件，验证两个同名章节、围栏内伪标题、跨章引用、超限节、文件末段和全文搜索结果。测试输出索引耗时、序列化大小、尾部读取字节数与耗时。浏览器测试打开完整工作台，使用 Rust 捕获的打开、分页、目录和搜索响应，按真实文件范围读取章节，经实际渲染器显示内容。测试操作包括 86,573 字节常规章节的单窗口渲染、目录筛选、同名标题锚点、脚注往返、超限提示、取消请求以及从全文命中回源码。截图写入临时目录的 `chapter.png` 和 `oversize.png`。

本机 macOS arm64 的一次 Rust debug 测量生成 243 个章节，索引 JSON 为 18,667 字节，扫描用时 708 ms。定位并读取尾章 102 字节用时 14 µs，全文命中第 38,894 行。计时包含文件系统缓存影响，可用上述测试在目标设备重复测量。

同机 Chrome 加载生产构建后，从点击章节入口到首个标题可见为 236 ms，从点击下一节到 86,573 字节章节的标题可见为 62 ms。浏览器使用已生成的原生索引，计时不含 Rust 扫描。超限节没有发起正文读取，取消操作发出了原生取消命令，页面没有报告未捕获的异常。

另外用 macOS Tauri debug 应用（隔离标识 `dev.otterdive.sectionreader.qa`）打开同一文件，在 WKWebView 中操作工作台，走实际 IPC。首次源码页可见后 1,021 ms，243 项索引及带有跨章脚注和链接的首节已显示。随后 75 ms 显示了常规章节的 80 段正文，此时只挂载一个文章节点。超限节可回源码，第二个同名标题定位到第 243 节，点击全文命中后状态栏显示第 38,894 行、第 1 列。
