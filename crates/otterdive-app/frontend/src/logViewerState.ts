export const LOG_CHUNK_BYTES = 256 * 1024;
export const LOG_WINDOW_BYTES = 2 * 1024 * 1024;

export type FileChunk = {
  text: string;
  startOffset: number;
  nextOffset: number;
  size: number;
  identity: string;
  revision: string;
  reset: boolean;
  hasMore: boolean;
  encoding: string;
  warning?: string | null;
  fingerprint: string;
};

export type LogReadAction = "start" | "previous" | "next" | "end" | "follow";
export type LogChunkRequest = {
  path: string;
  offset?: number;
  limit: number;
  tail: boolean;
  encoding: string;
  previousSize?: number;
  previousIdentity?: string;
  previousRevision?: string;
  previousFingerprint?: string;
};

export function logEncodingLabel(label: string): string {
  if (label === "UTF-8-BOM") return "UTF-8 BOM";
  if (label === "UTF-16 Little Endian") return "UTF-16 LE";
  if (label === "UTF-16 Big Endian") return "UTF-16 BE";
  return label;
}

export function logChunkRequest(
  path: string,
  action: LogReadAction,
  cursor: FileChunk | null,
  firstVisibleOffset: number,
  encoding: string,
): LogChunkRequest {
  const sequential = action === "next" || action === "follow";
  const tail = action === "end" || (action === "follow" && !cursor);
  const offset = tail ? undefined : action === "start" ? 0
    : action === "previous" ? Math.max(0, firstVisibleOffset - LOG_CHUNK_BYTES)
    : cursor?.nextOffset ?? 0;
  return {
    path, offset, limit: LOG_CHUNK_BYTES, tail, encoding: logEncodingLabel(encoding),
    previousSize: cursor?.size,
    previousIdentity: cursor?.identity,
    previousRevision: cursor?.revision,
    // A fingerprint describes bytes preceding exactly this sequential cursor.
    previousFingerprint: sequential && cursor ? cursor.fingerprint : undefined,
  };
}

/** Keep complete chunks so displayed byte positions always refer to real source boundaries. */
export function retainLogWindow(
  previous: readonly FileChunk[], incoming: FileChunk, append: boolean,
  limit = LOG_WINDOW_BYTES,
): FileChunk[] {
  if (incoming.text.length * 2 > limit) throw new Error("日志分块超过显示缓冲区限制");
  const last = previous.at(-1);
  const continuous = append && !incoming.reset && last?.identity === incoming.identity
    && last.nextOffset === incoming.startOffset;
  const chunks = continuous ? [...previous] : [];
  if (incoming.text) chunks.push(incoming);
  let bytes = chunks.reduce((sum, chunk) => sum + chunk.text.length * 2, 0);
  while (chunks.length > 1 && bytes > limit) bytes -= chunks.shift()!.text.length * 2;
  return chunks;
}

export function nextLogFollowAction(cursor: FileChunk | null): "follow" | "end" {
  return cursor && cursor.size - cursor.nextOffset > LOG_WINDOW_BYTES ? "end" : "follow";
}

export function shouldPauseLogFollow(
  following: boolean, previousTop: number, currentTop: number, programmatic: boolean,
): boolean {
  return following && !programmatic && currentTop < previousTop - 1;
}
