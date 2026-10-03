export function markdownProse(source: string, includeCode = false): string {
  let value = source.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, "");
  value = value.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gm, (block) => includeCode ? block.replace(/^.*\n|\n[^\n]*$/g, "") : "");
  value = value.replace(/<!--[^]*?-->/g, "").replace(/^\s*\[[^\]]+\]:\s+.*$/gm, "");
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  value = value.replace(/<[^>]*>/g, " ").replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "");
  value = value.replace(/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/gm, "");
  return value.replace(/[`*_~|]/g, "").replace(/\\([\p{P}\p{S}])/gu, "$1").replace(/&nbsp;/g, " ").replace(/&(?:amp|lt|gt|quot);/g, " ");
}

export function writingStats(source: string, markdown = false, includeCode = false) {
  const text = (markdown ? markdownProse(source, includeCode) : source).normalize("NFC");
  const chinese = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const words = (text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).filter(({ segment }) => !/^\s+$/u.test(segment)).length;
  return { chinese, words, characters: chars, readingMinutes: Math.max(text.trim() ? 1 : 0, Math.ceil(chinese / 400 + words / 200)) };
}
