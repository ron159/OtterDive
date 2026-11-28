import assert from "node:assert/strict";

export const sectionFixture = `# Target document

[Jump to duplicate](#duplicate-1)

[Reference](path-RepeatHit)

## Target section

#### Duplicate

First duplicate body.

First occurrence of RepeatHit.

#### Duplicate

Second duplicate body.

Second occurrence of RepeatHit.

> ### Quoted
>
> Nested quote body.

## Peer

Outside the folded section.

## Empty
## Last

` + "Target paragraph.\n\n".repeat(60);

export async function verifyReadingSections({ page, command, until, shot, calls, saved }) {
  const preview = page.locator("#markdownPreview");
  const toggle = id => preview.locator(`#${id} > button[aria-controls]`);
  const first = toggle("duplicate"), second = toggle("duplicate-1");
  const parent = toggle("target-section"), root = toggle("target-document");
  const expanded = button => button.getAttribute("aria-expanded");
  const tab = name => page.getByRole("tab").filter({ hasText: name }).click();
  const secondBody = preview.getByText("Second duplicate body.", { exact: true });

  await tab("target.md");
  await first.waitFor();
  assert.equal(await preview.getByRole("heading", { name: "Duplicate", exact: true }).count(), 2);
  assert.equal(await toggle("empty").count(), 0);
  await first.focus();
  await page.keyboard.press("Space");
  assert.equal(await expanded(first), "false");
  assert.equal(await first.evaluate(b => document.getElementById(b.getAttribute("aria-controls")).hidden), true);
  assert.equal(await first.evaluate(b => b === document.activeElement), true);
  assert.equal(await secondBody.isVisible(), true);
  await parent.focus();
  await page.keyboard.press("Enter");
  assert.equal(await second.isVisible(), false);
  assert.equal(await toggle("peer").isVisible(), true);
  await shot("reading-section-folded");
  await parent.click();
  assert.equal(await expanded(first), "false");
  await toggle("quoted").click();
  assert.equal(await preview.getByText("Nested quote body.").isVisible(), false);
  assert.equal(await toggle("peer").isVisible(), true);

  await second.click();
  await parent.click();
  await root.click();
  await page.locator("#outlineList").getByRole("button", { name: "Duplicate", exact: true }).nth(1).click();
  assert.equal(await expanded(root), "true");
  assert.equal(await expanded(parent), "true");
  assert.equal(await expanded(second), "false");
  assert.equal(await expanded(first), "false");

  await parent.click();
  await preview.getByRole("link", { name: "Jump to duplicate" }).click();
  assert.equal(await expanded(parent), "true");
  assert.equal(await expanded(second), "false");

  await parent.click();
  await root.click();
  await until(() => saved().markdownLocations?.["file:/qa/target.md"]?.collapsedHeadings?.includes("target-document"), "Fold state was not saved");
  await page.reload();
  await root.waitFor();
  assert.equal(await expanded(root), "false");
  assert.equal(await expanded(second), "false");
  await page.locator("#markdownSplitButton").click();
  await secondBody.waitFor();
  assert.equal(await preview.locator("button[aria-controls]").count(), 0);
  await page.locator("#markdownReadingButton").click();
  await root.waitFor();
  assert.equal(await expanded(second), "false");

  for (const [action, ipc, field] of [["file.exportHtml", "export_document_text", "text"], ["file.exportPdf", "export_pdf_with_outline", "html"]]) {
    await command("file", action);
    await until(() => calls.some(c => c.command === ipc), `${action} was not prepared`);
    const html = calls.findLast(c => c.command === ipc).args.request[field];
    assert.ok(await page.evaluate(html => {
      const body = new DOMParser().parseFromString(html, "text/html").querySelector(".markdown-body");
      return body.textContent.includes("Second duplicate body.") && !body.querySelector("button[aria-controls], [hidden]");
    }, html));
  }
  await page.evaluate(() => { window.print = () => { document.body.dataset.qaPrinted = "true"; }; });
  await command("file", "file.print");
  const printBody = page.locator(".markdown-print-root .markdown-body");
  await printBody.waitFor({ state: "attached" });
  assert.equal(await printBody.locator("button[aria-controls], [hidden]").count(), 0);
  assert.match(await printBody.textContent(), /Second duplicate body/);
  await page.waitForFunction(() => document.body.dataset.qaPrinted === "true");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await printBody.waitFor({ state: "detached" });

  await page.locator("#findButton").click();
  await page.locator("#currentFindInput").fill("Second duplicate body.");
  await page.locator("#currentFindInput").press("Enter");
  await secondBody.waitFor();
  await until(() => page.evaluate(() => window.getSelection()?.toString() === "Second duplicate body."), "Hidden search match was not selected");
  assert.equal(await expanded(first), "false");
  assert.equal(await expanded(second), "true");
  await second.click();
  await parent.click();
  await page.locator("#currentFindInput").fill("RepeatHit");
  await page.locator("#currentFindAllButton").click();
  await page.locator('#findResultsBody [data-current-search-results="true"] [data-result-index="2"]').click();
  await until(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.textContent === "Second occurrence of RepeatHit."),
    "Source-only URL match shifted the selected rendered occurrence");
  assert.equal(await expanded(second), "true");
  await page.locator("#closeCurrentFindButton").click();
  await root.click();
  await tab("notes.md");
  const link = preview.locator('a[href="target.md#target-section"]');
  await link.click();
  await parent.waitFor();
  assert.equal(await expanded(root), "true");
  assert.equal(await expanded(first), "false");
  await page.locator("#markdownBackButton").click();
  await link.waitFor();
}
