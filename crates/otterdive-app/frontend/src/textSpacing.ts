import { Lexer, type Token } from "marked";

const blank = (text: string) => text.replace(/[^\r\n]/g, " ");

function markdownProseMask(text: string) {
  const lexer = new Lexer({ gfm: true });
  // Resolve reference links before masking their definitions.
  lexer.lex(text);
  let mask = text.replace(/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?(?<=\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, blank);
  let fence: { marker: string; length: number } | null = null;
  mask = mask.split(/(?<=\n)|(?<=\r)(?!\n)/).map(line => {
    const marker = /^(?:[ \t]*>[ \t]*|[ \t]*(?:[-+*]|\d+[.)])[ \t]+)*[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length
        && !line.slice(marker[0].length).trim()) fence = null;
      return blank(line);
    }
    if (marker) {
      fence = { marker: marker[1][0], length: marker[1].length };
      return blank(line);
    }
    return /^(?: {4}|\t)/.test(line) ? blank(line) : line;
  }).join("");
  mask = mask.replace(/<!--[\s\S]*?(?:-->|$)/g, blank);
  mask = mask.replace(/\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\\\r\n])+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, blank);
  mask = mask.replace(/^(?:[ \t]*>[ \t]*|[ \t]*(?:[-+*]|\d+[.)])[ \t]+)*[ \t]{0,3}\[[^\]\r\n]+\]:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]+)*/gm, blank);

  const characters = mask.split("");
  function protect(start: number, end: number) {
    for (let index = start; index < end; index++) {
      if (characters[index] !== "\r" && characters[index] !== "\n") characters[index] = " ";
    }
  }
  function visit(tokens: Token[], offset: number) {
    for (const token of tokens) {
      const raw = token.raw;
      if (["codespan", "escape"].includes(token.type)) {
        protect(offset, offset + raw.length);
      } else if (token.type === "link" || token.type === "image") {
        const opening = raw.startsWith("![") ? 1 : raw.startsWith("[") ? 0 : -1;
        if (opening < 0) {
          protect(offset, offset + raw.length);
        } else {
          let closing = opening + 1, depth = 1;
          for (; closing < raw.length; closing++) {
            if (raw[closing] === "\\") { closing++; continue; }
            if (raw[closing] === "[") depth++;
            if (raw[closing] === "]" && --depth === 0) break;
          }
          const suffix = raw.slice(closing + 1);
          if (!suffix || suffix === "[]") {
            // Shortcut/collapsed labels also identify their reference target.
            protect(offset, offset + raw.length);
          } else {
            protect(offset + closing, offset + raw.length);
            visit(lexer.inlineTokens(raw.slice(opening + 1, closing)), offset + opening + 1);
          }
        }
      } else if ("tokens" in token && token.tokens) {
        const inner = token.tokens.map(child => child.raw).join("");
        const start = raw.indexOf(inner);
        if (start >= 0) visit(token.tokens, offset + start);
      }
      offset += raw.length;
    }
  }
  // Inline syntax must be recognized before math masking can alter a link's destination or identifier.
  visit(lexer.inlineTokens(text), 0);
  const htmlStack: Array<{ name: string; start: number }> = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const tag of characters.join("").matchAll(/<(\/?)([a-z][\w:-]*)(?=\s|\/?>)(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const name = tag[2].toLowerCase();
    protect(tag.index, tag.index + tag[0].length);
    if (tag[1]) {
      let opening = htmlStack.length - 1;
      while (opening >= 0 && htmlStack[opening].name !== name) opening--;
      if (opening >= 0) {
        protect(htmlStack[opening].start, tag.index + tag[0].length);
        htmlStack.splice(opening);
      }
    } else if (!tag[0].endsWith("/>") && !voidTags.has(name)) {
      htmlStack.push({ name, start: tag.index });
    }
  }
  for (const tag of htmlStack) protect(tag.start, mask.length);
  return characters.join("");
}

/** Source offsets let callers apply only edits inside a selection, with full Markdown context. */
export function textSpacingEdits(text: string, markdown = false): number[] {
  const prose = markdown ? markdownProseMask(text) : text;
  return Array.from(prose.matchAll(/(?<=\p{Script=Han})(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])(?=\p{Script=Han})/gu),
    match => match.index);
}

export function optimizeTextSpacing(text: string, markdown = false): string {
  let start = 0;
  const pieces = textSpacingEdits(text, markdown).map(offset => {
    const piece = text.slice(start, offset) + " ";
    start = offset;
    return piece;
  });
  return pieces.join("") + text.slice(start);
}
