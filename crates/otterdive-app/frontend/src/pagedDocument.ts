export interface DocumentPage {
  text: string; startOffset: number; nextOffset: number; size: number;
  startLine: number; startColumn: number; endLine: number; endColumn: number;
  hasMore: boolean; warning?: string | null;
}
export type PageTransition = "replace" | "append" | "prepend";
export const MAX_RETAINED_PAGES = 3;
export type PageTarget = { offset?: number; line?: number; column?: number };
export interface PageSource { path: string; encoding: string; revision: string }
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** One bounded model window; cancellation and generations prevent closed/reloaded tabs reviving. */
export class PagedDocumentController {
  page: DocumentPage | null = null;
  busy = false;
  error = "";
  private generation = 0;
  private requestId: string | null = null;
  private disposed = false;
  private pages: DocumentPage[] = [];
  readonly source: PageSource;
  private invoke: Invoke;
  private onPage: (page: DocumentPage, previous: DocumentPage | null, transition: PageTransition) => void;
  private onState: () => void;
  constructor(source: PageSource, invoke: Invoke, onPage: (page: DocumentPage, previous: DocumentPage | null, transition: PageTransition) => void, onState: () => void) {
    this.source = source; this.invoke = invoke; this.onPage = onPage; this.onState = onState;
  }
  async load(target: PageTarget = {}, transition: PageTransition = "replace"): Promise<DocumentPage | null> {
    if (this.disposed) return null;
    this.cancel();
    const generation = ++this.generation;
    const requestId = crypto.randomUUID(); this.requestId = requestId;
    this.busy = true; this.error = ""; this.onState();
    try {
      const page = await this.invoke<DocumentPage>("read_document_page", { request: { ...this.source, ...target, requestId } });
      if (this.disposed || generation !== this.generation) return null;
      const previous = this.page;
      if (transition === "append" && previous?.nextOffset === page.startOffset) {
        this.pages = [...this.pages, page].slice(-MAX_RETAINED_PAGES);
      } else if (transition === "prepend" && previous?.startOffset === page.nextOffset) {
        this.pages = [page, ...this.pages].slice(0, MAX_RETAINED_PAGES);
      } else { this.pages = [page]; transition = "replace"; }
      const first = this.pages[0]; const last = this.pages.at(-1)!;
      this.page = this.pages.length === 1 ? page : { ...first, text: this.pages.map(item => item.text).join(""),
        nextOffset: last.nextOffset, endLine: last.endLine, endColumn: last.endColumn,
        hasMore: last.hasMore, warning: last.warning };
      this.onPage(this.page, previous, transition); return this.page;
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.error = String(error);
      return null;
    } finally {
      if (!this.disposed && generation === this.generation) {
        this.busy = false; this.requestId = null; this.onState();
      }
    }
  }
  cancel() {
    this.generation++;
    if (this.requestId) void this.invoke("cancel_document_page", { requestId: this.requestId }).catch(() => {});
    this.requestId = null; this.busy = false;
  }
  close() { this.disposed = true; this.cancel(); }
}

export function pageLocalPosition(page: DocumentPage, line: number, column: number) {
  return { lineNumber: Math.max(1, line-page.startLine+1), column: Math.max(1, line===page.startLine ? column-page.startColumn+1 : column) };
}
