/** Expand a replacement against Monaco's LF search text and offsets. */
export function regexReplacementAt(
  source: string, start: number, matched: string, query: string, replacement: string, matchCase: boolean,
  lineText?: string, column = 1,
) {
  if (!replacement.includes("$")) return replacement;
  // Match Monaco TextModelSearch's scope: only expressions containing a literal
  // newline or an unescaped \n, \r or \W are evaluated across lines.
  let multiline = false;
  for (let index = 0; index < query.length; index++) {
    if (query[index] === "\n") multiline = true;
    if (query[index] === "\\") {
      index++;
      if (["n", "r", "W"].includes(query[index])) multiline = true;
    }
  }
  const pattern = new RegExp(query, `${matchCase ? "" : "i"}${multiline ? "m" : ""}uy`);
  let scope = source;
  pattern.lastIndex = start;
  if (!multiline) {
    if (lineText !== undefined) {
      scope = lineText;
      pattern.lastIndex = column - 1;
    } else {
      const lineStart = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = source.indexOf("\n", start);
      scope = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).replace(/\r$/, "");
      pattern.lastIndex = start - lineStart;
    }
  }
  const captures = pattern.exec(scope);
  if (!captures || captures[0] !== matched) throw new Error("匹配内容已变化，请重新查找后替换");
  return replacement.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (token, marker: string, name: string | undefined, digits: string | undefined) => {
    if (marker === "$") return "$";
    if (marker === "&") return matched;
    if (marker === "`") return source.slice(0, start);
    if (marker === "'") return source.slice(start + matched.length);
    if (name !== undefined) return captures.groups ? captures.groups[name] ?? "" : token;
    const index = Number(digits);
    if (index > 0 && index < captures.length) return captures[index] ?? "";
    const first = Number(digits![0]);
    if (digits!.length === 2 && first > 0 && first < captures.length) return (captures[first] ?? "") + digits![1];
    return token;
  });
}
