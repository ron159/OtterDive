export const outlineHeadingSelector = ".mu-container > :is(h1, h2, h3, h4, h5, h6)";
export const outlineHeadingOffset = 32;

/** Keep every original row available for scroll tracking, including hidden headings. */
export function filterOutlineRows(rows: Iterable<HTMLElement>, query: string) {
  const term = query.trim().toLowerCase();
  let matches = 0;
  for (const row of rows) {
    row.hidden = Boolean(term) && !(row.textContent ?? "").toLowerCase().includes(term);
    if (!row.hidden) matches++;
  }
  return matches;
}

export function handleOutlineNavigationKey(event: KeyboardEvent, input: HTMLInputElement, list: HTMLElement) {
  const fromInput = event.target === input;
  if (!fromInput && !(event.target instanceof HTMLButtonElement && list.contains(event.target))) return;
  const { key } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && !(fromInput && key === "Enter")) return;
  event.preventDefault();
  event.stopPropagation();
  const rows = [...list.querySelectorAll<HTMLButtonElement>("button:not([hidden])")];
  if (!rows.length) return;
  if (key === "Enter") {
    rows[0].click();
    return;
  }
  const index = rows.findIndex(row => row === event.target);
  const next = key === "ArrowDown" ? (index + 1) % rows.length : index > 0 ? index - 1 : rows.length - 1;
  rows[next].focus();
}

/** Scroll only the editor pane; centering the heading disagrees with scroll tracking. */
export function revealOutlineHeading(root: HTMLElement, index: number) {
  const heading = root.querySelectorAll<HTMLElement>(outlineHeadingSelector)[index];
  if (!heading) return null;
  root.scrollTo({
    top: root.scrollTop + heading.getBoundingClientRect().top - root.getBoundingClientRect().top - outlineHeadingOffset,
    behavior: "instant",
  });
  return { index, scrollTop: root.scrollTop };
}

export function retainedOutlineNavigation(navigation: { index: number; scrollTop: number } | null, scrollTop: number) {
  // At the document end, the browser can clamp the jump before the heading reaches the top.
  // Retain the clicked heading until the viewport actually moves again.
  return navigation && Math.abs(navigation.scrollTop - scrollTop) < 1 ? navigation : null;
}

/** Keep the outline and the readable document in one centered page layout. */
export function documentOutlineLayout(width: number, contentWidth: string, visible: boolean, split: boolean) {
  if (!visible || width <= 0) return { outlineWidth: 0, inset: 0 };
  const outlineWidth = Math.min(192, Math.max(96, Math.floor(width * 0.18)));
  const preferred = contentWidth.endsWith("px") ? Number.parseFloat(contentWidth) : width;
  const pageWidth = split || !Number.isFinite(preferred) ? width : preferred;
  return { outlineWidth, inset: Math.max(0, Math.floor((width - pageWidth - outlineWidth - 24) / 2)) };
}

export function restoreOutlinePreferences(snapshot: {
  outlineOpen?: boolean;
  outlinePosition?: unknown;
  outlineDisplayMode?: unknown;
  rightTool?: string;
  rightSidebarOpen?: boolean;
}) {
  return {
    outlineOpen: snapshot.outlineOpen ?? (snapshot.rightTool === "outline" ? Boolean(snapshot.rightSidebarOpen) : true),
    outlinePosition: snapshot.outlinePosition === "left" ? "left" as const : "right" as const,
    outlineDisplayMode: snapshot.outlineDisplayMode === "always" ? "always" as const : "hover" as const,
  };
}
