import { parseSrcAndTitle } from "../vendor/marktext-muya/src/inlineRenderer/linkDestination";

function markdownImageContentMask(markdown: string) {
  const blank = (value: string) => value.replace(/[^\r\n]/g, " ");
  let fence: { char: string; length: number } | null = null;
  let masked = markdown.split(/(?<=\n)/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length
        && /^\s*$/.test(line.slice(marker[0].length))) fence = null;
      return blank(line);
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; return blank(line); }
    return /^(?: {4}|\t)/.test(line) ? blank(line) : line;
  }).join("");
  masked = masked.replace(/(`+)[\s\S]*?\1(?!`)/g, blank);
  return masked.replace(/\\[!<\[]/g, blank);
}

export type ImageMigration = { source: string; relativePath: string };
type ImageReference = { source: string; start: number; end: number; html?: boolean };

function imageReferencesWithOffsets(text: string) {
  const mask = markdownImageContentMask(text);
  // Muya's inline parser receives paragraph lines joined with spaces. Keep source offsets intact.
  const inlineText = mask.replace(/[\r\n]/g, " ");
  const references: ImageReference[] = [];
  const labels = new Set<string>();
  const images = /!\[((?:\\.|[^\]\\])*)\](?:\(\s*|\[((?:\\.|[^\]\\])*)\])?|<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  for (let match; (match = images.exec(mask));) {
    if (match[0].startsWith("<")) {
      const attributes = /\s+([^\s=/>'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      for (const attribute of match[0].matchAll(attributes)) {
        if (attribute[1].toLowerCase() !== "src") continue;
        const source = attribute[2] ?? attribute[3] ?? attribute[4];
        if (source) {
          const end = match.index + attribute.index + attribute[0].length - (attribute[4] === undefined ? 1 : 0);
          references.push({ source, start: end - source.length, end, html: true });
        }
        break;
      }
      continue;
    }
    if (!/\(\s*$/.test(match[0])) {
      labels.add((match[2] || match[1]).trim().toLowerCase());
      continue;
    }
    const start = images.lastIndex;
    const tail = parseSrcAndTitle(inlineText.slice(start));
    if (!tail || mask[start + tail.length] !== ")") continue;
    const raw = mask.slice(start, start + tail.length);
    const destination = /^(?:<(?:\\.|[^>\\])*>|[^\s]+)/.exec(raw)?.[0];
    if (destination && tail.src) references.push({ source: tail.src, start, end: start + destination.length });
    images.lastIndex = start + tail.length + 1;
  }

  for (const match of mask.matchAll(/^ {0,3}\[([^\]\r\n]+)\]:\s*(<(?:\\.|[^>\\\r\n])*>|[^\s]+)/gm)) {
    if (!labels.has(match[1].trim().toLowerCase())) continue;
    const raw = match[2];
    const source = parseSrcAndTitle(raw)?.src;
    if (!source) continue;
    const end = match.index + match[0].length;
    references.push({ source, start: end - raw.length, end });
  }
  return references.sort((a, b) => a.start - b.start);
}

export function markdownImageReferences(markdown: string) {
  return [...new Set(imageReferencesWithOffsets(markdown).map(reference => reference.source))];
}

export function applyImageMigrations(text: string, migrated: ImageMigration[] = []) {
  if (!migrated.length) return text;
  const paths = new Map(migrated.map(asset => [asset.source, asset.relativePath]));
  const pieces: string[] = [];
  let previous = 0;
  for (const reference of imageReferencesWithOffsets(text)) {
    const target = paths.get(reference.source);
    if (!target) continue;
    pieces.push(text.slice(previous, reference.start), reference.html ? target : "<" + target + ">");
    previous = reference.end;
  }
  return pieces.length ? pieces.join("") + text.slice(previous) : text;
}
