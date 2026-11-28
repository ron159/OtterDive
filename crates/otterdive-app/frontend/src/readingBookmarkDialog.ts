import { createWorkbenchDialog } from "./workbenchPanels";
import type { ReadingBookmark } from "./readingBookmarks";

export async function showReadingBookmarks(options: {
  current: ReadingBookmark | null;
  anchors: Set<string>;
  bookmarks: ReadingBookmark[];
  onChange: (bookmarks: ReadingBookmark[]) => void;
}): Promise<string | null> {
  const panel = createWorkbenchDialog("标题书签");
  panel.dialog.classList.add("reading-bookmarks-dialog");
  let bookmarks = options.bookmarks;
  let editing = options.current;
  let destination: string | null = null;
  const form = document.createElement("form");
  form.className = "reading-bookmark-form";
  form.innerHTML = '<label>书签名称<input required></label><button type="submit"></button><small></small>';
  const input = form.querySelector("input")!;
  const submit = form.querySelector("button")!;
  const target = form.querySelector("small")!;
  const list = document.createElement("ul");
  list.className = "workbench-snapshot-list";
  list.setAttribute("aria-label", "当前文档的标题书签");
  const empty = document.createElement("p");
  empty.textContent = "当前文档还没有标题书签";
  panel.body.append(form, list, empty);

  function edit(heading: ReadingBookmark | null) {
    editing = heading;
    const existing = bookmarks.find(item => item.anchor === heading?.anchor);
    input.value = existing?.name ?? heading?.name ?? "";
    input.disabled = submit.disabled = !heading;
    submit.textContent = existing ? "保存名称" : "添加当前标题";
    target.textContent = heading ? `标题锚点 #${heading.anchor}` : "当前没有可添加书签的标题";
  }

  function render() {
    list.replaceChildren();
    empty.hidden = bookmarks.length > 0;
    for (const bookmark of bookmarks) {
      const row = document.createElement("li");
      const jump = document.createElement("button");
      jump.className = "workbench-snapshot-select";
      jump.disabled = !options.anchors.has(bookmark.anchor);
      const name = document.createElement("strong");
      name.textContent = bookmark.name;
      const anchor = document.createElement("span");
      anchor.textContent = `#${bookmark.anchor}${jump.disabled ? "（标题已不存在）" : ""}`;
      jump.append(name, anchor);
      jump.onclick = () => { destination = bookmark.anchor; panel.close(); };
      const rename = document.createElement("button");
      rename.textContent = "重命名";
      rename.setAttribute("aria-label", `重命名 ${bookmark.name}`);
      rename.onclick = () => { edit(bookmark); input.focus(); input.select(); };
      const remove = document.createElement("button");
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除 ${bookmark.name}`);
      remove.onclick = () => {
        update(bookmarks.filter(item => item.anchor !== bookmark.anchor));
        (list.querySelector<HTMLButtonElement>("button:enabled") ?? panel.actions.querySelector("button"))?.focus();
      };
      row.append(jump, rename, remove);
      list.append(row);
    }
    edit(options.current);
  }

  function update(next: ReadingBookmark[]) {
    bookmarks = next;
    options.onChange(next);
    render();
  }

  form.onsubmit = event => {
    event.preventDefault();
    if (!editing || !input.value.trim()) { input.select(); return; }
    const saved = { anchor: editing.anchor, name: input.value.trim() };
    update(bookmarks.some(item => item.anchor === saved.anchor)
      ? bookmarks.map(item => item.anchor === saved.anchor ? saved : item)
      : [...bookmarks, saved]);
  };
  render();
  if (editing) { input.focus(); input.select(); }
  await panel.closed;
  return destination;
}
