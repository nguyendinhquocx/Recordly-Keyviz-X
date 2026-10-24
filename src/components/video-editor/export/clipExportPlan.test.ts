import { describe, expect, it } from "vitest";
import type {
	AnnotationRegion,
	AudioRegion,
	CaptionCue,
	ClipRegion,
	WebcamOverlaySettings,
	ZoomRegion,
} from "../types";
import { buildClipExportPlans, getClipRegionsForPlans } from "./clipExportPlan";

const DEFAULT_WEBCAM: WebcamOverlaySettings = {
	visibleRanges: [{ startMs: 1200, endMs: 4800 }],
	enabled: true,
	sourcePath: "webcam.webm",
	timeOffsetMs: 250,
	mirror: true,
	cropRegion: { x: 0, y: 0, width: 1, height: 1 },
	corner: "bottom-right",
	positionPreset: "bottom-right",
	positionX: 1,
	positionY: 1,
	size: 40,
	width: 40,
	height: 40,
	reactToZoom: true,
	roundness: 100,
	shadow: 0.3,
	margin: 24,
};

function makeAnnotation(id: string, startMs: number, endMs: number): AnnotationRegion {
	return {
		id,
		startMs,
		endMs,
		type: "text",
		content: id,
		position: { x: 10, y: 10 },
		size: { width: 20, height: 20 },
		style: {
			color: "#fff",
			backgroundColor: "transparent",
			fontSize: 32,
			fontFamily: "sans-serif",
			fontWeight: "normal",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "left",
			borderRadius: 8,
		},
		zIndex: 1,
	};
}

describe("buildClipExportPlans", () => {
	it("maps nonzero sourceStartMs with speed != 1 through the time-base contract", () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 2 },
			{ id: "b", startMs: 1000, endMs: 3000, sourceStartMs: 2000, speed: 0.5 },
		];
		const { plans, skipped } = buildClipExportPlans({
			clips,
			sourceDurationMs: 10_000,
			fps: 30,
		});
		expect(skipped).toEqual([]);
		expect(plans).toHaveLength(2);

		const [a, b] = plans;
		expect(a).toMatchObject({
			timelineStartMs: 0,
			timelineEndMs: 1000,
			sourceStartMs: 0,
			sourceEndMs: 2000,
			speed: 2,
		});
		expect(b).toMatchObject({
			timelineStartMs: 1000,
			timelineEndMs: 3000,
			sourceStartMs: 2000,
			sourceEndMs: 3000,
			speed: 0.5,
		});

		// U = T - T0; S = S0 + U * speed
		expect(b.timelineMsToSourceMs(1500)).toBe(2250);
		expect(b.frameIndexToTimelineMs(0)).toBe(1000);
		expect(b.frameIndexToOutputMs(0)).toBe(0);
		// Global frame 30 = 1000ms on the shared 30fps grid; U = 0 -> S = S0.
		expect(b.frameIndexToSourceMs(30 - b.firstFrame + b.firstFrame - b.firstFrame)).toBe(2000);
		expect(a.frameIndexToSourceMs(0)).toBe(0);
		// Frame 15 = 500ms into clip a at 2x -> source 1000ms.
		expect(a.frameIndexToSourceMs(15)).toBe(1000);
	});

	it("keeps timeline order even when source order differs (split + reorder)", () => {
		const clips: ClipRegion[] = [
			{ id: "late", startMs: 0, endMs: 1000, sourceStartMs: 5000, speed: 2 },
			{ id: "early", startMs: 1000, endMs: 2000, sourceStartMs: 0, speed: 1 },
		];
		const { plans } = buildClipExportPlans({
			clips,
			sourceDurationMs: 10_000,
			fps: 30,
		});
		expect(plans.map((plan) => plan.clipId)).toEqual(["late", "early"]);
		expect(plans[0].sourceStartMs).toBe(5000);
		expect(plans[1].sourceStartMs).toBe(0);
		expect(plans.map((plan) => plan.clipIndex)).toEqual([1, 2]);
	});

	it.each([
		24, 30, 60, 59.94,
	])("preserves the global %s fps frame grid across fractional-frame cuts", (fps) => {
		// 137ms clips create fractional cuts on every fps.
		const clips: ClipRegion[] = Array.from({ length: 100 }, (_, i) => ({
			id: `${i}`,
			startMs: i * 137,
			endMs: (i + 1) * 137,
			sourceStartMs: i * 411,
			speed: 3,
		}));
		const { plans } = buildClipExportPlans({
			clips,
			sourceDurationMs: 100_000,
			fps,
		});
		const totalFrames = plans.reduce((sum, plan) => sum + plan.frameCount, 0);
		expect(totalFrames).toBe(Math.ceil((13_700 / 1000) * fps));
		// Adjacent clips share one boundary frame count: ceil(next.T0*fps) starts
		// where the previous clip ended on the global grid.
		for (let i = 1; i < plans.length; i++) {
			expect(plans[i].firstFrame).toBe(plans[i - 1].firstFrame + plans[i - 1].frameCount);
		}
		for (const plan of plans) {
			expect(plan.outputDurationMs).toBeCloseTo((plan.frameCount / fps) * 1000, 6);
		}
	});

	it("skips invalid clips and names them; zero valid clips yields no plans", () => {
		const clips: ClipRegion[] = [
			{ id: "ok", startMs: 0, endMs: 500, speed: 1 },
			{ id: "bad-bounds", startMs: 500, endMs: 500, speed: 1 },
			{ id: "bad-speed", startMs: 500, endMs: 1000, speed: 0 },
			{ id: "bad-nan", startMs: Number.NaN, endMs: 1000, speed: 1 },
			{
				id: "outside-recording",
				startMs: 1000,
				endMs: 2000,
				sourceStartMs: 9000,
				speed: 1,
			},
			{
				id: "outside-source-max",
				startMs: 2000,
				endMs: 3000,
				sourceStartMs: 0,
				sourceMaxMs: 500,
				speed: 1,
			},
		];
		const { plans, skipped } = buildClipExportPlans({
			clips,
			sourceDurationMs: 5000,
			fps: 30,
		});
		expect(plans.map((plan) => plan.clipId)).toEqual(["ok"]);
		expect(skipped).toEqual([
			{ clipId: "bad-bounds", clipIndex: 2, reason: "invalid-bounds" },
			{ clipId: "bad-speed", clipIndex: 3, reason: "invalid-speed" },
			{ clipId: "bad-nan", clipIndex: 4, reason: "invalid-bounds" },
			{ clipId: "outside-recording", clipIndex: 5, reason: "outside-source" },
			{ clipId: "outside-source-max", clipIndex: 6, reason: "outside-source" },
		]);

		const unknownDuration = buildClipExportPlans({
			clips: [{ id: "unknown-duration", startMs: 0, endMs: 500, speed: 1 }],
			sourceDurationMs: Number.NaN,
			fps: 30,
		});
		expect(unknownDuration.plans).toEqual([]);
		expect(unknownDuration.skipped).toEqual([
			{ clipId: "unknown-duration", clipIndex: 1, reason: "outside-source" },
		]);

		const empty = buildClipExportPlans({ clips: [], sourceDurationMs: 5000, fps: 30 });
		expect(empty.plans).toEqual([]);
		expect(empty.skipped).toEqual([]);
	});

	it("passes only valid original clips to the decoder in plan order", () => {
		const clips: ClipRegion[] = [
			{ id: "first", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "invalid", startMs: 1000, endMs: 2000, speed: 0 },
			{ id: "last", startMs: 2000, endMs: 3000, speed: 1 },
		];
		const { plans } = buildClipExportPlans({ clips, sourceDurationMs: 5000, fps: 30 });
		const decoderClips = getClipRegionsForPlans(clips, plans);

		expect(decoderClips.map((clip) => clip.id)).toEqual(["first", "last"]);
		expect(decoderClips[0]).toBe(clips[0]);
		expect(decoderClips[1]).toBe(clips[2]);
	});

	it("keeps a zoom pair connected across a clip boundary for both sides", () => {
		const zoomRegions: ZoomRegion[] = [
			{ id: "z1", startMs: 0, endMs: 1800, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
			{ id: "z2", startMs: 2000, endMs: 4000, depth: 2, focus: { cx: 0.3, cy: 0.6 } },
			{ id: "far", startMs: 20_000, endMs: 21_000, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
		];
		const { plans } = buildClipExportPlans({
			clips: [
				{ id: "a", startMs: 0, endMs: 1900, speed: 1 },
				{ id: "b", startMs: 1900, endMs: 4200, speed: 1 },
			],
			sourceDurationMs: 60_000,
			fps: 30,
			zoomRegions,
		});
		expect(plans[0].zoomRegions.map((region) => region.id)).toEqual(["z1", "z2"]);
		expect(plans[1].zoomRegions.map((region) => region.id)).toEqual(["z1", "z2"]);
		// Selected regions are untouched originals evaluated on the timeline clock.
		expect(plans[0].zoomRegions[0]).toBe(zoomRegions[0]);
	});

	it("passes webcam settings through untouched in source time", () => {
		const { plans } = buildClipExportPlans({
			clips: [{ id: "a", startMs: 1000, endMs: 2000, speed: 1 }],
			sourceDurationMs: 10_000,
			fps: 30,
			webcam: DEFAULT_WEBCAM,
		});
		expect(plans[0].webcam).toBe(DEFAULT_WEBCAM);
		expect(plans[0].webcam?.visibleRanges).toEqual([{ startMs: 1200, endMs: 4800 }]);
		expect(plans[0].webcam?.timeOffsetMs).toBe(250);
	});

	it("slices imported audio crossing both boundaries and preserves file offset", () => {
		const audioRegions: AudioRegion[] = [
			{
				id: "music",
				startMs: 500,
				endMs: 4000,
				audioPath: "music.mp3",
				volume: 0.7,
				normalize: true,
			},
		];
		const { plans } = buildClipExportPlans({
			clips: [
				{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
				{ id: "b", startMs: 1000, endMs: 2500, speed: 1 },
				{ id: "c", startMs: 2500, endMs: 5000, speed: 1 },
			],
			sourceDurationMs: 10_000,
			fps: 30,
			audioRegions,
		});
		// Clip a: overlay starts mid-clip (0.5s), file offset zero.
		expect(plans[0].audioOverlays).toEqual([
			{
				regionId: "music",
				audioPath: "music.mp3",
				volume: 0.7,
				normalize: true,
				outputStartMs: 500,
				outputEndMs: 1000,
				sourceOffsetMs: 0,
			},
		]);
		// Clip b: overlay crosses both boundaries; file continues from 500ms.
		expect(plans[1].audioOverlays).toEqual([
			{
				regionId: "music",
				audioPath: "music.mp3",
				volume: 0.7,
				normalize: true,
				outputStartMs: 0,
				outputEndMs: 1500,
				sourceOffsetMs: 500,
			},
		]);
		// Clip c: overlay ends mid-clip at its original file offset.
		expect(plans[2].audioOverlays[0]).toMatchObject({
			outputStartMs: 0,
			outputEndMs: 1500,
			sourceOffsetMs: 2000,
		});
	});

	it("projects captions to source clock and sidecars to clip-local output time", () => {
		const autoCaptions: CaptionCue[] = [
			{
				id: "c1",
				startMs: 200,
				endMs: 2400,
				text: "hello world",
				words: [
					{ text: "hello", startMs: 200, endMs: 800, leadingSpace: false },
					{ text: "world", startMs: 800, endMs: 2400, leadingSpace: true },
				],
			},
			{ id: "c2", startMs: 2400, endMs: 2800, text: "next" },
			{ id: "empty", startMs: 2600, endMs: 2700, text: "   " },
		];
		// Clip b reads source [2000..4000) at 1x; clip a source [0..2000).
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 2000, sourceStartMs: 0, speed: 1 },
			{ id: "b", startMs: 2000, endMs: 4000, sourceStartMs: 2000, speed: 2 },
		];
		const { plans } = buildClipExportPlans({
			clips,
			sourceDurationMs: 10_000,
			fps: 30,
			autoCaptions,
		});

		// Visual captions keep the source clock, intersected with [S0, S1).
		expect(plans[0].captionCues).toEqual([
			{
				id: "c1",
				startMs: 200,
				endMs: 2000,
				text: "hello world",
				words: [
					{ text: "hello", startMs: 200, endMs: 800, leadingSpace: false },
					{ text: "world", startMs: 800, endMs: 2400, leadingSpace: true },
				],
			},
		]);
		// Whitespace-only cues stay visual (renderer handles them) but never reach the sidecar.
		expect(plans[1].captionCues.map((cue) => cue.id)).toEqual(["c1", "c2", "empty"]);
		// Cue c1 bleeds into clip b's source window [2000..4000) at 2x speed.
		expect(plans[1].captionCues[0]).toMatchObject({ startMs: 2000, endMs: 2400 });

		// Sidecars preserve the existing cue-level SRT/VTT semantics and use clip-local output time.
		expect(plans[0].sidecarCues).toEqual([{ startMs: 200, endMs: 2000, text: "hello world" }]);
		// Clip b output duration is 1000ms (source 2000ms at 2x); c1 maps to
		// U = (2000-2000)/2 .. (2400-2000)/2 = 0..200, c2 to 200..400.
		expect(plans[1].sidecarCues).toEqual([
			{ startMs: 0, endMs: 200, text: "hello world" },
			{ startMs: 200, endMs: 400, text: "next" },
		]);
		expect(plans[1].outputDurationMs).toBe(2000);
	});

	it("keeps half-open source bounds so boundary cues are not duplicated", () => {
		const autoCaptions: CaptionCue[] = [
			{ id: "first", startMs: 0, endMs: 1000, text: "first" },
			{ id: "second", startMs: 1000, endMs: 2000, text: "second" },
		];
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, sourceStartMs: 1000, speed: 1 },
		];
		const { plans } = buildClipExportPlans({
			clips,
			sourceDurationMs: 10_000,
			fps: 30,
			autoCaptions,
		});
		expect(plans[0].captionCues.map((cue) => cue.id)).toEqual(["first"]);
		expect(plans[1].captionCues.map((cue) => cue.id)).toEqual(["second"]);
	});

	it("resolves source audio settings per clip id merged with defaults", () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1, muted: true },
		];
		const { plans } = buildClipExportPlans({
			clips,
			sourceDurationMs: 10_000,
			fps: 30,
			getSourceAudioTrackSettingsForClip: (clipId) =>
				clipId === "a" ? { mic: { volume: 0.5, normalize: false } } : {},
		});
		expect(plans[0].sourceAudioTrackSettings).toEqual({
			mic: { volume: 0.5, normalize: false },
		});
		expect(plans[0].muted).toBe(false);
		// muted mutes source audio only; it is display-independent metadata.
		expect(plans[1].muted).toBe(true);
		expect(plans[1].sourceAudioTrackSettings).toEqual({});
	});

	it("does not mutate project/editor state", () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 2 },
		];
		const autoCaptions: CaptionCue[] = [
			{
				id: "c1",
				startMs: 0,
				endMs: 1000,
				text: "hi",
				words: [{ text: "hi", startMs: 0, endMs: 1000 }],
			},
		];
		const audioRegions: AudioRegion[] = [
			{ id: "music", startMs: 0, endMs: 1000, audioPath: "m.mp3", volume: 1 },
		];
		const clipsSnapshot = JSON.stringify(clips);
		const captionsSnapshot = JSON.stringify(autoCaptions);
		const audioSnapshot = JSON.stringify(audioRegions);
		buildClipExportPlans({
			clips,
			sourceDurationMs: 10_000,
			fps: 30,
			autoCaptions,
			audioRegions,
		});
		expect(JSON.stringify(clips)).toBe(clipsSnapshot);
		expect(JSON.stringify(autoCaptions)).toBe(captionsSnapshot);
		expect(JSON.stringify(audioRegions)).toBe(audioSnapshot);
	});
});
