export interface ResultRow {
  path: string;
  line: number;
  column: number;
  text: string;
  fields?: Record<string, string>;
}
export interface AnalysisStep {
  action: 'include' | 'exclude' | 'extract' | 'dedupe';
  query: string;
  regex: boolean;
  matchCase: boolean;
}

export function analyseResults(rows: ResultRow[], step: AnalysisStep): ResultRow[] {
  if (step.action === 'dedupe') {
    const seen = new Set<string>();
    return rows.filter(row => {
      if (seen.has(row.text)) return false;
      seen.add(row.text);
      return true;
    });
  }
  if (!step.query) throw new Error('请输入筛选内容或正则表达式');
  const pattern = step.regex || step.action === 'extract'
    ? new RegExp(step.query, step.matchCase ? 'u' : 'iu') : null;
  const query = step.matchCase ? step.query : step.query.toLocaleLowerCase();
  return rows.flatMap(row => {
    const match = pattern?.exec(row.text);
    const found = pattern ? Boolean(match) : (step.matchCase ? row.text : row.text.toLocaleLowerCase()).includes(query);
    if (step.action === 'exclude') return found ? [] : [row];
    if (!found) return [];
    if (step.action !== 'extract' || !match) return [row];
    const fields = match.groups ? { ...match.groups } : Object.fromEntries(match.slice(1).map((value, i) => [String(i + 1), value ?? '']));
    return [{ ...row, text: match.length > 1 ? match.slice(1).map(value => value ?? '').join('\t') : match[0], fields }];
  });
}

export function exportResultRows(rows: ResultRow[], format: 'csv' | 'json') {
  if (format === 'json') return JSON.stringify(rows, null, 2);
  const quote = (value: unknown) => {
    let text = String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [['文件', '行', '列', '内容', '捕获字段'], ...rows.map(row => [row.path, row.line, row.column, row.text, JSON.stringify(row.fields ?? {})])]
    .map(values => values.map(quote).join(',')).join('\r\n');
}
