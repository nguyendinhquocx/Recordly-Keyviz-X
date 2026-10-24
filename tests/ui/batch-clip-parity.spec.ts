import { expect, test } from "@playwright/test";

test("real renderer retry replay matches full-timeline frames and imported-audio samples", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.goto("/tests/ui/batch-clip-parity.html");
	await expect(page.getByRole("status")).toContainText(
		/^PASS: 30 real pre-encode frames and 12000 audio samples match$/,
		{ timeout: 90_000 },
	);
});
