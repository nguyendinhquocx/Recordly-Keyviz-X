import type { ClipExportPlan } from "@/components/video-editor/export/clipExportPlan";
import type {
	AnnotationRegion,
	AudioRegion,
	AutoCaptionSettings,
	CaptionCue,
	ClipRegion,
	CropRegion,
	CursorStyle,
	CursorTelemetryPoint,
	Padding,
	SourceAudioTrackSettings,
	SpeedRegion,
	TrimRegion,
	WebcamOverlaySettings,
	ZoomMotionBlurTuning,
	ZoomRegion,
	ZoomTransitionEasing,
} from "@/components/video-editor/types";
import {
	ENCODED_H264_COLOR_SPACE_FALLBACK,
	EXPORT_CANVAS_COLOR_SPACE,
} from "./videoColorSpace";
import type { ExportEncodingMode } from "./types";
import {
	getWebCodecsEncodeQueueLimit,
	getWebCodecsKeyFrameInterval,
} from "./exportTuning";
/**
 * Shared-state MP4 batch renderer (Separate-clips mode).
 *
 * The batch keeps ONE decode pass and ONE frame-renderer session for the whole
 * timeline — exactly like a full-timeline export — and only rotates the MP4
 * output sink (encoder + muxer) at clip boundaries on the global frame grid.
 * Raw composited output for frame i is therefore pixel-identical to the
 * corresponding full-timeline render, while each file starts at PTS zero.
 *
 * The renderer is never recreated per clip; recreating it would reset camera
 * springs, cursor smoothing and zoom transitions at boundaries.
 */

export type ClipBatchItemStatus =
	| "completed"
	| "render-error"
	| "write-error"
	| "cancelled"
	| "skipped";

export interface ClipBatchResultItem {
	plan: ClipExportPlan;
	status: ClipBatchItemStatus;
	/** App-managed temp path of the finished MP4 (after audio muxing when present). */
	tempFilePath?: string;
	error?: string;
}

export interface ClipBatchExportResult {
	items: ClipBatchResultItem[];
	cancelled: boolean;
}

export interface ClipBatchRenderPorts {
	/** Streaming decoder over the loaded recording. */
	decoder: {
		loadMetadata: (videoUrl: string) => Promise<{
			width: number;
			height: number;
			hasAudio: boolean;
		}>;
		decodeAll: (
			targetFrameRate: number,
			trimRegions: TrimRegion[] | undefined,
			speedRegions: SpeedRegion[] | undefined,
			onFrame: (
				frame: VideoFrame | null,
				sourceTimestampUs: number,
				sourceTimestampMs: number,
				cursorTimestampMs: number,
			) => Promise<void>,
			clipRegions?: ClipRegion[],
		) => Promise<void>;
		destroy: () => void;
	};
	/** Stateful frame renderer shared across the whole batch. */
	renderer: {
		initialize: () => Promise<void>;
		renderFrame: (
			frame: VideoFrame | null,
			sourceTimestampUs: number,
			cursorTimestampUs: number,
			frameDurationUs: number,
			backgroundTimelineTimestampUs: number,
		) => Promise<void>;
		getCanvas: () => HTMLCanvasElement | OffscreenCanvas;
		dispose: () => void;
	};
	/** Creates one MP4 output sink (encoder + muxer) per clip file. */
	createSink: () => Promise<ClipBatchSink>;
	/** Renders the clip-local edited audio track as a WAV blob, or null when silent. */
	renderClipAudioWav: (plan: ClipExportPlan) => Promise<Blob | null>;
	/** FFmpeg muxing of the clip-local edited track into the video-only temp file. */
	muxClipAudio: (
		videoTempPath: string,
		wav: Blob,
		plan: ClipExportPlan,
	) => Promise<{ success: boolean; tempPath?: string; error?: string }>;
}

export interface ClipBatchSink {
	addFrame: (
		canvas: HTMLCanvasElement | OffscreenCanvas,
		timestampUs: number,
		durationUs: number,
		keyFrame: boolean,
	) => Promise<void>;
	/** Flush encoder and finalize the muxer; resolves the app-managed temp path. */
	finish: () => Promise<{ tempFilePath?: string; error?: string }>;
	/** Best-effort cleanup of an aborted sink (cancel/error path). */
	abort: () => Promise<void>;
}

export interface ClipBatchExporterOptions {
	videoUrl: string;
	frameRate: number;
	clipRegions: ClipRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	plans: ClipExportPlan[];
	audioRegions?: AudioRegion[];
	sourceAudioTrackSettings?: SourceAudioTrackSettings;
	/** Max frames in the WebCodecs encode queue before backpressure waits. */
	maxEncodeQueue?: number;
	isCancelled: () => boolean;
	/** Fired when a clip's output sink is created (rendering starts). */
	onClipStart?: (plan: ClipExportPlan) => void;
	/** Fired when a clip reaches a terminal render state (pre-commit). */
	onClipResult?: (
		plan: ClipExportPlan,
		status: "completed" | "render-error" | "write-error" | "cancelled",
		info?: { outputPath?: string; error?: string },
	) => void;
}

interface ActiveClipSink {
	plan: ClipExportPlan;
	sink: ClipBatchSink;
	localFrameCount: number;
}

/**
 * Serial clip batch renderer. One decode/render session, per-clip MP4 sinks.
 */
export class ClipBatchExporter {
	private ports: ClipBatchRenderPorts;
	private options: ClipBatchExporterOptions;
	private localCancelled = false;

	constructor(ports: ClipBatchRenderPorts, options: ClipBatchExporterOptions) {
		this.ports = ports;
		this.options = options;
	}

	/** Request cancellation; checked before every render/encode step. */
	cancel(): void {
		this.localCancelled = true;
	}

	private isCancelled(): boolean {
		return this.localCancelled || this.options.isCancelled();
	}

	async exportBatch(): Promise<ClipBatchExportResult> {
		const { frameRate } = this.options;
		const plans = [...this.options.plans].sort((a, b) => a.firstFrame - b.firstFrame);
		const items = new Map<string, ClipBatchResultItem>();
		for (const plan of plans) {
			items.set(plan.clipId, { plan, status: "skipped" });
		}
		if (plans.length === 0) {
			return { items: [], cancelled: this.isCancelled() };
		}

		const frameDurationUs = 1_000_000 / frameRate;
		let cancelled = false;
		// Holder object instead of a bare `let`: TS cannot narrow properties
		// across await points mutated inside the decode callback closure.
		const sinkState: { current: ActiveClipSink | null } = { current: null };
		let activeError: string | null = null;
		// Clip whose remaining frames are skipped after a per-clip render error.
		let skipUntilClipId: string | null = null;

		const finishActiveSink = async () => {
			const current = sinkState.current;
			if (!current) return;
			sinkState.current = null;
			if (current.localFrameCount === 0) {
				// A plan whose grid owns no frames produces no file.
				return;
			}
			const finished = await current.sink.finish();
			if (finished.error || !finished.tempFilePath) {
				items.set(current.plan.clipId, {
					plan: current.plan,
					status: "write-error",
					error: finished.error || "Batch output write failed",
				});
				this.options.onClipResult?.(current.plan, "write-error", {
					error: finished.error || "Batch output write failed",
				});
				return;
			}
			items.set(current.plan.clipId, {
				plan: current.plan,
				status: "completed",
				tempFilePath: finished.tempFilePath,
			});
			this.options.onClipResult?.(current.plan, "completed", {
				outputPath: finished.tempFilePath,
			});
		};

		const abortActiveSink = async () => {
			const current = sinkState.current;
			if (!current) return;
			sinkState.current = null;
			items.set(current.plan.clipId, {
				plan: current.plan,
				status: "cancelled",
			});
			this.options.onClipResult?.(current.plan, "cancelled");
			await current.sink.abort().catch(() => undefined);
		};

		const findPlanForGlobalFrame = (globalFrame: number): ClipExportPlan | null => {
			// Plans are timeline-ordered and share the global frame grid.
			for (const plan of plans) {
				if (
					globalFrame >= plan.firstFrame &&
					globalFrame < plan.firstFrame + plan.frameCount
				) {
					return plan;
				}
			}
			return null;
		};

		try {
			await this.ports.decoder.loadMetadata(this.options.videoUrl);
			await this.ports.renderer.initialize();

			const encodeQueueLimit =
				this.options.maxEncodeQueue ??
				getWebCodecsEncodeQueueLimit(frameRate, "balanced");
			const keyFrameInterval = getWebCodecsKeyFrameInterval(frameRate, "balanced");
			let globalFrame = 0;
			let encodeBacklog = 0;

			await this.ports.decoder.decodeAll(
				frameRate,
				this.options.trimRegions,
				this.options.speedRegions,
				async (videoFrame, sourceTimestampUs, _sourceTimestampMs, cursorTimestampMs) => {
					const currentGlobalFrame = globalFrame;
					globalFrame += 1;

					if (videoFrame === null) {
						// Gap frame on the global grid: owned by no clip, never encoded.
						return;
					}
					if (this.isCancelled()) {
						cancelled = true;
						videoFrame.close();
						return;
					}

					const plan = findPlanForGlobalFrame(currentGlobalFrame);
					if (!plan) {
						videoFrame.close();
						return;
					}

					if (skipUntilClipId && skipUntilClipId !== plan.clipId) {
						skipUntilClipId = null;
					}
					if (skipUntilClipId === plan.clipId) {
						// Rest frames of the failed clip are skipped without rendering
						// and without spinning up new sinks.
						videoFrame.close();
						return;
					}
					if (!sinkState.current || sinkState.current.plan.clipId !== plan.clipId) {
						// Rotate the MP4 output sink at the clip boundary. The renderer
						// session continues untouched — camera/cursor/zoom state survives.
						await finishActiveSink();
						if (this.isCancelled()) {
							cancelled = true;
							videoFrame.close();
							return;
						}
						sinkState.current = {
							plan,
							sink: await this.ports.createSink(),
							localFrameCount: 0,
						};
						this.options.onClipStart?.(plan);
					}

					const localFrame = currentGlobalFrame - plan.firstFrame;
					const localTimestampUs = localFrame * frameDurationUs;
					// Per-clip render/encode failure records that clip and continues
					// to later clips; the shared renderer session is never torn down.
					try {
						// Effects evaluate on the ORIGINAL clocks — identical inputs to a
						// full-timeline render at the same global frame.
						await this.ports.renderer.renderFrame(
							videoFrame,
							sourceTimestampUs,
							cursorTimestampMs * 1000,
							frameDurationUs,
							(currentGlobalFrame / frameRate) * 1_000_000,
						);
						videoFrame.close();
						if (this.isCancelled()) {
							cancelled = true;
							return;
						}

						const canvas = this.ports.renderer.getCanvas();
						// Backpressure: wait while the encode queue is saturated.
						while (encodeBacklog >= encodeQueueLimit && !this.isCancelled()) {
							await new Promise((resolve) => setTimeout(resolve, 1));
						}
						if (this.isCancelled()) {
							cancelled = true;
							return;
						}

						const activeSink = sinkState.current;
						if (!activeSink) {
							throw new Error("Batch sink disappeared before encode");
						}
						encodeBacklog += 1;
						await activeSink.sink.addFrame(
							canvas,
							localTimestampUs,
							frameDurationUs,
							// Every file must start on a keyframe; afterwards follow the
							// shared key-frame cadence on the LOCAL index.
							localFrame % Math.max(keyFrameInterval, 1) === 0,
						);
						encodeBacklog -= 1;
						activeSink.localFrameCount += 1;
					} catch (frameError) {
						const failed = sinkState.current;
						if (failed && failed.plan.clipId === plan.clipId) {
							sinkState.current = null;
							skipUntilClipId = plan.clipId;
							items.set(plan.clipId, {
								plan,
								status: "render-error",
								error:
									frameError instanceof Error
										? frameError.message
										: String(frameError),
							});
							this.options.onClipResult?.(plan, "render-error", {
								error:
									frameError instanceof Error
										? frameError.message
										: String(frameError),
							});
							await failed.sink.abort().catch(() => undefined);
						} else {
							throw frameError;
						}
					}
				},
				this.options.clipRegions,
			);

			if (cancelled || this.isCancelled()) {
				cancelled = true;
				await abortActiveSink();
				// Already-finished sinks stay completed; later clips keep "skipped".
			} else {
				await finishActiveSink();
			}
		} catch (error) {
			activeError = error instanceof Error ? error.message : String(error);
			const failed = sinkState.current;
			if (failed) {
				const current = failed;
				sinkState.current = null;
				items.set(current.plan.clipId, {
					plan: current.plan,
					status: "render-error",
					error: activeError,
				});
				await current.sink.abort().catch(() => undefined);
			} else if (items.size > 0) {
				// Session-level failure before any sink was active: every clip that
				// never started is reported as a render error, not a silent skip.
				for (const [clipId, item] of items) {
					if (item.status === "skipped") {
						items.set(clipId, { plan: item.plan, status: "render-error", error: activeError });
					}
				}
			}
		} finally {
			this.ports.renderer.dispose();
			this.ports.decoder.destroy();
		}

		// Attach the clip-local edited audio track to every completed video.
		for (const [clipId, item] of items) {
			if (item.status !== "completed" || !item.tempFilePath) continue;
			if (this.isCancelled()) {
				cancelled = true;
				break;
			}
			try {
				const wav = await this.ports.renderClipAudioWav(item.plan);
				if (!wav) continue;
				const muxed = await this.ports.muxClipAudio(item.tempFilePath, wav, item.plan);
				if (!muxed.success || !muxed.tempPath) {
					items.set(clipId, {
						...item,
						status: "write-error",
						error: muxed.error || "Failed to mux clip audio",
					});
				} else {
					items.set(clipId, { ...item, tempFilePath: muxed.tempPath });
				}
			} catch (error) {
				items.set(clipId, {
					...item,
					status: "write-error",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return {
			items: plans.map((plan) => items.get(plan.clipId)!),
			cancelled,
		};
	}
}

/** Frame-canvas capture identical to the single-export WebCodecs path. */
export function captureBatchVideoFrame(
	canvas: HTMLCanvasElement | OffscreenCanvas,
	timestampUs: number,
	durationUs: number,
): VideoFrame {
	// @ts-expect-error - colorSpace not in TS DOM definitions but works at runtime
	return new VideoFrame(canvas, {
		timestamp: timestampUs,
		duration: durationUs,
		colorSpace: EXPORT_CANVAS_COLOR_SPACE,
	});
}

/**
 * Adapter config for the real (Electron + WebCodecs) batch renderer. Mirrors
 * the single-export render configuration so per-frame composited output stays
 * identical to a full-timeline render.
 */
export interface ClipBatchAdapterConfig {
	videoUrl: string;
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
	codec?: string;
	encodingMode?: ExportEncodingMode;
	clipRegions: ClipRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	backgroundBlur: number;
	zoomMotionBlur?: number;
	zoomMotionBlurTuning?: ZoomMotionBlurTuning;
	connectZooms?: boolean;
	zoomInDurationMs?: number;
	zoomInOverlapMs?: number;
	zoomOutDurationMs?: number;
	connectedZoomGapMs?: number;
	connectedZoomDurationMs?: number;
	zoomInEasing?: ZoomTransitionEasing;
	zoomOutEasing?: ZoomTransitionEasing;
	connectedZoomEasing?: ZoomTransitionEasing;
	borderRadius?: number;
	padding?: Padding | number;
	cropRegion: CropRegion;
	webcam?: WebcamOverlaySettings;
	webcamUrl?: string | null;
	annotationRegions?: AnnotationRegion[];
	/** Full-timeline source-clock cues: shared-state parity with single export. */
	autoCaptions?: CaptionCue[];
	autoCaptionSettings?: AutoCaptionSettings;
	cursorTelemetry?: CursorTelemetryPoint[];
	showCursor?: boolean;
	cursorStyle?: CursorStyle;
	cursorSize?: number;
	cursorSmoothing?: number;
	zoomSmoothness?: number;
	previewWidth?: number;
	previewHeight?: number;
	sourceAudioFallbackPaths?: string[];
	sourceAudioFallbackStartDelayMsByPath?: Record<string, number>;
	/** Whether any audio source exists for the loaded recording. */
	hasAudio: boolean;
}

/**
 * Builds the real render ports: one StreamingVideoDecoder + one
 * ModernFrameRenderer for the whole batch, WebCodecs encoder + MP4 muxer per
 * clip sink, offline-rendered WAV + FFmpeg mux per clip audio track.
 */
export async function createClipBatchRenderPorts(
	config: ClipBatchAdapterConfig,
): Promise<ClipBatchRenderPorts> {
	const { StreamingVideoDecoder } = await import("./streamingDecoder");
	const { FrameRenderer: ModernFrameRenderer } = await import("./modernFrameRenderer");
	const { VideoMuxer } = await import("./muxer");
	const { AudioProcessor } = await import("./audioEncoder");
	const { getOrderedSupportedMp4EncoderCandidates } = await import("./mp4Support");

	const decoder = new StreamingVideoDecoder();
	// The renderer needs the decoded video dimensions for layout, so it is
	// created lazily after metadata is loaded (exportBatch loads first).
	let videoInfo: { width: number; height: number } | null = null;
	let renderer: import("./modernFrameRenderer").FrameRenderer | null = null;
	const getRenderer = () => {
		if (!renderer) {
			throw new Error("Batch renderer not initialized");
		}
		return renderer;
	};
	const createRenderer = () => {
		if (!videoInfo) {
			throw new Error("Batch renderer initialized before metadata");
		}
		const instance = new ModernFrameRenderer({
			timelineEffects: true,
			width: config.width,
			height: config.height,
			preferredRenderBackend: undefined,
			wallpaper: config.wallpaper,
			zoomRegions: config.zoomRegions,
			showShadow: config.showShadow,
			shadowIntensity: config.shadowIntensity,
			backgroundBlur: config.backgroundBlur,
			zoomMotionBlur: config.zoomMotionBlur,
			zoomMotionBlurTuning: config.zoomMotionBlurTuning,
			connectZooms: config.connectZooms,
			zoomInDurationMs: config.zoomInDurationMs,
			zoomInOverlapMs: config.zoomInOverlapMs,
			zoomOutDurationMs: config.zoomOutDurationMs,
			connectedZoomGapMs: config.connectedZoomGapMs,
			connectedZoomDurationMs: config.connectedZoomDurationMs,
			zoomInEasing: config.zoomInEasing,
			zoomOutEasing: config.zoomOutEasing,
			connectedZoomEasing: config.connectedZoomEasing,
			borderRadius: config.borderRadius,
			padding: config.padding,
			cropRegion: config.cropRegion,
			webcam: config.webcam,
			webcamUrl: config.webcamUrl,
			videoWidth: videoInfo.width,
			videoHeight: videoInfo.height,
			annotationRegions: config.annotationRegions,
			// Full-timeline cues keep caption evaluation identical to single export;
			// the source clock windows each clip naturally.
			autoCaptions: config.autoCaptions,
			autoCaptionSettings: config.autoCaptionSettings,
			speedRegions: config.speedRegions,
			previewWidth: config.previewWidth,
			previewHeight: config.previewHeight,
			cursorTelemetry: config.cursorTelemetry,
			showCursor: config.showCursor,
			cursorStyle: config.cursorStyle,
			cursorSize: config.cursorSize,
			cursorSmoothing: config.cursorSmoothing,
			zoomSmoothness: config.zoomSmoothness,
		});
		renderer = instance;
		return instance;
	};

	const muxConfigBase = {
		width: config.width,
		height: config.height,
		frameRate: config.frameRate,
		bitrate: config.bitrate,
		codec: config.codec,
		encodingMode: config.encodingMode,
	};

	return {
		decoder: {
			loadMetadata: async (videoUrl) => {
				const info = await decoder.loadMetadata(videoUrl);
				videoInfo = { width: info.width, height: info.height };
				return { width: info.width, height: info.height, hasAudio: info.hasAudio };
			},
			decodeAll: (frameRate, trimRegions, speedRegions, onFrame, clipRegions) =>
				// One decode pass over the full edited timeline, exactly like a
				// full-timeline export; clip sinks rotate inside the frame callback.
				decoder.decodeAll(
					frameRate,
					trimRegions,
					speedRegions,
					async (frame, sourceTimestampUs, sourceTimestampMs, cursorTimestampMs) =>
						onFrame(frame, sourceTimestampUs, sourceTimestampMs, cursorTimestampMs),
					clipRegions,
				),
			destroy: () => decoder.destroy(),
		},
		renderer: {
			initialize: async () => {
				await createRenderer().initialize();
			},
			renderFrame: (frame, sourceTimestampUs, cursorTimestampUs, frameDurationUs, timelineUs) =>
				getRenderer().renderFrame(frame, sourceTimestampUs, cursorTimestampUs, frameDurationUs, timelineUs),
			getCanvas: () => getRenderer().getCanvas(),
			dispose: () => renderer?.destroy(),
		},
		createSink: async () => {
			const muxer = new VideoMuxer(muxConfigBase, false);
			await muxer.initialize();
			const candidates = getOrderedSupportedMp4EncoderCandidates({
				codec: config.codec,
			});
			let resolvedCodec: string | null = null;
			let description: Uint8Array | undefined;
			let colorSpace: VideoColorSpaceInit | undefined;
			let chunkCount = 0;
			let muxError: Error | null = null;
			let pendingMuxing = Promise.resolve();

			const encoder = new VideoEncoder({
				output: (chunk, meta) => {
					if (meta?.decoderConfig?.description && !description) {
						const desc = meta.decoderConfig.description;
						description = ArrayBuffer.isView(desc)
							? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
							: new Uint8Array(desc);
					}
					if (meta?.decoderConfig?.colorSpace && !colorSpace) {
						colorSpace = meta.decoderConfig.colorSpace;
					}
					const isFirstChunk = chunkCount === 0;
					chunkCount += 1;
					pendingMuxing = pendingMuxing
						.then(async () => {
							if (isFirstChunk && description) {
								await muxer.addVideoChunk(chunk, {
									decoderConfig: {
										codec: resolvedCodec ?? config.codec ?? "avc1.640033",
										codedWidth: config.width,
										codedHeight: config.height,
										description,
										colorSpace:
											colorSpace ?? ENCODED_H264_COLOR_SPACE_FALLBACK,
									},
								});
							} else {
								await muxer.addVideoChunk(chunk, meta);
							}
						})
						.catch((error) => {
							muxError = error instanceof Error ? error : new Error(String(error));
						});
				},
				error: (error) => {
					muxError = error instanceof Error ? error : new Error(String(error));
				},
			});

			let configured = false;
			for (const candidate of candidates) {
				const encoderConfig: VideoEncoderConfig = {
					width: config.width,
					height: config.height,
					bitrate: config.bitrate,
					framerate: config.frameRate,
					bitrateMode: "variable",
					codec: candidate.codec,
					hardwareAcceleration: candidate.hardwareAcceleration,
					latencyMode: "quality",
				};
				const support = await VideoEncoder.isConfigSupported(encoderConfig);
				if (support.supported) {
					resolvedCodec = candidate.codec;
					encoder.configure(encoderConfig);
					configured = true;
					break;
				}
			}
			if (!configured) {
				throw new Error("No supported WebCodecs H.264 encoder for batch export");
			}

			return {
				addFrame: async (canvas, timestampUs, durationUs, keyFrame) => {
					if (muxError) throw muxError;
					const frame = captureBatchVideoFrame(canvas, timestampUs, durationUs);
					try {
						encoder.encode(frame, { keyFrame });
					} finally {
						frame.close();
					}
				},
				finish: async () => {
					if (encoder.state === "configured") {
						await encoder.flush();
					}
					await pendingMuxing;
					if (muxError) return { error: muxError.message };
					const result = await muxer.finalize();
					return result.mode === "stream"
						? { tempFilePath: result.tempFilePath }
						: { error: "Batch export requires the Electron stream target" };
				},
				abort: async () => {
					try {
						if (encoder.state === "configured") encoder.close();
					} catch {
						/* best-effort */
					}
					try {
						await muxer.abortStream();
					} finally {
						muxer.destroy();
					}
				},
			};
		},
		renderClipAudioWav: async (plan) => {
			if (!config.hasAudio) return null;
			const audioProcessor = new AudioProcessor();
			// Rebase the clip and its imported overlays onto a clip-local timeline:
			// the clip plays from output zero, overlays keep their file offsets.
			const localClip: ClipRegion = {
				id: plan.clipId,
				startMs: 0,
				endMs: Math.max(1, Math.round(plan.timelineEndMs - plan.timelineStartMs)),
				sourceStartMs: plan.sourceStartMs,
				speed: plan.speed,
				...(plan.muted ? { muted: true } : {}),
			};
			const localAudioRegions: AudioRegion[] = plan.audioOverlays.map((overlay) => ({
				id: overlay.regionId,
				startMs: overlay.outputStartMs,
				endMs: overlay.outputEndMs,
				audioPath: overlay.audioPath,
				volume: overlay.volume,
				...(overlay.normalize === undefined ? {} : { normalize: overlay.normalize }),
				...(overlay.trackIndex === undefined ? {} : { trackIndex: overlay.trackIndex }),
			}));
			return audioProcessor.renderEditedAudioTrack(
				config.videoUrl,
				undefined,
				undefined,
				localAudioRegions,
				config.sourceAudioFallbackPaths ?? [],
				config.sourceAudioFallbackStartDelayMsByPath,
				plan.sourceAudioTrackSettings,
				[localClip],
			);
		},
		muxClipAudio: async (videoTempPath, wav, plan) => {
			if (typeof window === "undefined" || !window.electronAPI?.muxExportedVideoAudioFromPath) {
				return { success: false, error: "FFmpeg audio muxing is unavailable" };
			}
			const editedAudioData = await wav.arrayBuffer();
			const result = await window.electronAPI.muxExportedVideoAudioFromPath(
				videoTempPath,
				{
					audioMode: "edited-track",
					audioSourcePath: null,
					editedTrackStrategy: "offline-render-fallback",
					outputDurationSec: plan.outputDurationMs / 1000,
					editedAudioData,
					editedAudioMimeType: wav.type || "audio/wav",
				},
			);
			if (!result.success || !result.tempPath) {
				return { success: false, error: result.error || "Failed to mux clip audio" };
			}
			return { success: true, tempPath: result.tempPath };
		},
	};
}
