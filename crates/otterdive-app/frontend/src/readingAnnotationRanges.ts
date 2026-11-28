import { revealReadingSections } from "./readingSections";
import { anchorSelection, textSignature, type ReadingText } from "./readingAnnotations";

type Segment = { node: Text; start: number; end: number };
type IndexedBody = ReadingText & { segments: Segment[] };
const excluded = "nav,.markdown-toc,.markdown-preview-empty,code:is(.language-mermaid,.language-vega-lite,.language-plantuml,.language-flowchart,.language-sequence),svg,math,script,style,button,[hidden]:not(.reading-section-content),[aria-hidden=true],.markdown-diagram,.katex-mathml";
const headings = "h1,h2,h3,h4,h5,h6";
const blocks = headings + ",p,li,td,th,pre,blockquote,div,dt,dd,figcaption";

// Inline markup is transparent. Block boundaries and explicit line breaks contribute a newline.
export function indexReadingBody(body: HTMLElement): IndexedBody {
  const segments: Segment[] = [];
  const sections: ReadingText["sections"] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      return node instanceof Element && node.matches(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "", previousBlock: Element | null = null, previousHeading: HTMLElement | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLBRElement) { text += "\n"; continue; }
    if (!(node instanceof Text) || !node.data) continue;
    const parent = node.parentElement!;
    const block = parent.closest(blocks);
    if (/[\r\n]/.test(node.data) && !node.data.trim() && !parent.closest("pre,p,li,td,th," + headings)) continue;
    if (previousBlock !== block && text && !text.endsWith("\n")) text += "\n";
    const heading = parent.closest<HTMLElement>(headings);
    if (heading && heading !== previousHeading) sections.push({ id: heading.id, label: heading.textContent ?? "", start: text.length });
    previousBlock = block;
    previousHeading = heading;
    const start = text.length;
    text += node.data;
    segments.push({ node, start, end: text.length });
  }
  return { text, sections, segments, signature: textSignature(text) };
}

export function selectedAnchor(body: HTMLElement, range: Range) {
  if (range.collapsed || !body.contains(range.commonAncestorContainer)) return null;
  const index = indexReadingBody(body);
  let start = -1, end = -1;
  for (const segment of index.segments) {
    if (!range.intersectsNode(segment.node)) continue;
    const left = segment.node === range.startContainer ? segment.start + range.startOffset : segment.start;
    const right = segment.node === range.endContainer ? segment.start + range.endOffset : segment.end;
    if (left >= right) continue;
    if (segment.node.parentElement?.closest(".reading-section-content[hidden]")) return null;
    if (start < 0) start = left;
    end = right;
  }
  return start >= 0 && index.text.slice(start, end).trim() ? anchorSelection(index, start, end) : null;
}

type Span = { start: number; end: number };

// Paint the union, so overlapping notes never nest marks or split existing inline elements.
export function paintReadingSpans(index: IndexedBody, spans: Span[]) {
  const merged: Span[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && previous.end >= span.start) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  const marks: HTMLElement[] = [];
  let first = 0;
  for (const { node, start, end } of index.segments) {
    while (merged[first] && merged[first].end <= start) first++;
    if (!merged[first] || merged[first].start >= end) continue;
    const result = document.createDocumentFragment();
    let cursor = start;
    for (let i = first; i < merged.length && merged[i].start < end; i++) {
      const left = Math.max(merged[i].start, start);
      const right = Math.min(merged[i].end, end);
      result.append(node.data.slice(cursor - start, left - start));
      const mark = document.createElement("mark");
      mark.className = "reading-annotation-mark";
      mark.textContent = node.data.slice(left - start, right - start);
      result.append(mark);
      marks.push(mark);
      cursor = right;
    }
    result.append(node.data.slice(cursor - start));
    node.replaceWith(result);
  }
  return marks;
}

export function clearReadingMarks(marks: HTMLElement[]) {
  const parents = new Set<Element>();
  for (const mark of marks) {
    if (mark.parentElement) parents.add(mark.parentElement);
    mark.replaceWith(...mark.childNodes);
  }
  for (const parent of parents) parent.normalize();
}

export function revealReadingSpan(body: HTMLElement, pane: HTMLElement, start: number, length: number) {
  const { segments } = indexReadingBody(body);
  const first = segments.find(segment => segment.end > start);
  const last = segments.find(segment => segment.end >= start + length);
  if (!first || !last) return;
  for (const { node, start: left, end: right } of segments) {
    if (right <= start) continue;
    if (left >= start + length) break;
    revealReadingSections(node.parentElement);
  }
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, start + length - last.start);
  pane.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  pane.scrollTop += range.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 3;
}
