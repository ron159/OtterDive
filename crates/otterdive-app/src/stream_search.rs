use crate::app::{
    SearchReportDto, SearchRequest, search_options_from_request, search_report_to_dto,
};
use otterdive_core::{analyse::CancellationToken, fs::search_directory_stream};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use tauri::ipc::Channel;

#[derive(Default)]
pub struct SearchService {
    next_id: AtomicU64,
    runs: Arc<Mutex<HashMap<u64, CancellationToken>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEvent {
    report: SearchReportDto,
    done: bool,
    cancelled: bool,
    truncated: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn start_workspace_search(
    request: SearchRequest,
    on_event: Channel<SearchEvent>,
    service: tauri::State<'_, SearchService>,
) -> Result<u64, String> {
    let id = service.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = CancellationToken::new();
    service
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, cancel.clone());
    let runs = service.runs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let options = search_options_from_request(&request);
        let outcome = search_directory_stream(
            &request.root,
            &request.query,
            &options,
            &cancel,
            usize::MAX,
            |batch| {
                on_event
                    .send(SearchEvent {
                        report: search_report_to_dto(batch),
                        done: false,
                        cancelled: false,
                        truncated: false,
                        error: None,
                    })
                    .is_ok()
            },
        );
        let mut event = SearchEvent {
            report: search_report_to_dto(Default::default()),
            done: true,
            cancelled: cancel.is_cancelled(),
            truncated: false,
            error: None,
        };
        match outcome {
            Ok(summary) => {
                event.cancelled = summary.cancelled;
                event.truncated = summary.truncated;
                event.report.files_scanned = summary.files_scanned;
                event.report.elapsed_ms = summary.elapsed_ms;
            }
            Err(error) => event.error = Some(error.to_string()),
        }
        let _ = on_event.send(event);
        if let Ok(mut runs) = runs.lock() {
            runs.remove(&id);
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn cancel_workspace_search(
    run_id: u64,
    service: tauri::State<'_, SearchService>,
) -> Result<(), String> {
    if let Some(cancel) = service.runs.lock().map_err(|e| e.to_string())?.get(&run_id) {
        cancel.cancel();
    }
    Ok(())
}
