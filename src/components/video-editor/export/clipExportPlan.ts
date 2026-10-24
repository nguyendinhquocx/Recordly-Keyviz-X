import type { SourceAudioTrackSettings } from "@/components/video-editor/audio/audioTypes";
import type {
	AnnotationRegion,
	AudioRegion,
	CaptionCue,
	ClipRegion,
	WebcamOverlaySettings,
	ZoomRegion,
} from "@/components/video-editor/types";
import {
	DEFAULT_CONNECTED_ZOOM_DURATION_MS,
	DEFAULT_CONNECTED_ZOOM_GAP_MS,
	DEFAULT_ZOOM_IN_DURATION_MS,
	DEFAULT_ZOOM_OUT_DURATION_MS,
	getClipSourceEndMs,
	getClipSourceStartMs,
	sortClipRegions,
} from "@/components/video-editor/types";

/**
 * Pure per-clip export plan for Separate-clips batch export.
 *
 * Clock contract (see SPEC time-base table):
 * - Timeline clip c: T0 = c.startMs, T1 = c.endMs, S0 = source in-point,
 *   S1 = source out-point. For sampled original timeline time T,
 *   U = T - T0 (clip-local output time) and S = S0 + U * c.speed.
 * - Frame grid follows the global output grid: firstFrame = ceil(T0 * fps),
 *   endFrame = ceil(T1 * fps). Output frame i samples original timeline
 *   frame T = (firstFrame + i) / fps and muxes with clip-local PTS i / fps.
 *   Frame counts are never recomputed from ceil((T1 - T0) * fps) — that would
 *   drift on fractional-frame cuts.
 * - Cursor/caption/webcam stay on the source clock (S). Zoom, annotations,
 *   wallpaper and imported overlays stay on the edited timeline clock (T).
 * - Sidecar cues are projected into clip-local output time U in [0, duration].
 */

export type ClipExportSkipReason = "invalid-bounds" | "invalid-speed" | "outside-source";

export interface ClipExportSkipEntry {
	clipId: string;
	/** 1-based ordinal in the timeline-ordered clip list. */
	clipIndex: number;
	reason: ClipExportSkipReason;
}

export interface ClipExportPlanAudioOverlay {
	regionId: string;
	audioPath: string;
	volume: number;
	normalize?: boolean;
	trackIndex?: number;
	/** Clip-local output placement U. */
	outputStartMs: number;
	outputEndMs: number;
	/**
	 * Offset into the audio file where this clip starts consuming it
	 * (overlapStart - region.startMs). A region that started before the clip
	 * must not restart its file at offset zero.
	 */
	sourceOffsetMs: number;
}

export interface ClipExportSidecarCue {
	startMs: number;
	endMs: number;
	text: string;
}

export interface ClipExportPlan {
	clipId: string;
	/** 1-based timeline ordinal (used for `clip-01` naming). */
	clipIndex: number;
	speed: number;
	/** Edited timeline bounds T0/T1. */
	timelineStartMs: number;
	timelineEndMs: number;
	/** Source-recording bounds S0/S1. */
	sourceStartMs: number;
	sourceEndMs: number;
	fps: number;
	/** Global output frame grid position for this clip. */
	firstFrame: number;
	frameCount: number;
	/** Frame-grid output duration (frameCount / fps). */
	outputDurationMs: number;
	/** Mutes source audio only; imported overlays stay unaffected. */
	muted: boolean;
	sourceAudioTrackSettings: SourceAudioTrackSettings;
	/** Original timeline-clock zoom regions, including connected-transition context. */
	zoomRegions: ZoomRegion[];
	/** Original timeline-clock annotation regions overlapping the clip. */
	annotationRegions: AnnotationRegion[];
	/** Visual captions kept on the renderer's source clock. */
	captionCues: CaptionCue[];
	/** Per-clip sidecar cues in clip-local output time [0, outputDurationMs]. */
	sidecarCues: ClipExportSidecarCue[];
	/** Imported audio overlays sliced to the clip with preserved file offsets. */
	audioOverlays: ClipExportPlanAudioOverlay[];
	/** Webcam settings pass through untouched (source-time visibleRanges/offset). */
	webcam: WebcamOverlaySettings | null;
	/** Global frame index -> original timeline time T in ms. */
	frameIndexToTimelineMs: (frameIndex: number) => number;
	/** Original timeline time T in ms -> source time S in ms. */
	timelineMsToSourceMs: (timelineMs: number) => number;
	/** Global frame index -> source time S in ms. */
	frameIndexToSourceMs: (frameIndex: number) => number;
	/** Global frame index -> clip-local output time U in ms (per-file PTS base). */
	frameIndexToOutputMs: (frameIndex: number) => number;
}

export interface BuildClipExportPlansInput {
	clips: ClipRegion[];
	/** Loaded recording duration in ms; source intervals must fit inside it. */
	sourceDurationMs: number;
	fps: number;
	zoomRegions?: ZoomRegion[];
	/**
	 * How far a zoom region's transition can reach past its own bounds.
	 * Regions are never cropped away when their transition touches the clip.
	 */
	zoomContextMs?: number;
	annotationRegions?: AnnotationRegion[];
	autoCaptions?: CaptionCue[];
	audioRegions?: AudioRegion[];
	getSourceAudioTrackSettingsForClip?: (clipId: string) => SourceAudioTrackSettings;
	webcam?: WebcamOverlaySettings | null;
}

export interface BuildClipExportPlansResult {
	plans: ClipExportPlan[];
	skipped: ClipExportSkipEntry[];
}

function safeFps(fps: number): number {
	return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function isFiniteNumber(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function getClipValidity(clip: ClipRegion, sourceDurationMs: number): ClipExportSkipReason | null {
	const { startMs, endMs } = clip;
	if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs) || endMs <= startMs) {
		return "invalid-bounds";
	}
	if (!isFiniteNumber(clip.speed) || clip.speed <= 0) {
		return "invalid-speed";
	}
	const S0 = getClipSourceStartMs(clip);
	const S1 = getClipSourceEndMs(clip);
	if (!isFiniteNumber(S0) || !isFiniteNumber(S1) || S1 <= S0) {
		return "invalid-bounds";
	}
	const minMs = Math.max(0, isFiniteNumber(clip.sourceMinMs) ? clip.sourceMinMs : 0);
	const maxMs = Math.min(
		Math.max(0, sourceDurationMs),
		isFiniteNumber(clip.sourceMaxMs) ? clip.sourceMaxMs : Number.POSITIVE_INFINITY,
	);
	if (S0 < minMs || S1 > maxMs) {
		return "outside-source";
	}
	return null;
}

function getDefaultZoomContextMs(): number {
	return (
		Math.max(DEFAULT_ZOOM_IN_DURATION_MS, DEFAULT_ZOOM_OUT_DURATION_MS) +
		DEFAULT_CONNECTED_ZOOM_GAP_MS +
		DEFAULT_CONNECTED_ZOOM_DURATION_MS
	);
}

/**
 * Select zoom regions whose transition state can affect frames inside the
 * clip. Regions are selected, never mutated: evaluation stays on the original
 * timeline clock, so an adjacent connected pair must survive selection when
 * its transition reaches into the clip.
 */
function selectZoomRegionsForClip(
	zoomRegions: ZoomRegion[],
	T0: number,
	T1: number,
	contextMs: number,
): ZoomRegion[] {
	return zoomRegions.filter(
		(region) =>
			Number.isFinite(region.startMs) &&
			Number.isFinite(region.endMs) &&
			region.endMs + contextMs > T0 &&
			region.startMs - contextMs < T1,
	);
}

function selectAnnotationsForClip(
	annotationRegions: AnnotationRegion[],
	T0: number,
	T1: number,
): AnnotationRegion[] {
	return annotationRegions.filter(
		(region) =>
			Number.isFinite(region.startMs) &&
			Number.isFinite(region.endMs) &&
			region.endMs > T0 &&
			region.startMs < T1,
	);
}

/**
 * Visual captions keep the renderer's source clock: intersect each cue (and
 * its words) with [S0, S1) using half-open bounds so a boundary cue is not
 * duplicated across neighbouring clips.
 */
function sliceCaptionsToSourceWindow(cues: CaptionCue[], S0: number, S1: number): CaptionCue[] {
	const sliced: CaptionCue[] = [];
	for (const cue of cues) {
		if (!isFiniteNumber(cue.startMs) || !isFiniteNumber(cue.endMs)) continue;
		const start = Math.max(cue.startMs, S0);
		const end = Math.min(cue.endMs, S1);
		if (end <= start) continue;
		const words = cue.words?.filter((word) => {
			if (!isFiniteNumber(word.startMs) || !isFiniteNumber(word.endMs)) return false;
			return word.endMs > start && word.startMs < end;
		});
		sliced.push({
			...cue,
			startMs: start,
			endMs: end,
			...(words ? { words: words.map((word) => ({ ...word })) } : {}),
		});
	}
	return sliced;
}

/**
 * Sidecar cues live in clip-local output time U. Source cue bounds map through
 * speed and clamp to [0, outputDurationMs]. Empty text cues are dropped, same
 * as the full-timeline sidecar payload.
 */
function projectSidecarCues(
	cues: CaptionCue[],
	S0: number,
	speed: number,
	outputDurationMs: number,
): ClipExportSidecarCue[] {
	const projected: ClipExportSidecarCue[] = [];
	for (const cue of cues) {
		if (!isFiniteNumber(cue.startMs) || !isFiniteNumber(cue.endMs)) continue;
		if (typeof cue.text !== "string" || cue.text.trim().length === 0) continue;
		const sourceStart = Math.max(cue.startMs, S0);
		const sourceEnd = Math.min(cue.endMs, S0 + outputDurationMs * speed);
		if (sourceEnd <= sourceStart) continue;
		const startMs = Math.max(
			0,
			Math.min(outputDurationMs, Math.round((sourceStart - S0) / speed)),
		);
		const endMs = Math.max(
			startMs,
			Math.min(outputDurationMs, Math.round((sourceEnd - S0) / speed)),
		);
		if (endMs <= startMs) continue;
		projected.push({ startMs, endMs, text: cue.text });
	}
	return projected;
}

/**
 * Imported audio overlays intersect with [T0, T1) and rebase their placement
 * to clip-local U while preserving the offset into the audio file, so an
 * overlay crossing the clip start keeps playing from where it already was.
 */
function sliceAudioOverlaysForClip(
	audioRegions: AudioRegion[],
	T0: number,
	T1: number,
): ClipExportPlanAudioOverlay[] {
	const overlays: ClipExportPlanAudioOverlay[] = [];
	for (const region of audioRegions) {
		if (!isFiniteNumber(region.startMs) || !isFiniteNumber(region.endMs)) continue;
		const overlapStart = Math.max(region.startMs, T0);
		const overlapEnd = Math.min(region.endMs, T1);
		if (overlapEnd <= overlapStart) continue;
		overlays.push({
			regionId: region.id,
			audioPath: region.audioPath,
			volume: region.volume,
			...(region.normalize === undefined ? {} : { normalize: region.normalize }),
			...(region.trackIndex === undefined ? {} : { trackIndex: region.trackIndex }),
			outputStartMs: overlapStart - T0,
			outputEndMs: overlapEnd - T0,
			sourceOffsetMs: overlapStart - region.startMs,
		});
	}
	return overlays;
}

export function buildClipExportPlans(input: BuildClipExportPlansInput): BuildClipExportPlansResult {
	const fps = safeFps(input.fps);
	const sourceDurationMs = Number.isFinite(input.sourceDurationMs)
		? Math.max(0, input.sourceDurationMs)
		: 0;
	const zoomContextMs =
		input.zoomContextMs !== undefined && Number.isFinite(input.zoomContextMs)
			? input.zoomContextMs
			: getDefaultZoomContextMs();
	const zoomRegions = input.zoomRegions ?? [];
	const annotationRegions = input.annotationRegions ?? [];
	const autoCaptions = input.autoCaptions ?? [];
	const audioRegions = input.audioRegions ?? [];
	const plans: ClipExportPlan[] = [];
	const skipped: ClipExportSkipEntry[] = [];

	// Timeline order is the batch order, even when source order differs.
	sortClipRegions(input.clips).forEach((clip, index) => {
		const clipIndex = index + 1;
		const invalidReason = getClipValidity(clip, sourceDurationMs);
		if (invalidReason) {
			skipped.push({ clipId: clip.id, clipIndex, reason: invalidReason });
			return;
		}

		const speed = clip.speed;
		const T0 = clip.startMs;
		const T1 = clip.endMs;
		const S0 = getClipSourceStartMs(clip);
		const S1 = getClipSourceEndMs(clip);
		const firstFrame = Math.ceil((T0 / 1000) * fps);
		const endFrame = Math.ceil((T1 / 1000) * fps);
		const frameCount = Math.max(0, endFrame - firstFrame);
		const outputDurationMs = (frameCount / fps) * 1000;
		const captionCues = sliceCaptionsToSourceWindow(autoCaptions, S0, S1);

		plans.push({
			clipId: clip.id,
			clipIndex,
			speed,
			timelineStartMs: T0,
			timelineEndMs: T1,
			sourceStartMs: S0,
			sourceEndMs: S1,
			fps,
			firstFrame,
			frameCount,
			outputDurationMs,
			muted: clip.muted === true,
			sourceAudioTrackSettings: input.getSourceAudioTrackSettingsForClip?.(clip.id) ?? {},
			zoomRegions: selectZoomRegionsForClip(zoomRegions, T0, T1, zoomContextMs),
			annotationRegions: selectAnnotationsForClip(annotationRegions, T0, T1),
			captionCues,
			sidecarCues: projectSidecarCues(captionCues, S0, speed, outputDurationMs),
			audioOverlays: sliceAudioOverlaysForClip(audioRegions, T0, T1),
			webcam: input.webcam ?? null,
			frameIndexToTimelineMs: (frameIndex) => ((firstFrame + frameIndex) / fps) * 1000,
			timelineMsToSourceMs: (timelineMs) => Math.round(S0 + (timelineMs - T0) * speed),
			frameIndexToSourceMs: (frameIndex) =>
				Math.round(S0 + (((firstFrame + frameIndex) / fps) * 1000 - T0) * speed),
			frameIndexToOutputMs: (frameIndex) => ((firstFrame + frameIndex) / fps) * 1000 - T0,
		});
	});

	return { plans, skipped };
}

/** Select only the original ClipRegion objects represented by valid plans. */
export function getClipRegionsForPlans(clips: ClipRegion[], plans: ClipExportPlan[]): ClipRegion[] {
	const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
	return plans.flatMap((plan) => {
		const clip = clipsById.get(plan.clipId);
		return clip ? [clip] : [];
	});
}
