import { describe, expect, it } from "vitest";
import { buildClipExportPlans } from "./clipExportPlan";
import { getBatchReplayPlans, getBatchRetryWork, makeSidecarPayload } from "./useBatchClipExport";

describe("batch sidecar settings", () => {
	it("honors includeCaptionSidecar and format while exporting cue-level sidecars", () => {
		const plan = buildClipExportPlans({
			clips: [{ id: "clip", startMs: 0, endMs: 1000, speed: 1 }],
			sourceDurationMs: 5000,
			fps: 30,
			autoCaptions: [
				{
					id: "cue",
					startMs: 100,
					endMs: 900,
					text: "word timing",
					words: [
						{ text: "word", startMs: 100, endMs: 400, leadingSpace: false },
						{ text: "timing", startMs: 500, endMs: 900, leadingSpace: true },
					],
				},
			],
		}).plans[0];
		expect(makeSidecarPayload(plan, false, "both")).toBeUndefined();
		expect(makeSidecarPayload(plan, true, undefined)).toBeUndefined();
		expect(makeSidecarPayload(plan, true, "vtt")).toEqual({
			format: "vtt",
			cues: [{ startMs: 100, endMs: 900, text: "word timing" }],
		});
	});
});

describe("batch retry state replay", () => {
	it("replays all prior plans through the last failed output but excludes later clips", () => {
		const plans = buildClipExportPlans({
			clips: [
				{ id: "done-a", startMs: 0, endMs: 1000, speed: 1 },
				{ id: "done-b", startMs: 1000, endMs: 2000, speed: 1 },
				{ id: "failed", startMs: 2000, endMs: 3000, speed: 1 },
				{ id: "later", startMs: 3000, endMs: 4000, speed: 1 },
			],
			sourceDurationMs: 10_000,
			fps: 30,
		}).plans;

		expect(getBatchReplayPlans(plans, [plans[2]]).map((plan) => plan.clipId)).toEqual([
			"done-a",
			"done-b",
			"failed",
		]);
		expect(getBatchReplayPlans(plans, [])).toEqual([]);
	});
});

describe("batch retry partition", () => {
	it("rerenders only failed clips without retained temps and reuses written temps", () => {
		const plans = buildClipExportPlans({
			clips: [
				{ id: "done", startMs: 0, endMs: 1000, speed: 1 },
				{ id: "render-failed", startMs: 1000, endMs: 2000, speed: 1 },
				{ id: "write-failed", startMs: 2000, endMs: 3000, speed: 1 },
				{ id: "unattempted", startMs: 3000, endMs: 4000, speed: 1 },
			],
			sourceDurationMs: 10_000,
			fps: 30,
		}).plans;

		const retry = getBatchRetryWork(plans, {
			onlyClipIds: ["render-failed", "write-failed", "unattempted"],
			retainedTemps: {
				"write-failed": "temp-write.mp4",
				unattempted: "temp-unattempted.mp4",
			},
			previousItems: [],
		});

		expect(retry.selectedPlans.map((plan) => plan.clipId)).toEqual([
			"render-failed",
			"write-failed",
			"unattempted",
		]);
		expect(retry.plansToRender.map((plan) => plan.clipId)).toEqual(["render-failed"]);
		expect(retry.workClipIds).toEqual(["render-failed", "write-failed", "unattempted"]);
		expect(retry.selectedPlans.some((plan) => plan.clipId === "done")).toBe(false);
	});
});
