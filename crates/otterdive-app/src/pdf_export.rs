use serde::Deserialize;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_HTML_BYTES: usize = 32 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;
const BROWSER_TIMEOUT: Duration = Duration::from_secs(120);
static TEMP_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPdfRequest {
    pub output_path: String,
    pub html: String,
    pub heading_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BrowserCandidate {
    label: &'static str,
    executable: PathBuf,
}

struct TempDirectory {
    path: PathBuf,
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct PendingFile {
    path: PathBuf,
}

impl Drop for PendingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[tauri::command]
pub async fn export_pdf_with_outline(request: ExportPdfRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_pdf(request))
        .await
        .map_err(|error| format!("PDF 导出任务失败：{error}"))?
}

fn export_pdf(request: ExportPdfRequest) -> Result<String, String> {
    let output_path = validate_request(&request)?;
    let browsers = installed_browser_candidates();
    if browsers.is_empty() {
        return Err(
            "未找到支持 PDF 大纲导出的 Chromium 浏览器，请安装 Google Chrome、Microsoft Edge 或 Chromium"
                .to_owned(),
        );
    }

    let workspace = create_temp_directory()?;
    let html_path = workspace.path.join("document.html");
    let generated_pdf_path = workspace.path.join("generated.pdf");
    write_new_file(&html_path, request.html.as_bytes())
        .map_err(|error| format!("写入临时 HTML 失败：{error}"))?;

    let document_url = file_url(&html_path)?;
    let mut failures = Vec::new();
    for (index, browser) in browsers.into_iter().enumerate() {
        let profile_path = workspace.path.join(format!("profile-{index}"));
        fs::create_dir(&profile_path)
            .map_err(|error| format!("创建浏览器隔离目录失败：{error}"))?;
        remove_file_if_present(&generated_pdf_path)
            .map_err(|error| format!("清理上一份浏览器输出失败：{error}"))?;
        match generate_pdf(&browser, &document_url, &profile_path, &generated_pdf_path)
            .and_then(|()| read_and_validate_pdf(&generated_pdf_path, request.heading_count > 0))
        {
            Ok(pdf) => {
                persist_pdf(&output_path, &pdf)?;
                return Ok(browser.label.to_owned());
            }
            Err(error) => failures.push(format!("{}：{error}", browser.label)),
        }
    }

    Err(format!(
        "浏览器未能生成带大纲的 PDF：{}",
        failures.join("；")
    ))
}

fn validate_request(request: &ExportPdfRequest) -> Result<PathBuf, String> {
    let html_bytes = request.html.len();
    if html_bytes == 0 {
        return Err("打印内容不能为空".to_owned());
    }
    if html_bytes > MAX_HTML_BYTES {
        return Err(format!(
            "打印内容过大（{html_bytes} 字节），最大支持 {MAX_HTML_BYTES} 字节"
        ));
    }

    let requested_path = PathBuf::from(request.output_path.trim());
    if requested_path.as_os_str().is_empty() {
        return Err("PDF 输出路径不能为空".to_owned());
    }
    let is_pdf = requested_path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err("PDF 输出路径必须以 .pdf 结尾".to_owned());
    }
    let file_name = requested_path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "PDF 输出路径缺少文件名".to_owned())?;
    let requested_parent = requested_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(requested_parent).map_err(|error| {
        format!(
            "PDF 输出目录不可用：{}：{error}",
            requested_parent.display()
        )
    })?;
    if !parent.is_dir() {
        return Err(format!("PDF 输出目录不存在：{}", parent.display()));
    }
    let output_path = parent.join(file_name);
    if output_path.exists() && !output_path.is_file() {
        return Err(format!(
            "PDF 输出目标不是普通文件：{}",
            output_path.display()
        ));
    }
    Ok(output_path)
}

fn installed_browser_candidates() -> Vec<BrowserCandidate> {
    browser_candidate_paths(std::env::consts::OS, |name| std::env::var_os(name))
        .into_iter()
        .filter(|candidate| candidate.executable.is_file())
        .collect()
}

fn browser_candidate_paths<F>(target_os: &str, mut env_var: F) -> Vec<BrowserCandidate>
where
    F: FnMut(&str) -> Option<OsString>,
{
    let mut candidates = match target_os {
        "macos" => vec![
            BrowserCandidate {
                label: "Google Chrome",
                executable: PathBuf::from(
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                ),
            },
            BrowserCandidate {
                label: "Microsoft Edge",
                executable: PathBuf::from(
                    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                ),
            },
            BrowserCandidate {
                label: "Chromium",
                executable: PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
            },
        ],
        "windows" => {
            let mut paths = Vec::new();
            for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
                let Some(root) = env_var(variable) else {
                    continue;
                };
                let root = PathBuf::from(root);
                paths.push(BrowserCandidate {
                    label: "Google Chrome",
                    executable: root.join("Google/Chrome/Application/chrome.exe"),
                });
                paths.push(BrowserCandidate {
                    label: "Microsoft Edge",
                    executable: root.join("Microsoft/Edge/Application/msedge.exe"),
                });
                paths.push(BrowserCandidate {
                    label: "Chromium",
                    executable: root.join("Chromium/Application/chrome.exe"),
                });
            }
            paths
        }
        "linux" => {
            let Some(path) = env_var("PATH") else {
                return Vec::new();
            };
            [
                ("Google Chrome", "google-chrome-stable"),
                ("Google Chrome", "google-chrome"),
                ("Microsoft Edge", "microsoft-edge-stable"),
                ("Microsoft Edge", "microsoft-edge"),
                ("Chromium", "chromium"),
                ("Chromium", "chromium-browser"),
            ]
            .into_iter()
            .filter_map(|(label, executable)| {
                find_on_path(executable, &path)
                    .map(|executable| BrowserCandidate { label, executable })
            })
            .collect()
        }
        _ => Vec::new(),
    };

    let mut unique = Vec::with_capacity(candidates.len());
    for candidate in candidates.drain(..) {
        if !unique
            .iter()
            .any(|existing: &BrowserCandidate| existing.executable == candidate.executable)
        {
            unique.push(candidate);
        }
    }
    unique
}

fn find_on_path(executable: &str, path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
}

fn generate_pdf(
    browser: &BrowserCandidate,
    document_url: &str,
    profile_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let mut command = Command::new(&browser.executable);
    command
        .arg("--headless=new")
        .arg("--disable-extensions")
        .arg("--disable-javascript")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--no-pdf-header-footer")
        .arg("--print-to-pdf-no-header")
        .arg("--generate-pdf-document-outline")
        .arg(format!("--user-data-dir={}", profile_path.display()))
        .arg(format!("--print-to-pdf={}", output_path.display()))
        .arg(document_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动失败：{error}"))?;
    let deadline = Instant::now() + BROWSER_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("进程退出状态为 {status}")),
            Ok(None) if pdf_file_is_complete(output_path) => {
                // Some Chromium builds keep the headless process alive after the PDF has
                // been fully written. The isolated process is no longer needed at this point.
                let _ = child.kill();
                let _ = child.wait();
                return Ok(());
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("生成 PDF 超时（{} 秒）", BROWSER_TIMEOUT.as_secs()));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待浏览器失败：{error}"));
            }
        }
    }
}

fn pdf_file_is_complete(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    if length < 11 {
        return false;
    }
    let mut header = [0_u8; 5];
    if file.read_exact(&mut header).is_err() || &header != b"%PDF-" {
        return false;
    }
    let tail_length = length.min(1_024) as usize;
    if file.seek(SeekFrom::End(-(tail_length as i64))).is_err() {
        return false;
    }
    let mut tail = vec![0_u8; tail_length];
    if file.read_exact(&mut tail).is_err() {
        return false;
    }
    let mut end = tail.len();
    while end > 0 && tail[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    tail[..end].ends_with(b"%%EOF")
}

fn read_and_validate_pdf(path: &Path, require_outline: bool) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取生成结果失败：{error}"))?;
    if metadata.len() > MAX_PDF_BYTES {
        return Err(format!(
            "生成的 PDF 过大（{} 字节），最大支持 {MAX_PDF_BYTES} 字节",
            metadata.len()
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("读取生成的 PDF 失败：{error}"))?;
    validate_pdf_bytes(&bytes, require_outline)?;
    Ok(bytes)
}

fn validate_pdf_bytes(bytes: &[u8], require_outline: bool) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("浏览器输出不是有效的 PDF 文件".to_owned());
    }
    if require_outline && !contains_bytes(bytes, b"/Outlines") {
        return Err("文档包含标题，但生成的 PDF 没有大纲；请更新 Chromium 浏览器".to_owned());
    }
    Ok(())
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn create_temp_directory() -> Result<TempDirectory, String> {
    for _ in 0..32 {
        let path = std::env::temp_dir().join(format!(
            "otterdive-pdf-{}-{}",
            std::process::id(),
            unique_nonce()
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => return Ok(TempDirectory { path }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建 PDF 临时目录失败：{error}")),
        }
    }
    Err("无法创建唯一的 PDF 临时目录".to_owned())
}

fn persist_pdf(output_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = output_path
        .parent()
        .ok_or_else(|| "PDF 输出路径缺少父目录".to_owned())?;
    let pending = create_pending_file(parent, output_path.file_name().unwrap_or_default())?;
    write_existing_file(&pending.path, bytes).map_err(|error| format!("暂存 PDF 失败：{error}"))?;
    install_pending_file(&pending.path, output_path)?;
    sync_parent_directory(parent);
    Ok(())
}

fn create_pending_file(parent: &Path, output_name: &OsStr) -> Result<PendingFile, String> {
    let safe_name = Path::new(output_name)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("document.pdf");
    for _ in 0..32 {
        let path = parent.join(format!(".{safe_name}.otterdive-{}.tmp", unique_nonce()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(PendingFile { path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建 PDF 暂存文件失败：{error}")),
        }
    }
    Err("无法创建唯一的 PDF 暂存文件".to_owned())
}

fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn write_existing_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(not(windows))]
fn install_pending_file(pending_path: &Path, output_path: &Path) -> Result<(), String> {
    fs::rename(pending_path, output_path).map_err(|error| format!("保存 PDF 失败：{error}"))
}

#[cfg(windows)]
fn install_pending_file(pending_path: &Path, output_path: &Path) -> Result<(), String> {
    if !output_path.exists() {
        return fs::rename(pending_path, output_path)
            .map_err(|error| format!("保存 PDF 失败：{error}"));
    }

    let parent = output_path
        .parent()
        .ok_or_else(|| "PDF 输出路径缺少父目录".to_owned())?;
    let file_name = output_path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("document.pdf");
    let backup_path = (0..32)
        .map(|_| parent.join(format!(".{file_name}.otterdive-{}.backup", unique_nonce())))
        .find(|path| !path.exists())
        .ok_or_else(|| "无法创建唯一的 PDF 备份路径".to_owned())?;

    fs::rename(output_path, &backup_path).map_err(|error| format!("备份原 PDF 失败：{error}"))?;
    if let Err(error) = fs::rename(pending_path, output_path) {
        let restore_result = fs::rename(&backup_path, output_path);
        return match restore_result {
            Ok(()) => Err(format!("保存 PDF 失败，已恢复原文件：{error}")),
            Err(restore_error) => Err(format!(
                "保存 PDF 失败，原文件保留在 {}，恢复也失败：{restore_error}",
                backup_path.display()
            )),
        };
    }
    fs::remove_file(&backup_path).map_err(|error| format!("清理原 PDF 备份失败：{error}"))
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) {
    let _ = File::open(parent).and_then(|directory| directory.sync_all());
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) {}

fn file_url(path: &Path) -> Result<String, String> {
    let path =
        fs::canonicalize(path).map_err(|error| format!("解析临时 HTML 路径失败：{error}"))?;
    Ok(path_string_to_file_url(&path.to_string_lossy()))
}

fn path_string_to_file_url(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    if let Some(path) = normalized.strip_prefix("//?/UNC/") {
        normalized = format!("//{path}");
    } else if let Some(path) = normalized.strip_prefix("//?/") {
        normalized = format!("/{path}");
    } else if !normalized.starts_with('/') {
        normalized.insert(0, '/');
    }
    let encoded = percent_encode_path(&normalized);
    if normalized.starts_with("//") {
        format!("file:{encoded}")
    } else {
        format!("file://{encoded}")
    }
}

fn percent_encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/' | b':') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn unique_nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:x}-{sequence:x}")
}

#[cfg(test)]
mod tests {
    use super::{
        BrowserCandidate, ExportPdfRequest, MAX_HTML_BYTES, browser_candidate_paths,
        path_string_to_file_url, pdf_file_is_complete, percent_encode_path, validate_pdf_bytes,
        validate_request,
    };
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn validates_pdf_output_path_and_html_limit() {
        let directory = std::env::temp_dir();
        let valid = ExportPdfRequest {
            output_path: directory.join("outline.PDF").display().to_string(),
            html: "<h1>标题</h1>".to_owned(),
            heading_count: 1,
        };
        assert_eq!(
            validate_request(&valid).expect("valid request"),
            fs::canonicalize(&directory)
                .expect("canonical temp directory")
                .join("outline.PDF")
        );

        let mut wrong_extension = valid;
        wrong_extension.output_path = directory.join("outline.html").display().to_string();
        assert!(validate_request(&wrong_extension).is_err());

        let oversized = ExportPdfRequest {
            output_path: directory.join("outline.pdf").display().to_string(),
            html: "x".repeat(MAX_HTML_BYTES + 1),
            heading_count: 0,
        };
        assert!(validate_request(&oversized).is_err());
    }

    #[test]
    fn validates_pdf_signature_and_required_outline() {
        assert!(validate_pdf_bytes(b"%PDF-1.7\n/Outlines 2 0 R", true).is_ok());
        assert!(validate_pdf_bytes(b"%PDF-1.7\n1 0 obj", false).is_ok());
        assert!(validate_pdf_bytes(b"%PDF-1.7\n1 0 obj", true).is_err());
        assert!(validate_pdf_bytes(b"not a pdf /Outlines", true).is_err());
    }

    #[test]
    fn detects_a_complete_pdf_file() {
        let directory = std::env::temp_dir();
        let complete = directory.join(format!(
            "otterdive-complete-pdf-{}-{}",
            std::process::id(),
            super::unique_nonce()
        ));
        let incomplete = directory.join(format!(
            "otterdive-incomplete-pdf-{}-{}",
            std::process::id(),
            super::unique_nonce()
        ));
        fs::write(&complete, b"%PDF-1.7\n1 0 obj\n%%EOF\n").expect("write complete pdf");
        fs::write(&incomplete, b"%PDF-1.7\n1 0 obj\n").expect("write incomplete pdf");

        assert!(pdf_file_is_complete(&complete));
        assert!(!pdf_file_is_complete(&incomplete));
        assert!(!pdf_file_is_complete(&directory.join("missing.pdf")));

        fs::remove_file(complete).expect("remove complete pdf");
        fs::remove_file(incomplete).expect("remove incomplete pdf");
    }

    #[test]
    fn builds_platform_browser_candidates_without_browser_processes() {
        let mac = browser_candidate_paths("macos", |_| None);
        assert_eq!(mac.len(), 3);
        assert!(
            mac.iter()
                .any(|candidate| candidate.label == "Google Chrome")
        );
        assert!(
            mac.iter()
                .any(|candidate| candidate.label == "Microsoft Edge")
        );
        assert!(mac.iter().any(|candidate| candidate.label == "Chromium"));

        let windows = browser_candidate_paths("windows", |name| match name {
            "PROGRAMFILES" => Some(OsString::from(r"C:\Program Files")),
            "LOCALAPPDATA" => Some(OsString::from(r"C:\Users\tester\AppData\Local")),
            _ => None,
        });
        assert!(windows.contains(&BrowserCandidate {
            label: "Google Chrome",
            executable:
                PathBuf::from(r"C:\Program Files").join("Google/Chrome/Application/chrome.exe"),
        }));
        assert!(windows.contains(&BrowserCandidate {
            label: "Microsoft Edge",
            executable:
                PathBuf::from(r"C:\Program Files").join("Microsoft/Edge/Application/msedge.exe"),
        }));

        assert!(browser_candidate_paths("unsupported", |_| None).is_empty());
    }

    #[test]
    fn percent_encodes_file_url_paths() {
        assert_eq!(
            percent_encode_path("/tmp/打印 test/document.html"),
            "/tmp/%E6%89%93%E5%8D%B0%20test/document.html"
        );
        assert_eq!(percent_encode_path("/C:/Temp/a.html"), "/C:/Temp/a.html");
        assert_eq!(
            path_string_to_file_url(r"\\?\C:\Temp\打印 test\document.html"),
            "file:///C:/Temp/%E6%89%93%E5%8D%B0%20test/document.html"
        );
        assert_eq!(
            path_string_to_file_url(r"\\?\UNC\server\share\document.html"),
            "file://server/share/document.html"
        );
        assert_eq!(
            path_string_to_file_url(r"\\server\share\document.html"),
            "file://server/share/document.html"
        );
    }

    #[test]
    fn linux_path_lookup_does_not_require_a_browser_installation() {
        let directory = std::env::temp_dir().join(format!(
            "otterdive-browser-candidate-test-{}-{}",
            std::process::id(),
            super::unique_nonce()
        ));
        fs::create_dir(&directory).expect("create test directory");
        let executable = directory.join("chromium");
        fs::write(&executable, b"test").expect("write fake executable");
        let path = std::env::join_paths([&directory]).expect("build PATH");

        let candidates =
            browser_candidate_paths("linux", |name| (name == "PATH").then(|| path.clone()));
        assert!(candidates.contains(&BrowserCandidate {
            label: "Chromium",
            executable,
        }));

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn candidate_path_filter_skips_empty_path_entries() {
        assert_eq!(super::find_on_path("missing", OsStr::new("")), None);
    }
}
