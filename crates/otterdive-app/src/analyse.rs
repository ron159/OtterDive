use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use otterdive_core::analyse::{
    AnalyseEngine, AnalyseMatcherBackend, AnalyseMatcherRouter, AnalysePattern,
    AnalysePatternError, AnalyseRunInput, AnalyseRunOutput, AnalyseSearchType, AnalyseSelection,
    CancellationToken, EffectiveStyle, LineIndex, MergedLineResult, RgbColor, StyledSegment,
    parse_profile, write_profile, write_result_html, write_result_rtf,
};
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub struct AnalyseService {
    engine: Arc<AnalyseEngine>,
    active_runs: Mutex<HashMap<u64, CancellationToken>>,
    result_batches: Mutex<HashMap<String, Vec<AnalyseLineDto>>>,
}

const RESULT_CHUNK_LINES: usize = 2_000;
const MAX_RESULT_CHUNK_LINES: usize = 10_000;
const MAX_ANALYSE_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

impl AnalyseService {
    fn register_run(&self, run_id: u64, cancel: CancellationToken) -> Result<(), String> {
        self.active_runs
            .lock()
            .map_err(|_| "Analyse cancellation state is unavailable".to_owned())?
            .insert(run_id, cancel);
        Ok(())
    }

    fn finish_run(&self, run_id: u64) {
        if let Ok(mut active_runs) = self.active_runs.lock() {
            active_runs.remove(&run_id);
        }
    }

    pub(crate) fn package_result(
        &self,
        mut result: AnalyseResultDto,
    ) -> Result<AnalyseResultDto, String> {
        if result.lines.iter().any(|line| line.text.len() > 256 * 1024) {
            return Err("Analyse 单条结果超过 256 KiB 安全显示上限；结果未被截成局部分析，请缩小 Pattern 范围".into());
        }
        result.total_lines = result.lines.len();
        if result.lines.len() <= RESULT_CHUNK_LINES {
            return Ok(result);
        }
        let token = format!(
            "{}:{}:{}:{}",
            result.document_id, result.run_id, result.document_revision, result.pattern_revision
        );
        let all_lines = std::mem::take(&mut result.lines);
        result.lines = all_lines[..RESULT_CHUNK_LINES].to_vec();
        let mut batches = self
            .result_batches
            .lock()
            .map_err(|_| "Analyse result batch state is unavailable".to_owned())?;
        // The UI exposes one active Analyse result. A newer packaged result makes
        // every older batch stale, so discard it instead of retaining an orphan.
        batches.clear();
        batches.insert(token.clone(), all_lines);
        result.result_token = Some(token);
        Ok(result)
    }

    fn read_result_chunk(
        &self,
        request: AnalyseResultChunkRequest,
    ) -> Result<AnalyseResultChunkDto, String> {
        let mut batches = self
            .result_batches
            .lock()
            .map_err(|_| "Analyse result batch state is unavailable".to_owned())?;
        let Some(lines) = batches.get(&request.result_token) else {
            return Err("Analyse result batch has expired".to_owned());
        };
        let offset = request.offset.min(lines.len());
        let limit = request.limit.clamp(1, MAX_RESULT_CHUNK_LINES);
        let end = offset.saturating_add(limit).min(lines.len());
        let chunk = lines[offset..end].to_vec();
        let done = end >= lines.len();
        if done {
            batches.remove(&request.result_token);
        }
        Ok(AnalyseResultChunkDto {
            lines: chunk,
            next_offset: end,
            done,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseRunRequest {
    pub run_id: u64,
    pub document_id: u64,
    pub document_revision: u64,
    pub pattern_revision: u64,
    pub text: String,
    pub patterns: Vec<AnalysePatternDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysePathRunRequest {
    pub run_id: u64,
    pub document_id: u64,
    pub document_revision: u64,
    pub pattern_revision: u64,
    pub path: String,
    pub expected_file_size: u64,
    pub patterns: Vec<AnalysePatternDto>,
    pub encoding: Option<String>,
    pub expected_disk_revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysePatternDto {
    pub id: u64,
    #[serde(default)]
    pub order_num: String,
    pub enabled: bool,
    pub search_text: String,
    pub search_type: String,
    pub match_case: bool,
    pub whole_word: bool,
    pub selection: String,
    pub hide: bool,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub foreground: String,
    pub background: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub group: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseProfileParseRequest {
    pub xml: String,
    pub first_pattern_id: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedAnalyseProfileDto {
    pub patterns: Vec<AnalysePatternDto>,
    pub next_pattern_id: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseProfileWriteRequest {
    pub patterns: Vec<AnalysePatternDto>,
    #[serde(default)]
    pub pattern_hits: Vec<AnalysePatternHitsDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseResultFindRequest {
    pub text: String,
    pub query: String,
    pub search_type: String,
    pub match_case: bool,
    pub whole_word: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseResultFindMatchDto {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseRtfRequest {
    pub lines: Vec<AnalyseLineDto>,
    pub show_line_numbers: bool,
    pub font_size: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseResultDto {
    pub run_id: u64,
    pub document_id: u64,
    pub document_revision: u64,
    pub pattern_revision: u64,
    pub lines: Vec<AnalyseLineDto>,
    pub total_matches: usize,
    pub pattern_hits: Vec<AnalysePatternHitsDto>,
    pub pattern_errors: Vec<AnalysePatternErrorDto>,
    pub total_lines: usize,
    pub result_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseResultChunkRequest {
    pub result_token: String,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseResultChunkDto {
    pub lines: Vec<AnalyseLineDto>,
    pub next_offset: usize,
    pub done: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysePatternHitsDto {
    pub pattern_id: u64,
    pub hits: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseLineDto {
    pub source_line: usize,
    pub text: String,
    pub matching_pattern_ids: Vec<u64>,
    pub styled_segments: Vec<StyledSegmentDto>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyledSegmentDto {
    pub start_byte_in_line: usize,
    pub end_byte_in_line: usize,
    pub pattern_id: Option<u64>,
    pub hidden: bool,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub foreground: String,
    pub background: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysePatternErrorDto {
    pub pattern_id: u64,
    pub kind: String,
    pub message: String,
}

#[tauri::command]
pub async fn run_analyse(
    request: AnalyseRunRequest,
    service: tauri::State<'_, AnalyseService>,
) -> Result<AnalyseResultDto, String> {
    let run_id = request.run_id;
    let engine = Arc::clone(&service.engine);
    let cancel = CancellationToken::new();
    service.register_run(run_id, cancel.clone())?;
    let task =
        tauri::async_runtime::spawn_blocking(move || execute(request, &engine, &cancel)).await;
    service.finish_run(run_id);
    let result = task.map_err(|error| format!("Analyse task failed: {error}"))??;
    service.package_result(result)
}

#[tauri::command]
pub async fn run_analyse_path(
    request: AnalysePathRunRequest,
    service: tauri::State<'_, AnalyseService>,
) -> Result<AnalyseResultDto, String> {
    let run_id = request.run_id;
    let engine = Arc::clone(&service.engine);
    let cancel = CancellationToken::new();
    service.register_run(run_id, cancel.clone())?;
    let task =
        tauri::async_runtime::spawn_blocking(move || execute_path(request, &engine, &cancel)).await;
    service.finish_run(run_id);
    let result = task.map_err(|error| format!("Analyse path task failed: {error}"))??;
    service.package_result(result)
}

#[tauri::command]
pub fn cancel_analyse(run_id: u64, service: tauri::State<'_, AnalyseService>) -> bool {
    let Ok(active_runs) = service.active_runs.lock() else {
        return false;
    };
    let Some(cancel) = active_runs.get(&run_id) else {
        return false;
    };
    cancel.cancel();
    true
}

#[tauri::command]
pub fn read_analyse_result_chunk(
    request: AnalyseResultChunkRequest,
    service: tauri::State<'_, AnalyseService>,
) -> Result<AnalyseResultChunkDto, String> {
    service.read_result_chunk(request)
}

#[tauri::command]
pub fn release_analyse_result(
    result_token: String,
    service: tauri::State<'_, AnalyseService>,
) -> bool {
    service
        .result_batches
        .lock()
        .map(|mut batches| batches.remove(&result_token).is_some())
        .unwrap_or(false)
}

#[tauri::command]
pub fn parse_analyse_profile(
    request: AnalyseProfileParseRequest,
) -> Result<ParsedAnalyseProfileDto, String> {
    let parsed =
        parse_profile(&request.xml, request.first_pattern_id).map_err(|error| error.to_string())?;
    Ok(ParsedAnalyseProfileDto {
        patterns: parsed
            .patterns
            .into_iter()
            .map(AnalysePatternDto::from)
            .collect(),
        next_pattern_id: parsed.next_pattern_id,
    })
}

#[tauri::command]
pub fn write_analyse_profile(request: AnalyseProfileWriteRequest) -> Result<String, String> {
    let patterns = request
        .patterns
        .into_iter()
        .map(AnalysePattern::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    let hits = request
        .pattern_hits
        .into_iter()
        .map(|item| (item.pattern_id, item.hits))
        .collect::<BTreeMap<_, _>>();
    write_profile(&patterns, Some(&hits)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn find_analyse_result(
    request: AnalyseResultFindRequest,
) -> Result<Vec<AnalyseResultFindMatchDto>, String> {
    let pattern = AnalysePattern {
        id: 1,
        search_text: request.query,
        search_type: parse_search_type(&request.search_type)?,
        match_case: request.match_case,
        whole_word: request.whole_word,
        selection: AnalyseSelection::Text,
        ..Default::default()
    };
    let line_index = LineIndex::new(&request.text);
    let matcher = AnalyseMatcherRouter::default()
        .compile(&pattern)
        .map_err(|error| error.to_string())?;
    matcher
        .find_all(&request.text, &line_index, &CancellationToken::new())
        .map_err(|error| error.to_string())
        .map(|matches| {
            matches
                .into_iter()
                .filter_map(|item| line_index.monaco_range(&request.text, &item))
                .map(|range| AnalyseResultFindMatchDto {
                    start_line: range.start_line,
                    start_column: range.start_column_utf16,
                    end_line: range.end_line,
                    end_column: range.end_column_utf16,
                })
                .collect()
        })
}

#[tauri::command]
pub fn serialize_analyse_rtf(request: AnalyseRtfRequest) -> Result<String, String> {
    let lines = analyse_lines_to_merged(request.lines)?;
    Ok(write_result_rtf(
        &lines,
        request.show_line_numbers,
        request.font_size,
    ))
}

#[tauri::command]
pub fn serialize_analyse_html(request: AnalyseRtfRequest) -> Result<String, String> {
    let lines = analyse_lines_to_merged(request.lines)?;
    Ok(write_result_html(
        &lines,
        request.show_line_numbers,
        request.font_size,
    ))
}

fn analyse_lines_to_merged(lines: Vec<AnalyseLineDto>) -> Result<Vec<MergedLineResult>, String> {
    lines
        .into_iter()
        .map(|line| {
            let styled_segments = line
                .styled_segments
                .into_iter()
                .map(|segment| {
                    Ok(StyledSegment {
                        start_byte_in_line: segment.start_byte_in_line,
                        end_byte_in_line: segment.end_byte_in_line,
                        pattern_id: segment.pattern_id,
                        style: EffectiveStyle {
                            hidden: segment.hidden,
                            bold: segment.bold,
                            italic: segment.italic,
                            underline: segment.underline,
                            foreground: parse_color("foreground", &segment.foreground)?,
                            background: parse_color("background", &segment.background)?,
                        },
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(MergedLineResult {
                source_line: line.source_line,
                text: line.text,
                matches: Vec::new(),
                styled_segments,
            })
        })
        .collect()
}

pub(crate) fn execute_path(
    request: AnalysePathRunRequest,
    engine: &AnalyseEngine,
    cancel: &CancellationToken,
) -> Result<AnalyseResultDto, String> {
    let path = PathBuf::from(&request.path);
    if let Some(revision) = &request.expected_disk_revision {
        crate::file_revision::ensure_revision(&path, revision)?;
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Unable to read Analyse source metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Analyse path is not a regular file".to_owned());
    }
    if metadata.len() != request.expected_file_size {
        return Err(format!(
            "Analyse source changed before the run: expected {} bytes, found {} bytes",
            request.expected_file_size,
            metadata.len()
        ));
    }
    if metadata.len() > MAX_ANALYSE_FILE_BYTES {
        return Err(format!(
            "Analyse source exceeds the {} byte safety limit",
            MAX_ANALYSE_FILE_BYTES
        ));
    }
    if cancel.is_cancelled() {
        return Err("Analyse run was cancelled".to_owned());
    }
    let decoded = otterdive_core::fs::read_text_cancellable(
        &path,
        request.encoding.as_deref().map(crate::app::parse_encoding),
        cancel,
    )
    .map_err(|error| format!("Unable to read Analyse source: {error}"))?;
    let size_after = fs::metadata(&path)
        .map_err(|error| format!("Unable to recheck Analyse source: {error}"))?
        .len();
    if size_after != request.expected_file_size {
        return Err("Analyse source changed while it was being read".to_owned());
    }
    if let Some(revision) = &request.expected_disk_revision {
        crate::file_revision::ensure_revision(&path, revision)?;
    }
    execute(
        AnalyseRunRequest {
            run_id: request.run_id,
            document_id: request.document_id,
            document_revision: request.document_revision,
            pattern_revision: request.pattern_revision,
            text: decoded.text,
            patterns: request.patterns,
        },
        engine,
        cancel,
    )
}

fn execute(
    request: AnalyseRunRequest,
    engine: &AnalyseEngine,
    cancel: &CancellationToken,
) -> Result<AnalyseResultDto, String> {
    let patterns = request
        .patterns
        .into_iter()
        .map(AnalysePattern::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    let output = engine
        .run_with_pattern_results(
            AnalyseRunInput {
                run_id: request.run_id,
                document_id: request.document_id,
                document_revision: request.document_revision,
                pattern_revision: request.pattern_revision,
                text: &request.text,
                patterns: &patterns,
            },
            cancel,
        )
        .map_err(|error| error.to_string())?;
    Ok(output.into())
}

impl TryFrom<AnalysePatternDto> for AnalysePattern {
    type Error = String;

    fn try_from(value: AnalysePatternDto) -> Result<Self, Self::Error> {
        Ok(Self {
            id: value.id,
            order_num: value.order_num,
            enabled: value.enabled,
            search_text: value.search_text,
            search_type: parse_search_type(&value.search_type)?,
            match_case: value.match_case,
            whole_word: value.whole_word,
            selection: parse_selection(&value.selection)?,
            hide: value.hide,
            bold: value.bold,
            italic: value.italic,
            underline: value.underline,
            foreground: parse_color("foreground", &value.foreground)?,
            background: parse_color("background", &value.background)?,
            comment: value.comment,
            group: value.group,
        })
    }
}

impl From<AnalysePattern> for AnalysePatternDto {
    fn from(value: AnalysePattern) -> Self {
        Self {
            id: value.id,
            order_num: value.order_num,
            enabled: value.enabled,
            search_text: value.search_text,
            search_type: match value.search_type {
                AnalyseSearchType::Normal => "normal",
                AnalyseSearchType::Escaped => "escaped",
                AnalyseSearchType::Regex => "regex",
                AnalyseSearchType::RegexMultiline => "regexMultiline",
            }
            .to_owned(),
            match_case: value.match_case,
            whole_word: value.whole_word,
            selection: match value.selection {
                AnalyseSelection::Line => "line",
                AnalyseSelection::Text => "text",
            }
            .to_owned(),
            hide: value.hide,
            bold: value.bold,
            italic: value.italic,
            underline: value.underline,
            foreground: value.foreground.to_hex(),
            background: value.background.to_hex(),
            comment: value.comment,
            group: value.group,
        }
    }
}

impl From<AnalyseRunOutput> for AnalyseResultDto {
    fn from(value: AnalyseRunOutput) -> Self {
        let AnalyseRunOutput {
            result,
            pattern_results,
        } = value;
        Self {
            run_id: result.run_id,
            document_id: result.document_id,
            document_revision: result.document_revision,
            pattern_revision: result.pattern_revision,
            lines: result.lines.into_iter().map(AnalyseLineDto::from).collect(),
            total_matches: result.total_matches,
            pattern_hits: pattern_results
                .into_iter()
                .map(|pattern_result| AnalysePatternHitsDto {
                    pattern_id: pattern_result.pattern_id,
                    hits: pattern_result.matches.len(),
                })
                .collect(),
            pattern_errors: result
                .pattern_errors
                .into_iter()
                .map(AnalysePatternErrorDto::from)
                .collect(),
            total_lines: 0,
            result_token: None,
        }
    }
}

impl From<MergedLineResult> for AnalyseLineDto {
    fn from(value: MergedLineResult) -> Self {
        let mut matching_pattern_ids = Vec::new();
        for line_match in value.matches {
            if !matching_pattern_ids.contains(&line_match.pattern_id) {
                matching_pattern_ids.push(line_match.pattern_id);
            }
        }
        Self {
            source_line: value.source_line,
            text: value.text,
            matching_pattern_ids,
            styled_segments: value
                .styled_segments
                .into_iter()
                .map(StyledSegmentDto::from)
                .collect(),
        }
    }
}

impl From<StyledSegment> for StyledSegmentDto {
    fn from(value: StyledSegment) -> Self {
        let EffectiveStyle {
            hidden,
            bold,
            italic,
            underline,
            foreground,
            background,
        } = value.style;
        Self {
            start_byte_in_line: value.start_byte_in_line,
            end_byte_in_line: value.end_byte_in_line,
            pattern_id: value.pattern_id,
            hidden,
            bold,
            italic,
            underline,
            foreground: foreground.to_hex(),
            background: background.to_hex(),
        }
    }
}

impl From<AnalysePatternError> for AnalysePatternErrorDto {
    fn from(value: AnalysePatternError) -> Self {
        Self {
            pattern_id: value.pattern_id,
            kind: format!("{:?}", value.kind),
            message: value.message,
        }
    }
}

fn parse_search_type(value: &str) -> Result<AnalyseSearchType, String> {
    match value {
        "normal" => Ok(AnalyseSearchType::Normal),
        "escaped" => Ok(AnalyseSearchType::Escaped),
        "regex" => Ok(AnalyseSearchType::Regex),
        "regexMultiline" | "rgx_multiline" => Ok(AnalyseSearchType::RegexMultiline),
        _ => Err(format!("Unsupported Analyse search type: {value}")),
    }
}

fn parse_selection(value: &str) -> Result<AnalyseSelection, String> {
    match value {
        "text" => Ok(AnalyseSelection::Text),
        "line" => Ok(AnalyseSelection::Line),
        _ => Err(format!("Unsupported Analyse selection: {value}")),
    }
}

fn parse_color(field: &str, value: &str) -> Result<RgbColor, String> {
    RgbColor::from_hex(value).ok_or_else(|| format!("Invalid {field} color: {value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(search_text: &str, search_type: &str) -> AnalysePatternDto {
        AnalysePatternDto {
            id: 1,
            order_num: "1".to_owned(),
            enabled: true,
            search_text: search_text.to_owned(),
            search_type: search_type.to_owned(),
            match_case: true,
            whole_word: false,
            selection: "text".to_owned(),
            hide: false,
            bold: true,
            italic: false,
            underline: false,
            foreground: "#FF0000".to_owned(),
            background: "#FFFFFF".to_owned(),
            comment: String::new(),
            group: String::new(),
        }
    }

    #[test]
    fn request_executes_regex_and_maps_result_dto() {
        let result = execute(
            AnalyseRunRequest {
                run_id: 10,
                document_id: 20,
                document_revision: 30,
                pattern_revision: 40,
                text: "ERROR wlan0".to_owned(),
                patterns: vec![pattern(r"(?<=ERROR )wlan0", "regex")],
            },
            &AnalyseEngine::default(),
            &CancellationToken::new(),
        )
        .unwrap();

        assert_eq!(result.run_id, 10);
        assert_eq!(result.total_matches, 1);
        assert_eq!(result.pattern_hits[0].hits, 1);
        assert_eq!(result.lines[0].source_line, 1);
        assert_eq!(result.lines[0].matching_pattern_ids, [1]);
        assert!(
            result.lines[0]
                .styled_segments
                .iter()
                .any(|segment| segment.bold)
        );
    }

    #[test]
    fn request_rejects_unknown_enums_and_invalid_colors() {
        let mut invalid_type = pattern("text", "glob");
        assert!(AnalysePattern::try_from(invalid_type.clone()).is_err());
        invalid_type.search_type = "normal".to_owned();
        invalid_type.foreground = "red".to_owned();
        assert!(AnalysePattern::try_from(invalid_type).is_err());
    }

    #[test]
    fn profile_commands_parse_apply_ids_and_round_trip() {
        let parsed = parse_analyse_profile(AnalyseProfileParseRequest {
            xml: r#"<?xml version="1.0"?><AnalyseDoc><SearchText searchType="regex" group="logs">ERROR.+</SearchText></AnalyseDoc>"#.to_owned(),
            first_pattern_id: 7,
        })
        .unwrap();

        assert_eq!(parsed.next_pattern_id, 8);
        assert_eq!(parsed.patterns[0].id, 7);
        assert_eq!(parsed.patterns[0].search_type, "regex");
        assert_eq!(parsed.patterns[0].group, "logs");

        let xml = write_analyse_profile(AnalyseProfileWriteRequest {
            patterns: parsed.patterns,
            pattern_hits: vec![AnalysePatternHitsDto {
                pattern_id: 7,
                hits: 3,
            }],
        })
        .unwrap();
        assert!(xml.contains("hits=\"3\""));
        assert!(xml.contains("searchType=\"regex\""));
        assert!(xml.contains("ERROR.+"));
    }

    #[test]
    fn result_find_uses_the_same_functional_matcher() {
        let matches = find_analyse_result(AnalyseResultFindRequest {
            text: "INFO one\nERROR wlan0".to_owned(),
            query: r"(?<=ERROR )wlan\d".to_owned(),
            search_type: "regex".to_owned(),
            match_case: true,
            whole_word: false,
        })
        .unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].start_line, 2);
        assert_eq!(matches[0].start_column, 7);
        assert_eq!(matches[0].end_column, 12);
    }

    #[test]
    fn rtf_command_keeps_logical_text_and_style() {
        let rtf = serialize_analyse_rtf(AnalyseRtfRequest {
            lines: vec![AnalyseLineDto {
                source_line: 2,
                text: "错误".to_owned(),
                matching_pattern_ids: vec![1],
                styled_segments: vec![StyledSegmentDto {
                    start_byte_in_line: 0,
                    end_byte_in_line: "错误".len(),
                    pattern_id: Some(1),
                    hidden: false,
                    bold: true,
                    italic: false,
                    underline: false,
                    foreground: "#FF0000".to_owned(),
                    background: "#FFFFFF".to_owned(),
                }],
            }],
            show_line_numbers: true,
            font_size: 12,
        })
        .unwrap();

        assert!(rtf.contains("2: "));
        assert!(rtf.contains("\\b "));
        assert!(rtf.contains("\\u"));
    }

    #[test]
    fn html_command_keeps_logical_text_and_style() {
        let html = serialize_analyse_html(AnalyseRtfRequest {
            lines: vec![AnalyseLineDto {
                source_line: 2,
                text: "错误 <x>".to_owned(),
                matching_pattern_ids: vec![1],
                styled_segments: vec![StyledSegmentDto {
                    start_byte_in_line: 0,
                    end_byte_in_line: "错误".len(),
                    pattern_id: Some(1),
                    hidden: false,
                    bold: true,
                    italic: false,
                    underline: true,
                    foreground: "#FF0000".to_owned(),
                    background: "#FFFFFF".to_owned(),
                }],
            }],
            show_line_numbers: true,
            font_size: 12,
        })
        .unwrap();

        assert!(html.contains("2: "));
        assert!(html.contains("font-weight:700;"));
        assert!(html.contains("text-decoration:underline;"));
        assert!(html.contains("&lt;x&gt;"));
    }

    #[test]
    fn path_run_validates_size_and_executes_the_shared_engine() {
        let path = std::env::temp_dir().join(format!(
            "otterdive-analyse-path-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, "INFO\nERROR wlan0\n").unwrap();
        let file_size = fs::metadata(&path).unwrap().len();
        let result = execute_path(
            AnalysePathRunRequest {
                encoding: None,
                expected_disk_revision: None,
                run_id: 50,
                document_id: 60,
                document_revision: 70,
                pattern_revision: 80,
                path: path.display().to_string(),
                expected_file_size: file_size,
                patterns: vec![pattern("ERROR", "normal")],
            },
            &AnalyseEngine::default(),
            &CancellationToken::new(),
        )
        .unwrap();
        let _ = fs::remove_file(&path);

        assert_eq!(result.run_id, 50);
        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.lines[0].source_line, 2);
    }

    #[test]
    fn path_analysis_reaches_beyond_33_mib_without_using_the_editor_window() {
        use std::io::Write;
        let path =
            std::env::temp_dir().join(format!("otterdive-analyse-33m-{}.txt", std::process::id()));
        let block = b"ordinary line\n".repeat(4096);
        let mut file = fs::File::create(&path).unwrap();
        let mut size = 0;
        let mut lines = 0;
        while size < 33 * 1024 * 1024 {
            file.write_all(&block).unwrap();
            size += block.len();
            lines += 4096;
        }
        file.write_all("中文 TAIL_TARGET\n".as_bytes()).unwrap();
        drop(file);
        let started = std::time::Instant::now();
        let request = AnalysePathRunRequest {
            encoding: Some("UTF-8".into()),
            expected_disk_revision: Some(crate::file_revision::revision(&path).unwrap()),
            run_id: 1,
            document_id: 1,
            document_revision: 1,
            pattern_revision: 1,
            path: path.to_string_lossy().into(),
            expected_file_size: fs::metadata(&path).unwrap().len(),
            patterns: vec![pattern("TAIL_TARGET", "normal")],
        };
        let result = execute_path(
            request,
            &AnalyseEngine::default(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.lines[0].source_line, lines + 1);
        assert_eq!(result.lines[0].text, "中文 TAIL_TARGET");
        eprintln!(
            "33 MiB full Analyse {:?}; source line {}",
            started.elapsed(),
            result.lines[0].source_line
        );
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn path_run_rejects_a_stale_file_size() {
        let path = std::env::temp_dir().join(format!(
            "otterdive-analyse-path-stale-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, "ERROR\n").unwrap();
        let result = execute_path(
            AnalysePathRunRequest {
                encoding: None,
                expected_disk_revision: None,
                run_id: 51,
                document_id: 61,
                document_revision: 71,
                pattern_revision: 81,
                path: path.display().to_string(),
                expected_file_size: 1,
                patterns: vec![pattern("ERROR", "normal")],
            },
            &AnalyseEngine::default(),
            &CancellationToken::new(),
        );
        let _ = fs::remove_file(&path);

        assert!(result.unwrap_err().contains("changed before the run"));
    }

    #[test]
    fn path_run_rejects_a_same_size_replacement_using_disk_revision() {
        let path =
            std::env::temp_dir().join(format!("otterdive-analyse-revision-{}", std::process::id()));
        let replacement = path.with_extension("replacement");
        fs::write(&path, "ERROR\n").unwrap();
        let revision = crate::file_revision::revision(&path).unwrap();
        fs::write(&replacement, "OTHER\n").unwrap();
        fs::rename(&replacement, &path).unwrap();
        let result = execute_path(
            AnalysePathRunRequest {
                encoding: None,
                expected_disk_revision: Some(revision),
                run_id: 52,
                document_id: 62,
                document_revision: 72,
                pattern_revision: 82,
                path: path.to_string_lossy().into_owned(),
                expected_file_size: 6,
                patterns: vec![pattern("ERROR", "normal")],
            },
            &AnalyseEngine::default(),
            &CancellationToken::new(),
        );
        fs::remove_file(path).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn large_results_are_returned_and_released_in_bounded_chunks() {
        let service = AnalyseService::default();
        let lines = (1..=RESULT_CHUNK_LINES + 1)
            .map(|source_line| AnalyseLineDto {
                source_line,
                text: format!("line {source_line}"),
                matching_pattern_ids: vec![1],
                styled_segments: Vec::new(),
            })
            .collect();
        let first = service
            .package_result(AnalyseResultDto {
                run_id: 1,
                document_id: 2,
                document_revision: 3,
                pattern_revision: 4,
                lines,
                total_matches: RESULT_CHUNK_LINES + 1,
                pattern_hits: Vec::new(),
                pattern_errors: Vec::new(),
                total_lines: 0,
                result_token: None,
            })
            .unwrap();
        let token = first.result_token.clone().unwrap();

        assert_eq!(first.lines.len(), RESULT_CHUNK_LINES);
        assert_eq!(first.total_lines, RESULT_CHUNK_LINES + 1);
        let last = service
            .read_result_chunk(AnalyseResultChunkRequest {
                result_token: token.clone(),
                offset: RESULT_CHUNK_LINES,
                limit: RESULT_CHUNK_LINES,
            })
            .unwrap();
        assert_eq!(last.lines.len(), 1);
        assert!(last.done);
        assert!(!service.result_batches.lock().unwrap().contains_key(&token));
    }
}
