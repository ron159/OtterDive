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
