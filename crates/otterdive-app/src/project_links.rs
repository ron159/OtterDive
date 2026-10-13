use std::process::{Command, Stdio};

fn project_link_command(url: &str) -> Result<Command, String> {
    if !matches!(
        url,
        "https://github.com/ron159/OtterDive" | "https://github.com/ron159/OtterDive/issues"
    ) {
        return Err("仅支持打开 OtterDive 项目和问题反馈页面".to_owned());
    }

    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = Command::new("xdg-open");

    command.arg(url).stdin(Stdio::null());
    Ok(command)
}

pub fn open_project_link(url: &str) -> Result<(), String> {
    let status = project_link_command(url)?
        .status()
        .map_err(|error| format!("无法启动系统浏览器：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("系统浏览器启动失败：{status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::project_link_command;

    #[test]
    fn project_links_use_the_system_opener_with_an_exact_url_argument() {
        for url in [
            "https://github.com/ron159/OtterDive",
            "https://github.com/ron159/OtterDive/issues",
        ] {
            let command = project_link_command(url).expect("project link is allowed");
            let args: Vec<_> = command
                .get_args()
                .map(|arg| arg.to_str().unwrap())
                .collect();
            #[cfg(target_os = "macos")]
            {
                assert_eq!(command.get_program(), "/usr/bin/open");
                assert_eq!(args, [url]);
            }
            #[cfg(target_os = "windows")]
            {
                assert_eq!(command.get_program(), "rundll32.exe");
                assert_eq!(args, ["url.dll,FileProtocolHandler", url]);
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                assert_eq!(command.get_program(), "xdg-open");
                assert_eq!(args, [url]);
            }
        }
    }

    #[test]
    fn project_links_reject_unrelated_urls_and_command_arguments() {
        for url in [
            "https://example.com",
            "https://github.com/ron159/OtterDive.evil",
            "https://github.com/ron159/OtterDive/issues?next=https://example.com",
            "https://github.com@evil.example/ron159/OtterDive",
            "https://github.com/ron159/OtterDive;open /tmp/file",
            "file:///tmp/file",
            "-a Terminal",
        ] {
            assert!(project_link_command(url).is_err(), "rejected {url}");
        }
    }
}
