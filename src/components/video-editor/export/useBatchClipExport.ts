import { useCallback, useMemo, useRef, useState } from "react";
import type { ExportSettings } from "@/lib/exporter/types";
import { buildClipExportPlans } from "./clipExportPlan";
import type { ClipExportPlan } from "./clipExportPlan";

/**
 * Separate-clips batch state for the Local export popover.
 *
 * Owns one batch lifecycle (folder pick → plan → render → commit → summary)
 * with its own state shape. It deliberately does not reuse the single-export
 * `PendingExportSave`: batch recovery re-renders only failed clips and keeps
 * completed files untouched.
 */

export type BatchClipItemStatus =
	| "pending"
	| "rendering"
	| "completed"
	| "render-error"
	| "write-error"
	| "cancelled"
	| "skipped";

export interface BatchClipItem {
	clipId: string;
	clipIndex: number;
	status: BatchClipItemStatus;
	outputPath?: string;
	error?: string;
	sidecarWarning?: boolean;
	/**
	 * App-managed temp retained by a write failure: retry can re-commit this
	 * clip into a newly chosen folder without rendering it again.
	 */
	retainedTempPath?: string;
}

export interface BatchExportSummary {
	items: BatchClipItem[];
	completedCount: number;
	failedCount: number;
	sidecarWarningCount: number;
	cancelled: boolean;
}

export interface UseBatchClipExportInput {
	/** Clip-validity inputs for the pure plan builder. */
	buildPlans: () => ReturnType<typeof buildClipExportPlans>;
	/** Builds the full-timeline-shaped render adapter for the batch. */
	createBatch: (
		plans: ClipExportPlan[],
		settings: ExportSettings,
		hooks: {
			onClipStart: (plan: ClipExportPlan) => void;
			onClipDone: (
				plan: ClipExportPlan,
				status: "completed" | "render-error" | "write-error" | "cancelled",
				info?: { outputPath?: string; error?: string },
			) => void;
			onProgress: (completedFiles: number, total: number) => void;
			isCancelled: () => boolean;
		},
	) => Promise<{
		exportBatch: () => Promise<{
			items: Array<{
				plan: ClipExportPlan;
				status: string;
				tempFilePath?: string;
				error?: string;
			}>;
			cancelled: boolean;
		}>;
		cancel: () => void;
	}>;
	/** Main-process side: one folder pick, then per-clip atomic commits. */
	openFolderSession: (
		clipCount: number,
		sourceBaseName: string,
	) => Promise<{ success: boolean; batchId?: string; canceled?: boolean; error?: string }>;
	commitClip: (input: {
		batchId: string;
		tempPath: string;
		plan: ClipExportPlan;
		sidecar?: { format: "srt" | "vtt" | "both"; cues: Array<{ startMs: number; endMs: number; text: string }> };
	}) => Promise<{ success: boolean; path?: string; sidecarWarning?: string | null; errorKind?: string; error?: string }>;
	cancelSession: (batchId: string) => Promise<void>;
}

export type BatchClipExportController = ReturnType<typeof useBatchClipExport>;

export function useBatchClipExport(input: UseBatchClipExportInput) {
	const inputRef = useRef(input);
	inputRef.current = input;

	const [isBatchExporting, setIsBatchExporting] = useState(false);
	const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
		null,
	);
	const [batchSummary, setBatchSummary] = useState<BatchExportSummary | null>(null);
	const [batchError, setBatchError] = useState<string | null>(null);
	const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

	const validClipCount = useMemo(() => input.buildPlans().plans.length, [input]);

	const startBatchExport = useCallback(
		async (
			settings: ExportSettings,
			sourceBaseName: string,
			retry?: {
				onlyClipIds: string[];
				retainedTemps: Record<string, string>;
			},
		): Promise<boolean> => {
			const built = inputRef.current.buildPlans();
			const retryIds = retry ? new Set(retry.onlyClipIds) : null;
			const plans = retryIds
				? built.plans.filter((plan) => retryIds.has(plan.clipId))
				: built.plans;
			const skipped = retryIds
				? built.skipped.filter((entry) => !retryIds.has(entry.clipId))
				: built.skipped;
			if (plans.length === 0 && (!retry || Object.keys(retry.retainedTemps).length === 0)) {
				setBatchError("no-valid-clips");
				return false;
			}
			setBatchError(null);
			setBatchSummary(null);

			// One folder selection, before any rendering starts.
			const opened = await inputRef.current.openFolderSession(
				plans.length,
				sourceBaseName,
			);
			if (!opened.success || !opened.batchId) {
				if (opened.canceled) {
					// Folder canceled: no batch was started, nothing to clean up.
					return false;
				}
				setBatchError(opened.error || "Could not open the destination folder");
				return false;
			}
			const batchId = opened.batchId;

			const retainedTemps = retry?.retainedTemps ?? {};
			const items: BatchClipItem[] = plans.map((plan) => ({
				clipId: plan.clipId,
				clipIndex: plan.clipIndex,
				status: "pending",
			}));
			for (const [clipId, tempPath] of Object.entries(retainedTemps)) {
				const existing = items.find((item) => item.clipId === clipId);
				if (existing) {
					existing.retainedTempPath = tempPath;
				} else {
					// A retry may retain a temp whose plan was not re-listed.
					items.push({
						clipId,
						clipIndex: -1,
						status: "pending",
						retainedTempPath: tempPath,
					});
				}
			}
			const itemByClipId = new Map(items.map((item) => [item.clipId, item]));
			for (const entry of skipped) {
				itemByClipId.set(entry.clipId, {
					clipId: entry.clipId,
					clipIndex: entry.clipIndex,
					status: "skipped",
				});
			}
			cancelRef.current = { cancelled: false };
			setIsBatchExporting(true);
			setBatchProgress({ current: 0, total: plans.length + Object.keys(retainedTemps).length });

			let completedFiles = 0;
			const reportProgress = () =>
				setBatchProgress({ current: completedFiles, total: plans.length });

			try {
				const batch = await inputRef.current.createBatch(plans, settings, {
					onClipStart: (plan) => {
						const item = itemByClipId.get(plan.clipId);
						if (item && item.status === "pending") item.status = "rendering";
					},
					onClipDone: (plan, status, info) => {
						const item = itemByClipId.get(plan.clipId);
						if (item) {
							item.status = status;
							item.outputPath = info?.outputPath;
							item.error = info?.error;
						}
					},
					onProgress: (completed, total) => {
						completedFiles = completed;
						setBatchProgress({ current: completed, total });
					},
					isCancelled: () => cancelRef.current.cancelled,
				});

				const renderResult = await batch.exportBatch();

				// Commit every returned temp path. A commit that won the race
				// against cancel still counts as completed.
				for (const entry of renderResult.items) {
					const item = itemByClipId.get(entry.plan.clipId);
					if (!item) continue;
					if (entry.status === "completed" && entry.tempFilePath) {
						if (cancelRef.current.cancelled) {
							// Cancellation wins only before publication; the renderer
							// discards the still-owned temp file itself.
							item.status = "cancelled";
							continue;
						}
						item.status = "rendering";
						const sidecar =
							entry.plan.sidecarCues.length > 0
								? {
										format: "both" as const,
										cues: entry.plan.sidecarCues.map((cue) => ({
											startMs: cue.startMs,
											endMs: cue.endMs,
											text: cue.text,
										})),
									}
								: undefined;
						const commit = await inputRef.current.commitClip({
							batchId,
							tempPath: entry.tempFilePath,
							plan: entry.plan,
							sidecar,
						});
						if (commit.success && commit.path) {
							item.status = "completed";
							item.outputPath = commit.path;
							item.sidecarWarning = Boolean(commit.sidecarWarning);
							completedFiles += 1;
							reportProgress();
						} else if (commit.errorKind === "cancelled") {
							item.status = "cancelled";
						} else {
							item.status = "write-error";
							item.error = commit.error || "Could not save the clip file";
							// The temp was never published; keep it for destination retry.
							item.retainedTempPath = entry.tempFilePath;
						}
					} else if (entry.status === "cancelled") {
						item.status = "cancelled";
					} else if (entry.status !== "completed") {
						item.status =
							entry.status === "write-error" ? "write-error" : "render-error";
						item.error = entry.error;
					}
				}

				// Re-commit retained temps from a previous write failure without
				// rendering those clips again.
				for (const item of items) {
					if (!item.retainedTempPath || item.status !== "pending") continue;
					if (cancelRef.current.cancelled) {
						item.status = "cancelled";
						continue;
					}
					const plan = plans.find((candidate) => candidate.clipId === item.clipId);
					item.status = "rendering";
					const commit = await inputRef.current.commitClip({
						batchId,
						tempPath: item.retainedTempPath,
						plan: plan ?? {
							clipId: item.clipId,
							clipIndex: item.clipIndex,
							speed: 1,
							timelineStartMs: 0,
							timelineEndMs: 0,
							sourceStartMs: 0,
							sourceEndMs: 0,
							fps: 30,
							firstFrame: 0,
							frameCount: 0,
							outputDurationMs: 0,
							muted: false,
							sourceAudioTrackSettings: {},
							zoomRegions: [],
							annotationRegions: [],
							captionCues: [],
							sidecarCues: [],
							audioOverlays: [],
							webcam: null,
							frameIndexToTimelineMs: () => 0,
							timelineMsToSourceMs: () => 0,
							frameIndexToSourceMs: () => 0,
							frameIndexToOutputMs: () => 0,
						},
					});
					if (commit.success && commit.path) {
						item.status = "completed";
						item.outputPath = commit.path;
						item.sidecarWarning = Boolean(commit.sidecarWarning);
						item.retainedTempPath = undefined;
						completedFiles += 1;
						reportProgress();
					} else if (commit.errorKind === "cancelled") {
						item.status = "cancelled";
					} else {
						item.status = "write-error";
						item.error = commit.error || "Could not save the clip file";
					}
				}

				const listed = items.map((item) => ({ ...item }));
				const summary: BatchExportSummary = {
					items: listed,
					completedCount: listed.filter((item) => item.status === "completed").length,
					failedCount: listed.filter(
						(item) => item.status === "render-error" || item.status === "write-error",
					).length,
					sidecarWarningCount: listed.filter((item) => item.sidecarWarning).length,
					cancelled: cancelRef.current.cancelled,
				};
				setBatchSummary(summary);
				if (summary.completedCount === 0 && !summary.cancelled && summary.failedCount > 0) {
					setBatchError("all-clips-failed");
				}
				return summary.completedCount > 0;
			} catch (error) {
				setBatchError(error instanceof Error ? error.message : String(error));
				return false;
			} finally {
				setIsBatchExporting(false);
				if (cancelRef.current.cancelled) {
					void inputRef.current.cancelSession(batchId);
				}
			}
		},
		[],
	);

	const cancelBatchExport = useCallback(() => {
		cancelRef.current.cancelled = true;
		setBatchError(null);
	}, []);

	const dismissBatchResult = useCallback(() => {
		setBatchSummary(null);
		setBatchProgress(null);
		setBatchError(null);
	}, []);

	return {
		isBatchExporting,
		batchProgress,
		batchSummary,
		batchError,
		validClipCount,
		startBatchExport,
		cancelBatchExport,
		dismissBatchResult,
		cancelTokenRef: cancelRef,
	};
}
