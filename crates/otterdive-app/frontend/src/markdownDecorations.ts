export const markdownAlertNames: Record<string, string> = {
  NOTE: "备注", TIP: "提示", IMPORTANT: "重要", WARNING: "警告", CAUTION: "注意",
};

export function markdownAlertType(text: string) {
  const type = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s|$)/i.exec(text.trimStart())?.[1].toUpperCase();
  return type ?? null;
}

export function markdownTocHtml(items: Array<{ level: number; text: string; id: string }>) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const minimumLevel = Math.min(...items.map((item) => item.level), 6);
  return `<nav class="markdown-toc" aria-label="文档目录"><ol>${items.map((item, index) => `<li style="margin-inline-start:${Math.max(0, item.level - minimumLevel)}em"><a href="#${escape(encodeURIComponent(item.id))}" data-heading-index="${index}">${escape(item.text || "无标题")}</a></li>`).join("")}</ol></nav>`;
}
