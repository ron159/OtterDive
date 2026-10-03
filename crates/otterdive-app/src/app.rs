use otterdive_core::{
    DirectorySearchReport, Document, EncodingKind, FileReplacePreview, LineEnding, LoadedDocument,
    SearchMode, SearchOptions, TextMatch, document::EDITABLE_FILE_LIMIT_BYTES,
    preview_directory_replace, search_directory,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};

use crate::analyse::AnalyseService;
use crate::session_store::SessionStore;
use crate::shell_integration::ShellIntegrationStatus;

const SUPPORTED_LANGUAGES: &[&str] = &[
    "plaintext",
    "abap",
    "apex",
    "azcli",
    "bat",
    "bicep",
    "cameligo",
    "clojure",
    "coffee",
    "cpp",
    "csharp",
    "csp",
    "css",
    "cypher",
    "dart",
    "dockerfile",
    "ecl",
    "elixir",
    "flow9",
    "freemarker2",
    "fsharp",
    "go",
    "graphql",
    "handlebars",
    "hcl",
    "html",
    "ini",
    "java",
    "javascript",
    "json",
    "julia",
    "kotlin",
    "less",
    "lexon",
    "liquid",
    "lua",
    "m3",
    "markdown",
    "mdx",
    "mips",
    "msdax",
    "mysql",
    "objective-c",
    "pascal",
    "pascaligo",
    "perl",
    "pgsql",
    "php",
    "pla",
    "postiats",
    "powerquery",
    "powershell",
    "protobuf",
    "pug",
    "python",
    "qsharp",
    "r",
    "razor",
    "redis",
    "redshift",
    "restructuredtext",
    "ruby",
    "rust",
    "sb",
    "scala",
    "scheme",
    "scss",
    "shell",
    "solidity",
    "sophia",
    "sparql",
    "sql",
    "st",
    "swift",
    "systemverilog",
    "tcl",
    "toml",
    "twig",
    "typescript",
    "typespec",
    "vb",
    "wgsl",
    "xml",
    "yaml",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDto {
    pub decode_had_errors: bool,
    pub disk_revision: Option<String>,
    pub title: String,
    pub path: Option<String>,
    pub text: String,
    pub encoding: String,
    pub line_ending: String,
    pub file_size: usize,
    pub read_only: bool,
    pub read_only_reason: Option<String>,
    pub language: String,
    pub large_file: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub root: String,
    pub name: String,
    pub items: Vec<TreeItemDto>,
}

#[cfg(target_os = "macos")]
fn macos_menu_item(
    app: &tauri::AppHandle,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    let builder = MenuItemBuilder::with_id(id, text);
    match accelerator {
        Some(accelerator) => builder.accelerator(accelerator).build(app),
        None => builder.build(app),
    }
}

#[cfg(target_os = "macos")]
fn build_macos_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = macos_menu_item(app, "app.settings", "设置…", Some("CmdOrCtrl+,"))?;
    let app_menu = SubmenuBuilder::new(app, "OtterDive")
        .about_with_text("关于 OtterDive", None)
        .separator()
        .item(&settings)
        .separator()
        .services_with_text("服务")
        .separator()
        .hide_with_text("隐藏 OtterDive")
        .hide_others_with_text("隐藏其他")
        .show_all_with_text("全部显示")
        .separator()
        .quit_with_text("退出 OtterDive")
        .build()?;

    let new_document = macos_menu_item(app, "file.new", "新建", Some("CmdOrCtrl+N"))?;
    let new_markdown = macos_menu_item(
        app,
        "file.new_markdown",
        "新建 Markdown",
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let open_document = macos_menu_item(app, "file.open", "打开文件…", Some("CmdOrCtrl+O"))?;
    let open_recent = macos_menu_item(app, "file.open_recent", "最近打开", None)?;
    let open_workspace = macos_menu_item(
        app,
        "file.open_workspace",
        "打开工作区…",
        Some("CmdOrCtrl+Alt+O"),
    )?;
    let close_workspace = macos_menu_item(app, "file.close_workspace", "关闭工作区", None)?;
    let save = macos_menu_item(app, "file.save", "保存", Some("CmdOrCtrl+S"))?;
    let save_all = macos_menu_item(app, "file.save_all", "全部保存", Some("CmdOrCtrl+Alt+S"))?;
    let save_as = macos_menu_item(app, "file.save_as", "另存为…", Some("CmdOrCtrl+Shift+S"))?;
    let export_pdf = macos_menu_item(app, "file.export_pdf", "导出带大纲 PDF…", None)?;
    let export_html = macos_menu_item(app, "file.exportHtml", "导出 HTML…", None)?;
    let export_docx = macos_menu_item(app, "file.exportDocx", "导出 Word 文档…", None)?;
    let export_epub = macos_menu_item(app, "file.exportEpub", "导出 EPUB…", None)?;
    let import_document = macos_menu_item(app, "file.importDocument", "导入文档…", None)?;
    let recovery = macos_menu_item(app, "file.recovery", "恢复副本…", None)?;
    let history = macos_menu_item(app, "file.history", "本地历史…", None)?;
    let compare_disk = macos_menu_item(app, "file.compareDisk", "与磁盘文件比较", None)?;
    let compare_other = macos_menu_item(app, "file.compareOther", "与其他文件比较…", None)?;
    let log_viewer = macos_menu_item(app, "file.logViewer", "分块阅读与日志尾随…", None)?;
    let print = macos_menu_item(app, "file.print", "系统打印…", Some("CmdOrCtrl+P"))?;
    let close_document = macos_menu_item(app, "file.close", "关闭当前标签", Some("CmdOrCtrl+W"))?;
    let file_menu = SubmenuBuilder::new(app, "文件")
        .items(&[&new_document, &new_markdown])
        .separator()
        .items(&[
            &open_document,
            &open_recent,
            &open_workspace,
            &close_workspace,
        ])
        .separator()
        .items(&[&save, &save_all, &save_as])
        .separator()
        .items(&[
            &recovery,
            &history,
            &compare_disk,
            &compare_other,
            &log_viewer,
        ])
        .separator()
        .items(&[
            &import_document,
            &export_pdf,
            &export_html,
            &export_docx,
            &export_epub,
            &print,
        ])
        .separator()
        .item(&close_document)
        .build()?;

    let uppercase = macos_menu_item(app, "edit.uppercase", "转为大写", None)?;
    let lowercase = macos_menu_item(app, "edit.lowercase", "转为小写", None)?;
    let format_document = macos_menu_item(
        app,
        "edit.format_document",
        "格式化文档",
        Some("Shift+Alt+F"),
    )?;
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo_with_text("撤销")
        .redo_with_text("重做")
        .separator()
        .cut_with_text("剪切")
        .copy_with_text("复制")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .separator()
        .items(&[&uppercase, &lowercase, &format_document])
        .build()?;

    let find = macos_menu_item(app, "search.find", "查找…", Some("CmdOrCtrl+F"))?;
    let replace = macos_menu_item(app, "search.replace", "替换…", Some("CmdOrCtrl+Alt+F"))?;
    let find_workspace = macos_menu_item(
        app,
        "search.find_workspace",
        "在文件中查找…",
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let replace_workspace = macos_menu_item(
        app,
        "search.replace_workspace",
        "在文件中替换…",
        Some("CmdOrCtrl+Shift+Alt+F"),
    )?;
    let go_to_line = macos_menu_item(app, "search.go_to_line", "跳转到行…", Some("CmdOrCtrl+G"))?;
    let command_palette = macos_menu_item(
        app,
        "search.command_palette",
        "命令面板…",
        Some("CmdOrCtrl+Shift+P"),
    )?;
    let undo_workspace_replace =
        macos_menu_item(app, "workspace.undoReplace", "撤回最近批量替换", None)?;
    let search_menu = SubmenuBuilder::new(app, "查找")
        .items(&[&find, &replace])
        .separator()
        .items(&[&find_workspace, &replace_workspace])
        .item(&undo_workspace_replace)
        .separator()
        .items(&[&go_to_line, &command_palette])
        .build()?;

    let word_wrap = macos_menu_item(app, "view.word_wrap", "自动换行", Some("Alt+Z"))?;
    let markdown_wysiwyg =
        macos_menu_item(app, "view.markdown_wysiwyg", "Markdown 即时编辑", None)?;
    let markdown_split = macos_menu_item(app, "view.markdown_split", "Markdown 分屏预览", None)?;
    let markdown_source = macos_menu_item(app, "view.markdown_source", "Markdown 源码", None)?;
    let markdown_outline = macos_menu_item(
        app,
        "view.markdown_outline",
        "Markdown 大纲",
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let theme = macos_menu_item(app, "view.theme", "切换主题", None)?;
    let side_editor = macos_menu_item(app, "view.sideEditor", "并排阅读", None)?;
    let side_scroll_sync = macos_menu_item(app, "view.sideScrollSync", "并排滚动同步", None)?;
    let markdown_reading = macos_menu_item(app, "markdown.reading", "Markdown 阅读模式", None)?;
    let markdown_focus = macos_menu_item(app, "markdown.focus", "Markdown 专注模式", None)?;
    let markdown_typewriter =
        macos_menu_item(app, "markdown.typewriter", "Markdown 打字机模式", None)?;
    let markdown_localize_images = macos_menu_item(
        app,
        "markdown.localizeImages",
        "保存远程图片到附件目录",
        None,
    )?;
    let markdown_insert_toc = macos_menu_item(app, "markdown.insertToc", "插入正文目录", None)?;
    let markdown_check_links = macos_menu_item(app, "markdown.checkLinks", "检查本地链接…", None)?;
    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(&word_wrap)
        .separator()
        .items(&[
            &markdown_wysiwyg,
            &markdown_split,
            &markdown_source,
            &markdown_outline,
            &markdown_reading,
            &markdown_focus,
            &markdown_typewriter,
        ])
        .separator()
        .items(&[
            &markdown_insert_toc,
            &markdown_localize_images,
            &markdown_check_links,
        ])
        .separator()
        .items(&[&side_editor, &side_scroll_sync])
        .separator()
        .item(&theme)
        .separator()
        .fullscreen_with_text("进入全屏")
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .minimize_with_text("最小化")
        .maximize_with_text("缩放")
        .separator()
        .bring_all_to_front_with_text("前置全部窗口")
        .build()?;
    window_menu.set_as_windows_menu_for_nsapp()?;

    let check_updates = macos_menu_item(app, "help.check_updates", "检查更新…", None)?;
    let help_menu = SubmenuBuilder::new(app, "帮助")
        .item(&check_updates)
        .build()?;
    help_menu.set_as_help_menu_for_nsapp()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &search_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeItemDto {
    pub path: String,
    pub name: String,
    pub depth: usize,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupArgsDto {
    pub files: Vec<String>,
    pub directories: Vec<String>,
}

#[derive(Default)]
struct OpenRequestQueue(Mutex<VecDeque<StartupArgsDto>>);

impl OpenRequestQueue {
    fn push(&self, request: StartupArgsDto) {
        if let Ok(mut queue) = self.0.lock() {
            queue.push_back(request);
        }
    }

    fn drain(&self) -> Vec<StartupArgsDto> {
        self.0
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReportDto {
    pub hits: Vec<FileHitDto>,
    pub skipped: Vec<String>,
    pub total: usize,
    pub files_scanned: usize,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewDto {
    pub preview_id: String,
    pub items: Vec<FileReplacePreviewDto>,
    pub skipped: Vec<String>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReplacePreviewDto {
    pub file_id: usize,
    pub path: String,
    pub file_name: String,
    pub encoding: String,
    pub count: usize,
    pub matches: Vec<ReplacementMatchDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHitDto {
    pub path: String,
    pub file_name: String,
    pub encoding: String,
    pub matches: Vec<TextMatchDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMatchDto {
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub column: usize,
    pub matched_text: String,
    pub line_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub source_path: Option<String>,
    pub source_encoding: Option<String>,
    pub expected_revision: Option<String>,
    pub path: Option<String>,
    pub text: String,
    pub encoding: String,
    pub line_ending: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogPathRequest {
    pub default_dir: Option<String>,
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageTransferRequest {
    pub source: String,
    pub destination: String,
    pub move_source: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub root: String,
    pub query: String,
    pub mode: String,
    pub match_case: bool,
    pub whole_word: bool,
    pub include_hidden: bool,
    pub recursive: bool,
    pub file_glob: String,
    pub skip_dirs: String,
    pub max_file_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenRequest {
    pub path: String,
    pub encoding: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub root: String,
    pub query: String,
    pub replacement: String,
    pub mode: String,
    pub match_case: bool,
    pub whole_word: bool,
    pub include_hidden: bool,
    pub recursive: bool,
    pub file_glob: String,
    pub skip_dirs: String,
    pub max_file_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReplaceRequest {
    pub preview_id: String,
    pub selections: Vec<ReplaceSelectionDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSelectionDto {
    pub file_id: usize,
    pub match_ids: Vec<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementMatchDto {
    #[serde(flatten)]
    pub location: TextMatchDto,
    pub match_id: usize,
    pub replacement_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFailureDto {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceApplyDto {
    pub batch_id: String,
    pub applied_files: usize,
    pub applied_matches: usize,
    pub undone_files: usize,
    pub failures: Vec<ReplaceFailureDto>,
}

#[derive(Default)]
struct ReplaceState {
    next_id: u64,
    preview: Option<(String, Vec<FileReplacePreview>)>,
    // Keep one bounded batch. Starting a new preview preserves the latest undo batch.
    undo: Option<(String, otterdive_core::fs::ReplaceBatch)>,
}
#[derive(Default)]
struct ReplaceService(Arc<Mutex<ReplaceState>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutationDto {
    pub workspace: WorkspaceDto,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreateRequest {
    pub root: String,
    pub parent: String,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRenameRequest {
    pub root: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameRequest {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathRequest {
    pub root: String,
    pub path: String,
}

fn persisted_window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED
}

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(OpenRequestQueue::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(persisted_window_state_flags())
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let request = classify_open_args(args.into_iter().skip(1), Some(Path::new(&cwd)));
            if !request.files.is_empty() || !request.directories.is_empty() {
                if let Some(queue) = app.try_state::<OpenRequestQueue>() {
                    queue.push(request);
                }
                let _ = app.emit("open-request", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));

    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_macos_menu).on_menu_event(|app, event| {
        let _ = app.emit("native-menu", event.id().as_ref());
    });

    builder
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                use tauri_plugin_window_state::WindowExt;
                if let Err(error) = window.restore_state(persisted_window_state_flags()) {
                    eprintln!("恢复窗口状态失败：{error}");
                }
            }
            let database_path = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?
                .join("otterdive.db");
            let store = SessionStore::new(database_path);
            store.initialize().map_err(std::io::Error::other)?;
            app.manage(store);
            app.manage(AnalyseService::default());
            app.manage(ReplaceService::default());
            app.manage(crate::stream_search::SearchService::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::workbench::save_snapshot,
            crate::workbench::list_snapshots,
            crate::workbench::read_snapshot,
            crate::workbench::delete_snapshot,
            crate::workbench::store_markdown_asset,
            crate::workbench::migrate_markdown_assets,
            crate::workbench::read_file_chunk,
            crate::workbench::pandoc_status,
            crate::workbench::convert_document,
            crate::workbench::export_document_text,
            crate::workbench::export_document_bytes,
            load_session,
            save_session,
            open_file_dialog,
            pick_file_path,
            open_path,
            crate::file_revision::file_revisions,
            reopen_path_with_encoding,
            pick_save_path,
            pick_pdf_save_path,
            transfer_image_file,
            save_document,
            pick_workspace_path,
            choose_workspace,
            read_workspace,
            create_workspace_entry,
            rename_workspace_entry,
            rename_file,
            delete_workspace_entry,
            reveal_workspace_entry,
            search_workspace,
            crate::stream_search::start_workspace_search,
            crate::stream_search::cancel_workspace_search,
            preview_workspace_replace,
            apply_workspace_replace,
            undo_workspace_replace,
            startup_args,
            take_open_requests,
            shell_integration_status,
            set_shell_integration,
            default_app_candidate_status,
            set_default_app_candidate,
            supported_languages,
            supported_encodings,
            crate::pdf_export::export_pdf_with_outline,
            crate::analyse::run_analyse,
            crate::analyse::run_analyse_path,
            crate::analyse::cancel_analyse,
            crate::analyse::read_analyse_result_chunk,
            crate::analyse::release_analyse_result,
            crate::analyse::find_analyse_result,
            crate::analyse::serialize_analyse_rtf,
            crate::analyse::serialize_analyse_html,
            crate::analyse::parse_analyse_profile,
            crate::analyse::write_analyse_profile,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build OtterDive")
        .run(|app, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let files = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| path.is_file())
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>();
                if !files.is_empty() {
                    app.state::<OpenRequestQueue>().push(StartupArgsDto {
                        files,
                        directories: Vec::new(),
                    });
                    let _ = app.emit("open-request", ());
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}

#[tauri::command]
fn load_session(store: tauri::State<'_, SessionStore>) -> Result<Option<String>, String> {
    store.load()
}

#[tauri::command]
fn save_session(snapshot: String, store: tauri::State<'_, SessionStore>) -> Result<(), String> {
    store.save(&snapshot)
}

#[tauri::command]
async fn open_file_dialog() -> Result<Option<DocumentDto>, String> {
    let Some(path) = pick_file_path(DialogPathRequest {
        default_dir: None,
        file_name: None,
    })?
    else {
        return Ok(None);
    };
    open_path(path).await.map(Some)
}

#[tauri::command]
fn pick_file_path(request: DialogPathRequest) -> Result<Option<String>, String> {
    Ok(configure_dialog(request)
        .pick_file()
        .map(|path| path.display().to_string()))
}

#[tauri::command]
async fn open_path(path: String) -> Result<DocumentDto, String> {
    tauri::async_runtime::spawn_blocking(move || load_path(PathBuf::from(path)))
        .await
        .map_err(|err| format!("打开任务失败：{err}"))?
}

fn load_path(path: PathBuf) -> Result<DocumentDto, String> {
    let revision = crate::file_revision::revision(&path)?;
    let doc = LoadedDocument::open(&path)
        .map_err(|err| format!("打开失败：{}：{err}", path.display()))?;
    crate::file_revision::ensure_revision(&path, &revision)?;
    let mut dto = loaded_document_to_dto(doc);
    dto.disk_revision = Some(revision);
    Ok(dto)
}

#[tauri::command]
async fn reopen_path_with_encoding(request: ReopenRequest) -> Result<DocumentDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(request.path);
        let revision = crate::file_revision::revision(&path)?;
        let metadata = fs::metadata(&path)
            .map_err(|err| format!("读取文件信息失败：{}：{err}", path.display()))?;
        let bytes =
            fs::read(&path).map_err(|err| format!("读取文件失败：{}：{err}", path.display()))?;
        let encoding = parse_encoding(&request.encoding);
        let file_size = bytes.len();
        let decoded = otterdive_core::fs::decode_owned_bytes_with_encoding(bytes, encoding);
        let title = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_owned();
        let line_ending = LineEnding::detect(&decoded.text);
        crate::file_revision::ensure_revision(&path, &revision)?;
        Ok(DocumentDto {
            decode_had_errors: decoded.had_errors,
            disk_revision: Some(revision),
            title,
            path: Some(path.display().to_string()),
            language: language_from_path(Some(&path)),
            large_file: metadata.len() > EDITABLE_FILE_LIMIT_BYTES,
            text: decoded.text,
            encoding: encoding_label(decoded.encoding).to_owned(),
            line_ending: line_ending_label(line_ending).to_owned(),
            file_size,
            read_only: decoded.had_errors
                || metadata.permissions().readonly()
                || metadata.len() > EDITABLE_FILE_LIMIT_BYTES,
            read_only_reason: if decoded.had_errors {
                Some("解码含有无效字符，请选择正确编码重新打开；禁止覆盖原文件".to_owned())
            } else if metadata.permissions().readonly() {
                Some("文件系统只读".to_owned())
            } else if metadata.len() > EDITABLE_FILE_LIMIT_BYTES {
                Some("超过编辑保护阈值".to_owned())
            } else {
                None
            },
        })
    })
    .await
    .map_err(|err| format!("编码重读失败：{err}"))?
}

#[tauri::command]
async fn save_document(request: SaveRequest) -> Result<DocumentDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = match request.path {
            Some(path) => PathBuf::from(path),
            None => return Err("保存路径不能为空".to_owned()),
        };

        let overwrites_source = request.source_path.as_deref().is_some_and(|source| {
            let source = Path::new(source);
            source == path
                || fs::canonicalize(source)
                    .ok()
                    .zip(fs::canonicalize(&path).ok())
                    .is_some_and(|(source, destination)| source == destination)
        });
        if overwrites_source && path.exists() {
            let bytes = fs::read(&path).map_err(|error| format!("读取原文件失败：{error}"))?;
            let decoded = match request.source_encoding.as_deref() {
                Some(source) => {
                    otterdive_core::fs::decode_bytes_with_encoding(&bytes, parse_encoding(source))
                }
                None => otterdive_core::fs::decode_bytes(&bytes),
            };
            if decoded.had_errors {
                return Err(
                    "原文件按所选编码解码含有无效字符，请重新选择编码读取；原文件未修改".to_owned(),
                );
            }
        }
        let mut doc = Document::untitled(1);
        doc.meta.encoding = parse_encoding(&request.encoding);
        doc.meta.line_ending = parse_line_ending(&request.line_ending);
        doc.set_text(normalize_line_endings(&request.text, doc.meta.line_ending));
        if let Some(expected) = &request.expected_revision {
            crate::file_revision::ensure_revision(&path, expected)?;
        }
        doc.save_as(&path)
            .map_err(|err| format!("保存失败：{}：{err}", path.display()))?;

        Ok(document_to_dto(doc))
    })
    .await
    .map_err(|err| format!("保存任务失败：{err}"))?
}

#[tauri::command]
fn pick_save_path(request: DialogPathRequest) -> Result<Option<String>, String> {
    Ok(configure_dialog(request)
        .save_file()
        .map(|path| path.display().to_string()))
}

#[tauri::command]
fn pick_pdf_save_path(request: DialogPathRequest) -> Result<Option<String>, String> {
    Ok(configure_dialog(request)
        .add_filter("PDF", &["pdf"])
        .save_file()
        .map(|path| path.display().to_string()))
}

#[tauri::command]
async fn choose_workspace() -> Result<Option<WorkspaceDto>, String> {
    let Some(path) = pick_workspace_path(DialogPathRequest {
        default_dir: None,
        file_name: None,
    })?
    else {
        return Ok(None);
    };
    read_workspace(path).await.map(Some)
}

#[tauri::command]
fn pick_workspace_path(request: DialogPathRequest) -> Result<Option<String>, String> {
    Ok(configure_dialog(request)
        .pick_folder()
        .map(|path| path.display().to_string()))
}

fn configure_dialog(request: DialogPathRequest) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new();
    if let Some(default_dir) = request
        .default_dir
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
    {
        dialog = dialog.set_directory(default_dir);
    }
    if let Some(file_name) = request.file_name.filter(|name| !name.trim().is_empty()) {
        dialog = dialog.set_file_name(file_name);
    }
    dialog
}

#[tauri::command]
async fn read_workspace(path: String) -> Result<WorkspaceDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(path);
        if !root.is_dir() {
            return Err(format!("不是有效目录：{}", root.display()));
        }
        Ok(workspace_to_dto(&root))
    })
    .await
    .map_err(|err| format!("读取目录失败：{err}"))?
}

#[tauri::command]
async fn create_workspace_entry(
    request: WorkspaceCreateRequest,
) -> Result<WorkspaceMutationDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(request.root);
        let parent = workspace_existing_path(&root, &PathBuf::from(request.parent))?;
        if !parent.is_dir() {
            return Err(format!("目标不是目录：{}", parent.display()));
        }
        let name = sanitize_workspace_entry_name(&request.name)?;
        let path = parent.join(name);
        ensure_new_workspace_path(&root, &path)?;
        if request.is_dir {
            fs::create_dir(&path).map_err(|err| format!("新建文件夹失败：{err}"))?;
        } else {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|err| format!("新建文件失败：{err}"))?;
        }
        Ok(WorkspaceMutationDto {
            workspace: workspace_to_dto(&root),
            path: Some(path.display().to_string()),
        })
    })
    .await
    .map_err(|err| format!("新建任务失败：{err}"))?
}

#[tauri::command]
async fn rename_workspace_entry(
    request: WorkspaceRenameRequest,
) -> Result<WorkspaceMutationDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(request.root);
        let path = workspace_existing_path(&root, &PathBuf::from(request.path))?;
        ensure_not_workspace_root(&root, &path, "不能重命名工作区根目录")?;
        let parent = path
            .parent()
            .ok_or_else(|| format!("无法取得父目录：{}", path.display()))?;
        let name = sanitize_workspace_entry_name(&request.name)?;
        let next_path = parent.join(name);
        ensure_new_workspace_path(&root, &next_path)?;
        fs::rename(&path, &next_path).map_err(|err| format!("重命名失败：{err}"))?;
        Ok(WorkspaceMutationDto {
            workspace: workspace_to_dto(&root),
            path: Some(next_path.display().to_string()),
        })
    })
    .await
    .map_err(|err| format!("重命名任务失败：{err}"))?
}

#[tauri::command]
async fn rename_file(request: FileRenameRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rename_file_in_place(&PathBuf::from(request.path), &request.name)
            .map(|path| path.display().to_string())
    })
    .await
    .map_err(|err| format!("重命名任务失败：{err}"))?
}

#[tauri::command]
async fn delete_workspace_entry(
    request: WorkspacePathRequest,
) -> Result<WorkspaceMutationDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(request.root);
        let path = workspace_existing_path(&root, &PathBuf::from(request.path))?;
        ensure_not_workspace_root(&root, &path, "不能删除工作区根目录")?;
        let metadata = fs::metadata(&path).map_err(|err| format!("读取文件信息失败：{err}"))?;
        if metadata.is_dir() {
            fs::remove_dir_all(&path).map_err(|err| format!("删除文件夹失败：{err}"))?;
        } else {
            fs::remove_file(&path).map_err(|err| format!("删除文件失败：{err}"))?;
        }
        Ok(WorkspaceMutationDto {
            workspace: workspace_to_dto(&root),
            path: None,
        })
    })
    .await
    .map_err(|err| format!("删除任务失败：{err}"))?
}

#[tauri::command]
async fn reveal_workspace_entry(request: WorkspacePathRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(request.root);
        let path = workspace_existing_path(&root, &PathBuf::from(request.path))?;
        let metadata = fs::metadata(&path).map_err(|err| format!("读取文件信息失败：{err}"))?;
        let mut command = Command::new("explorer.exe");
        if metadata.is_dir() {
            command.arg(&path);
        } else {
            command.arg(format!("/select,{}", path.display()));
        }
        command
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("打开资源管理器失败：{err}"))
    })
    .await
    .map_err(|err| format!("打开资源管理器任务失败：{err}"))?
}

#[tauri::command]
async fn search_workspace(request: SearchRequest) -> Result<SearchReportDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.query.is_empty() {
            return Err("查询内容不能为空".to_owned());
        }
        let options = search_options_from_request(&request);
        let report = search_directory(&request.root, &request.query, &options)
            .map_err(|err| err.to_string())?;
        Ok(search_report_to_dto(report))
    })
    .await
    .map_err(|err| format!("目录搜索失败：{err}"))?
}

#[tauri::command]
async fn preview_workspace_replace(
    request: ReplaceRequest,
    service: tauri::State<'_, ReplaceService>,
) -> Result<ReplacePreviewDto, String> {
    let service = service.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let options = replace_options_from_request(&request);
        let (items, skipped) = preview_directory_replace(
            &request.root,
            &request.query,
            &request.replacement,
            &options,
        )
        .map_err(|err| err.to_string())?;
        let mut state = service.lock().map_err(|_| "替换服务不可用")?;
        state.next_id += 1;
        let preview_id = format!("preview-{}", state.next_id);
        let dto = replace_preview_to_dto(preview_id.clone(), &items, skipped);
        state.preview = Some((preview_id, items));
        Ok(dto)
    })
    .await
    .map_err(|err| format!("替换预览失败：{err}"))?
}

#[tauri::command]
async fn apply_workspace_replace(
    request: ApplyReplaceRequest,
    service: tauri::State<'_, ReplaceService>,
) -> Result<ReplaceApplyDto, String> {
    let service = service.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = service.lock().map_err(|_| "替换服务不可用")?;
        let (id, items) = state.preview.as_ref().ok_or("预览已失效，请重新预览")?;
        if id != &request.preview_id {
            return Err("预览已失效，请重新预览".to_owned());
        }
        let selections = request
            .selections
            .into_iter()
            .map(|selection| otterdive_core::fs::ReplaceSelection {
                file_id: selection.file_id,
                match_ids: selection.match_ids,
            })
            .collect::<Vec<_>>();
        let batch = otterdive_core::fs::apply_selected_directory_replace(items, &selections)
            .map_err(|error| error.to_string())?;
        state.next_id += 1;
        let batch_id = format!("batch-{}", state.next_id);
        let dto = ReplaceApplyDto {
            batch_id: batch_id.clone(),
            applied_files: batch.files.len(),
            applied_matches: batch.files.iter().map(|file| file.count).sum(),
            undone_files: 0,
            failures: replace_failures(&batch.failures),
        };
        if !batch.files.is_empty() {
            state.undo = Some((batch_id, batch));
        }
        state.preview = None;
        Ok(dto)
    })
    .await
    .map_err(|err| format!("执行替换失败：{err}"))?
}

#[tauri::command]
async fn undo_workspace_replace(
    batch_id: String,
    service: tauri::State<'_, ReplaceService>,
) -> Result<ReplaceApplyDto, String> {
    let service = service.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = service.lock().map_err(|_| "替换服务不可用")?;
        let (id, batch) = state.undo.as_mut().ok_or("没有可撤销的批量替换")?;
        if id != &batch_id {
            return Err("仅能撤销最近一次批量替换".to_owned());
        }
        let (undone_files, failures) = otterdive_core::fs::undo_directory_replace(batch);
        let dto = ReplaceApplyDto {
            batch_id,
            applied_files: 0,
            applied_matches: 0,
            undone_files,
            failures: replace_failures(&failures),
        };
        if batch.files.is_empty() {
            state.undo = None;
        }
        Ok(dto)
    })
    .await
    .map_err(|err| format!("撤销替换失败：{err}"))?
}

fn replace_failures(failures: &[(PathBuf, String)]) -> Vec<ReplaceFailureDto> {
    failures
        .iter()
        .map(|(path, error)| ReplaceFailureDto {
            path: path.display().to_string(),
            error: error.clone(),
        })
        .collect()
}

#[tauri::command]
fn supported_languages() -> Vec<&'static str> {
    SUPPORTED_LANGUAGES.to_vec()
}

#[tauri::command]
fn supported_encodings() -> Vec<&'static str> {
    vec![
        "GBK",
        "Big5",
        "Shift-JIS",
        "Windows-1252",
        "UTF-8",
        "UTF-8-BOM",
        "UTF-16 Big Endian",
        "UTF-16 Little Endian",
    ]
}

#[tauri::command]
fn startup_args() -> StartupArgsDto {
    let cwd = std::env::current_dir().ok();
    classify_open_args(std::env::args().skip(1), cwd.as_deref())
}

#[tauri::command]
fn take_open_requests(queue: tauri::State<'_, OpenRequestQueue>) -> Vec<StartupArgsDto> {
    queue.drain()
}

#[tauri::command]
fn shell_integration_status() -> Result<ShellIntegrationStatus, String> {
    crate::shell_integration::status()
}

#[tauri::command]
fn set_shell_integration(enabled: bool) -> Result<ShellIntegrationStatus, String> {
    crate::shell_integration::set_enabled(enabled)
}

#[tauri::command]
fn default_app_candidate_status() -> Result<ShellIntegrationStatus, String> {
    crate::shell_integration::default_app_status()
}

#[tauri::command]
fn set_default_app_candidate(enabled: bool) -> Result<ShellIntegrationStatus, String> {
    crate::shell_integration::set_default_app_enabled(enabled)
}

fn classify_open_args<I>(args: I, cwd: Option<&Path>) -> StartupArgsDto
where
    I: IntoIterator<Item = String>,
{
    let mut files = Vec::new();
    let mut directories = Vec::new();
    for arg in args {
        let path = PathBuf::from(arg);
        let path = if path.is_relative() {
            cwd.map(|cwd| cwd.join(&path)).unwrap_or(path)
        } else {
            path
        };
        if path.is_file() {
            files.push(path.display().to_string());
        } else if path.is_dir() {
            directories.push(path.display().to_string());
        }
    }
    StartupArgsDto { files, directories }
}

fn document_to_dto(doc: Document) -> DocumentDto {
    let path = doc.meta.path.as_deref();
    DocumentDto {
        decode_had_errors: doc.meta.decode_had_errors,
        disk_revision: path.and_then(|path| crate::file_revision::revision(path).ok()),
        title: doc.title,
        path: path.map(|path| path.display().to_string()),
        language: language_from_path(path),
        large_file: doc.meta.read_only && doc.meta.file_size > EDITABLE_FILE_LIMIT_BYTES as usize,
        text: doc.text,
        encoding: encoding_label(doc.meta.encoding).to_owned(),
        line_ending: line_ending_label(doc.meta.line_ending).to_owned(),
        file_size: doc.meta.file_size,
        read_only: doc.meta.read_only,
        read_only_reason: doc.meta.read_only_reason,
    }
}

fn loaded_document_to_dto(doc: LoadedDocument) -> DocumentDto {
    let path = doc.meta.path.as_deref();
    DocumentDto {
        decode_had_errors: doc.meta.decode_had_errors,
        disk_revision: path.and_then(|path| crate::file_revision::revision(path).ok()),
        title: doc.title,
        path: path.map(|path| path.display().to_string()),
        language: language_from_path(path),
        large_file: doc.meta.read_only && doc.meta.file_size > EDITABLE_FILE_LIMIT_BYTES as usize,
        text: doc.text,
        encoding: encoding_label(doc.meta.encoding).to_owned(),
        line_ending: line_ending_label(doc.meta.line_ending).to_owned(),
        file_size: doc.meta.file_size,
        read_only: doc.meta.read_only,
        read_only_reason: doc.meta.read_only_reason,
    }
}

fn workspace_to_dto(root: &Path) -> WorkspaceDto {
    let mut items = Vec::new();
    collect_tree_items(root, 0, &mut items);
    WorkspaceDto {
        root: root.display().to_string(),
        name: root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("工作目录")
            .to_owned(),
        items,
    }
}

fn collect_tree_items(root: &Path, depth: usize, out: &mut Vec<TreeItemDto>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    let mut entries = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let is_dir = file_type.is_dir();
            if should_skip_tree_entry(&name, is_dir)
                || (file_type.is_file() && !is_text_like(&path))
            {
                return None;
            }
            Some((entry, file_type, name, path))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| {
        let is_file = entry.1.is_file();
        (is_file, entry.2.to_ascii_lowercase())
    });

    for (_entry, file_type, name, path) in entries {
        let is_dir = file_type.is_dir();
        out.push(TreeItemDto {
            path: path.display().to_string(),
            name,
            depth,
            is_dir,
        });
        if is_dir {
            collect_tree_items(&path, depth + 1, out);
        }
    }
}

fn workspace_existing_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root_canonical = root
        .canonicalize()
        .map_err(|err| format!("读取工作区失败：{}：{err}", root.display()))?;
    let path_canonical = path
        .canonicalize()
        .map_err(|err| format!("读取目标失败：{}：{err}", path.display()))?;
    if !path_canonical.starts_with(&root_canonical) {
        return Err(format!("目标不在工作区内：{}", path.display()));
    }
    Ok(path_canonical)
}

fn ensure_new_workspace_path(root: &Path, path: &Path) -> Result<(), String> {
    let root_canonical = root
        .canonicalize()
        .map_err(|err| format!("读取工作区失败：{}：{err}", root.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法取得父目录：{}", path.display()))?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|err| format!("读取父目录失败：{}：{err}", parent.display()))?;
    if !parent_canonical.starts_with(&root_canonical) {
        return Err(format!("目标不在工作区内：{}", path.display()));
    }
    if path.exists() {
        return Err(format!("目标已存在：{}", path.display()));
    }
    Ok(())
}

fn ensure_not_workspace_root(root: &Path, path: &Path, message: &str) -> Result<(), String> {
    let root_canonical = root
        .canonicalize()
        .map_err(|err| format!("读取工作区失败：{}：{err}", root.display()))?;
    let path_canonical = path
        .canonicalize()
        .map_err(|err| format!("读取目标失败：{}：{err}", path.display()))?;
    if root_canonical == path_canonical {
        return Err(message.to_owned());
    }
    Ok(())
}

fn sanitize_workspace_entry_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("名称不能为空".to_owned());
    }
    if name == "." || name == ".." {
        return Err("名称不能是 . 或 ..".to_owned());
    }
    if name.ends_with([' ', '.']) {
        return Err("名称不能以空格或点结尾".to_owned());
    }
    if name.chars().any(|ch| {
        matches!(
            ch,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'
        )
    }) {
        return Err("名称包含 Windows 不支持的字符".to_owned());
    }
    Ok(name.to_owned())
}

fn rename_file_in_place(path: &Path, requested_name: &str) -> Result<PathBuf, String> {
    let metadata =
        fs::metadata(path).map_err(|err| format!("读取文件失败：{}：{err}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("目标不是文件：{}", path.display()));
    }
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| format!("无法取得父目录：{}", path.display()))?;
    let name = sanitize_workspace_entry_name(requested_name)?;
    let next_path = parent.join(name);
    if next_path == path {
        return Ok(path.to_path_buf());
    }
    if next_path.exists() {
        return Err(format!("目标已存在：{}", next_path.display()));
    }
    fs::rename(path, &next_path).map_err(|err| format!("重命名失败：{err}"))?;
    Ok(next_path)
}

#[cfg(test)]
mod tests {
    use super::{SUPPORTED_LANGUAGES, language_from_path, rename_file_in_place};
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("otterdive-{label}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn rename_file_in_place_updates_only_the_name() {
        let dir = unique_test_dir("rename-file");
        fs::create_dir_all(&dir).expect("create test directory");
        let source = dir.join("before.txt");
        fs::write(&source, "unchanged").expect("write source file");

        let renamed = rename_file_in_place(&source, "after.sql").expect("rename file");

        assert_eq!(renamed, dir.join("after.sql"));
        assert_eq!(
            fs::read_to_string(&renamed).expect("read renamed file"),
            "unchanged"
        );
        assert!(!source.exists());
        fs::remove_dir_all(&dir).expect("remove test directory");
    }

    #[test]
    fn language_detection_covers_common_source_and_extensionless_files() {
        let cases = [
            ("src/main.tsx", "typescript"),
            ("scripts/check.py", "python"),
            ("config/settings.toml", "toml"),
            ("schema.graphql", "graphql"),
            ("include/header.hpp", "cpp"),
            ("services/api/Dockerfile", "dockerfile"),
            ("Makefile", "shell"),
        ];

        for (path, expected) in cases {
            let language = language_from_path(Some(Path::new(path)));
            assert_eq!(language, expected, "unexpected language for {path}");
            assert!(SUPPORTED_LANGUAGES.contains(&language.as_str()));
        }
    }

    #[test]
    fn rename_file_in_place_does_not_overwrite_an_existing_file() {
        let dir = unique_test_dir("rename-conflict");
        fs::create_dir_all(&dir).expect("create test directory");
        let source = dir.join("before.txt");
        let existing = dir.join("existing.txt");
        fs::write(&source, "source").expect("write source file");
        fs::write(&existing, "existing").expect("write existing file");

        let error = rename_file_in_place(&source, "existing.txt").expect_err("rename should fail");

        assert!(error.contains("目标已存在"));
        assert_eq!(
            fs::read_to_string(&source).expect("read source file"),
            "source"
        );
        assert_eq!(
            fs::read_to_string(&existing).expect("read existing file"),
            "existing"
        );
        fs::remove_dir_all(&dir).expect("remove test directory");
    }
}

pub(crate) fn search_report_to_dto(report: DirectorySearchReport) -> SearchReportDto {
    let total = report.hits.iter().map(|hit| hit.matches.len()).sum();
    let files_scanned = report.files_scanned;
    let elapsed_ms = report.elapsed_ms;
    SearchReportDto {
        hits: report
            .hits
            .into_iter()
            .map(|hit| FileHitDto {
                file_name: hit
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("文件")
                    .to_owned(),
                path: hit.path.display().to_string(),
                encoding: encoding_label(hit.encoding).to_owned(),
                matches: hit.matches.into_iter().map(match_to_dto).collect(),
            })
            .collect(),
        skipped: report.skipped,
        total,
        files_scanned,
        elapsed_ms,
    }
}

#[tauri::command]
async fn transfer_image_file(request: ImageTransferRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(request.source);
        let destination = PathBuf::from(request.destination);
        if source == destination {
            return Err("源图片和目标路径相同".to_owned());
        }
        let metadata = fs::metadata(&source)
            .map_err(|err| format!("读取源图片失败：{}：{err}", source.display()))?;
        if !metadata.is_file() {
            return Err(format!("源路径不是文件：{}", source.display()));
        }
        let _destination_dir = destination
            .parent()
            .filter(|path| path.is_dir())
            .ok_or_else(|| format!("目标目录不存在：{}", destination.display()))?;
        fs::copy(&source, &destination).map_err(|err| {
            format!(
                "复制图片失败：{} -> {}：{err}",
                source.display(),
                destination.display()
            )
        })?;
        if request.move_source {
            fs::remove_file(&source)
                .map_err(|err| format!("删除原图片失败：{}：{err}", source.display()))?;
        }
        Ok(destination.display().to_string())
    })
    .await
    .map_err(|err| format!("图片文件操作失败：{err}"))?
}

fn replace_preview_to_dto(
    preview_id: String,
    items: &[FileReplacePreview],
    skipped: Vec<String>,
) -> ReplacePreviewDto {
    ReplacePreviewDto {
        preview_id,
        total: items.iter().map(|item| item.outcome.count).sum(),
        skipped,
        items: items
            .iter()
            .enumerate()
            .map(|(file_id, item)| FileReplacePreviewDto {
                file_id,
                file_name: item
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("文件")
                    .to_owned(),
                path: item.path.display().to_string(),
                encoding: encoding_label(item.encoding).to_owned(),
                count: item.outcome.count,
                matches: item
                    .outcome
                    .matches
                    .iter()
                    .zip(&item.outcome.replacements)
                    .enumerate()
                    .map(
                        |(match_id, (location, replacement_text))| ReplacementMatchDto {
                            location: match_to_dto(location.clone()),
                            match_id,
                            replacement_text: replacement_text.clone(),
                        },
                    )
                    .collect(),
            })
            .collect(),
    }
}

fn match_to_dto(value: TextMatch) -> TextMatchDto {
    TextMatchDto {
        start: value.range.start,
        end: value.range.end,
        line: value.line,
        column: value.column,
        matched_text: value.matched_text,
        line_text: value.line_text,
    }
}

pub(crate) fn search_options_from_request(request: &SearchRequest) -> SearchOptions {
    SearchOptions {
        mode: parse_search_mode(&request.mode),
        match_case: request.match_case,
        whole_word: request.whole_word,
        wrap: true,
        include_hidden: request.include_hidden,
        recursive: request.recursive,
        file_glob: request.file_glob.clone(),
        skip_dirs: request.skip_dirs.clone(),
        max_file_size: request.max_file_size,
    }
}

fn replace_options_from_request(request: &ReplaceRequest) -> SearchOptions {
    SearchOptions {
        mode: parse_search_mode(&request.mode),
        match_case: request.match_case,
        whole_word: request.whole_word,
        wrap: true,
        include_hidden: request.include_hidden,
        recursive: request.recursive,
        file_glob: request.file_glob.clone(),
        skip_dirs: request.skip_dirs.clone(),
        max_file_size: request.max_file_size,
    }
}

fn parse_search_mode(value: &str) -> SearchMode {
    match value {
        "regex" => SearchMode::Regex,
        "extended" => SearchMode::Extended,
        _ => SearchMode::Literal,
    }
}

fn should_skip_tree_entry(name: &str, is_dir: bool) -> bool {
    (is_dir && matches!(name, ".git" | ".idea" | ".vscode"))
        || (is_dir
            && matches!(
                name,
                "target" | "target-codex-run" | "node_modules" | "dist" | "build"
            ))
}

fn is_text_like(path: &Path) -> bool {
    if language_from_file_name(path).is_some() {
        return true;
    }

    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| language_from_extension(&ext.to_ascii_lowercase()).is_some())
        .unwrap_or(true)
}

pub(crate) fn language_from_path(path: Option<&Path>) -> String {
    let Some(path) = path else {
        return "plaintext".to_owned();
    };

    if let Some(language) = language_from_file_name(path) {
        return language.to_owned();
    }

    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .and_then(|ext| language_from_extension(&ext))
        .unwrap_or("plaintext")
        .to_owned()
}

fn language_from_file_name(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    match name.as_str() {
        "dockerfile" | "containerfile" => Some("dockerfile"),
        "makefile" | "gnumakefile" => Some("shell"),
        ".babelrc" | ".bowerrc" | ".eslintrc" | ".jscsrc" | ".jshintrc" | ".prettierrc" => {
            Some("json")
        }
        ".env" | ".env.local" | ".gitignore" | ".dockerignore" | ".npmrc" => Some("plaintext"),
        _ => None,
    }
}

fn language_from_extension(ext: &str) -> Option<&'static str> {
    match ext {
        "txt" | "text" | "log" | "csv" | "tsv" => Some("plaintext"),
        "md" | "markdown" | "rmd" => Some("markdown"),
        "mdx" => Some("mdx"),
        "json" | "jsonc" | "har" => Some("json"),
        "toml" => Some("toml"),
        "yaml" | "yml" => Some("yaml"),
        "sql" => Some("sql"),
        "mysql" => Some("mysql"),
        "pgsql" => Some("pgsql"),
        "ps1" | "psm1" | "psd1" => Some("powershell"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "ts" | "tsx" | "mts" | "cts" => Some("typescript"),
        "py" | "pyw" | "pyi" => Some("python"),
        "xml" | "xsd" | "xsl" | "svg" => Some("xml"),
        "html" | "htm" | "xhtml" => Some("html"),
        "css" => Some("css"),
        "scss" => Some("scss"),
        "less" => Some("less"),
        "java" => Some("java"),
        "rs" => Some("rust"),
        "go" => Some("go"),
        "c" | "h" | "cc" | "cpp" | "cxx" | "hh" | "hpp" | "hxx" => Some("cpp"),
        "cs" | "csx" => Some("csharp"),
        "php" | "phtml" => Some("php"),
        "rb" | "rake" | "gemspec" => Some("ruby"),
        "sh" | "bash" | "zsh" | "fish" | "ksh" => Some("shell"),
        "bat" | "cmd" => Some("bat"),
        "ini" | "cfg" | "conf" | "editorconfig" | "properties" => Some("ini"),
        "kt" | "kts" => Some("kotlin"),
        "swift" => Some("swift"),
        "scala" | "sc" => Some("scala"),
        "dart" => Some("dart"),
        "lua" => Some("lua"),
        "pl" | "pm" => Some("perl"),
        "r" => Some("r"),
        "ex" | "exs" => Some("elixir"),
        "fs" | "fsi" | "fsx" => Some("fsharp"),
        "clj" | "cljs" | "cljc" | "edn" => Some("clojure"),
        "coffee" => Some("coffee"),
        "graphql" | "gql" => Some("graphql"),
        "tf" | "tfvars" | "hcl" => Some("hcl"),
        "proto" => Some("protobuf"),
        "sol" => Some("solidity"),
        "sv" | "svh" => Some("systemverilog"),
        "vb" | "vbs" => Some("vb"),
        "m" | "mm" => Some("objective-c"),
        "pas" | "pp" => Some("pascal"),
        "pug" | "jade" => Some("pug"),
        "hbs" | "handlebars" => Some("handlebars"),
        "twig" => Some("twig"),
        "liquid" => Some("liquid"),
        "ftl" => Some("freemarker2"),
        "cshtml" | "razor" => Some("razor"),
        "redis" => Some("redis"),
        "rst" => Some("restructuredtext"),
        "rq" | "sparql" => Some("sparql"),
        "tcl" => Some("tcl"),
        "wgsl" => Some("wgsl"),
        "bicep" => Some("bicep"),
        "apex" | "cls" | "trigger" => Some("apex"),
        "abap" => Some("abap"),
        "azcli" => Some("azcli"),
        "cypher" | "cql" => Some("cypher"),
        "qs" => Some("qsharp"),
        "pq" => Some("powerquery"),
        "tsp" => Some("typespec"),
        "ecl" => Some("ecl"),
        "jl" => Some("julia"),
        "asm" | "s" | "mips" => Some("mips"),
        "mligo" | "ligo" => Some("cameligo"),
        _ => None,
    }
}

pub(crate) fn parse_encoding(label: &str) -> EncodingKind {
    match label {
        "ANSI" | "GBK" => EncodingKind::Gbk,
        "Big5" => EncodingKind::Big5,
        "Shift-JIS" | "Shift_JIS" => EncodingKind::ShiftJis,
        "Windows-1252" => EncodingKind::Windows1252,
        "UTF-8-BOM" | "UTF-8 BOM" => EncodingKind::Utf8Bom,
        "UTF-16 Big Endian" | "UTF-16 BE" => EncodingKind::Utf16Be,
        "UTF-16 Little Endian" | "UTF-16 LE" => EncodingKind::Utf16Le,
        _ => EncodingKind::Utf8,
    }
}

fn parse_line_ending(label: &str) -> LineEnding {
    match label {
        "CRLF" => LineEnding::Crlf,
        "CR" => LineEnding::Cr,
        _ => LineEnding::Lf,
    }
}

fn normalize_line_endings(text: &str, line_ending: LineEnding) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    match line_ending {
        LineEnding::Lf => normalized,
        LineEnding::Crlf => normalized.replace('\n', "\r\n"),
        LineEnding::Cr => normalized.replace('\n', "\r"),
    }
}

pub(crate) fn encoding_label(encoding: EncodingKind) -> &'static str {
    match encoding {
        EncodingKind::Utf8 => "UTF-8",
        EncodingKind::Utf8Bom => "UTF-8-BOM",
        EncodingKind::Utf16Le => "UTF-16 Little Endian",
        EncodingKind::Utf16Be => "UTF-16 Big Endian",
        EncodingKind::Gbk => "GBK",
        EncodingKind::Big5 => "Big5",
        EncodingKind::ShiftJis => "Shift-JIS",
        EncodingKind::Windows1252 => "Windows-1252",
    }
}

pub(crate) fn line_ending_label(line_ending: LineEnding) -> &'static str {
    match line_ending {
        LineEnding::Lf => "LF",
        LineEnding::Crlf => "CRLF",
        LineEnding::Cr => "CR",
    }
}

#[cfg(test)]
mod large_document_tests {
    use super::*;
    use std::io::{BufWriter, Write};

    #[test]
    fn opening_large_document_preserves_the_complete_text() {
        let path = std::env::temp_dir().join(format!("otterdive-large-dto-{}", std::process::id()));
        let mut temp = BufWriter::new(std::fs::File::create(&path).unwrap());
        for _ in 0..450_000 {
            temp.write_all(b"2026-09-07 INFO request completed in 10 milliseconds\n")
                .unwrap();
        }
        temp.flush().unwrap();
        drop(temp);
        let dto = load_path(path.clone()).unwrap();
        assert!(dto.read_only && dto.large_file);
        assert!(dto.file_size > 20_000_000);
        assert_eq!(dto.text.len(), dto.file_size);
        assert_eq!(dto.text.lines().count(), 450_000);
        let reopened = tauri::async_runtime::block_on(reopen_path_with_encoding(ReopenRequest {
            path: path.to_string_lossy().into_owned(),
            encoding: "UTF-8".to_owned(),
        }))
        .unwrap();
        assert_eq!(reopened.text, dto.text);
        assert_eq!(reopened.disk_revision, dto.disk_revision);
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod save_encoding_tests {
    use super::*;

    fn directory() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "otterdive-save-encoding-{}-{}-{sequence}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        directory
    }

    fn save(
        path: &Path,
        source: &Path,
        source_encoding: &str,
        text: &str,
    ) -> Result<DocumentDto, String> {
        tauri::async_runtime::block_on(save_document(SaveRequest {
            source_path: Some(source.to_string_lossy().into_owned()),
            source_encoding: Some(source_encoding.into()),
            expected_revision: None,
            path: Some(path.to_string_lossy().into_owned()),
            text: text.into(),
            encoding: "UTF-8".into(),
            line_ending: "LF".into(),
        }))
    }

    #[test]
    fn save_as_does_not_decode_unrelated_destination_with_source_encoding() {
        let directory = directory();
        let source = directory.join("source.txt");
        let target = directory.join("target.txt");
        let bytes = otterdive_core::fs::encode_text("原文件", EncodingKind::Utf16Le).unwrap();
        fs::write(&source, &bytes).unwrap();
        fs::write(&target, "odd").unwrap();
        save(&target, &source, "UTF-16 LE", "新内容").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "新内容");
        assert_eq!(fs::read(&source).unwrap(), bytes);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn overwriting_invalid_source_is_rejected_without_changing_original_bytes() {
        let directory = directory();
        let path = directory.join("invalid.txt");
        let bytes = [0xef, 0xbb, 0xbf, 0xff];
        fs::write(&path, bytes).unwrap();
        assert!(save(&path, &path, "UTF-8", "replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn source_and_target_encoding_are_independent_during_conversion() {
        let directory = directory();
        let path = directory.join("gbk.txt");
        fs::write(
            &path,
            otterdive_core::fs::encode_text("中文", EncodingKind::Gbk).unwrap(),
        )
        .unwrap();
        save(&path, &path, "GBK", "中文🙂").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "中文🙂");
        fs::remove_dir_all(directory).unwrap();
    }
}
