import { invoke } from "@tauri-apps/api/core";
import { createWorkbenchDialog } from "./workbenchPanels";
import "./documentTemplates.css";

export type DocumentTemplate = { id: string; title: string; text: string; updatedAt: number; builtin?: boolean };
type TemplateDraft = { id?: string; title: string; text: string };
export type DocumentTemplatesOptions = {
  mode: "new" | "insert" | "manage";
  title?: string;
  onUse?: (text: string, title: string) => void | Promise<void>;
};

export const BUILTIN_DOCUMENT_TEMPLATES: readonly Readonly<DocumentTemplate>[] = Object.freeze([
  Object.freeze({ id: "builtin-meeting", title: "会议记录", builtin: true, updatedAt: 0, text: "# {{title}}\n\n日期：{{date}} {{time}}\n\n## 参会人\n\n- \n\n## 讨论事项\n\n- \n\n## 决策\n\n- \n\n## 待办\n\n- [ ] 事项 / 负责人 / 截止时间\n" }),
  Object.freeze({ id: "builtin-plan", title: "技术方案", builtin: true, updatedAt: 0, text: "# {{title}}\n\n日期：{{date}}\n\n## 背景与目标\n\n## 约束与范围\n\n## 方案设计\n\n## 备选方案与取舍\n\n## 风险与验证\n\n## 实施步骤\n\n- [ ] \n" }),
  Object.freeze({ id: "builtin-reading", title: "读书笔记", builtin: true, updatedAt: 0, text: "# {{title}}\n\n日期：{{date}}\n\n作者：\n\n## 核心观点\n\n## 摘录\n\n> \n\n## 我的思考\n\n## 行动与延伸阅读\n\n- [ ] \n" }),
]);

/** Replace known variables once; inserted titles remain literal user content. */
export function expandTemplateVariables(text: string, options: { title: string; date?: Date }) {
  const date = options.date ?? new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const values = {
    title: options.title,
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
  return text.replace(/\{\{(title|date|time)\}\}/g, (_, name: keyof typeof values) => values[name]);
}

export function templateDraft(template: Readonly<DocumentTemplate>): TemplateDraft {
  return { id: template.builtin ? undefined : template.id, title: template.builtin ? `${template.title}（副本）` : template.title, text: template.text };
}

function button(label: string, action: () => void) {
  const result = document.createElement("button");
  result.type = "button";
  result.textContent = label;
  result.addEventListener("click", action);
  return result;
}

function field(labelText: string, control: HTMLInputElement | HTMLTextAreaElement) {
  const label = document.createElement("label");
  label.className = "document-template-field";
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

async function editTemplate(draft: TemplateDraft): Promise<DocumentTemplate | null> {
  const panel = createWorkbenchDialog(draft.id ? "编辑模板" : "保存自定义模板");
  panel.dialog.classList.add("document-template-editor");
  const title = document.createElement("input");
  title.type = "text";
  title.maxLength = 200;
  title.value = draft.title;
  const text = document.createElement("textarea");
  text.value = draft.text;
  const initialEditorValue = text.value;
  text.spellcheck = false;
  text.rows = 16;
  const hint = document.createElement("p");
  hint.className = "document-template-hint";
  hint.textContent = "可用变量：{{title}}、{{date}}、{{time}}。保存时保留原文，使用模板时替换。";
  const error = document.createElement("p");
  error.className = "workbench-error";
  error.setAttribute("role", "alert");
  panel.body.append(field("模板名称", title), field("Markdown 内容", text), hint, error);
  panel.actions.querySelector("button")!.textContent = "取消";
  let saved: DocumentTemplate | null = null;
  let saving = false;
  const save = button("保存模板", () => void (async () => {
    if (saving) return;
    if (!title.value.trim()) { error.textContent = "请输入模板名称"; title.focus(); return; }
    saving = true;
    save.disabled = title.disabled = text.disabled = true;
    error.textContent = "";
    try {
      saved = await invoke<DocumentTemplate>("template_save", { request: { id: draft.id ?? null, title: title.value, text: text.value === initialEditorValue ? draft.text : text.value } });
      panel.close();
    } catch (reason) { error.textContent = String(reason); }
    finally { saving = false; save.disabled = title.disabled = text.disabled = false; }
  })());
  panel.actions.prepend(save);
  panel.dialog.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); save.click(); }
  });
  title.focus();
  title.select();
  await panel.closed;
  return saved;
}

/** Opens an editable copy. The source document is never changed by saving it. */
export async function saveDocumentAsTemplate(text: string, title = "未命名模板"): Promise<void> {
  await editTemplate({ title: title.replace(/\.(?:md|markdown|mdx|rmd)$/i, ""), text });
}

export async function showDocumentTemplates(options: DocumentTemplatesOptions): Promise<void> {
  const panel = createWorkbenchDialog(options.mode === "manage" ? "管理模板与片段" : options.mode === "insert" ? "插入模板片段" : "从模板新建");
  panel.dialog.classList.add("document-templates-dialog");
  const layout = document.createElement("div");
  layout.className = "document-templates-layout";
  const list = document.createElement("div");
  list.className = "document-templates-list";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "模板列表");
  const previewPane = document.createElement("div");
  previewPane.className = "document-template-preview";
  const title = document.createElement("input");
  title.type = "text";
  title.maxLength = 200;
  const preview = document.createElement("textarea");
  preview.readOnly = true;
  preview.spellcheck = false;
  preview.rows = 16;
  const hint = document.createElement("p");
  hint.className = "document-template-hint";
  hint.textContent = options.mode === "manage" ? "内置模板可复制为自定义模板后编辑。" : "预览会替换 {{title}}、{{date}}、{{time}}，自定义模板保存在本机应用数据目录。";
  previewPane.append(field(options.mode === "manage" ? "模板名称" : "文档标题", title), field(options.mode === "manage" ? "模板原文" : "使用后预览", preview), hint);
  title.readOnly = options.mode === "manage";
  layout.append(list, previewPane);
  const error = document.createElement("p");
  error.className = "workbench-error";
  error.setAttribute("role", "alert");
  const confirmation = document.createElement("div");
  confirmation.className = "document-template-confirmation";
  confirmation.hidden = true;
  const confirmationText = document.createElement("span");
  const cancelDelete = button("取消删除", () => { confirmation.hidden = true; remove.focus(); });
  const confirmDelete = button("确认删除", () => void run(async () => {
    await invoke("template_delete", { id: selected.id });
    custom = custom.filter(item => item.id !== selected.id);
    selected = BUILTIN_DOCUMENT_TEMPLATES[0];
    confirmation.hidden = true;
    renderList(true);
    list.querySelector<HTMLButtonElement>("button")?.focus();
  }));
  confirmation.append(confirmationText, cancelDelete, confirmDelete);
  panel.body.append(layout, confirmation, error);
  let custom: DocumentTemplate[] = [];
  let selected: Readonly<DocumentTemplate> = BUILTIN_DOCUMENT_TEMPLATES[0];
  let busy = false;
  const controls: HTMLButtonElement[] = [];
  const refreshPreview = () => {
    preview.value = options.mode === "manage" ? selected.text : expandTemplateVariables(selected.text, { title: title.value.trim() || selected.title });
  };
  const renderList = (resetTitle = false) => {
    const restoreListFocus = list.contains(document.activeElement);
    list.replaceChildren();
    for (const item of [...BUILTIN_DOCUMENT_TEMPLATES, ...custom]) {
      const itemButton = button(`${item.title}${item.builtin ? " · 内置" : ""}`, () => {
        selected = item;
        confirmation.hidden = true;
        renderList(true);
      });
      itemButton.setAttribute("aria-pressed", String(item.id === selected.id));
      itemButton.disabled = busy;
      list.append(itemButton);
    }
    if (resetTitle || options.mode === "manage") title.value = options.mode === "manage" ? selected.title : options.title || selected.title;
    edit.textContent = selected.builtin ? "复制并编辑" : "编辑模板";
    remove.disabled = busy || Boolean(selected.builtin);
    refreshPreview();
    if (restoreListFocus) list.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  };
  const run = async (action: () => void | Promise<void>) => {
    if (busy) return;
    const previousFocus = document.activeElement;
    busy = true;
    error.textContent = "";
    controls.forEach(item => { item.disabled = true; });
    list.querySelectorAll("button").forEach(item => { item.disabled = true; });
    try { await action(); }
    catch (reason) { error.textContent = String(reason); }
    finally {
      busy = false;
      controls.forEach(item => { item.disabled = false; });
      list.querySelectorAll("button").forEach(item => { item.disabled = false; });
      remove.disabled = Boolean(selected.builtin);
      if (panel.dialog.isConnected && previousFocus instanceof HTMLElement && previousFocus.isConnected
        && (document.activeElement === panel.dialog || !panel.dialog.contains(document.activeElement))) previousFocus.focus();
    }
  };
  const newTemplate = button("新建模板", () => void run(async () => {
    const saved = await editTemplate({ title: "未命名模板", text: "# {{title}}\n\n{{date}}\n" });
    if (saved && panel.dialog.isConnected) { custom = [saved, ...custom]; selected = saved; renderList(true); }
  }));
  const edit = button("复制并编辑", () => void run(async () => {
    const saved = await editTemplate(templateDraft(selected));
    if (saved && panel.dialog.isConnected) { custom = [saved, ...custom.filter(item => item.id !== saved.id)]; selected = saved; renderList(true); }
  }));
  const remove = button("删除模板", () => {
    if (selected.builtin || busy) return;
    confirmationText.textContent = `删除“${selected.title}”？此操作不能撤销。`;
    confirmation.hidden = false;
    cancelDelete.focus();
  });
  controls.push(newTemplate, edit, remove, cancelDelete, confirmDelete);
  if (options.mode === "manage") panel.actions.prepend(newTemplate, edit, remove);
  else {
    const use = button(options.mode === "new" ? "新建文档" : "插入片段", () => void run(async () => {
      if (!options.onUse) throw new Error("未配置模板使用操作");
      await options.onUse(preview.value, title.value.trim() || selected.title);
      panel.close();
    }));
    controls.push(use);
    panel.actions.prepend(use);
  }
  title.addEventListener("input", refreshPreview);
  panel.dialog.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!(event.target instanceof HTMLButtonElement) || !list.contains(event.target)) return;
    const items = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = items.indexOf(event.target);
    const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    event.preventDefault();
    next?.focus();
  });
  renderList(true);
  list.querySelector<HTMLButtonElement>("button")?.focus();
  try {
    custom = await invoke<DocumentTemplate[]>("template_list");
    if (panel.dialog.isConnected) renderList();
  } catch (reason) { error.textContent = `读取自定义模板失败：${String(reason)}`; }
  await panel.closed;
}
