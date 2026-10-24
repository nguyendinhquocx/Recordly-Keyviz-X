import { describe, expect, it } from "vitest";
import type { ClipExportPlan } from "@/components/video-editor/export/clipExportPlan";
import { buildClipExportPlans } from "@/components/video-editor/export/clipExportPlan";
import type { ClipRegion } from "@/components/video-editor/types";
import {
	type ClipBatchRenderPorts,
	type ClipBatchSink,
	ClipBatchExporter,
	cleanupFailedClipBatchSinkInitialization,
	shouldRenderClipAudio,
} from "./clipBatchExporter";

const FPS = 30;
const FRAME_US = 1_000_000 / FPS;

function makePlans(clips: ClipRegion[]) {
	const result = buildClipExportPlans({
		clips,
		sourceDurationMs: 10_000,
		fps: FPS,
	});
	expect(result.skipped).toEqual([]);
	return result.plans;
}

/** Deterministic frame fixture: one marker object per global frame. */
function createFakeFrames(totalFrames: number) {
	const closed: number[] = [];
	return {
		closed,
		get: (globalFrame: number) =>
			({
				index: globalFrame,
				close: () => closed.push(globalFrame),
			}) as unknown as VideoFrame,
	};
}

interface RecordedRenderCall {
	sourceTimestampUs: number;
	cursorTimestampUs: number;
	backgroundTimelineTimestampUs: number;
	globalFrame: number;
}

interface RecordedSink {
	frames: Array<{ timestampUs: number; durationUs: number; keyFrame: boolean }>;
	finished: boolean;
	aborted: boolean;
	tempPath: string;
}

function createPorts(options: {
	totalFrames: number;
	clips: ClipRegion[];
	onRenderFrame?: (call: RecordedRenderCall) => void;
	onSinkAddFrame?: (sinkIndex: number, frameIndex: number) => void;
	sinkAddFrameError?: (sinkIndex: number) => Error | null;
	sinkFinishError?: (sinkIndex: number) => Error | null;
	isCancelled?: () => boolean;
}) {
	const frames = createFakeFrames(options.totalFrames);
	const renderCalls: RecordedRenderCall[] = [];
	const sinks: RecordedSink[] = [];
	const sinkCreationOptions: Array<{ maxEncodeQueue: number; isCancelled: () => boolean }> = [];
	let createdSinks = 0;
	let emitted = 0;
	let decoderCancelled = false;

	const ports: ClipBatchRenderPorts = {
		decoder: {
			loadMetadata: async () => ({ width: 1280, height: 720, hasAudio: true }),
			cancel: () => {
				decoderCancelled = true;
			},
			decodeAll: async (_fps, _trims, _speeds, onFrame, clipRegions) => {
				const sorted = [...clipRegions!].sort((a, b) => a.startMs - b.startMs);
				for (let globalFrame = 0; globalFrame < options.totalFrames; globalFrame++) {
					if (decoderCancelled || options.isCancelled?.()) break;
					const timeMs = (globalFrame / FPS) * 1000;
					const owner = sorted.find(
						(clip) => timeMs >= clip.startMs && timeMs < clip.endMs,
					);
					if (!owner) {
						// Gap frame on the global grid.
						await onFrame(null, 0, 0, 0);
						continue;
					}
					const sourceMs = owner.startMs! - owner.startMs!; // placeholder, replaced below
					void sourceMs;
					const sourceStart = owner.sourceStartMs ?? owner.startMs;
					const mappedSourceMs = sourceStart + (timeMs - owner.startMs) * owner.speed;
					emitted += 1;
					await onFrame(
						frames.get(globalFrame),
						mappedSourceMs * 1000,
						mappedSourceMs,
						mappedSourceMs,
					);
				}
			},
			destroy: () => undefined,
		},
		renderer: {
			initialize: async () => undefined,
			renderFrame: async (
				_frame,
				sourceTimestampUs,
				cursorTimestampUs,
				_frameDurationUs,
				backgroundTimelineTimestampUs,
			) => {
				const globalFrame = (backgroundTimelineTimestampUs / 1_000_000) * FPS;
				const call = {
					sourceTimestampUs,
					cursorTimestampUs,
					backgroundTimelineTimestampUs,
					globalFrame,
				};
				renderCalls.push(call);
				options.onRenderFrame?.(call);
			},
			getCanvas: () => ({ marker: "canvas" }) as unknown as HTMLCanvasElement,
			dispose: () => undefined,
		},
		createSink: async (sinkOptions) => {
			sinkCreationOptions.push(sinkOptions);
			const sinkIndex = createdSinks++;
			const sink: RecordedSink = {
				frames: [],
				finished: false,
				aborted: false,
				tempPath: `/tmp/batch-clip-${sinkIndex}.mp4`,
			};
			sinks.push(sink);
			const api: ClipBatchSink = {
				addFrame: async (canvas, timestampUs, durationUs, keyFrame) => {
					const error = options.sinkAddFrameError?.(sinkIndex);
					if (error) throw error;
					void canvas;
					options.onSinkAddFrame?.(sinkIndex, sink.frames.length);
					sink.frames.push({ timestampUs, durationUs, keyFrame });
				},
				finish: async () => {
					sink.finished = true;
					const error = options.sinkFinishError?.(sinkIndex);
					return error
						? { error: error.message, errorKind: "write" as const }
						: { tempFilePath: sink.tempPath };
				},
				abort: async () => {
					sink.aborted = true;
				},
			};
			return api;
		},
		cancelAudio: () => undefined,
		renderClipAudioWav: async () => new Blob(["wav"], { type: "audio/wav" }),
		muxClipAudio: async (videoTempPath) => ({
			success: true,
			tempPath: `${videoTempPath}.audio.mp4`,
		}),
		discardTemp: async () => undefined,
	};

	return {
		ports,
		renderCalls,
		sinks,
		frames,
		sinkCreationOptions,
		emittedCount: () => emitted,
		decoderCancelled: () => decoderCancelled,
	};
}

function buildBatch(
	ports: ClipBatchRenderPorts,
	plans: ClipExportPlan[],
	clips: ClipRegion[],
	isCancelled?: () => boolean,
) {
	return new ClipBatchExporter(ports, {
		videoUrl: "file://recording.mp4",
		frameRate: FPS,
		clipRegions: clips,
		plans,
		isCancelled: isCancelled ?? (() => false),
	});
}

describe("failed batch sink initialization cleanup", () => {
	it("closes the encoder, aborts the stream, and destroys the muxer", async () => {
		const calls: string[] = [];
		await cleanupFailedClipBatchSinkInitialization(
			{
				abortStream: async () => {
					calls.push("abort-stream");
				},
				destroy: () => calls.push("destroy-muxer"),
			},
			{
				state: "configured",
				close: () => calls.push("close-encoder"),
			},
		);

		expect(calls).toEqual(["close-encoder", "abort-stream", "destroy-muxer"]);
	});

	it("still destroys the muxer when abort fails or no encoder was created", async () => {
		const calls: string[] = [];
		await cleanupFailedClipBatchSinkInitialization(
			{
				abortStream: async () => {
					calls.push("abort-stream");
					throw new Error("stream already closed");
				},
				destroy: () => calls.push("destroy-muxer"),
			},
			null,
		);

		expect(calls).toEqual(["abort-stream", "destroy-muxer"]);
	});
});

describe("silent video audio gate", () => {
	it("does not render or mux audio for a video-only clip with no fallback or overlay", () => {
		const [plan] = makePlans([{ id: "silent", startMs: 0, endMs: 1000, speed: 1 }]);
		expect(shouldRenderClipAudio(false, [], plan)).toBe(false);
	});

	it("still renders audio for a video-only source when an overlay or fallback exists", () => {
		const [planWithoutOverlay] = makePlans([
			{ id: "silent", startMs: 0, endMs: 1000, speed: 1 },
		]);
		const withOverlay = buildClipExportPlans({
			clips: [{ id: "silent", startMs: 0, endMs: 1000, speed: 1 }],
			sourceDurationMs: 10_000,
			fps: FPS,
			audioRegions: [
				{ id: "music", startMs: 0, endMs: 1000, audioPath: "music.mp3", volume: 1 },
			],
		}).plans[0];
		expect(shouldRenderClipAudio(false, [], withOverlay)).toBe(true);
		expect(shouldRenderClipAudio(false, ["mic.m4a"], planWithoutOverlay)).toBe(true);
	});
});

describe("ClipBatchExporter silent source metadata", () => {
	it("keeps a video-only clip and skips audio mux when decoder reports no audio", async () => {
		const clips: ClipRegion[] = [{ id: "silent", startMs: 0, endMs: 1000, speed: 1 }];
		const plans = makePlans(clips);
		const { ports } = createPorts({ totalFrames: 30, clips });
		ports.decoder.loadMetadata = async () => ({ width: 1280, height: 720, hasAudio: false });
		const seenMetadata: boolean[] = [];
		let muxCalls = 0;
		ports.renderClipAudioWav = async (plan, hasEmbeddedAudio) => {
			seenMetadata.push(hasEmbeddedAudio);
			return shouldRenderClipAudio(hasEmbeddedAudio, [], plan)
				? new Blob(["unexpected audio"], { type: "audio/wav" })
				: null;
		};
		ports.muxClipAudio = async () => {
			muxCalls += 1;
			return { success: false, error: "silent source should not be muxed" };
		};

		const result = await buildBatch(ports, plans, clips).exportBatch();

		expect(seenMetadata).toEqual([false]);
		expect(muxCalls).toBe(0);
		expect(result.items[0].status).toBe("completed");
		expect(result.items[0].tempFilePath).toBe("/tmp/batch-clip-0.mp4");
	});
});

describe("ClipBatchExporter", () => {
	it("keeps one render session and matches full-timeline clocks at every global frame", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, sourceStartMs: 2000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, renderCalls, sinks } = createPorts({ totalFrames: 60, clips });
		const result = await buildBatch(ports, plans, clips).exportBatch();

		expect(result.cancelled).toBe(false);
		expect(result.items.map((item) => item.status)).toEqual(["completed", "completed"]);
		// One shared renderer: render order equals full-timeline frame order.
		expect(renderCalls).toHaveLength(60);
		// Frame 0 (clip a): T=0, S=0.
		expect(renderCalls[0]).toMatchObject({
			sourceTimestampUs: 0,
			cursorTimestampUs: 0,
			backgroundTimelineTimestampUs: 0,
		});
		// Frame 15 (clip a): T=500ms, S=500ms.
		expect(renderCalls[15]).toMatchObject({
			sourceTimestampUs: 500_000,
			backgroundTimelineTimestampUs: 500_000,
		});
		// Frame 30 (clip b): T=1000ms, S=2000ms — original clocks, not rebased.
		expect(renderCalls[30]).toMatchObject({
			sourceTimestampUs: 2_000_000,
			backgroundTimelineTimestampUs: 1_000_000,
		});
		// Frame 45 (clip b): T=1500ms, S=2500ms.
		expect(renderCalls[45]).toMatchObject({
			sourceTimestampUs: 2_500_000,
			backgroundTimelineTimestampUs: 1_500_000,
		});
		// Two sinks: one per clip, no renderer recreation.
		expect(sinks).toHaveLength(2);
	});

	it("replays prior timeline frames for state but creates output only for retry targets", async () => {
		const clips: ClipRegion[] = [
			{ id: "done-a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "done-b", startMs: 1000, endMs: 2000, speed: 1 },
			{ id: "retry", startMs: 2000, endMs: 3000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, renderCalls, sinks } = createPorts({ totalFrames: 90, clips });
		const result = await new ClipBatchExporter(ports, {
			videoUrl: "file://recording.mp4",
			frameRate: FPS,
			clipRegions: clips,
			plans,
			outputClipIds: ["retry"],
			isCancelled: () => false,
		}).exportBatch();

		expect(renderCalls).toHaveLength(90);
		expect(sinks).toHaveLength(1);
		expect(sinks[0].frames).toHaveLength(30);
		expect(sinks[0].frames[0].timestampUs).toBe(0);
		expect(result.items.map((item) => item.status)).toEqual([
			"skipped",
			"skipped",
			"completed",
		]);
	});

	it("passes a bounded queue limit and cancellation predicate to every sink", async () => {
		const clips: ClipRegion[] = [{ id: "a", startMs: 0, endMs: 1000, speed: 1 }];
		const plans = makePlans(clips);
		const { ports, sinkCreationOptions } = createPorts({ totalFrames: 30, clips });
		const exporter = new ClipBatchExporter(ports, {
			videoUrl: "file://recording.mp4",
			frameRate: FPS,
			clipRegions: clips,
			plans,
			maxEncodeQueue: 2,
			isCancelled: () => false,
		});
		await exporter.exportBatch();
		expect(sinkCreationOptions).toHaveLength(1);
		expect(sinkCreationOptions[0].maxEncodeQueue).toBe(2);
		expect(typeof sinkCreationOptions[0].isCancelled).toBe("function");
	});

	it("starts each file at PTS zero on the global frame grid with a leading keyframe", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 2 },
			{ id: "b", startMs: 1000, endMs: 3000, sourceStartMs: 2000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, sinks } = createPorts({ totalFrames: 90, clips });
		const result = await buildBatch(ports, plans, clips).exportBatch();

		expect(result.items.map((item) => item.status)).toEqual(["completed", "completed"]);
		// Clip a: [0..1000ms) at 2x -> 30 frames; clip b: [1000..3000ms) -> 60 frames.
		expect(sinks[0].frames).toHaveLength(30);
		expect(sinks[1].frames).toHaveLength(60);
		// PTS starts at zero per file and advances one frame.
		expect(sinks[0].frames[0].timestampUs).toBe(0);
		expect(sinks[1].frames[0].timestampUs).toBe(0);
		expect(sinks[1].frames[1].timestampUs).toBeCloseTo(FRAME_US, 6);
		expect(sinks[1].frames[59].timestampUs).toBeCloseTo(59 * FRAME_US, 6);
		// Leading keyframe per file.
		expect(sinks[0].frames[0].keyFrame).toBe(true);
		expect(sinks[1].frames[0].keyFrame).toBe(true);
		expect(sinks[1].frames[1].keyFrame).toBe(false);
	});

	it("muxes clip-local edited audio onto each completed video", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1, muted: true },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
		];
		const plans = makePlans(clips);
		const audioCalls: Array<{ video: string; planId: string; muted: boolean }> = [];
		const { ports } = createPorts({ totalFrames: 60, clips });
		ports.renderClipAudioWav = async (plan) => {
			void plan;
			return new Blob(["wav"], { type: "audio/wav" });
		};
		ports.muxClipAudio = async (videoTempPath, _wav, plan) => {
			audioCalls.push({
				video: videoTempPath,
				planId: plan.clipId,
				muted: plan.muted,
			});
			return { success: true, tempPath: `${videoTempPath}.audio.mp4` };
		};
		const result = await buildBatch(ports, plans, clips).exportBatch();

		expect(audioCalls.map((call) => call.planId)).toEqual(["a", "b"]);
		expect(audioCalls[0]).toMatchObject({ video: "/tmp/batch-clip-0.mp4", muted: true });
		expect(audioCalls[1].muted).toBe(false);
		// Final item paths point at the audio-muxed outputs.
		expect(result.items[0].tempFilePath).toBe("/tmp/batch-clip-0.mp4.audio.mp4");
		expect(result.items[1].tempFilePath).toBe("/tmp/batch-clip-1.mp4.audio.mp4");
	});

	it("discards a video-only temp when clip audio mux fails", async () => {
		const clips: ClipRegion[] = [{ id: "a", startMs: 0, endMs: 1000, speed: 1 }];
		const plans = makePlans(clips);
		const { ports } = createPorts({ totalFrames: 30, clips });
		const discarded: string[] = [];
		ports.muxClipAudio = async () => ({ success: false, error: "FFmpeg failed" });
		ports.discardTemp = async (tempPath) => {
			discarded.push(tempPath);
		};

		const result = await buildBatch(ports, plans, clips).exportBatch();

		expect(result.items[0].status).toBe("render-error");
		expect(result.items[0].tempFilePath).toBeUndefined();
		expect(discarded).toEqual(["/tmp/batch-clip-0.mp4"]);
	});

	it("records a render failure for that clip and continues with later clips", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
			{ id: "c", startMs: 2000, endMs: 3000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, sinks, renderCalls } = createPorts({
			totalFrames: 90,
			clips,
			sinkAddFrameError: (sinkIndex) => (sinkIndex === 1 ? new Error("encoder boom") : null),
		});
		const result = await buildBatch(ports, plans, clips).exportBatch();

		expect(result.items[0].status).toBe("completed");
		expect(result.items[1].status).toBe("render-error");
		expect(result.items[1].error).toBe("encoder boom");
		expect(result.items[2].status).toBe("completed");
		// Failed output frames are not encoded, but the renderer advances through
		// the rest of that clip so later stateful effects match the full timeline.
		expect(sinks[1].aborted).toBe(true);
		expect(
			renderCalls.filter((call) => call.globalFrame >= 30 && call.globalFrame < 60),
		).toHaveLength(30);
		expect(sinks[2].frames.length).toBe(30);
	});

	it("stops the batch after a temporary output write failure", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
			{ id: "c", startMs: 2000, endMs: 3000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, sinks, decoderCancelled } = createPorts({
			totalFrames: 90,
			clips,
			sinkFinishError: (sinkIndex) => (sinkIndex === 0 ? new Error("temp disk full") : null),
		});
		const result = await buildBatch(ports, plans, clips).exportBatch();

		expect(result.cancelled).toBe(false);
		expect(decoderCancelled()).toBe(true);
		expect(sinks).toHaveLength(1);
		expect(result.items.map((item) => item.status)).toEqual([
			"write-error",
			"write-error",
			"write-error",
		]);
	});

	it("stops starting new clips after cancellation and keeps completed files", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
			{ id: "c", startMs: 2000, endMs: 3000, speed: 1 },
		];
		const plans = makePlans(clips);
		let renderCount = 0;
		const { ports, sinks } = createPorts({
			totalFrames: 90,
			clips,
			isCancelled: () => renderCount >= 45,
			onRenderFrame: () => {
				renderCount += 1;
			},
		});
		const result = await buildBatch(ports, plans, clips, () => renderCount >= 45).exportBatch();

		expect(result.cancelled).toBe(true);
		// Clip a finished before the cancel point.
		expect(result.items[0].status).toBe("completed");
		expect(sinks[0].finished).toBe(true);
		// Clip b was in flight: cancelled, sink aborted, no file published.
		expect(["cancelled", "skipped"]).toContain(result.items[1].status);
		expect(result.items[1].tempFilePath).toBeUndefined();
		// Clip c never started.
		expect(result.items[2].status).toBe("skipped");
		expect(result.items[2].tempFilePath).toBeUndefined();
	});

	it("signals the active decoder immediately when cancelled during decode", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, sinks } = createPorts({ totalFrames: 60, clips });
		let decoderEntered!: () => void;
		let releaseDecode!: () => void;
		const entered = new Promise<void>((resolve) => (decoderEntered = resolve));
		const released = new Promise<void>((resolve) => (releaseDecode = resolve));
		let decoderCancelled = false;
		ports.decoder.cancel = () => {
			decoderCancelled = true;
		};
		ports.decoder.decodeAll = async () => {
			decoderEntered();
			await released;
			// A real StreamingVideoDecoder observes cancel before emitting another frame.
			if (!decoderCancelled) throw new Error("decode continued after cancel");
		};

		const exporter = buildBatch(ports, plans, clips);
		const running = exporter.exportBatch();
		await entered;
		exporter.cancel();
		releaseDecode();
		const result = await running;

		expect(decoderCancelled).toBe(true);
		expect(result.cancelled).toBe(true);
		expect(sinks).toHaveLength(0);
	});

	it("cancel immediately stops the active StreamingVideoDecoder", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, renderCalls, sinks, decoderCancelled } = createPorts({
			totalFrames: 60,
			clips,
		});
		let audioCancelled = false;
		ports.cancelAudio = () => {
			audioCancelled = true;
		};
		const exporter = buildBatch(ports, plans, clips);
		const renderFrame = ports.renderer.renderFrame;
		ports.renderer.renderFrame = async (...args) => {
			await renderFrame(...args);
			if (renderCalls.length === 1) exporter.cancel();
		};

		const result = await exporter.exportBatch();

		expect(result.cancelled).toBe(true);
		expect(decoderCancelled()).toBe(true);
		expect(audioCancelled).toBe(true);
		expect(renderCalls).toHaveLength(1);
		expect(sinks[0].aborted).toBe(true);
		expect(result.items[1].status).toBe("skipped");
	});

	it("never encodes gap frames that belong to no clip", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1500, endMs: 2000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, sinks } = createPorts({ totalFrames: 60, clips });
		const result = await buildBatch(ports, plans, clips).exportBatch();

		// Gap [1000..1500ms) = frames 30..44 on the shared grid: skipped.
		expect(sinks[0].frames).toHaveLength(30);
		expect(sinks[1].frames).toHaveLength(15);
		expect(sinks[1].frames[0].timestampUs).toBe(0);
		expect(result.items.map((item) => item.status)).toEqual(["completed", "completed"]);
	});

	it("returns no items for an empty plan without touching the decoder", async () => {
		const clips: ClipRegion[] = [];
		const { ports } = createPorts({ totalFrames: 0, clips });
		let decoderTouched = false;
		ports.decoder.loadMetadata = async () => {
			decoderTouched = true;
			return { width: 1, height: 1, hasAudio: false };
		};
		const result = await new ClipBatchExporter(ports, {
			videoUrl: "file://x.mp4",
			frameRate: FPS,
			clipRegions: [],
			plans: [],
			isCancelled: () => false,
		}).exportBatch();

		expect(result.items).toEqual([]);
		expect(result.cancelled).toBe(false);
		expect(decoderTouched).toBe(false);
	});
});

describe("ClipBatchExporter sidecar payloads", () => {
	it("attaches each clip's own sidecar projection, never a shared full payload", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, sourceStartMs: 1000, speed: 1 },
		];
		const withCaptions = buildClipExportPlans({
			clips,
			sourceDurationMs: 10_000,
			fps: FPS,
			autoCaptions: [
				{
					id: "c1",
					startMs: 200,
					endMs: 1400,
					text: "spans both clips",
					words: [{ text: "spans", startMs: 200, endMs: 600 }],
				},
			],
		});
		expect(withCaptions.skipped).toEqual([]);
		const { ports } = createPorts({ totalFrames: 60, clips });
		const result = await buildBatch(ports, withCaptions.plans, clips).exportBatch();

		expect(result.items).toHaveLength(2);
		// Item plans carry clip-local cue-level sidecar projections, never a shared full payload.
		expect(result.items[0].plan.sidecarCues).toEqual([
			{ startMs: 200, endMs: 1000, text: "spans both clips" },
		]);
		expect(result.items[1].plan.sidecarCues).toEqual([
			{ startMs: 0, endMs: 400, text: "spans both clips" },
		]);
	});
});

describe("clip-local audio rebase", () => {
	it("keeps the original file offset via a negative local start", async () => {
		const { buildClipLocalAudioRegions } = await import("./clipBatchExporter");
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2500, speed: 1 },
		];
		const { plans } = buildClipExportPlans({
			clips,
			sourceDurationMs: 10_000,
			fps: FPS,
			audioRegions: [
				{
					id: "music",
					startMs: 500,
					endMs: 4000,
					audioPath: "music.mp3",
					volume: 0.7,
				},
			],
		});
		const [regionA] = buildClipLocalAudioRegions(plans[0]);
		// Overlay starts mid-clip: local start equals the overlap position.
		expect(regionA).toMatchObject({ startMs: 500, endMs: 1000 });
		const [regionB] = buildClipLocalAudioRegions(plans[1]);
		// Overlay started before clip b, but output placement remains [0..1500).
		// Its separate file offset is 500ms; scheduler tests verify this offsets
		// the decoded buffer without truncating clip-local output duration.
		expect(regionB).toMatchObject({ startMs: 0, endMs: 1500, sourceOffsetMs: 500 });
	});
});

describe("gap frame state continuity", () => {
	it("advances the shared renderer across gap frames without encoding them", async () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1500, endMs: 2000, speed: 1 },
		];
		const plans = makePlans(clips);
		const { ports, renderCalls, sinks } = createPorts({ totalFrames: 60, clips });
		const result = await buildBatch(ports, plans, clips).exportBatch();

		expect(result.items.map((item) => item.status)).toEqual(["completed", "completed"]);
		// Gap [1000..1500ms) = frames 30..44: rendered for state continuity...
		const gapRenderCalls = renderCalls.filter(
			(call) => call.globalFrame >= 30 && call.globalFrame < 45,
		);
		expect(gapRenderCalls).toHaveLength(15);
		expect(gapRenderCalls[0].backgroundTimelineTimestampUs).toBeCloseTo(1_000_000, 6);
		// ...but never encoded.
		expect(sinks[0].frames).toHaveLength(30);
		expect(sinks[1].frames).toHaveLength(15);
	});
});
