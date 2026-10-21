#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(all(not(debug_assertions), not(feature = "custom-protocol")))]
compile_error!("OtterDive release builds must enable the custom-protocol feature");

mod analyse;
mod app;
mod document_delivery;
mod document_templates;
mod file_revision;
mod paged_document;
mod pdf_export;
mod project_links;
mod session_store;
mod shell_integration;
mod stream_search;
mod workbench;
mod workspace_refactor;

fn main() {
    app::run();
}
