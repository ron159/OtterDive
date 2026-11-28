import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/markdownLinkPopover.ts", import.meta.url))],
  bundle: true, platform: "browser", format: "esm", write: false });
const { markdownPopoverTarget: target } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

test("popovers resolve Markdown paths and renderer fragments without decoding twice", () => {
  const name = encodeURIComponent("中文 空格.rmd"), anchor = encodeURIComponent("标题-1");
  assert.deepEqual(target(`../${name}?view=1#${anchor}`, "/notes/sub/current.md"), { path: "/notes/中文 空格.rmd", anchor: "标题-1" });
  assert.deepEqual(target(`#${anchor}`), { path: "", anchor: "标题-1" });
  assert.deepEqual(target("file:///D:/docs/100%2525.MD"), { path: "D:\\docs\\100%25.MD", anchor: "" });
  assert.deepEqual(target("draft.MDX", null, "/workspace"), { path: "/workspace/draft.MDX", anchor: "" });
  assert.equal(target("draft.md"), null);
});

test("remote URLs, network shares and non-Markdown files never qualify for a read", () => {
  for (const href of ["", "#", "https://example.test/a.md", "ftp://host/a.md", "mailto:a.md", "//host/share/a.md",
    String.raw`\\host\share\a.md`, "file://host/share/a.md", "file:////host/share/a.md", "%5C%5Chost%5Cshare%5Ca.md",
    "photo.jpg#heading", "app.exe?name=file.md", "data:text/plain,README.md", "blob:https://host/a.md"]) {
    assert.equal(target(href, "/local/current.md"), null, href);
  }
  assert.equal(target("nearby.md", String.raw`\\host\share\current.md`), null);
});
