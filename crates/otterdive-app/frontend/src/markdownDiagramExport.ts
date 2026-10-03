export type MarkdownDiagramFormat = "svg" | "png";

export function diagramExportSize(width: number, height: number, scale = 2) {
  if (![width, height, scale].every(Number.isFinite) || width <= 0 || height <= 0 || scale <= 0) {
    throw new Error("图表尚未完成渲染，无法确定导出尺寸");
  }
  const factor = Math.min(scale, 4096 / width, 4096 / height, Math.sqrt(16_000_000 / (width * height)));
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}

async function readBlob(source: string) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.blob();
  } finally {
    window.clearTimeout(timer);
  }
}

function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图表图片"));
    reader.readAsDataURL(blob);
  });
}

/** Export the selected rendered diagram, including Mermaid HTML labels and local styles. */
export async function createMarkdownDiagramExport(target: Element, format: MarkdownDiagramFormat): Promise<Blob> {
  const original = target instanceof SVGSVGElement ? target : target.querySelector<SVGSVGElement>("svg");
  let svg: SVGSVGElement;
  let width = 0;
  let height = 0;
  if (original) {
    svg = original.cloneNode(true) as SVGSVGElement;
    const bounds = original.getBoundingClientRect();
    width = original.viewBox.baseVal.width || bounds.width;
    height = original.viewBox.baseVal.height || bounds.height;
    const sources = [original, ...original.querySelectorAll("*")];
    const copies = [svg, ...svg.querySelectorAll("*")];
    const properties = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "color", "background-color", "font-family", "font-size", "font-weight", "font-style", "line-height", "text-anchor", "dominant-baseline", "white-space"];
    sources.forEach((source, index) => {
      const style = getComputedStyle(source);
      const copy = copies[index] as HTMLElement | SVGElement;
      for (const property of properties) copy.style.setProperty(property, style.getPropertyValue(property));
    });
  } else {
    const image = target instanceof HTMLImageElement ? target : target.querySelector<HTMLImageElement>("img");
    if (!image?.src) throw new Error("请选择已完成渲染的图表，再导出 SVG 或 PNG");
    if (!image.complete || !image.naturalWidth) throw new Error("图表图片尚未加载完成");
    width = image.naturalWidth;
    height = image.naturalHeight;
    const blob = await readBlob(image.currentSrc || image.src);
    if (blob.type.includes("svg")) {
      const parsed = new DOMParser().parseFromString(await blob.text(), "image/svg+xml");
      const element = parsed.documentElement;
      if (element.localName !== "svg" || parsed.querySelector("parsererror")) throw new Error("图表服务器返回了无效的 SVG");
      svg = document.importNode(element, true) as unknown as SVGSVGElement;
    } else {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const child = document.createElementNS("http://www.w3.org/2000/svg", "image");
      child.setAttribute("href", await dataUrl(blob));
      child.setAttribute("width", String(width));
      child.setAttribute("height", String(height));
      svg.appendChild(child);
    }
  }

  diagramExportSize(width, height);
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  if (!svg.hasAttribute("viewBox")) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.removeProperty("max-width");
  svg.querySelectorAll("script, iframe, object, embed, link").forEach((element) => element.remove());
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || (["href", "xlink:href"].includes(attribute.name) && /^\s*javascript:/i.test(attribute.value))) element.removeAttribute(attribute.name);
    }
  }
  for (const element of svg.querySelectorAll("image, img")) {
    const attribute = element.hasAttribute("src") ? "src" : element.hasAttribute("href") ? "href" : "xlink:href";
    const source = element.getAttribute(attribute);
    if (source && !source.startsWith("data:")) {
      try { element.setAttribute(attribute, await dataUrl(await readBlob(new URL(source, document.baseURI).href))); }
      catch { throw new Error("图表包含无法内嵌的图片，请确认图片可读取后再导出"); }
    }
  }
  const svgBlob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" });
  if (format === "svg") return svgBlob;
  const size = diagramExportSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法创建 PNG 画布，请导出 SVG");
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    context.drawImage(image, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG 转换失败，请导出 SVG")), "image/png"));
  } catch {
    throw new Error("当前图表无法转换为 PNG，请导出 SVG（部分 WebView 不支持 HTML 图表标签转图片）");
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 1;
  }
}
