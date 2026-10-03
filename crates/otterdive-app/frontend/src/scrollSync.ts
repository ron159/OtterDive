/** Piecewise interpolation retains chapter positions even when images change their height. */
export function mapScrollPosition(position: number, anchors: Array<{ source: number; target: number }>) {
  const points = anchors.filter((point) => Number.isFinite(point.source) && Number.isFinite(point.target))
    .sort((a, b) => a.source - b.source);
  if (!points.length) return 0;
  if (position <= points[0].source) return Math.max(0, points[0].target);
  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1], after = points[index];
    if (position <= after.source) {
      const fraction = (position - before.source) / Math.max(1, after.source - before.source);
      return Math.max(0, before.target + fraction * (after.target - before.target));
    }
  }
  return Math.max(0, points.at(-1)!.target);
}
