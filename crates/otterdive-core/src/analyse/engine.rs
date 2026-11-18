use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::{
    AnalyseMatcherBackend, AnalyseMatcherRouter, AnalysePattern, AnalysePatternError,
    AnalysePatternErrorKind, AnalyseResult, AnalyseSearchType, AnalyseSelection, CancellationToken,
    CompiledAnalyseMatcher, EffectiveStyle, LineIndex, LinePatternMatch, MergedLineResult,
    PatternId, PatternResult, StyledSegment,
};

pub const COMPATIBILITY_STYLE_LIMIT: usize = 247;

pub struct AnalyseRunInput<'a> {
    pub run_id: u64,
    pub document_id: u64,
    pub document_revision: u64,
    pub pattern_revision: u64,
    pub text: &'a str,
    pub patterns: &'a [AnalysePattern],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalyseRunOutput {
    pub result: AnalyseResult,
    pub pattern_results: Vec<PatternResult>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnalyseRunError {
    Cancelled,
    DuplicatePatternId(PatternId),
}

impl std::fmt::Display for AnalyseRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "Analyse run was cancelled"),
            Self::DuplicatePatternId(id) => write!(f, "duplicate Analyse pattern ID: {id}"),
        }
    }
}

impl std::error::Error for AnalyseRunError {}

pub struct AnalyseEngine {
    matcher: Arc<dyn AnalyseMatcherBackend>,
    compile_cache: Mutex<HashMap<SearchFingerprint, CachedCompile>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SearchFingerprint {
    pattern_id: PatternId,
    search_text: String,
    search_type: AnalyseSearchType,
    match_case: bool,
    whole_word: bool,
}

impl From<&AnalysePattern> for SearchFingerprint {
    fn from(pattern: &AnalysePattern) -> Self {
        Self {
            pattern_id: pattern.id,
            search_text: pattern.search_text.clone(),
            search_type: pattern.search_type,
            match_case: pattern.match_case,
            whole_word: pattern.whole_word,
        }
    }
}

#[derive(Clone)]
enum CachedCompile {
    Matcher(Arc<dyn CompiledAnalyseMatcher>),
    Error(AnalysePatternError),
}

impl Default for AnalyseEngine {
    fn default() -> Self {
        Self::new(Arc::new(AnalyseMatcherRouter::new()))
    }
}

impl AnalyseEngine {
    pub fn new(matcher: Arc<dyn AnalyseMatcherBackend>) -> Self {
        Self {
            matcher,
            compile_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn run(
        &self,
        input: AnalyseRunInput<'_>,
        cancel: &CancellationToken,
    ) -> Result<AnalyseResult, AnalyseRunError> {
        Ok(self.run_with_pattern_results(input, cancel)?.result)
    }

    pub fn run_with_pattern_results(
        &self,
        input: AnalyseRunInput<'_>,
        cancel: &CancellationToken,
    ) -> Result<AnalyseRunOutput, AnalyseRunError> {
        self.execute(input, None, None, cancel)
    }

    pub fn run_incremental(
        &self,
        input: AnalyseRunInput<'_>,
        previous: &AnalyseRunOutput,
        search_revisions: &HashMap<PatternId, u64>,
        cancel: &CancellationToken,
    ) -> Result<AnalyseRunOutput, AnalyseRunError> {
        self.execute(input, Some(previous), Some(search_revisions), cancel)
    }

    pub fn clear_compile_cache(&self) {
        self.compile_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    pub fn compile_cache_len(&self) -> usize {
        self.compile_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    fn execute(
        &self,
        input: AnalyseRunInput<'_>,
        previous: Option<&AnalyseRunOutput>,
        search_revisions: Option<&HashMap<PatternId, u64>>,
        cancel: &CancellationToken,
    ) -> Result<AnalyseRunOutput, AnalyseRunError> {
        validate_pattern_ids(input.patterns)?;
        check_cancelled(cancel)?;
        self.prune_compile_cache(input.patterns);
        let line_index = LineIndex::new(input.text);
        let mut pattern_results = Vec::with_capacity(input.patterns.len());
        let reusable_results: HashMap<_, _> = previous
            .filter(|previous| {
                previous.result.document_id == input.document_id
                    && previous.result.document_revision == input.document_revision
            })
            .map(|previous| {
                previous
                    .pattern_results
                    .iter()
                    .map(|result| (result.pattern_id, result))
                    .collect()
            })
            .unwrap_or_default();

        for pattern in input.patterns {
            check_cancelled(cancel)?;
            if !pattern.enabled {
                continue;
            }
            let search_revision = search_revisions
                .and_then(|revisions| revisions.get(&pattern.id).copied())
                .unwrap_or(input.pattern_revision);
            if let Some(previous) = reusable_results
                .get(&pattern.id)
                .filter(|previous| previous.search_revision == search_revision)
            {
                pattern_results.push((*previous).clone());
                continue;
            }

            let result = match self.compile_pattern(pattern) {
                Ok(matcher) => match matcher.find_all(input.text, &line_index, cancel) {
                    Ok(matches) => PatternResult {
                        pattern_id: pattern.id,
                        matches,
                        error: None,
                        search_revision,
                    },
                    Err(error) if error.kind == AnalysePatternErrorKind::Cancelled => {
                        return Err(AnalyseRunError::Cancelled);
                    }
                    Err(error) => PatternResult {
                        pattern_id: pattern.id,
                        matches: Vec::new(),
                        error: Some(error),
                        search_revision,
                    },
                },
                Err(error) => PatternResult {
                    pattern_id: pattern.id,
                    matches: Vec::new(),
                    error: Some(error),
                    search_revision,
                },
            };
            pattern_results.push(result);
        }

        let lines = merge_pattern_results(
            input.text,
            &line_index,
            input.patterns,
            &pattern_results,
            cancel,
        )?;
        let total_matches = pattern_results
            .iter()
            .map(|result| result.matches.len())
            .sum();
        let pattern_errors = pattern_results
            .iter()
            .filter_map(|result| result.error.clone())
            .collect();

        Ok(AnalyseRunOutput {
            result: AnalyseResult {
                run_id: input.run_id,
                document_id: input.document_id,
                document_revision: input.document_revision,
                pattern_revision: input.pattern_revision,
                lines,
                total_matches,
                pattern_errors,
            },
            pattern_results,
        })
    }

    fn compile_pattern(
        &self,
        pattern: &AnalysePattern,
    ) -> Result<Arc<dyn CompiledAnalyseMatcher>, AnalysePatternError> {
        let fingerprint = SearchFingerprint::from(pattern);
        if let Some(cached) = self
            .compile_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&fingerprint)
            .cloned()
        {
            return match cached {
                CachedCompile::Matcher(matcher) => Ok(matcher),
                CachedCompile::Error(error) => Err(error),
            };
        }

        let compiled = match self.matcher.compile(pattern) {
            Ok(matcher) => CachedCompile::Matcher(Arc::from(matcher)),
            Err(error) => CachedCompile::Error(error),
        };
        self.compile_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(fingerprint, compiled.clone());
        match compiled {
            CachedCompile::Matcher(matcher) => Ok(matcher),
            CachedCompile::Error(error) => Err(error),
        }
    }

    fn prune_compile_cache(&self, patterns: &[AnalysePattern]) {
        let active: HashSet<_> = patterns.iter().map(SearchFingerprint::from).collect();
        self.compile_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|fingerprint, _| active.contains(fingerprint));
    }
}

pub fn merge_pattern_results(
    text: &str,
    line_index: &LineIndex,
    patterns: &[AnalysePattern],
    pattern_results: &[PatternResult],
    cancel: &CancellationToken,
) -> Result<Vec<MergedLineResult>, AnalyseRunError> {
    let results_by_id: HashMap<_, _> = pattern_results
        .iter()
        .map(|result| (result.pattern_id, result))
        .collect();
    let mut merged: BTreeMap<usize, Vec<LinePatternMatch>> = BTreeMap::new();

    for pattern in patterns {
        check_cancelled(cancel)?;
        let Some(result) = results_by_id.get(&pattern.id) else {
            continue;
        };
        for raw_match in &result.matches {
            check_cancelled(cancel)?;
            for span in &raw_match.line_spans {
                let line_matches = merged.entry(span.line).or_default();
                if let Some(line_match) = line_matches
                    .iter_mut()
                    .find(|line_match| line_match.pattern_id == pattern.id)
                {
                    line_match.spans.push(span.clone());
                } else {
                    line_matches.push(LinePatternMatch {
                        pattern_id: pattern.id,
                        spans: vec![span.clone()],
                    });
                }
            }
        }
    }

    let mut lines = Vec::with_capacity(merged.len());
    for (source_line, matches) in merged {
        check_cancelled(cancel)?;
        let line_text = line_index
            .line_text(text, source_line)
            .unwrap_or_default()
            .to_owned();
        let styled_segments = resolve_line_styles(&line_text, &matches, patterns);
        lines.push(MergedLineResult {
            source_line,
            text: line_text,
            matches,
            styled_segments,
        });
    }

    Ok(lines)
}

pub fn resolve_line_styles(
    line_text: &str,
    matches: &[LinePatternMatch],
    patterns: &[AnalysePattern],
) -> Vec<StyledSegment> {
    if line_text.is_empty() {
        return Vec::new();
    }

    let matches_by_id: HashMap<_, _> = matches
        .iter()
        .map(|line_match| (line_match.pattern_id, line_match))
        .collect();
    let mut segments = vec![StyledSegment {
        start_byte_in_line: 0,
        end_byte_in_line: line_text.len(),
        pattern_id: None,
        style: EffectiveStyle::default(),
    }];

    for (pattern_index, pattern) in patterns.iter().enumerate() {
        let Some(line_match) = matches_by_id.get(&pattern.id) else {
            continue;
        };
        let style = if pattern_index < COMPATIBILITY_STYLE_LIMIT {
            style_for_pattern(pattern)
        } else {
            EffectiveStyle::default()
        };
        if pattern.selection == AnalyseSelection::Line {
            segments = vec![StyledSegment {
                start_byte_in_line: 0,
                end_byte_in_line: line_text.len(),
                pattern_id: Some(pattern.id),
                style,
            }];
            continue;
        }
        // Sweep both ordered lists once so dense lines do not rebuild every earlier segment.
        let mut ranges: Vec<_> = line_match
            .spans
            .iter()
            .map(|span| {
                (
                    span.start_byte_in_line,
                    span.end_byte_in_line.min(line_text.len()),
                )
            })
            .filter(|(start, end)| start < end)
            .collect();
        ranges.sort_unstable();
        let mut ranges = ranges.into_iter().peekable();
        let mut output = Vec::with_capacity(segments.len());
        for segment in segments {
            let mut pos = segment.start_byte_in_line;
            while pos < segment.end_byte_in_line {
                let Some(&(start, end)) = ranges.peek() else {
                    output.push(StyledSegment {
                        start_byte_in_line: pos,
                        ..segment
                    });
                    break;
                };
                if end <= pos {
                    ranges.next();
                    continue;
                }
                let covered = start <= pos;
                let next = segment
                    .end_byte_in_line
                    .min(if covered { end } else { start });
                output.push(StyledSegment {
                    start_byte_in_line: pos,
                    end_byte_in_line: next,
                    pattern_id: if covered {
                        Some(pattern.id)
                    } else {
                        segment.pattern_id
                    },
                    style: if covered { style } else { segment.style },
                });
                pos = next;
            }
        }
        segments = merge_adjacent_segments(output);
    }

    segments
}

fn style_for_pattern(pattern: &AnalysePattern) -> EffectiveStyle {
    EffectiveStyle {
        hidden: pattern.hide,
        bold: pattern.bold,
        italic: pattern.italic,
        underline: pattern.underline,
        foreground: pattern.foreground,
        background: pattern.background,
    }
}

fn merge_adjacent_segments(segments: Vec<StyledSegment>) -> Vec<StyledSegment> {
    let mut merged: Vec<StyledSegment> = Vec::with_capacity(segments.len());
    for segment in segments {
        if let Some(previous) = merged.last_mut()
            && previous.end_byte_in_line == segment.start_byte_in_line
            && previous.pattern_id == segment.pattern_id
            && previous.style == segment.style
        {
            previous.end_byte_in_line = segment.end_byte_in_line;
        } else {
            merged.push(segment);
        }
    }
    merged
}

fn validate_pattern_ids(patterns: &[AnalysePattern]) -> Result<(), AnalyseRunError> {
    let mut ids = HashSet::with_capacity(patterns.len());
    for pattern in patterns {
        if !ids.insert(pattern.id) {
            return Err(AnalyseRunError::DuplicatePatternId(pattern.id));
        }
    }
    Ok(())
}

fn check_cancelled(cancel: &CancellationToken) -> Result<(), AnalyseRunError> {
    if cancel.is_cancelled() {
        Err(AnalyseRunError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::analyse::{AnalysePatternError, AnalyseSearchType, LineSpan, RawMatch, RgbColor};

    struct CountingBackend {
        compile_count: Arc<AtomicUsize>,
        find_count: Arc<AtomicUsize>,
        router: AnalyseMatcherRouter,
    }

    impl AnalyseMatcherBackend for CountingBackend {
        fn compile(
            &self,
            pattern: &AnalysePattern,
        ) -> Result<Box<dyn CompiledAnalyseMatcher>, AnalysePatternError> {
            self.compile_count.fetch_add(1, Ordering::Relaxed);
            let inner = self.router.compile(pattern)?;
            Ok(Box::new(CountingMatcher {
                find_count: Arc::clone(&self.find_count),
                inner,
            }))
        }
    }

    struct CountingMatcher {
        find_count: Arc<AtomicUsize>,
        inner: Box<dyn CompiledAnalyseMatcher>,
    }

    impl CompiledAnalyseMatcher for CountingMatcher {
        fn find_all(
            &self,
            text: &str,
            line_index: &LineIndex,
            cancel: &CancellationToken,
        ) -> Result<Vec<RawMatch>, AnalysePatternError> {
            self.find_count.fetch_add(1, Ordering::Relaxed);
            self.inner.find_all(text, line_index, cancel)
        }
    }

    fn pattern(id: PatternId, text: &str) -> AnalysePattern {
        AnalysePattern {
            id,
            search_text: text.to_owned(),
            ..Default::default()
        }
    }

    fn run(text: &str, patterns: &[AnalysePattern]) -> AnalyseResult {
        AnalyseEngine::default()
            .run(
                AnalyseRunInput {
                    run_id: 1,
                    document_id: 2,
                    document_revision: 3,
                    pattern_revision: 4,
                    text,
                    patterns,
                },
                &CancellationToken::new(),
            )
            .unwrap()
    }

    #[test]
    fn engine_merges_patterns_in_source_line_and_pattern_order() {
        let patterns = [pattern(1, "ERROR"), pattern(2, "timeout")];
        let result = run("ok\nERROR timeout\nERROR", &patterns);
        assert_eq!(result.total_matches, 3);
        assert_eq!(
            result
                .lines
                .iter()
                .map(|line| line.source_line)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(
            result.lines[0]
                .matches
                .iter()
                .map(|line_match| line_match.pattern_id)
                .collect::<Vec<_>>(),
            [1, 2]
        );
    }

    #[test]
    fn one_pattern_error_does_not_discard_other_results() {
        let mut regex = pattern(1, "(");
        regex.search_type = AnalyseSearchType::Regex;
        let patterns = [regex, pattern(2, "ERROR")];
        let result = run("ERROR wifi", &patterns);
        assert_eq!(result.total_matches, 1);
        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.pattern_errors.len(), 1);
        assert_eq!(
            result.pattern_errors[0].kind,
            AnalysePatternErrorKind::InvalidRegex
        );
    }

    #[test]
    fn escaped_multiline_match_adds_each_covered_line() {
        let mut escaped = pattern(1, r"start\r\nend");
        escaped.search_type = AnalyseSearchType::Escaped;
        let result = run("start\r\nend", &[escaped]);
        assert_eq!(result.total_matches, 1);
        assert_eq!(
            result
                .lines
                .iter()
                .map(|line| line.source_line)
                .collect::<Vec<_>>(),
            [1, 2]
        );
    }

    #[test]
    fn later_text_pattern_overrides_only_its_span() {
        let mut line_pattern = pattern(1, "line");
        line_pattern.foreground = RgbColor::new(255, 0, 0);
        let mut text_pattern = pattern(2, "middle");
        text_pattern.selection = AnalyseSelection::Text;
        text_pattern.bold = true;
        text_pattern.foreground = RgbColor::new(0, 0, 255);

        let result = run("line middle tail", &[line_pattern, text_pattern]);
        let segments = &result.lines[0].styled_segments;
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].pattern_id, Some(1));
        assert_eq!(segments[1].pattern_id, Some(2));
        assert!(segments[1].style.bold);
        assert_eq!(segments[2].pattern_id, Some(1));
    }

    #[test]
    fn overlapping_unordered_spans_keep_later_pattern_precedence() {
        let matches = |id, ranges: &[(usize, usize)]| LinePatternMatch {
            pattern_id: id,
            spans: ranges
                .iter()
                .map(|&(start, end)| LineSpan {
                    line: 1,
                    start_byte_in_line: start,
                    end_byte_in_line: end,
                })
                .collect(),
        };
        let mut patterns = [pattern(1, "a"), pattern(2, "b")];
        for pattern in &mut patterns {
            pattern.selection = AnalyseSelection::Text;
        }
        let result = resolve_line_styles(
            "0123456789",
            &[
                matches(1, &[(7, 10), (0, 4)]),
                matches(2, &[(5, 8), (2, 6), (3, 3)]),
            ],
            &patterns,
        );
        let spans: Vec<_> = result
            .iter()
            .map(|s| (s.start_byte_in_line, s.end_byte_in_line, s.pattern_id))
            .collect();
        assert_eq!(spans, [(0, 2, Some(1)), (2, 8, Some(2)), (8, 10, Some(1))]);
    }

    #[test]
    fn hide_changes_view_style_but_preserves_logical_text() {
        let mut hidden = pattern(1, "secret");
        hidden.selection = AnalyseSelection::Text;
        hidden.hide = true;
        let result = run("visible secret text", &[hidden]);
        assert_eq!(result.lines[0].text, "visible secret text");
        assert!(
            result.lines[0]
                .styled_segments
                .iter()
                .any(|segment| segment.style.hidden)
        );
    }

    #[test]
    fn pattern_248_uses_default_style_and_still_wins() {
        let mut patterns: Vec<_> = (1..=248)
            .map(|id| {
                let mut pattern = pattern(id, "x");
                pattern.selection = AnalyseSelection::Text;
                pattern.foreground = RgbColor::new(255, 0, 0);
                pattern
            })
            .collect();
        patterns[247].bold = true;
        let result = run("x", &patterns);
        let segment = &result.lines[0].styled_segments[0];
        assert_eq!(segment.pattern_id, Some(248));
        assert_eq!(segment.style, EffectiveStyle::default());
        assert_eq!(result.total_matches, 248);
    }

    #[test]
    fn merge_can_reuse_cached_pattern_results_after_reorder() {
        let text = "abc";
        let index = LineIndex::new(text);
        let span = LineSpan {
            line: 1,
            start_byte_in_line: 0,
            end_byte_in_line: 1,
        };
        let raw_match = RawMatch {
            start_byte: 0,
            end_byte: 1,
            start_line: 1,
            end_line: 1,
            line_spans: vec![span],
        };
        let results = [
            PatternResult {
                pattern_id: 1,
                matches: vec![raw_match.clone()],
                error: None,
                search_revision: 1,
            },
            PatternResult {
                pattern_id: 2,
                matches: vec![raw_match],
                error: None,
                search_revision: 1,
            },
        ];
        let patterns = [pattern(2, "a"), pattern(1, "a")];
        let lines =
            merge_pattern_results(text, &index, &patterns, &results, &CancellationToken::new())
                .unwrap();
        assert_eq!(
            lines[0]
                .matches
                .iter()
                .map(|line_match| line_match.pattern_id)
                .collect::<Vec<_>>(),
            [2, 1]
        );
        assert_eq!(lines[0].styled_segments[0].pattern_id, Some(1));
    }

    #[test]
    fn cancellation_and_duplicate_ids_fail_the_run() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            AnalyseEngine::default()
                .run(
                    AnalyseRunInput {
                        run_id: 1,
                        document_id: 1,
                        document_revision: 1,
                        pattern_revision: 1,
                        text: "text",
                        patterns: &[pattern(1, "text")],
                    },
                    &cancel,
                )
                .unwrap_err(),
            AnalyseRunError::Cancelled
        );

        let duplicate = [pattern(1, "a"), pattern(1, "b")];
        assert_eq!(
            AnalyseEngine::default()
                .run(
                    AnalyseRunInput {
                        run_id: 1,
                        document_id: 1,
                        document_revision: 1,
                        pattern_revision: 1,
                        text: "ab",
                        patterns: &duplicate,
                    },
                    &CancellationToken::new(),
                )
                .unwrap_err(),
            AnalyseRunError::DuplicatePatternId(1)
        );
    }

    #[test]
    fn disabled_pattern_has_no_result_or_error() {
        let mut disabled = pattern(1, "text");
        disabled.enabled = false;
        let result = run("text", &[disabled]);
        assert_eq!(result.total_matches, 0);
        assert!(result.lines.is_empty());
        assert!(result.pattern_errors.is_empty());
    }

    #[test]
    fn empty_pattern_is_isolated_as_a_pattern_error() {
        let result = run("text", &[pattern(1, ""), pattern(2, "text")]);
        assert_eq!(result.total_matches, 1);
        assert_eq!(result.pattern_errors.len(), 1);
        assert_eq!(
            result.pattern_errors[0],
            AnalysePatternError::new(
                1,
                AnalysePatternErrorKind::EmptyPattern,
                "search text is empty"
            )
        );
    }

    #[test]
    fn incremental_run_reuses_pattern_results_and_compile_cache() {
        let compile_count = Arc::new(AtomicUsize::new(0));
        let find_count = Arc::new(AtomicUsize::new(0));
        let engine = AnalyseEngine::new(Arc::new(CountingBackend {
            compile_count: Arc::clone(&compile_count),
            find_count: Arc::clone(&find_count),
            router: AnalyseMatcherRouter::new(),
        }));
        let first_patterns = [pattern(1, "x"), pattern(2, "x")];
        let first = engine
            .run_with_pattern_results(
                AnalyseRunInput {
                    run_id: 1,
                    document_id: 1,
                    document_revision: 1,
                    pattern_revision: 1,
                    text: "x",
                    patterns: &first_patterns,
                },
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(compile_count.load(Ordering::Relaxed), 2);
        assert_eq!(find_count.load(Ordering::Relaxed), 2);

        let mut presentation_only = pattern(1, "x");
        presentation_only.bold = true;
        let reordered = [pattern(2, "x"), presentation_only];
        let revisions = HashMap::from([(1, 1), (2, 1)]);
        let second = engine
            .run_incremental(
                AnalyseRunInput {
                    run_id: 2,
                    document_id: 1,
                    document_revision: 1,
                    pattern_revision: 2,
                    text: "x",
                    patterns: &reordered,
                },
                &first,
                &revisions,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(compile_count.load(Ordering::Relaxed), 2);
        assert_eq!(find_count.load(Ordering::Relaxed), 2);
        assert_eq!(
            second.result.lines[0]
                .matches
                .iter()
                .map(|line_match| line_match.pattern_id)
                .collect::<Vec<_>>(),
            [2, 1]
        );
        assert!(second.result.lines[0].styled_segments[0].style.bold);

        let search_changed = [pattern(2, "x"), pattern(1, "y")];
        let changed_revisions = HashMap::from([(1, 2), (2, 1)]);
        let third = engine
            .run_incremental(
                AnalyseRunInput {
                    run_id: 3,
                    document_id: 1,
                    document_revision: 1,
                    pattern_revision: 3,
                    text: "x",
                    patterns: &search_changed,
                },
                &second,
                &changed_revisions,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(compile_count.load(Ordering::Relaxed), 3);
        assert_eq!(find_count.load(Ordering::Relaxed), 3);
        assert_eq!(third.result.total_matches, 1);
        assert_eq!(engine.compile_cache_len(), 2);

        let fourth = engine
            .run_incremental(
                AnalyseRunInput {
                    run_id: 4,
                    document_id: 1,
                    document_revision: 2,
                    pattern_revision: 3,
                    text: "x",
                    patterns: &search_changed,
                },
                &third,
                &changed_revisions,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(find_count.load(Ordering::Relaxed), 5);
        assert_eq!(fourth.result.total_matches, 1);
        assert_eq!(compile_count.load(Ordering::Relaxed), 3);

        engine.clear_compile_cache();
        assert_eq!(engine.compile_cache_len(), 0);
    }
}
