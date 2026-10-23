import { expect, test } from "@playwright/test";

async function openPublish(page: import("@playwright/test").Page, query = "") {
	// First launch defaults to Vietnamese; pin English for deterministic copy.
	await page.addInitScript(() => {
		localStorage.setItem("recordly.locale", "en");
	});
	await page.goto(`/tests/ui/batch-clip-export.html${query}`);
	await page.getByRole("button", { name: "Publish", exact: true }).click();
}

test("separate clips mode persists and Link isolates the batch controls", async ({ page }) => {
	await openPublish(page);
	await page
		.getByRole("button", { name: "Fixture separate clips" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await page
		.getByRole("row", { name: "Separate clips" })
		.click();
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
	await page
		.getByRole("row", { name: "Separate clips" })
		.click();
	await page
		.getByRole("button", { name: "Fixture gif format" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByText(/MP4 only/i)).toBeVisible();
	await expect(page.getByRole("row", { name: "Separate clips" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	// The format is never silently switched and the full-timeline CTA remains.
	await expect(page.getByRole("button", { name: /Export GIF/i })).toBeVisible();
});

test("zero valid clips disables the batch action without opening a picker", async ({ page }) => {
	await openPublish(page, "?clips=0");
	await page
		.getByRole("button", { name: "Fixture separate clips" })
		.evaluate((button: HTMLButtonElement) => button.click());
	await page
		.getByRole("row", { name: "Separate clips" })
		.click();
	await expect(page.getByRole("button", { name: /No valid clips/i })).toBeDisabled();
	await expect(page.getByText(/Trim the timeline/i)).toBeVisible();
});

test("batch progress reports clip N of total and supports cancel", async ({ page }) => {
	await openPublish(page, "?state=progress");
	await expect(page.getByRole("status")).toHaveText("Exporting clips");
	await expect(page.getByText("3 of 10 clips")).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	// The cancelled summary keeps the completed file visible.
	await page.goto("/tests/ui/batch-clip-export.html?state=cancelled");
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.getByText("Export cancelled")).toBeVisible();
	await expect(page.getByText("1 of 2 clips saved.")).toBeVisible();
});

test("partial results offer retry for failed clips only and surface sidecar warnings", async ({
	page,
}) => {
	await openPublish(page, "?state=partial");
	await expect(page.getByText("Export finished with issues")).toBeVisible();
	await expect(page.getByText("2 of 4 clips saved.")).toBeVisible();
	await expect(page.getByText(/saved without caption files/i)).toBeVisible();
	await expect(page.getByText(/Clip 2: encoder boom/)).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry failed clips" })).toBeVisible();
});

test("complete batch reports every clip saved", async ({ page }) => {
	await openPublish(page, "?state=complete");
	await expect(page.getByText("All clips exported")).toBeVisible();
	await expect(page.getByText("3 of 3 clips saved.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry failed clips" })).toHaveCount(0);
});
