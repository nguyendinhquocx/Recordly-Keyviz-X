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
import { ENCODED_H264_COLOR_SPACE_FALLBACK, EXPORT_CANVAS_COLOR_SPACE } from "./videoColorSpace";
import type { ExportEncodingMode } from "./types";
import { getWebCodecsEncodeQueueLimit, getWebCodecsKeyFrameInterval } from "./exportTuning";
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
		cancel: () => void;
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
	createSink: (options: {
		maxEncodeQueue: number;
		isCancelled: () => boolean;
	}) => Promise<ClipBatchSink>;
	/** Renders clip-local edited audio as WAV, or null when no audio source exists. */
	renderClipAudioWav: (plan: ClipExportPlan, hasEmbeddedAudio: boolean) => Promise<Blob | null>;
	/** Interrupts the currently active offline audio renderer, if any. */
	cancelAudio: () => void;
	/** FFmpeg muxing of the clip-local edited track into the video-only temp file. */
	muxClipAudio: (
		videoTempPath: string,
		wav: Blob,
		plan: ClipExportPlan,
	) => Promise<{ success: boolean; tempPath?: string; error?: string }>;
	discardTemp: (tempPath: string) => Promise<void>;
}

export interface ClipBatchSink {
	addFrame: (
		canvas: HTMLCanvasElement | OffscreenCanvas,
		timestampUs: number,
		durationUs: number,
		keyFrame: boolean,
	) => Promise<void>;
	/** Flush encoder and finalize the muxer; resolves the app-managed temp path. */
	finish: () => Promise<{
		tempFilePath?: string;
		error?: string;
		errorKind?: "render" | "write";
	}>;
	/** Best-effort cleanup of an aborted sink (cancel/error path). */
	abort: () => Promise<void>;
}

export class ClipBatchSinkWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClipBatchSinkWriteError";
	}
}

/** Close resources if sink creation fails after the main-process stream opens. */
export async function cleanupFailedClipBatchSinkInitialization(
	muxer: { abortStream: () => Promise<void>; destroy: () => void },
	encoder: { state: string; close: () => void } | null,
): Promise<void> {
	try {
		if (encoder && encoder.state !== "closed") encoder.close();
	} catch {
		/* best-effort */
	}
	try {
		await muxer.abortStream();
	} catch {
		/* best-effort */
	}
	muxer.destroy();
}

export interface ClipBatchExporterOptions {
	videoUrl: string;
	frameRate: number;
	clipRegions: ClipRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	plans: ClipExportPlan[];
	/** Only these plans create output sinks; preceding plans may replay state. */
	outputClipIds?: string[];
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
		this.ports.decoder.cancel();
		this.ports.cancelAudio();
	}

	private isCancelled(): boolean {
		return this.localCancelled || this.options.isCancelled();
	}

	async exportBatch(): Promise<ClipBatchExportResult> {
		const { frameRate } = this.options;
		const plans = [...this.options.plans].sort((a, b) => a.firstFrame - b.firstFrame);
		const outputClipIds = new Set(
			this.options.outputClipIds ?? plans.map((plan) => plan.clipId),
		);
		const items = new Map<string, ClipBatchResultItem>();
		for (const plan of plans) {
			items.set(plan.clipId, { plan, status: "skipped" });
		}
		if (plans.length === 0) {
			return { items: [], cancelled: this.isCancelled() };
		}
		if (this.isCancelled()) {
			return {
				items: plans.map((plan) => ({ plan, status: "cancelled" as const })),
				cancelled: true,
			};
		}

		const frameDurationUs = 1_000_000 / frameRate;
		let cancelled = false;
		// Holder object instead of a bare `let`: TS cannot narrow properties
		// across await points mutated inside the decode callback closure.
		const sinkState: { current: ActiveClipSink | null } = { current: null };
		let activeError: string | null = null;
		let stopAfterWriteFailure = false;
		let writeFailureMessage = "Batch output could not be written";
		// Clip whose remaining frames are skipped after a per-clip render error.
		let skipUntilClipId: string | null = null;

		const finishActiveSink = async () => {
			const current = sinkState.current;
			if (!current) return;
			sinkState.current = null;
			if (current.localFrameCount === 0) {
				// A plan whose grid owns no frames (clip shorter than one output
				// frame) produces no file — surface it instead of swallowing it.
				const message = "Clip is shorter than one output frame at this FPS";
				items.set(current.plan.clipId, {
					plan: current.plan,
					status: "render-error",
					error: message,
				});
				this.options.onClipResult?.(current.plan, "render-error", { error: message });
				await current.sink.abort().catch(() => undefined);
				return;
			}
			const finished = await current.sink.finish();
			if (finished.error || !finished.tempFilePath) {
				const message = finished.error || "Batch output write failed";
				const status = finished.errorKind === "render" ? "render-error" : "write-error";
				items.set(current.plan.clipId, { plan: current.plan, status, error: message });
				this.options.onClipResult?.(current.plan, status, { error: message });
				await current.sink.abort().catch(() => undefined);
				if (status === "write-error") {
					stopAfterWriteFailure = true;
					writeFailureMessage = message;
					this.ports.decoder.cancel();
				}
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

		let hasEmbeddedAudio = false;
		try {
			const mediaInfo = await this.ports.decoder.loadMetadata(this.options.videoUrl);
			hasEmbeddedAudio = mediaInfo.hasAudio;
			if (this.isCancelled()) {
				cancelled = true;
				for (const [clipId, item] of items) {
					items.set(clipId, { plan: item.plan, status: "cancelled" });
				}
			} else {
				await this.ports.renderer.initialize();
			}
			if (cancelled || this.isCancelled()) {
				cancelled = true;
				return { items: plans.map((plan) => items.get(plan.clipId)!), cancelled: true };
			}

			const encodeQueueLimit =
				this.options.maxEncodeQueue ?? getWebCodecsEncodeQueueLimit(frameRate, "balanced");
			const keyFrameInterval = getWebCodecsKeyFrameInterval(frameRate, "balanced");
			let globalFrame = 0;

			await this.ports.decoder.decodeAll(
				frameRate,
				this.options.trimRegions,
				this.options.speedRegions,
				async (videoFrame, sourceTimestampUs, _sourceTimestampMs, cursorTimestampMs) => {
					const currentGlobalFrame = globalFrame;
					globalFrame += 1;

					if (this.isCancelled()) {
						cancelled = true;
						videoFrame?.close();
						return;
					}
					if (stopAfterWriteFailure) {
						videoFrame?.close();
						return;
					}
					if (videoFrame === null) {
						// Gap frame on the global grid: owned by no clip, never encoded.
						// It still advances the shared renderer state exactly like a
						// full-timeline export does, so a clip starting after a gap
						// begins from the same camera/cursor state.
						await this.ports.renderer.renderFrame(
							null,
							(currentGlobalFrame / frameRate) * 1_000_000,
							0,
							frameDurationUs,
							(currentGlobalFrame / frameRate) * 1_000_000,
						);
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
						// Don't encode the failed clip's remaining frames, but keep advancing
						// stateful zoom/cursor render state for the next clip.
						try {
							await this.ports.renderer.renderFrame(
								videoFrame,
								sourceTimestampUs,
								cursorTimestampMs * 1000,
								frameDurationUs,
								(currentGlobalFrame / frameRate) * 1_000_000,
							);
						} finally {
							videoFrame.close();
						}
						return;
					}

					if (!outputClipIds.has(plan.clipId)) {
						// Retried batches replay completed/intervening clips to restore the
						// original stateful renderer, but never create sinks for them.
						try {
							if (sinkState.current) await finishActiveSink();
							if (stopAfterWriteFailure) return;
							if (this.isCancelled()) {
								cancelled = true;
								return;
							}
							await this.ports.renderer.renderFrame(
								videoFrame,
								sourceTimestampUs,
								cursorTimestampMs * 1000,
								frameDurationUs,
								(currentGlobalFrame / frameRate) * 1_000_000,
							);
							if (this.isCancelled()) cancelled = true;
						} finally {
							videoFrame.close();
						}
						return;
					}

					if (!sinkState.current || sinkState.current.plan.clipId !== plan.clipId) {
						// Rotate the MP4 output sink at the clip boundary. The renderer
						// session continues untouched — camera/cursor/zoom state survives.
						try {
							await finishActiveSink();
							if (stopAfterWriteFailure) {
								videoFrame.close();
								return;
							}
							if (this.isCancelled()) {
								cancelled = true;
								videoFrame.close();
								return;
							}
							sinkState.current = {
								plan,
								sink: await this.ports.createSink({
									maxEncodeQueue: encodeQueueLimit,
									isCancelled: () => this.isCancelled(),
								}),
								localFrameCount: 0,
							};
							if (this.isCancelled()) {
								cancelled = true;
								videoFrame.close();
								await abortActiveSink();
								return;
							}
						} catch (rotationError) {
							videoFrame.close();
							const message =
								rotationError instanceof Error
									? rotationError.message
									: String(rotationError);
							if (this.isCancelled()) {
								cancelled = true;
								items.set(plan.clipId, { plan, status: "cancelled" });
								this.options.onClipResult?.(plan, "cancelled");
								await abortActiveSink();
								return;
							}
							if (rotationError instanceof ClipBatchSinkWriteError) {
								stopAfterWriteFailure = true;
								writeFailureMessage = message;
								items.set(plan.clipId, {
									plan,
									status: "write-error",
									error: message,
								});
								this.options.onClipResult?.(plan, "write-error", {
									error: message,
								});
								this.ports.decoder.cancel();
							} else {
								items.set(plan.clipId, {
									plan,
									status: "render-error",
									error: message,
								});
								this.options.onClipResult?.(plan, "render-error", {
									error: message,
								});
								skipUntilClipId = plan.clipId;
							}
							return;
						}
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

						const activeSink = sinkState.current;
						if (!activeSink) {
							throw new Error("Batch sink disappeared before encode");
						}
						// The real sink enforces backpressure against its actual WebCodecs
						// queue and pending mux writes, not this call stack.
						await activeSink.sink.addFrame(
							this.ports.renderer.getCanvas(),
							localTimestampUs,
							frameDurationUs,
							localFrame % Math.max(keyFrameInterval, 1) === 0,
						);
						activeSink.localFrameCount += 1;
					} catch (frameError) {
						const failed = sinkState.current;
						if (failed && failed.plan.clipId === plan.clipId) {
							sinkState.current = null;
							const message =
								frameError instanceof Error
									? frameError.message
									: String(frameError);
							if (this.isCancelled()) {
								cancelled = true;
								items.set(plan.clipId, { plan, status: "cancelled" });
								this.options.onClipResult?.(plan, "cancelled");
							} else if (frameError instanceof ClipBatchSinkWriteError) {
								stopAfterWriteFailure = true;
								writeFailureMessage = message;
								items.set(plan.clipId, {
									plan,
									status: "write-error",
									error: message,
								});
								this.options.onClipResult?.(plan, "write-error", {
									error: message,
								});
								this.ports.decoder.cancel();
							} else {
								skipUntilClipId = plan.clipId;
								items.set(plan.clipId, {
									plan,
									status: "render-error",
									error: message,
								});
								this.options.onClipResult?.(plan, "render-error", {
									error: message,
								});
							}
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
			if (!stopAfterWriteFailure) {
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
					// Session-level render failure: clips that never started are failed,
					// not silently reported as a successful partial batch.
					for (const [clipId, item] of items) {
						if (item.status === "skipped") {
							items.set(clipId, {
								plan: item.plan,
								status: "render-error",
								error: activeError,
							});
						}
					}
				}
			}
		} finally {
			this.ports.renderer.dispose();
			this.ports.decoder.destroy();
		}

		if (stopAfterWriteFailure && !cancelled && !this.isCancelled()) {
			for (const [clipId, item] of items) {
				if (item.status === "skipped") {
					items.set(clipId, {
						plan: item.plan,
						status: "write-error",
						error: writeFailureMessage,
					});
				}
			}
		}

		// Attach the clip-local edited audio track to every completed video.
		for (const [clipId, item] of items) {
			if (item.status !== "completed" || !item.tempFilePath) continue;
			if (this.isCancelled()) {
				cancelled = true;
				break;
			}
			try {
				const wav = await this.ports.renderClipAudioWav(item.plan, hasEmbeddedAudio);
				if (this.isCancelled()) {
					cancelled = true;
					await this.ports.discardTemp(item.tempFilePath).catch(() => undefined);
					items.set(clipId, { plan: item.plan, status: "cancelled" });
					continue;
				}
				if (!wav) continue;
				const muxed = await this.ports.muxClipAudio(item.tempFilePath, wav, item.plan);
				if (this.isCancelled()) {
					cancelled = true;
					await this.ports.discardTemp(item.tempFilePath).catch(() => undefined);
					if (muxed.tempPath)
						await this.ports.discardTemp(muxed.tempPath).catch(() => undefined);
					items.set(clipId, { plan: item.plan, status: "cancelled" });
					continue;
				}
				if (!muxed.success || !muxed.tempPath) {
					// The video-only temp lacks edited audio; discard it instead of
					// accidentally publishing a silent/incomplete file.
					await this.ports.discardTemp(item.tempFilePath).catch(() => undefined);
					items.set(clipId, {
						plan: item.plan,
						status: "render-error",
						error: muxed.error || "Failed to mux clip audio",
					});
				} else {
					// FFmpeg returns a new managed temp. Remove the video-only source.
					await this.ports.discardTemp(item.tempFilePath).catch(() => undefined);
					items.set(clipId, { ...item, tempFilePath: muxed.tempPath });
				}
			} catch (error) {
				await this.ports.discardTemp(item.tempFilePath).catch(() => undefined);
				if (this.isCancelled()) {
					cancelled = true;
					items.set(clipId, { plan: item.plan, status: "cancelled" });
				} else {
					items.set(clipId, {
						plan: item.plan,
						status: "render-error",
						error: error instanceof Error ? error.message : String(error),
					});
				}
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
 * Rebase a plan's imported audio overlays onto the clip-local timeline while
 * keeping their original file positions. Output placement stays in clip-local
 * time; `sourceOffsetMs` separately tells the offline renderer where to begin
 * reading the imported file so a clipped overlay never restarts at zero.
 */
type ClipLocalAudioRegion = AudioRegion & { sourceOffsetMs: number };

export function shouldRenderClipAudio(
	hasEmbeddedAudio: boolean,
	sourceAudioFallbackPaths: string[] | undefined,
	plan: ClipExportPlan,
): boolean {
	return (
		hasEmbeddedAudio ||
		(sourceAudioFallbackPaths?.length ?? 0) > 0 ||
		plan.audioOverlays.length > 0
	);
}

export function buildClipLocalAudioRegions(plan: ClipExportPlan): ClipLocalAudioRegion[] {
	return plan.audioOverlays.map((overlay) => ({
		id: overlay.regionId,
		// Placement remains the exact clip-local overlap. The separate file
		// offset tells OfflineAudioProcessor where to start reading the buffer.
		startMs: overlay.outputStartMs,
		endMs: overlay.outputEndMs,
		sourceOffsetMs: overlay.sourceOffsetMs,
		audioPath: overlay.audioPath,
		volume: overlay.volume,
		...(overlay.normalize === undefined ? {} : { normalize: overlay.normalize }),
		...(overlay.trackIndex === undefined ? {} : { trackIndex: overlay.trackIndex }),
	}));
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
	let activeAudioProcessor: InstanceType<typeof AudioProcessor> | null = null;
	// The renderer needs decoded dimensions; audio routing also depends on the
	// recording's actual streams, not the editor's selected source-audio state.
	let videoInfo: { width: number; height: number; hasAudio: boolean } | null = null;
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
				videoInfo = { width: info.width, height: info.height, hasAudio: info.hasAudio };
				return { width: info.width, height: info.height, hasAudio: info.hasAudio };
			},
			cancel: () => decoder.cancel(),
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
			renderFrame: (
				frame,
				sourceTimestampUs,
				cursorTimestampUs,
				frameDurationUs,
				timelineUs,
			) =>
				getRenderer().renderFrame(
					frame,
					sourceTimestampUs,
					cursorTimestampUs,
					frameDurationUs,
					timelineUs,
				),
			getCanvas: () => getRenderer().getCanvas(),
			dispose: () => renderer?.destroy(),
		},
		createSink: async ({ maxEncodeQueue, isCancelled }) => {
			const muxer = new VideoMuxer(muxConfigBase, false);
			try {
				await muxer.initialize();
			} catch (error) {
				await cleanupFailedClipBatchSinkInitialization(muxer, null);
				throw new ClipBatchSinkWriteError(
					error instanceof Error ? error.message : String(error),
				);
			}
			let createdEncoder: VideoEncoder | null = null;
			try {
				const candidates = getOrderedSupportedMp4EncoderCandidates({
					codec: config.codec,
				});
				let resolvedCodec: string | null = null;
				let description: Uint8Array | undefined;
				let colorSpace: VideoColorSpaceInit | undefined;
				let chunkCount = 0;
				let muxError: Error | null = null;
				let encoderError: Error | null = null;
				let queuedFrames = 0;
				let pendingMuxChunks = 0;
				let pendingMuxing = Promise.resolve();
				const queueLimit = Math.max(1, Math.floor(maxEncodeQueue));

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
						queuedFrames = Math.max(0, queuedFrames - 1);
						pendingMuxChunks += 1;
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
								muxError =
									error instanceof Error ? error : new Error(String(error));
							})
							.finally(() => {
								pendingMuxChunks = Math.max(0, pendingMuxChunks - 1);
							});
					},
					error: (error) => {
						encoderError = error instanceof Error ? error : new Error(String(error));
					},
				});
				createdEncoder = encoder;

				const waitForEncodeCapacity = async () => {
					while (
						!isCancelled() &&
						!muxError &&
						!encoderError &&
						Math.max(encoder.encodeQueueSize, queuedFrames, pendingMuxChunks) >=
							queueLimit
					) {
						// Poll while saturated so cancellation can wake an encoder with no
						// further dequeue callback pending.
						await new Promise((resolve) => setTimeout(resolve, 1));
					}
					if (isCancelled()) throw new Error("Batch export cancelled");
					if (muxError) throw new ClipBatchSinkWriteError(muxError.message);
					if (encoderError) throw encoderError;
				};

				let configured = false;
				for (const candidate of candidates) {
					if (isCancelled()) throw new Error("Batch export cancelled");
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
				if (isCancelled()) throw new Error("Batch export cancelled");
				if (!configured) {
					throw new Error("No supported WebCodecs H.264 encoder for batch export");
				}

				return {
					addFrame: async (canvas, timestampUs, durationUs, keyFrame) => {
						await waitForEncodeCapacity();
						const frame = captureBatchVideoFrame(canvas, timestampUs, durationUs);
						queuedFrames += 1;
						try {
							encoder.encode(frame, { keyFrame });
						} catch (error) {
							queuedFrames = Math.max(0, queuedFrames - 1);
							throw error;
						} finally {
							frame.close();
						}
					},
					finish: async () => {
						try {
							if (encoder.state === "configured") {
								await encoder.flush();
							}
							await pendingMuxing;
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							return {
								error: message,
								errorKind: encoderError ? ("render" as const) : ("write" as const),
							};
						}
						if (encoderError)
							return { error: encoderError.message, errorKind: "render" as const };
						if (muxError)
							return { error: muxError.message, errorKind: "write" as const };
						try {
							const result = await muxer.finalize();
							return result.mode === "stream"
								? { tempFilePath: result.tempFilePath }
								: {
										error: "Batch export requires the Electron stream target",
										errorKind: "write" as const,
									};
						} catch (error) {
							return {
								error: error instanceof Error ? error.message : String(error),
								errorKind: "write" as const,
							};
						}
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
			} catch (error) {
				await cleanupFailedClipBatchSinkInitialization(muxer, createdEncoder);
				throw error;
			}
		},
		renderClipAudioWav: async (plan, hasEmbeddedAudio) => {
			if (!shouldRenderClipAudio(hasEmbeddedAudio, config.sourceAudioFallbackPaths, plan)) {
				return null;
			}
			const audioProcessor = new AudioProcessor();
			activeAudioProcessor = audioProcessor;
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
			const localAudioRegions = buildClipLocalAudioRegions(plan);
			try {
				return await audioProcessor.renderEditedAudioTrack(
					config.videoUrl,
					undefined,
					undefined,
					localAudioRegions,
					config.sourceAudioFallbackPaths ?? [],
					config.sourceAudioFallbackStartDelayMsByPath,
					plan.sourceAudioTrackSettings,
					[localClip],
				);
			} finally {
				if (activeAudioProcessor === audioProcessor) activeAudioProcessor = null;
			}
		},
		cancelAudio: () => activeAudioProcessor?.cancel(),
		muxClipAudio: async (videoTempPath, wav, plan) => {
			if (
				typeof window === "undefined" ||
				!window.electronAPI?.muxExportedVideoAudioFromPath
			) {
				return { success: false, error: "FFmpeg audio muxing is unavailable" };
			}
			const editedAudioData = await wav.arrayBuffer();
			const result = await window.electronAPI.muxExportedVideoAudioFromPath(videoTempPath, {
				audioMode: "edited-track",
				audioSourcePath: null,
				editedTrackStrategy: "offline-render-fallback",
				outputDurationSec: plan.outputDurationMs / 1000,
				editedAudioData,
				editedAudioMimeType: wav.type || "audio/wav",
			});
			if (!result.success || !result.tempPath) {
				return { success: false, error: result.error || "Failed to mux clip audio" };
			}
			return { success: true, tempPath: result.tempPath };
		},
		discardTemp: async (tempPath) => {
			await window.electronAPI?.discardExportedTemp?.(tempPath);
		},
	};
}
