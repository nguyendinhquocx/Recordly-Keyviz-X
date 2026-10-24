import { expect, test } from "@playwright/test";

async function openPublish(page: import("@playwright/test").Page, query = "") {
	// First launch defaults to Vietnamese; pin English for deterministic copy.
	await page.addInitScript(() => {
		localStorage.setItem("recordly.locale", "en");
	});
	await page.goto(`/tests/ui/batch-clip-export.html${query}`);
	if (!query.includes("state=progress")) {
		await page.getByRole("button", { name: "Publish", exact: true }).click();
	}
}

test("separate clips mode persists and Link isolates the batch controls", async ({ page }) => {
	await openPublish(page);
	await page
		.getByRole("button", { name: "Fixture separate clips" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await page.getByRole("row", { name: "Separate clips" }).click();
	await expect(page.getByRole("button", { name: "Export 10 clips" })).toBeVisible();

	// The mode survives reopening the popover.
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.getByRole("button", { name: "Export 10 clips" })).toBeVisible();

	// Local -> Link -> Local: Link keeps the share flow, returning restores mode.
	await page
		.getByRole("button", { name: "Fixture link destination" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByRole("button", { name: "Export 10 clips" })).toHaveCount(0);
	await expect(page.getByRole("row", { name: "Separate clips" })).toHaveCount(0);
	await page
		.getByRole("button", { name: "Fixture local destination" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByRole("button", { name: "Export 10 clips" })).toBeVisible();
});

test("gif format disables separate clips with a localized explanation", async ({ page }) => {
	await openPublish(page);
	await page
		.getByRole("button", { name: "Fixture separate clips" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await page.getByRole("row", { name: "Separate clips" }).click();
	await page
		.getByRole("button", { name: "Fixture gif format" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByText(/MP4 only/i)).toBeVisible();
	await expect(page.getByRole("row", { name: "Separate clips" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	// The format is never silently switched and batch mode cannot dispatch the
	// full-timeline GIF flow. Explicitly choosing Full timeline restores it.
	const gifExport = page.getByRole("button", { name: /Export GIF/i });
	await expect(gifExport).toHaveAttribute("data-export-action-disabled", "true");
	await expect(gifExport).toBeDisabled();
	await page.getByRole("row", { name: "Full timeline" }).click();
	await expect(gifExport).toBeEnabled();
});

test("zero valid clips disables the batch action without opening a picker", async ({ page }) => {
	await openPublish(page, "?clips=0");
	await page
		.getByRole("button", { name: "Fixture separate clips" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await page.getByRole("row", { name: "Separate clips" }).click();
	await expect(page.getByRole("button", { name: /No valid clips/i })).toBeDisabled();
	await expect(page.getByText(/Trim the timeline/i)).toBeVisible();
});

test("one valid clip CTA stays singular", async ({ page }) => {
	await openPublish(page, "?clips=1");
	await page
		.getByRole("button", { name: "Fixture separate clips" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await page.getByRole("row", { name: "Separate clips" }).click();
	await expect(page.getByRole("button", { name: "Export 1 clip", exact: true })).toBeVisible();
});

test("batch progress reports clip N of total and supports cancel", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("recordly.locale", "en"));
	await page.goto("/tests/ui/batch-clip-export.html?state=progress");
	await expect(page.getByRole("status")).toHaveText("Exporting clips");
	await expect(page.getByText("3 of 10 clips")).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	// The cancelled summary keeps the completed file visible.
	await page.goto("/tests/ui/batch-clip-export.html?state=cancelled");
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.getByText("Export cancelled")).toBeVisible();
	await expect(page.getByText("1 of 2 clips saved.")).toBeVisible();
});

test("cannot switch Local to Link while a batch is active", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("recordly.locale", "en"));
	await page.goto("/tests/ui/batch-clip-export.html?state=progress");
	await expect(page.getByText("3 of 10 clips")).toBeVisible();
	await expect(page.getByRole("row", { name: "Local" })).toHaveAttribute("data-selected", "true");
	await expect(page.getByRole("row", { name: "Link" })).toHaveAttribute("aria-disabled", "true");
	await page.getByRole("row", { name: "Link" }).evaluate((row: HTMLElement) => row.click());
	await expect(page.getByRole("row", { name: "Local" })).toHaveAttribute("data-selected", "true");
	await expect(page.getByText("3 of 10 clips")).toBeVisible();
});

test("partial results offer retry for failed clips only and surface sidecar warnings", async ({
	page,
}) => {
	await openPublish(page, "?state=partial");
	await expect(page.getByText("Export finished with issues")).toBeVisible();
	await expect(page.getByText("2 of 4 clips saved.")).toBeVisible();
	await expect(page.getByText(/saved without caption files/i)).toBeVisible();
	await expect(
		page.getByText(/Clip 4 caption sidecar warning: VTT: file is locked/i),
	).toBeVisible();
	await expect(page.getByText(/Skipped 1 invalid clip/i)).toBeVisible();
	await expect(
		page.getByText(/Clip 5 \(e\): Source range is outside the recording/),
	).toBeVisible();
	await expect(page.getByText(/Clip 2: encoder boom/)).toBeVisible();
	await page.getByRole("button", { name: "Retry failed clips" }).click();
	await expect(page.getByTestId("retry-observation")).toHaveText(
		JSON.stringify({ rerender: ["b"], recommit: ["c"], completed: ["a", "d"] }),
	);
});

test("actual batch hook retries retained temps without rerendering completed clips", async ({
	page,
}) => {
	await page.goto("/tests/ui/batch-clip-export.html?state=hook-retry");
	await page.getByRole("button", { name: "Start hook batch" }).click();
	await expect(page.getByRole("status")).toHaveText("1 complete / 2 failed");
	await expect(page.getByTestId("rendered-clip-ids")).toHaveText("a,b,c");
	await expect(page.getByTestId("committed-clip-ids")).toHaveText("a,b");

	await page.getByRole("button", { name: "Retry failed only" }).click();
	await expect(page.getByRole("status")).toHaveText("3 complete / 0 failed");
	// Retry uses retained temps for b/c; completed a and all prior render output
	// are not rendered a second time.
	await expect(page.getByTestId("rendered-clip-ids")).toHaveText("a,b,c");
	await expect(page.getByTestId("committed-clip-ids")).toHaveText("a,b,b,c");
});

test("retrying a render-failed late clip replays prior plans without repeating completed outputs", async ({
	page,
}) => {
	await page.goto("/tests/ui/batch-clip-export.html?state=hook-retry-render");
	await page.getByRole("button", { name: "Start hook batch" }).click();
	await expect(page.getByRole("status")).toHaveText("2 complete / 1 failed");
	await expect(page.getByTestId("rendered-clip-ids")).toHaveText("a,b,c");

	await page.getByRole("button", { name: "Retry failed only" }).click();
	await expect(page.getByRole("status")).toHaveText("3 complete / 0 failed");
	await expect(page.getByTestId("rendered-clip-ids")).toHaveText("a,b,c,b");
	await expect(page.getByTestId("replayed-clip-ids")).toHaveText("a,b");
	await expect(page.getByTestId("committed-clip-ids")).toHaveText("a,c,b");
});

test("cancelling the retry folder picker preserves the previous summary and retained temps", async ({
	page,
}) => {
	await page.goto("/tests/ui/batch-clip-export.html?state=hook-retry-cancel");
	await page.getByRole("button", { name: "Start hook batch" }).click();
	await expect(page.getByRole("status")).toHaveText("1 complete / 2 failed");
	await expect(page.getByTestId("retry-retained-temps")).toHaveText("temp-b.mp4,temp-c.mp4");

	await page.getByRole("button", { name: "Retry failed only" }).click();
	await expect(page.getByRole("status")).toHaveText("1 complete / 2 failed");
	await expect(page.getByTestId("retry-retained-temps")).toHaveText("temp-b.mp4,temp-c.mp4");
	await expect(page.getByTestId("rendered-clip-ids")).toHaveText("a,b,c");
	await expect(page.getByTestId("committed-clip-ids")).toHaveText("a,b");
});

test("cancel after render but before commit discards the owned temp", async ({ page }) => {
	await page.goto("/tests/ui/batch-clip-export.html?state=hook-cancel");
	await page.getByRole("button", { name: "Start cancel test" }).click();
	await page
		.getByRole("button", { name: "Release rendered output" })
		.waitFor({ state: "visible" });
	await page.getByRole("button", { name: "Cancel before commit" }).click();
	await page.getByRole("button", { name: "Release rendered output" }).click();
	await expect(page.getByRole("status")).toHaveText("cancelled");
	await expect(page.getByTestId("cancel-cleanup")).toHaveText(
		"commits=0; discards=temp-a.mp4; cancels=2; closes=1",
	);
});

test("captures Publish idle, progress, complete, and partial visual states", async ({
	page,
}, testInfo) => {
	await page.addInitScript(() => localStorage.setItem("recordly.locale", "en"));
	const states = [
		{ name: "idle-separate-clips", query: "?state=idle", open: true, selectBatch: true },
		{ name: "progress", query: "?state=progress", open: false, selectBatch: false },
		{ name: "complete", query: "?state=complete", open: true, selectBatch: false },
		{ name: "partial-retry", query: "?state=partial", open: true, selectBatch: false },
	];
	for (const state of states) {
		await page.goto(`/tests/ui/batch-clip-export.html${state.query}`);
		if (state.open) await page.getByRole("button", { name: "Publish", exact: true }).click();
		if (state.selectBatch) {
			await page
				.getByRole("button", { name: "Fixture separate clips" })
				.evaluate((button: HTMLButtonElement) => button.click());
			await page.getByRole("row", { name: "Separate clips" }).click();
		}
		const popover = page.getByRole("dialog", { name: "Publish" });
		await expect(popover).toBeVisible();
		await popover.screenshot({ path: testInfo.outputPath(`${state.name}.png`) });
	}
});

test("complete batch reports every clip saved", async ({ page }) => {
	await openPublish(page, "?state=complete");
	await expect(page.getByText("All clips exported")).toBeVisible();
	await expect(page.getByText("3 of 3 clips saved.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry failed clips" })).toHaveCount(0);
});
