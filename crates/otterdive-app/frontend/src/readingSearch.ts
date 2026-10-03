/** Select a rendered match without modifying markup or the underlying document. */
export function revealReadingMatch(root: HTMLElement, text: string, occurrence = 0) {
  if (!text) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest('script,style,nav,.markdown-toc') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let content = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = content.length;
    content += node.textContent ?? '';
    nodes.push({ node: node as Text, start, end: content.length });
  }
  let index = -1;
  for (let count = 0; count <= occurrence; count++) {
    index = content.indexOf(text, index + 1);
    if (index < 0) break;
  }
  if (index < 0) index = content.indexOf(text);
  if (index < 0) return false;
  const start = nodes.find((item) => item.end > index);
  const end = nodes.find((item) => item.end >= index + text.length);
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, index - start.start);
  range.setEnd(end.node, index + text.length - end.start);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  start.node.parentElement?.scrollIntoView({ block: 'center' });
  return true;
}
