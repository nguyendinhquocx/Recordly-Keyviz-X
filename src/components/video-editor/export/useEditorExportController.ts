import type { RefObject } from "react";
import type { useI18n } from "@/contexts/I18nContext";
import type { useVideoEditorAudio } from "../audio/useVideoEditorAudio";
import type { getSmokeExportConfig } from "../smokeExportConfig";
import type { useAppearanceState } from "../state/useAppearanceState";
import type { useTimelineState } from "../state/useTimelineState";
import type { CursorTelemetryPoint, SpeedRegion, ZoomRegion } from "../types";
import type { VideoPlaybackRef } from "../VideoPlayback";
import { getMp4ExportBitrate } from "@/lib/exporter/exportBitrate";
import {
	ClipBatchExporter,
	createClipBatchRenderPorts,
} from "@/lib/exporter/clipBatchExporter";
import { DEFAULT_MP4_CODEC } from "@/lib/exporter/mp4Support";
import { buildClipExportPlans } from "./clipExportPlan";
import { calculateMp4ExportDimensions } from "../exportDimensions";
import { useBatchClipExport } from "./useBatchClipExport";
import { useExportDialogActions } from "./useExportDialogActions";
import type { useExportDimensions } from "./useExportDimensions";
import { useExportMessages } from "./useExportMessages";
import { useExportRunner } from "./useExportRunner";
import type { useExportSession } from "./useExportSession";
import type { useExportSettings } from "./useExportSettings";
import { resolveMp4ExportSettings } from "../mp4ExportSettings";
import { useExportStatusViewModel } from "./useExportStatusViewModel";
import { useSmokeExportAutomation } from "./useSmokeExportAutomation";

type Input = {
	t: ReturnType<typeof useI18n>["t"];
	videoPath: string | null;
	videoSourcePath: string | null;
	videoPlaybackRef: RefObject<VideoPlaybackRef | null>;
	isPlaying: boolean;
	duration: number;
	error: string | null;
	loading: boolean;
	isPreviewReady: boolean;
	appearance: ReturnType<typeof useAppearanceState>;
	timeline: ReturnType<typeof useTimelineState>;
	settings: ReturnType<typeof useExportSettings>;
	session: ReturnType<typeof useExportSession>;
	dimensions: ReturnType<typeof useExportDimensions>;
	audio: ReturnType<typeof useVideoEditorAudio>;
	smokeConfig: ReturnType<typeof getSmokeExportConfig>;
	effectiveSpeedRegions: SpeedRegion[];
	effectiveZoomRegions: ZoomRegion[];
	effectiveCursorTelemetry: CursorTelemetryPoint[];
	effectiveShowCursor: boolean;
	cursorTelemetrySourcePath: string | null;
	hasCaptionsForSidecar: boolean;
	captionSidecarPayload?: Parameters<typeof useExportRunner>[0]["captionSidecarPayload"];
	experimentalNvidiaCudaExport: boolean;
	nvidiaCudaExportAvailable: boolean;
	remountPreview: () => void;
};

function getSourceBaseName(videoPath: string | null): string {
	if (!videoPath) return "export";
	const withoutQuery = videoPath.split(/[?#]/)[0];
	const segments = withoutQuery.split(/[\\/]/);
	const fileName = segments[segments.length - 1] || "export";
	return fileName.replace(/\.[a-z0-9]+$/i, "") || "export";
}

export function useEditorExportController(input: Input) {
	const runner = useExportRunner({
		videoPath: input.videoPath,
		videoPlaybackRef: input.videoPlaybackRef,
		isPlaying: input.isPlaying,
		appearance: input.appearance,
		timeline: input.timeline,
		exportSettings: input.settings,
		exportSession: input.session,
		audio: input.audio,
		smokeExportConfig: input.smokeConfig,
		effectiveSpeedRegions: input.effectiveSpeedRegions,
		effectiveZoomRegions: input.effectiveZoomRegions,
		effectiveCursorTelemetry: input.effectiveCursorTelemetry,
		effectiveShowCursor: input.effectiveShowCursor,
		ensureSupportedMp4SourceDimensions: input.dimensions.ensureSupportedMp4SourceDimensions,
		captionSidecarPayload: input.captionSidecarPayload,
		experimentalNvidiaCudaExport: input.experimentalNvidiaCudaExport,
		nvidiaCudaExportAvailable: input.nvidiaCudaExportAvailable,
		remountPreview: input.remountPreview,
	});
	const dialogActions = useExportDialogActions({
		videoPath: input.videoPath,
		videoPlaybackRef: input.videoPlaybackRef,
		hasCaptionsForSidecar: input.hasCaptionsForSidecar,
		settings: input.settings,
		session: input.session,
		handleExport: runner.handleExport,
		showExportSuccessToast: runner.showExportSuccessToast,
	});

	// Separate-clips batch: one folder pick, one shared render session, one
	// MP4 per valid timeline clip committed through the no-clobber IPC.
	const batch = useBatchClipExport({
		buildPlans: () =>
			buildClipExportPlans({
				clips: input.timeline.clipRegions,
				sourceDurationMs: Math.max(0, input.duration) * 1000,
				fps: input.settings.mp4FrameRate,
				zoomRegions: input.effectiveZoomRegions,
				annotationRegions: input.timeline.annotationRegions,
				autoCaptions: input.timeline.autoCaptions,
				audioRegions: input.timeline.audioRegions,
				getSourceAudioTrackSettingsForClip: (clipId) =>
					input.audio.getSourceAudioTrackSettingsForClip(clipId),
				webcam: input.appearance.webcam,
			}),
		createBatch: async (plans, settings, hooks) => {
			const { quality, encodingMode, selectedMp4FrameRate } = resolveMp4ExportSettings({
				smokeExportConfig: { enabled: false },
				settings,
				exportQuality: input.settings.exportQuality,
				exportEncodingMode: input.settings.exportEncodingMode,
				mp4FrameRate: input.settings.mp4FrameRate,
			});
			const supportedSourceDimensions =
				await input.dimensions.ensureSupportedMp4SourceDimensions(selectedMp4FrameRate);
			const requestedDimensions = calculateMp4ExportDimensions(
				supportedSourceDimensions.width,
				supportedSourceDimensions.height,
				quality,
			);
			const bitrate = getMp4ExportBitrate({
				width: requestedDimensions.width,
				height: requestedDimensions.height,
				frameRate: selectedMp4FrameRate,
				quality,
				encodingMode,
				useModernNativeStaticLayout: false,
			});
			const appearance = input.appearance;
			const ports = await createClipBatchRenderPorts({
				videoUrl: input.videoPath ?? "",
				width: requestedDimensions.width,
				height: requestedDimensions.height,
				frameRate: selectedMp4FrameRate,
				bitrate,
				codec: DEFAULT_MP4_CODEC,
				encodingMode,
				clipRegions: input.timeline.clipRegions,
				trimRegions: input.timeline.trimRegions,
				speedRegions: input.effectiveSpeedRegions,
				wallpaper: appearance.wallpaper,
				zoomRegions: input.effectiveZoomRegions,
				showShadow: appearance.shadowIntensity > 0,
				shadowIntensity: appearance.shadowIntensity,
				backgroundBlur: appearance.backgroundBlur,
				zoomMotionBlur: appearance.zoomMotionBlur,
				zoomMotionBlurTuning: appearance.zoomMotionBlurTuning,
				connectZooms: appearance.connectZooms,
				zoomInDurationMs: appearance.zoomInDurationMs,
				zoomInOverlapMs: appearance.zoomInOverlapMs,
				zoomOutDurationMs: appearance.zoomOutDurationMs,
				connectedZoomGapMs: appearance.connectedZoomGapMs,
				connectedZoomDurationMs: appearance.connectedZoomDurationMs,
				zoomInEasing: appearance.zoomInEasing,
				zoomOutEasing: appearance.zoomOutEasing,
				connectedZoomEasing: appearance.connectedZoomEasing,
				borderRadius: appearance.borderRadius,
				padding: appearance.padding,
				cropRegion: appearance.cropRegion,
				webcam: appearance.webcam,
				webcamUrl:
					appearance.resolvedWebcamVideoUrl ??
					(appearance.webcam.sourcePath ? `file://${appearance.webcam.sourcePath}` : null),
				annotationRegions: input.timeline.annotationRegions,
				autoCaptions: input.timeline.autoCaptions,
				autoCaptionSettings: input.timeline.autoCaptionSettings,
				cursorTelemetry: input.effectiveCursorTelemetry,
				showCursor: input.effectiveShowCursor,
				cursorStyle: appearance.cursorStyle,
				cursorSize: appearance.cursorSize,
				cursorSmoothing: appearance.cursorSmoothing,
				zoomSmoothness: appearance.zoomSmoothness,
				sourceAudioFallbackPaths: input.audio.sourceAudioFallbackPaths,
				sourceAudioFallbackStartDelayMsByPath:
					input.audio.sourceAudioFallbackStartDelayMsByPath,
				hasAudio: true,
			});
			const exporter = new ClipBatchExporter(ports, {
				videoUrl: input.videoPath ?? "",
				frameRate: selectedMp4FrameRate,
				clipRegions: input.timeline.clipRegions,
				trimRegions: input.timeline.trimRegions,
				speedRegions: input.effectiveSpeedRegions,
				plans,
				audioRegions: input.timeline.audioRegions,
				isCancelled: hooks.isCancelled,
				onClipStart: hooks.onClipStart,
				onClipResult: hooks.onClipDone,
			});
			return {
				exportBatch: () => exporter.exportBatch(),
				cancel: () => exporter.cancel(),
			};
		},
		openFolderSession: async (clipCount, sourceBaseName) => {
			if (typeof window === "undefined" || !window.electronAPI?.openBatchExportSession) {
				return { success: false, error: "Batch export is unavailable in this environment" };
			}
			return window.electronAPI.openBatchExportSession({ clipCount, sourceBaseName });
		},
		commitClip: async (commit) => {
			if (typeof window === "undefined" || !window.electronAPI?.commitBatchExportClip) {
				return { success: false, errorKind: "write", error: "Batch commit is unavailable" };
			}
			return window.electronAPI.commitBatchExportClip({
				batchId: commit.batchId,
				tempPath: commit.tempPath,
				clipIndex: commit.plan.clipIndex,
				captionSidecar: commit.sidecar,
			});
		},
		cancelSession: async (batchId) => {
			await window.electronAPI?.cancelBatchExportSession?.(batchId);
		},
	});

	const handleStartBatchExport = async () => {
		const resolvedSettings = dialogActions.resolveCurrentSettings("mp4");
		if (!resolvedSettings) return;
		await batch.startBatchExport(resolvedSettings, getSourceBaseName(input.videoPath));
	};

	useSmokeExportAutomation({
		config: input.smokeConfig,
		cursorTelemetrySourcePath: input.cursorTelemetrySourcePath,
		duration: input.duration,
		error: input.error,
		isPreviewReady: input.isPreviewReady,
		loading: input.loading,
		videoPath: input.videoPath,
		videoSourcePath: input.videoSourcePath,
		handleExport: runner.handleExport,
	});
	const status = useExportStatusViewModel({
		t: input.t,
		session: input.session,
		settings: input.settings,
	});
	const exportMessage = useExportMessages({
		t: input.t,
		active: status.isLightningExportInProgress,
	});

	return {
		dialogActions,
		status,
		exportMessage,
		batchExport: { ...batch, handleStartBatchExport },
	};
}
