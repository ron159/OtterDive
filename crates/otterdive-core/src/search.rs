use regex::{Regex, RegexBuilder};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Literal,
    Extended,
    Regex,
}

impl SearchMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Literal => "普通",
            Self::Extended => "扩展",
            Self::Regex => "正则",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchOptions {
    pub mode: SearchMode,
    pub match_case: bool,
    pub whole_word: bool,
    pub wrap: bool,
    pub include_hidden: bool,
    pub recursive: bool,
    pub file_glob: String,
    pub skip_dirs: String,
    pub max_file_size: u64,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            mode: SearchMode::Literal,
            match_case: false,
            whole_word: false,
            wrap: true,
            include_hidden: false,
            recursive: true,
            file_glob: "*.*".to_owned(),
            skip_dirs: ".git;target;node_modules;.reference".to_owned(),
            max_file_size: 20 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextMatch {
    pub range: MatchRange,
    pub line: usize,
    pub column: usize,
    pub matched_text: String,
    pub line_text: String,
    pub line_text_start_column: usize,
}

#[derive(Debug, Clone)]
pub struct ReplaceOutcome {
    pub replacements: Vec<String>,
    pub text: String,
    pub count: usize,
    pub matches: Vec<TextMatch>,
}

pub(crate) struct SearchMatcher {
    pattern: Regex,
    whole_word: bool,
}

impl SearchMatcher {
    pub(crate) fn new(query: &str, options: &SearchOptions) -> Result<Self, SearchError> {
        Ok(Self {
            pattern: compile_pattern(query, options)?,
            whole_word: options.whole_word,
        })
    }

    pub(crate) fn find_all(&self, text: &str) -> Vec<TextMatch> {
        let ranges = self.matching_ranges(text);
        if ranges.is_empty() {
            return Vec::new();
        }

        let line_index = LineIndex::new(text);
        ranges
            .into_iter()
            .map(|(start, end)| line_index.match_from_range(text, start, end))
            .collect()
    }

    pub(crate) fn visit_matches(&self, text: &str, mut visit: impl FnMut(TextMatch) -> bool) {
        let index = LineIndex::new(text);
        for mat in self.pattern.find_iter(text) {
            if mat.start() == mat.end()
                || (self.whole_word && !is_whole_word(text, mat.start(), mat.end()))
            {
                continue;
            }
            if !visit(index.match_from_range(text, mat.start(), mat.end())) {
                break;
            }
        }
    }

    pub(crate) fn visit_bounded_matches(
        &self,
        text: &str,
        mut visit: impl FnMut(TextMatch) -> bool,
    ) {
        let index = LineIndex::new(text);
        for mat in self.pattern.find_iter(text) {
            if mat.start() == mat.end()
                || (self.whole_word && !is_whole_word(text, mat.start(), mat.end()))
            {
                continue;
            }
            let line_idx = index
                .starts
                .partition_point(|offset| *offset <= mat.start())
                .saturating_sub(1);
            let line_start = index.starts[line_idx];
            let line_end = index.line_end(text, line_idx);
            let mut preview_start = mat.start().saturating_sub(1024).max(line_start);
            while !text.is_char_boundary(preview_start) {
                preview_start += 1;
            }
            let mut preview_end = (preview_start + 4096).min(line_end);
            while !text.is_char_boundary(preview_end) {
                preview_end -= 1;
            }
            let mut matched_end = mat.end().min(mat.start() + 2048);
            while !text.is_char_boundary(matched_end) {
                matched_end -= 1;
            }
            let hit = TextMatch {
                range: MatchRange {
                    start: mat.start(),
                    end: mat.end(),
                },
                line: line_idx + 1,
                column: text[line_start..mat.start()].encode_utf16().count() + 1,
                line_text_start_column: text[line_start..preview_start].encode_utf16().count() + 1,
                line_text: text[preview_start..preview_end].to_owned(),
                matched_text: text[mat.start()..matched_end].to_owned(),
            };
            if !visit(hit) {
                break;
            }
        }
    }

    fn matching_ranges(&self, text: &str) -> Vec<(usize, usize)> {
        self.pattern
            .find_iter(text)
            .filter(|mat| mat.start() != mat.end())
            .filter(|mat| !self.whole_word || is_whole_word(text, mat.start(), mat.end()))
            .map(|mat| (mat.start(), mat.end()))
            .collect()
    }
}

#[derive(Debug, Clone)]
pub enum SearchError {
    EmptyQuery,
    InvalidRegex(String),
    ReadFile(String),
    ReadOnlyDocument(String),
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyQuery => write!(f, "查询内容不能为空"),
            Self::ReadFile(err) => write!(f, "读取搜索源失败：{err}"),
            Self::InvalidRegex(err) => write!(f, "正则表达式错误：{err}"),
            Self::ReadOnlyDocument(reason) => write!(f, "文档只读：{reason}"),
        }
    }
}

impl std::error::Error for SearchError {}

pub fn find_all(
    text: &str,
    query: &str,
    options: &SearchOptions,
) -> Result<Vec<TextMatch>, SearchError> {
    Ok(SearchMatcher::new(query, options)?.find_all(text))
}

pub fn preview_replace(
    text: &str,
    query: &str,
    replacement: &str,
    options: &SearchOptions,
) -> Result<ReplaceOutcome, SearchError> {
    apply_replace_all(text, query, replacement, options)
}

pub fn apply_replace_all(
    text: &str,
    query: &str,
    replacement: &str,
    options: &SearchOptions,
) -> Result<ReplaceOutcome, SearchError> {
    let matcher = SearchMatcher::new(query, options)?;
    Ok(apply_replace_all_with_matcher(
        text,
        replacement,
        options,
        &matcher,
    ))
}

pub(crate) fn apply_replace_all_with_matcher(
    text: &str,
    replacement: &str,
    options: &SearchOptions,
    matcher: &SearchMatcher,
) -> ReplaceOutcome {
    bounded_replace_with_matcher(text, replacement, options, matcher, usize::MAX, usize::MAX)
        .expect("unbounded replacement")
}

pub(crate) fn bounded_replace_with_matcher(
    text: &str,
    replacement: &str,
    options: &SearchOptions,
    matcher: &SearchMatcher,
    max_bytes: usize,
    max_matches: usize,
) -> Option<ReplaceOutcome> {
    let index = LineIndex::new(text);
    let mut matches = Vec::new();
    let mut replacements = Vec::new();
    let mut retained = text.len();
    // Expand captures against the complete source, preserving anchors and word boundaries.
    for captures in matcher.pattern.captures_iter(text) {
        let mat = captures.get(0).expect("capture zero exists");
        if mat.start() == mat.end()
            || (matcher.whole_word && !is_whole_word(text, mat.start(), mat.end()))
        {
            continue;
        }
        let mut expanded = String::new();
        if options.mode == SearchMode::Regex {
            captures.expand(replacement, &mut expanded);
        } else {
            expanded = normalized_replacement(replacement, options);
        }
        let location = index.match_from_range(text, mat.start(), mat.end());
        retained = retained
            .saturating_add(location.line_text.len())
            .saturating_add(location.matched_text.len())
            .saturating_add(expanded.len().saturating_mul(2));
        if retained > max_bytes || matches.len() >= max_matches {
            return None;
        }
        matches.push(location);
        replacements.push(expanded);
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (mat, replacement) in matches.iter().zip(&replacements) {
        out.push_str(&text[last..mat.range.start]);
        out.push_str(replacement);
        last = mat.range.end;
    }
    out.push_str(&text[last..]);
    Some(ReplaceOutcome {
        text: out,
        count: matches.len(),
        matches,
        replacements,
    })
}

pub fn replacement_for_match(
    matched_text: &str,
    query: &str,
    replacement: &str,
    options: &SearchOptions,
) -> Result<String, SearchError> {
    if options.mode == SearchMode::Regex {
        let regex = compile_pattern(query, options)?;
        Ok(regex.replace(matched_text, replacement).into_owned())
    } else {
        Ok(normalized_replacement(replacement, options))
    }
}

pub fn translate_extended(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('0') => out.push('\0'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn normalized_replacement(replacement: &str, options: &SearchOptions) -> String {
    if options.mode == SearchMode::Extended {
        translate_extended(replacement)
    } else {
        replacement.to_owned()
    }
}

fn compile_pattern(query: &str, options: &SearchOptions) -> Result<Regex, SearchError> {
    if query.is_empty() {
        return Err(SearchError::EmptyQuery);
    }
    let pattern = match options.mode {
        SearchMode::Literal => regex::escape(query),
        SearchMode::Extended => regex::escape(&translate_extended(query)),
        SearchMode::Regex => query.to_owned(),
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.match_case)
        .multi_line(true)
        .build()
        .map_err(|err| SearchError::InvalidRegex(err.to_string()))
}

struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(text: &str) -> Self {
        let mut starts = vec![0];
        let bytes = text.as_bytes();
        for (idx, byte) in bytes.iter().copied().enumerate() {
            if byte == b'\n' || (byte == b'\r' && bytes.get(idx + 1) != Some(&b'\n')) {
                starts.push(idx + 1);
            }
        }
        Self { starts }
    }

    fn line_end(&self, text: &str, line_idx: usize) -> usize {
        let start = self.starts[line_idx];
        let next = self.starts.get(line_idx + 1).copied().unwrap_or(text.len());
        start + text[start..next].trim_end_matches(['\r', '\n']).len()
    }

    fn match_from_range(&self, text: &str, start: usize, end: usize) -> TextMatch {
        let line_idx = self
            .starts
            .partition_point(|line_start| *line_start <= start)
            .saturating_sub(1);
        let line_start = self.starts[line_idx];
        let line_end = self.line_end(text, line_idx);
        let column = text[line_start..start].encode_utf16().count() + 1;
        TextMatch {
            range: MatchRange { start, end },
            line: line_idx + 1,
            column,
            matched_text: text[start..end].to_owned(),
            line_text: text[line_start..line_end].to_owned(),
            line_text_start_column: 1,
        }
    }
}

fn is_whole_word(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
}

fn is_word_char(ch: char) -> bool {
    ch == '_' || ch.is_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_search_is_case_insensitive_by_default() {
        let options = SearchOptions::default();
        let hits = find_all("Alpha alpha ALPHA", "alpha", &options).unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].matched_text, "Alpha");
    }

    #[test]
    fn whole_word_filters_embedded_matches() {
        let options = SearchOptions {
            whole_word: true,
            ..Default::default()
        };
        let hits = find_all("cat scatter cat_ cat", "cat", &options).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn search_reports_line_column_and_line_text() {
        let options = SearchOptions {
            match_case: true,
            ..Default::default()
        };
        let hits = find_all("one\ntwo target\nthree", "target", &options).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].column, 5);
        assert_eq!(hits[0].line_text, "two target");
    }

    #[test]
    fn search_and_replace_locations_follow_editor_newlines_and_utf16_columns() {
        let text = "first\r甲😀 target\r\nlast target\n";
        let options = SearchOptions::default();
        let hits = find_all(text, "target", &options).unwrap();
        assert_eq!((hits[0].line, hits[0].column), (2, 5));
        assert_eq!(hits[0].line_text, "甲😀 target");
        assert_eq!((hits[1].line, hits[1].column), (3, 6));
        let replacement = apply_replace_all(text, "target", "found", &options).unwrap();
        assert_eq!(replacement.matches, hits);
        assert_eq!(replacement.text, "first\r甲😀 found\r\nlast found\n");
    }

    #[test]
    fn bounded_and_regular_search_report_the_same_utf16_locations() {
        let text = "😀 target\rnext\r\n😀 target";
        let matcher = SearchMatcher::new("target", &SearchOptions::default()).unwrap();
        let expected = matcher.find_all(text);
        let mut bounded = Vec::new();
        matcher.visit_bounded_matches(text, |hit| {
            bounded.push(hit);
            true
        });
        assert_eq!(expected, bounded);
        assert_eq!((expected[0].line, expected[0].column), (1, 4));
        assert_eq!((expected[1].line, expected[1].column), (3, 4));
    }

    #[test]
    fn bounded_search_handles_newline_matches_and_multiline_spans() {
        let text = "first\rtarget\r\nnext\nend";
        for query in ["\r", "\r\n", "\n", "target\r\nnext", "(?s)target.*end"] {
            let matcher = SearchMatcher::new(
                query,
                &SearchOptions {
                    mode: SearchMode::Regex,
                    ..Default::default()
                },
            )
            .unwrap();
            let expected = matcher.find_all(text);
            assert!(!expected.is_empty(), "query {query:?}");
            let mut bounded = Vec::new();
            matcher.visit_bounded_matches(text, |hit| {
                bounded.push(hit);
                true
            });
            assert_eq!(bounded, expected, "query {query:?}");
        }

        // A newline begins just outside the trimmed preview, including the LF in CRLF.
        let long_line = format!("{}\r\nend", "😀".repeat(3000));
        for query in ["\r", "\n", "\r\n"] {
            let matcher = SearchMatcher::new(query, &SearchOptions::default()).unwrap();
            let mut count = 0;
            matcher.visit_bounded_matches(&long_line, |hit| {
                count += 1;
                assert_eq!(hit.line, 1);
                assert!(hit.column >= 6001);
                assert!(hit.line_text.len() <= 4096);
                assert!(!hit.line_text.contains(['\r', '\n']));
                true
            });
            assert_eq!(count, 1);
        }
    }

    #[test]
    fn extended_mode_translates_escape_sequences() {
        let options = SearchOptions {
            mode: SearchMode::Extended,
            ..Default::default()
        };
        let hits = find_all("a\nb\n", "\\n", &options).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn matcher_can_be_reused_across_multiple_documents() {
        let options = SearchOptions {
            whole_word: true,
            ..Default::default()
        };
        let matcher = SearchMatcher::new("otterdive", &options).unwrap();

        let first = matcher.find_all("OtterDive is open");
        let second_text = "otterdivedamus otterdive";
        let second = matcher.find_all(second_text);
        let empty = matcher.find_all("another editor");

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(
            second[0].column,
            second_text.rfind("otterdive").unwrap() + 1
        );
        assert!(empty.is_empty());
    }

    #[test]
    fn matcher_rejects_invalid_regex_when_created() {
        let options = SearchOptions {
            mode: SearchMode::Regex,
            ..Default::default()
        };

        assert!(matches!(
            SearchMatcher::new("(", &options),
            Err(SearchError::InvalidRegex(_))
        ));
    }

    #[test]
    fn regex_replacement_supports_captures() {
        let options = SearchOptions {
            mode: SearchMode::Regex,
            match_case: true,
            ..Default::default()
        };
        let out = apply_replace_all("name=otterdive", r"name=(\w+)", "app=$1", &options).unwrap();
        assert_eq!(out.text, "app=otterdive");
        assert_eq!(out.count, 1);
    }

    #[test]
    fn extended_replacement_translates_escape_sequences() {
        let options = SearchOptions {
            mode: SearchMode::Extended,
            match_case: true,
            ..Default::default()
        };
        let out = apply_replace_all("alpha,beta", ",", "\\r\\n", &options).unwrap();
        assert_eq!(out.text, "alpha\r\nbeta");
    }

    #[test]
    fn current_match_replacement_uses_regex_captures() {
        let options = SearchOptions {
            mode: SearchMode::Regex,
            match_case: true,
            ..Default::default()
        };
        let replacement =
            replacement_for_match("name=otterdive", r"name=(\w+)", "app=$1", &options).unwrap();
        assert_eq!(replacement, "app=otterdive");
    }
}
