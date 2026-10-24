import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { buildClipExportPlans } from "@/components/video-editor/export/clipExportPlan";
import type {
	AudioRegion,
	ClipRegion,
	CursorTelemetryPoint,
	ZoomRegion,
} from "@/components/video-editor/types";
import { getClipSourceStartMs } from "@/components/video-editor/types";
import {
	ClipBatchExporter,
	type ClipBatchRenderPorts,
	type ClipBatchSink,
} from "@/lib/exporter/clipBatchExporter";
import "@/index.css";

const width = 160;
const height = 90;
const videoWidth = 64;
const videoHeight = 36;
const frameRate = 30;
const frameDurationUs = 1_000_000 / frameRate;
const totalFrames = 75;

const clips: ClipRegion[] = [
	{ id: "first", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 1 },
	{ id: "second", startMs: 1500, endMs: 2500, sourceStartMs: 3000, speed: 1.5 },
];

const zoomRegions: ZoomRegion[] = [
	{ id: "zoom-a", startMs: 200, endMs: 1900, depth: 3, focus: { cx: 0.35, cy: 0.42 } },
	{ id: "zoom-b", startMs: 2200, endMs: 2400, depth: 2, focus: { cx: 0.72, cy: 0.61 } },
];

const cursorTelemetry: CursorTelemetryPoint[] = [
	{ timeMs: 0, cx: 0.1, cy: 0.2 },
	{ timeMs: 1000, cx: 0.85, cy: 0.25 },
	{ timeMs: 3000, cx: 0.2, cy: 0.8 },
	{ timeMs: 4500, cx: 0.9, cy: 0.35 },
];

const plansResult = buildClipExportPlans({
	clips,
	sourceDurationMs: 5000,
	fps: frameRate,
	zoomRegions,
});

function getClipAtTimelineTime(timelineMs: number): ClipRegion | undefined {
	return clips.find((clip) => timelineMs >= clip.startMs && timelineMs < clip.endMs);
}

function makeSourceFrame(sourceTimeMs: number): VideoFrame {
	const sourceCanvas = document.createElement("canvas");
	sourceCanvas.width = videoWidth;
	sourceCanvas.height = videoHeight;
	const context = sourceCanvas.getContext("2d");
	if (!context) throw new Error("Could not create source-frame canvas");
	const phase = Math.floor(sourceTimeMs / 25) % 255;
	context.fillStyle = `rgb(${phase}, ${(phase * 3) % 255}, ${(phase * 7) % 255})`;
	context.fillRect(0, 0, videoWidth, videoHeight);
	context.fillStyle = "#ffffff";
	context.fillRect(4, 5, 19, 11);
	context.fillStyle = "#111111";
	context.fillRect(39, 18, 17, 13);
	return new VideoFrame(sourceCanvas, {
		timestamp: Math.round(sourceTimeMs * 1000),
		duration: Math.round(frameDurationUs),
	});
}

function createRendererConfig() {
	return {
		timelineEffects: true,
		width,
		height,
		preferredRenderBackend: "webgl",
		wallpaper: "#ffffff",
		zoomRegions,
		showShadow: false,
		shadowIntensity: 0,
		backgroundBlur: 0,
		connectZooms: true,
		zoomInDurationMs: 650,
		zoomOutDurationMs: 450,
		connectedZoomGapMs: 500,
		connectedZoomDurationMs: 300,
		borderRadius: 0,
		padding: 0,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		videoWidth,
		videoHeight,
		annotationRegions: [],
		autoCaptions: [],
		cursorTelemetry,
		showCursor: true,
		cursorStyle: "dot",
		cursorSize: 1,
		cursorSmoothing: 0.55,
		zoomSmoothness: 0.5,
	} as never;
}

async function verifyFrameParity(): Promise<number> {
	if (plansResult.plans.length !== 2 || plansResult.skipped.length > 0) {
		throw new Error("Parity fixture plans are invalid");
	}
	const { FrameRenderer } = await import("@/lib/exporter/modernFrameRenderer");
	const referenceRenderer = new FrameRenderer(createRendererConfig());
	const batchRenderer = new FrameRenderer(createRendererConfig());
	const referencePixels = new Map<number, Uint8ClampedArray>();
	const outputPixels: Uint8ClampedArray[][] = [];
	let batchRendererDisposed = false;

	try {
		await referenceRenderer.initialize();
		for (let globalFrame = 0; globalFrame < totalFrames; globalFrame += 1) {
			const timelineMs = (globalFrame / frameRate) * 1000;
			const timelineUs = globalFrame * frameDurationUs;
			const clip = getClipAtTimelineTime(timelineMs);
			if (!clip) {
				await referenceRenderer.renderFrame(
					null,
					timelineUs,
					0,
					frameDurationUs,
					timelineUs,
				);
			} else {
				const sourceMs =
					getClipSourceStartMs(clip) + (timelineMs - clip.startMs) * clip.speed;
				const frame = makeSourceFrame(sourceMs);
				try {
					await referenceRenderer.renderFrame(
						frame,
						Math.round(sourceMs * 1000),
						Math.round(sourceMs * 1000),
						frameDurationUs,
						timelineUs,
					);
				} finally {
					frame.close();
				}
			}

			if (
				plansResult.plans.some(
					(plan) =>
						globalFrame >= plan.firstFrame &&
						globalFrame < plan.firstFrame + plan.frameCount,
				)
			) {
				const pixels = referenceRenderer.capturePixelsForNativeExport();
				if (!pixels) throw new Error("Reference renderer could not read back pixels");
				referencePixels.set(globalFrame, pixels.slice());
			}
		}

		const firstSceneFrame = referencePixels.get(0);
		const laterSceneFrame = referencePixels.get(15);
		if (
			!firstSceneFrame ||
			!laterSceneFrame ||
			firstSceneFrame.every((channel, index) => channel === laterSceneFrame[index])
		) {
			throw new Error("Reference renderer fixture produced no visible frame variation");
		}

		let nextSinkIndex = 0;
		let decoderCancelled = false;
		const ports: ClipBatchRenderPorts = {
			decoder: {
				loadMetadata: async () => ({
					width: videoWidth,
					height: videoHeight,
					hasAudio: false,
				}),
				cancel: () => {
					decoderCancelled = true;
				},
				decodeAll: async (_fps, _trims, _speeds, onFrame) => {
					for (
						let globalFrame = 0;
						globalFrame < totalFrames && !decoderCancelled;
						globalFrame += 1
					) {
						const timelineMs = (globalFrame / frameRate) * 1000;
						const timelineUs = globalFrame * frameDurationUs;
						const clip = getClipAtTimelineTime(timelineMs);
						if (!clip) {
							await onFrame(null, timelineUs, 0, 0);
							continue;
						}
						const sourceMs =
							getClipSourceStartMs(clip) + (timelineMs - clip.startMs) * clip.speed;
						const frame = makeSourceFrame(sourceMs);
						await onFrame(frame, Math.round(sourceMs * 1000), sourceMs, sourceMs);
					}
				},
				destroy: () => {
					decoderCancelled = true;
				},
			},
			renderer: {
				initialize: async () => {
					await batchRenderer.initialize();
				},
				renderFrame: (
					frame,
					sourceTimestampUs,
					cursorTimestampUs,
					durationUs,
					timelineUs,
				) =>
					batchRenderer.renderFrame(
						frame,
						sourceTimestampUs,
						cursorTimestampUs,
						durationUs,
						timelineUs,
					),
				getCanvas: () => batchRenderer.getCanvas(),
				dispose: () => {
					batchRendererDisposed = true;
					batchRenderer.destroy();
				},
			},
			createSink: async ({ maxEncodeQueue: _maxEncodeQueue, isCancelled: _isCancelled }) => {
				const sinkIndex = nextSinkIndex++;
				const frames: Uint8ClampedArray[] = [];
				outputPixels[sinkIndex] = frames;
				const sink: ClipBatchSink = {
					addFrame: async () => {
						const pixels = batchRenderer.capturePixelsForNativeExport();
						if (!pixels) throw new Error("Batch renderer could not read back pixels");
						frames.push(pixels.slice());
					},
					finish: async () => ({ tempFilePath: `parity-${sinkIndex}.mp4` }),
					abort: async () => undefined,
				};
				return sink;
			},
			renderClipAudioWav: async () => null,
			cancelAudio: () => undefined,
			muxClipAudio: async () => ({
				success: false,
				error: "Audio is disabled in this fixture",
			}),
			discardTemp: async () => undefined,
		};
		const result = await new ClipBatchExporter(ports, {
			videoUrl: "fixture://stateful-timeline",
			frameRate,
			clipRegions: clips,
			plans: plansResult.plans,
			outputClipIds: ["second"],
			isCancelled: () => false,
			maxEncodeQueue: 2,
		}).exportBatch();

		if (
			result.cancelled ||
			result.items.map((item) => item.status).join(",") !== "skipped,completed" ||
			outputPixels.length !== 1
		) {
			throw new Error(
				"Retry renderer must replay the completed clip without creating its output",
			);
		}
		let comparedFrames = 0;
		let differingChannels = 0;
		const plan = plansResult.plans[1];
		const output = outputPixels[0] ?? [];
		if (output.length !== plan.frameCount) {
			throw new Error(
				`Clip ${plan.clipIndex} emitted ${output.length}/${plan.frameCount} frames`,
			);
		}
		for (let localFrame = 0; localFrame < plan.frameCount; localFrame += 1) {
			const expected = referencePixels.get(plan.firstFrame + localFrame);
			const actual = output[localFrame];
			if (!expected || !actual || expected.length !== actual.length) {
				throw new Error(`Missing parity frame for clip ${plan.clipIndex}:${localFrame}`);
			}
			for (let channel = 0; channel < expected.length; channel += 1) {
				if (expected[channel] !== actual[channel]) differingChannels += 1;
			}
			comparedFrames += 1;
		}
		if (comparedFrames === 0 || differingChannels > 0) {
			throw new Error(`Pre-encode parity mismatch: ${differingChannels} differing channels`);
		}
		return comparedFrames;
	} finally {
		referenceRenderer.destroy();
		if (!batchRendererDisposed) batchRenderer.destroy();
	}
}

async function verifyAudioOverlaySamples(): Promise<number> {
	const { OfflineAudioProcessor } = await import("@/lib/exporter/offlineAudioProcessor");
	class TestAudioProcessor extends OfflineAudioProcessor {
		scheduleOverlay(
			context: OfflineAudioContext,
			buffer: AudioBuffer,
			region: AudioRegion & { sourceOffsetMs: number },
			durationSec: number,
		) {
			this.scheduleRegionForChunk(context, buffer, region, [], 0, durationSec, true);
		}
	}

	const sampleRate = 8000;
	const sourceSamples = sampleRate * 3;
	const sourceContext = new OfflineAudioContext(1, sourceSamples, sampleRate);
	const sourceBuffer = sourceContext.createBuffer(1, sourceSamples, sampleRate);
	const sourceData = sourceBuffer.getChannelData(0);
	for (let index = 0; index < sourceData.length; index += 1) {
		sourceData[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.5;
	}
	const outputDurationMs = 1500;
	const outputContext = new OfflineAudioContext(
		1,
		Math.round((outputDurationMs / 1000) * sampleRate),
		sampleRate,
	);
	const processor = new TestAudioProcessor();
	processor.scheduleOverlay(
		outputContext,
		sourceBuffer,
		{
			id: "audio-clip",
			startMs: 0,
			endMs: outputDurationMs,
			sourceOffsetMs: 500,
			audioPath: "fixture",
			volume: 1,
		},
		outputDurationMs / 1000,
	);
	const output = await outputContext.startRendering();
	const outputData = output.getChannelData(0);
	const sourceOffsetSamples = Math.round(0.5 * sampleRate);
	let differingSamples = 0;
	for (let index = 0; index < outputData.length; index += 1) {
		if (Math.abs(outputData[index] - sourceData[sourceOffsetSamples + index]) > 0.00001) {
			differingSamples += 1;
		}
	}
	if (differingSamples > 0) {
		throw new Error(
			`Imported audio differs from its source window in ${differingSamples} samples`,
		);
	}
	return outputData.length;
}

function ParityPreview() {
	const [status, setStatus] = useState("Running real renderer parity fixture…");
	useEffect(() => {
		let active = true;
		void Promise.all([verifyFrameParity(), verifyAudioOverlaySamples()]).then(
			([comparedFrames, audioSamples]) => {
				if (active) {
					setStatus(
						`PASS: ${comparedFrames} real pre-encode frames and ${audioSamples} audio samples match`,
					);
				}
			},
			(error) => {
				if (active)
					setStatus(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
			},
		);
		return () => {
			active = false;
		};
	}, []);
	return <p role="status">{status}</p>;
}

createRoot(document.getElementById("root")!).render(<ParityPreview />);
