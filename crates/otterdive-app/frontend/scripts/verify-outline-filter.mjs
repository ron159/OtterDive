import assert from "node:assert/strict";

// Runs against the restored two-document workspace in verify-markdown-workflows.
export async function verifyOutlineFilter(page, notes, shot) {
  const filter = page.getByRole("searchbox", { name: "筛选标题" });
  const list = page.locator("#outlineList");
  const matches = list.getByRole("button", { name: "API 使用", exact: true });
  const sourceLine = notes.split("\n").lastIndexOf("## API 使用") + 1;
  const current = list.locator('[aria-current="location"]:visible');

  for (const mode of ["Reading", "Wysiwyg", "Source", "Split"]) {
    await page.locator(`#markdown${mode}Button`).click();
    await matches.nth(1).waitFor();
    const start = list.getByRole("button", { name: "阅读验证", exact: true });
    await start.click();
    await list.locator('[data-outline-index="0"][aria-current="location"]').waitFor();
    await filter.fill("aPi 使");
    // The quoted heading is part of the rendered reading outline only.
    const indices = mode === "Reading" ? [5, 8] : [4, 7];
    assert.deepEqual(await list.getByRole("button").evaluateAll(rows => rows.map(row => Number(row.dataset.outlineIndex))), indices);
    assert.equal(await current.count(), 0);
    await filter.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    assert.ok(await filter.evaluate(el => el === document.activeElement));
    await filter.press("ArrowUp");
    assert.ok(await matches.nth(1).evaluate(row => row === document.activeElement));
    await page.keyboard.press("ArrowUp");
    assert.ok(await matches.first().evaluate(row => row === document.activeElement));
    await page.keyboard.press("ArrowDown");
    assert.equal(await current.count(), 0);
    await page.keyboard.press("Enter");
    await list.locator(`[data-outline-index="${indices[1]}"][aria-current="location"]`).waitFor();

    if (mode === "Source" || mode === "Split") {
      await page.locator("#statusRight").getByText(`第 ${sourceLine} 行，第 1 列`, { exact: true }).waitFor();
    } else {
      // Check the second matching heading's physical position inside the real scroll pane.
      const pane = mode === "Reading" ? "#markdownPreview" : '.markdown-editor-pane[aria-hidden="false"]';
      const heading = page.locator(pane).locator("h2").filter({ hasText: "API 使用" }).nth(1);
      assert.ok(await heading.evaluate((node, selector) => {
        const scrollPane = node.closest(selector);
        const y = node.getBoundingClientRect().top - scrollPane.getBoundingClientRect().top;
        const offset = scrollPane.querySelector(".markdown-preview-head")?.offsetHeight ?? 0;
        return y >= offset - 2 && y <= Math.max(32, offset + 8) + 2;
      }, pane), `${mode} did not scroll to the second duplicate`);
    }
    await shot(`outline-filter-${mode.toLowerCase()}`);

    await filter.fill("不存在的标题");
    assert.equal(await list.getByRole("button").count(), 0);
    assert.equal(await page.locator("#outlineEmpty").textContent(), "没有匹配的标题");
    await filter.press("Enter");
    await filter.press("Escape");
    assert.equal(await filter.inputValue(), "");
    assert.equal(await current.getAttribute("data-outline-index"), String(indices[1]));
    await filter.fill("使");
    if (mode === "Reading") {
      await page.locator("#markdownPreview").hover();
      await page.mouse.wheel(0, 1400);
      await current.waitFor({ state: "hidden" });
      await filter.press("Escape");
      assert.ok(Number(await current.getAttribute("data-outline-index")) > indices[1]);
      await filter.fill("使");
    }
    await page.getByRole("tab", { name: /target\.md/ }).click();
    await list.getByRole("button", { name: "Target section", exact: true }).waitFor();
    assert.equal(await filter.inputValue(), "");
    await filter.fill("TARGET SECTION");
    await filter.press("Enter");
    await list.locator('[data-outline-index="1"][aria-current="location"]').waitFor();
    await page.getByRole("tab", { name: /notes\.md/ }).click();
    await matches.first().waitFor();
    assert.equal(await filter.inputValue(), "");
  }

  await page.locator("#markdownReadingButton").click();
  await list.getByRole("button", { name: "引用中的标题" }).waitFor();
  await page.locator("#outlineButton").click();
  await page.locator("#markdownPreview").press("Control+Shift+O");
  assert.ok(await filter.evaluate(el => el === document.activeElement));
  await filter.press("Escape");
  assert.ok(await page.locator("#markdownPreview").evaluate(el => el === document.activeElement));
}
