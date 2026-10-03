import { normalizeWorkbenchPreferences, spellcheckLanguageSuggestions, type WorkbenchPreferences } from "./workbenchPreferences";

const row = (label: string, detail: string, control: string) => `<label class="settings-row workbench-setting"><div><strong>${label}</strong><span>${detail}</span></div>${control}</label>`;
const toggle = (key: keyof WorkbenchPreferences) => `<input type="checkbox" data-workbench-pref="${key}" />`;
const number = (key: keyof WorkbenchPreferences, min: number, max: number, step = 1) => `<input type="number" min="${min}" max="${max}" step="${step}" data-workbench-pref="${key}" />`;
const text = (key: keyof WorkbenchPreferences, placeholder = "") => `<input type="text" data-workbench-pref="${key}" placeholder="${placeholder}" spellcheck="false" />`;
const select = (key: keyof WorkbenchPreferences, values: string[][]) => `<select data-workbench-pref="${key}">${values.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>`;

export function mountWorkbenchSettings(get: () => WorkbenchPreferences, update: (preferences: WorkbenchPreferences) => void) {
  document.querySelector('[data-settings-panel="editor"] .settings-list')?.insertAdjacentHTML("beforeend", [
    row("自动保存方式", "恢复副本独立于磁盘自动保存", select("autoSaveMode", [["off", "手动保存"], ["afterDelay", "停止编辑后"], ["onFocusChange", "离开编辑器时"]])),
    row("未保存内容恢复", "为临时文件、已有文件和缺失文件保留恢复副本", toggle("recoveryEnabled")),
    row("本地历史", "保存前保留历史内容，可比较、恢复或另存", toggle("historyEnabled")),
    row("副本保留天数", "到期副本自动清理", number("retentionDays", 1, 365)),
    row("每个文件的历史数量", "达到上限时清理最早版本", number("historyEntries", 1, 100)),
    row("高对比度", "提高文字、边框和键盘焦点的可见度", toggle("highContrast")),
    row("屏幕阅读器", "编辑器支持读屏；Ctrl/Cmd+M 切换 Tab 焦点导航", select("screenReader", [["auto", "自动检测"], ["on", "开启"], ["off", "关闭"]])),
  ].join(""));
  const workspacePanel = document.querySelector('[data-settings-panel="workspace"]');
  const markdownPanel = document.createElement("section");
  markdownPanel.className = "settings-panel";
  markdownPanel.dataset.settingsPanel = "markdown";
  markdownPanel.innerHTML = `<header class="settings-section-head"><strong>Markdown</strong><span>写作、阅读、附件与导出</span></header>
    <h3>写作与阅读</h3><div class="settings-list">
    ${row("专注模式", "淡化当前段落以外的内容", toggle("focusMode"))}
    ${row("打字机模式", "输入时让当前行保持在视口中部", toggle("typewriterMode"))}
    ${row("默认阅读模式", "打开 Markdown 时先阅读，可随时切回编辑", toggle("defaultReading"))}
    ${row("行距", "即时编辑、阅读和预览的行高倍数", number("lineHeight", 1.2, 2.5, 0.1))}
    ${row("段落间距", "段落之间的空白，单位 em", number("paragraphSpacing", 0, 3, 0.1))}
    ${row("双向滚动同步", "分屏中按标题位置同步源码与预览", toggle("syncScroll"))}
    ${row("字数统计包含代码", "关闭时统计正文，排除 Front Matter 与代码块", toggle("includeCodeInStats"))}
    ${row("拼写检查", "使用系统 WebView 提供的拼写检查", toggle("spellcheckEnabled"))}
    ${row("拼写检查语言", "留空跟随系统；可选建议或输入语言代码，字典由系统提供。中文不作语法校对", '<input type="text" data-workbench-pref="spellcheckLanguage" list="markdownSpellcheckLanguages" placeholder="跟随系统" spellcheck="false" />')}
    <datalist id="markdownSpellcheckLanguages"></datalist>
    </div><h3>语法扩展</h3><div class="settings-list">
    ${row("脚注", "识别 [^编号] 和对应脚注定义", toggle("markdownFootnotes"))}
    ${row("数学公式", "识别行内公式、公式块及标签引用", toggle("markdownMath"))}
    ${row("上标与下标", "识别 ^上标^ 和 ~下标~", toggle("markdownSuperSubScript"))}
    ${row("Front Matter", "识别文档开头的 YAML、TOML 等元数据", toggle("markdownFrontMatter"))}
    ${row("高亮标记", "识别 ==高亮内容==", toggle("markdownHighlight"))}
    ${row("提示块", "识别 GitHub 风格的 NOTE、TIP、WARNING 等提示", toggle("markdownAlerts"))}
    ${row("正文目录", "将独立的 [TOC] 段落显示为可跳转目录", toggle("markdownToc"))}
    </div><h3>图片与图表</h3><div class="settings-list">
    ${row("自动复制插入的图片", "粘贴和拖入本地图片时保存到文档附件目录", toggle("imageCopy"))}
    ${row("图片目录", "留空使用“文档名.assets”；支持相对或绝对目录", text("imageDirectory", "文档名.assets"))}
    ${row("PlantUML 服务", "留空禁用远程渲染；填写后图表源码将发送到此服务", text("plantumlServer", "https://服务器/plantuml/svg/"))}
    </div><h3>导出与排版</h3><div class="settings-list">
    ${row("纸张", "用于 PDF 和系统打印", select("paperSize", [["A4", "A4"], ["Letter", "Letter"], ["Legal", "Legal"]]))}
    ${row("横向纸张", "适合宽表格和图表", toggle("landscape"))}
    ${row("页边距", "四边留白，单位毫米", number("marginMm", 5, 50))}
    ${row("页码", "PDF 和打印页码，取决于所用打印引擎支持", toggle("pageNumbers"))}
    ${row("页眉", "留空不显示", text("printHeader"))}
    ${row("页脚", "留空不显示", text("printFooter"))}
    <label class="workbench-css-label"><strong>自定义 Markdown CSS</strong><span>应用到阅读、预览及导出</span><textarea data-workbench-pref="customCss" rows="6" spellcheck="false" placeholder=".markdown-preview-body { ... }"></textarea></label>
    </div>`;
  workspacePanel?.before(markdownPanel);
  const languageList = markdownPanel.querySelector("#markdownSpellcheckLanguages");
  const languageNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["zh-CN"], { type: "language" }) : null;
  for (const language of spellcheckLanguageSuggestions(navigator.languages)) {
    const option = document.createElement("option");
    option.value = language;
    option.label = languageNames?.of(language) ?? language;
    languageList?.appendChild(option);
  }
  document.querySelector('[data-settings-section="workspace"]')?.insertAdjacentHTML("beforebegin", '<button class="settings-nav-item" data-settings-section="markdown"><span class="icon-slot" data-icon="NotebookPen"></span><span>Markdown</span></button>');
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-workbench-pref]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.workbenchPref!;
      const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked
        : input instanceof HTMLInputElement && input.type === "number" ? input.valueAsNumber : input.value;
      update(normalizeWorkbenchPreferences({ ...get(), [key]: value }));
    });
  });
  syncWorkbenchSettings(get());
}

export function syncWorkbenchSettings(preferences: WorkbenchPreferences) {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-workbench-pref]").forEach((input) => {
    const value = preferences[input.dataset.workbenchPref as keyof WorkbenchPreferences];
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
    if (input.dataset.workbenchPref === "spellcheckLanguage") input.disabled = !preferences.spellcheckEnabled;
  });
}
