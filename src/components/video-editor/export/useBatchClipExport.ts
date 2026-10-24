import { useCallback, useMemo, useRef, useState } from "react";
import type { ExportSettings } from "@/lib/exporter/types";
import { buildClipExportPlans } from "./clipExportPlan";
import type { ClipExportPlan, ClipExportSkipReason } from "./clipExportPlan";

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
	sidecarWarning?: string;
	skipReason?: ClipExportSkipReason;
	/** App-managed temp kept only when publication failed and can be retried. */
	retainedTempPath?: string;
}

export interface BatchExportSummary {
	items: BatchClipItem[];
	completedCount: number;
	failedCount: number;
	skippedCount: number;
	sidecarWarningCount: number;
	cancelled: boolean;
}

export interface BatchRetryRequest {
	onlyClipIds: string[];
	retainedTemps: Record<string, string>;
	previousItems: BatchClipItem[];
}

export interface BatchClipSidecarPayload {
	format: "srt" | "vtt" | "both";
	cues: Array<{ startMs: number; endMs: number; text: string }>;
}

interface RenderedClip {
	plan: ClipExportPlan;
	status: "completed" | "render-error" | "write-error" | "cancelled" | "skipped";
	tempFilePath?: string;
	error?: string;
}

interface RenderBatchResult {
	items: RenderedClip[];
	cancelled: boolean;
}

export interface BatchRetryWork {
	selectedPlans: ClipExportPlan[];
	plansToRender: ClipExportPlan[];
	workClipIds: string[];
}

/** Pure retry partition: completed clip IDs are absent; retained temps aren't rendered. */
export function getBatchReplayPlans(
	allPlans: ClipExportPlan[],
	plansToRender: ClipExportPlan[],
): ClipExportPlan[] {
	if (plansToRender.length === 0) return [];
	const outputIds = new Set(plansToRender.map((plan) => plan.clipId));
	const lastOutputFrame = Math.max(
		...plansToRender.map((plan) => plan.firstFrame + plan.frameCount),
	);
	return allPlans.filter(
		(plan) => outputIds.has(plan.clipId) || plan.firstFrame < lastOutputFrame,
	);
}

export function getBatchRetryWork(
	plans: ClipExportPlan[],
	retry?: BatchRetryRequest,
): BatchRetryWork {
	const retryIds = retry ? new Set(retry.onlyClipIds) : null;
	const selectedPlans = retryIds ? plans.filter((plan) => retryIds.has(plan.clipId)) : plans;
	const retainedTemps = retry?.retainedTemps ?? {};
	const retainedIds = new Set(Object.keys(retainedTemps));
	return {
		selectedPlans,
		plansToRender: selectedPlans.filter((plan) => !retainedIds.has(plan.clipId)),
		workClipIds: [
			...selectedPlans.map((plan) => plan.clipId),
			...Object.keys(retainedTemps).filter(
				(clipId) => !selectedPlans.some((plan) => plan.clipId === clipId),
			),
		],
	};
}

export interface UseBatchClipExportInput {
	buildPlans: () => ReturnType<typeof buildClipExportPlans>;
	includeCaptionSidecar: boolean;
	sidecarFormat?: "srt" | "vtt" | "both";
	createBatch: (
		plansToRender: ClipExportPlan[],
		replayPlans: ClipExportPlan[],
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
		exportBatch: () => Promise<RenderBatchResult>;
		cancel: () => void;
	}>;
	openFolderSession: (
		clipCount: number,
		sourceBaseName: string,
	) => Promise<{ success: boolean; batchId?: string; canceled?: boolean; error?: string }>;
	commitClip: (input: {
		batchId: string;
		tempPath: string;
		clipIndex: number;
		sidecar?: BatchClipSidecarPayload;
	}) => Promise<{
		success: boolean;
		path?: string;
		sidecarWarning?: string | null;
		errorKind?: string;
		error?: string;
	}>;
	cancelSession: (batchId: string) => Promise<void>;
	closeSession: (batchId: string) => Promise<void>;
	discardTemp: (tempPath: string) => Promise<void>;
}

export function makeSidecarPayload(
	plan: ClipExportPlan | undefined,
	includeCaptionSidecar: boolean,
	format: UseBatchClipExportInput["sidecarFormat"],
): BatchClipSidecarPayload | undefined {
	if (!plan || !includeCaptionSidecar || !format || plan.sidecarCues.length === 0)
		return undefined;
	return {
		format,
		cues: plan.sidecarCues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
	};
}

export type BatchClipExportController = ReturnType<typeof useBatchClipExport>;

export function useBatchClipExport(input: UseBatchClipExportInput) {
	const inputRef = useRef(input);
	inputRef.current = input;
	const activeBatchRef = useRef<{
		batchId: string;
		cancel: () => void;
	} | null>(null);
	const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

	const [isBatchExporting, setIsBatchExporting] = useState(false);
	const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
		null,
	);
	const [batchSummary, setBatchSummary] = useState<BatchExportSummary | null>(null);
	const [batchError, setBatchError] = useState<string | null>(null);
	const validClipCount = useMemo(() => input.buildPlans().plans.length, [input]);

	const startBatchExport = useCallback(
		async (
			settings: ExportSettings,
			sourceBaseName: string,
			retry?: BatchRetryRequest,
		): Promise<boolean> => {
			const built = inputRef.current.buildPlans();
			const plansById = new Map(built.plans.map((plan) => [plan.clipId, plan]));
			const retryWork = getBatchRetryWork(built.plans, retry);
			const { plansToRender, workClipIds } = retryWork;
			const retainedTemps = retry?.retainedTemps ?? {};
			const retainedIds = new Set(Object.keys(retainedTemps));
			// A retained temp is already rendered; never include that clip in the
			// renderer batch. Only failed clips without temps need re-rendering.
			if (workClipIds.length === 0) {
				setBatchError("no-valid-clips");
				return false;
			}

			setBatchError(null);
			setIsBatchExporting(true);
			cancelRef.current = { cancelled: false };
			const totalSteps = plansToRender.length + retainedIds.size;
			setBatchProgress({ current: 0, total: totalSteps });
			let doneCount = 0;
			const progressed = new Set<string>();
			const reportProgress = (id: string) => {
				if (progressed.has(id)) return;
				progressed.add(id);
				doneCount = Math.min(doneCount + 1, totalSteps);
				setBatchProgress({ current: doneCount, total: totalSteps });
			};

			let opened: Awaited<ReturnType<UseBatchClipExportInput["openFolderSession"]>>;
			try {
				opened = await inputRef.current.openFolderSession(
					workClipIds.length,
					sourceBaseName,
				);
			} catch (error) {
				setIsBatchExporting(false);
				setBatchProgress(null);
				setBatchError(error instanceof Error ? error.message : String(error));
				return false;
			}
			if (!opened.success || !opened.batchId) {
				setIsBatchExporting(false);
				setBatchProgress(null);
				if (!opened.canceled)
					setBatchError(opened.error || "Could not open the destination folder");
				return false;
			}
			const batchId = opened.batchId;
			setBatchSummary(null);
			activeBatchRef.current = { batchId, cancel: () => undefined };
			if (cancelRef.current.cancelled) {
				await inputRef.current.cancelSession(batchId).catch(() => undefined);
			}

			const itemsById = new Map<string, BatchClipItem>();
			for (const previous of retry?.previousItems ?? []) {
				itemsById.set(previous.clipId, { ...previous });
			}
			for (const clipId of workClipIds) {
				const plan = plansById.get(clipId);
				const existing = itemsById.get(clipId);
				if (existing) {
					existing.status = "pending";
					existing.error = undefined;
					existing.retainedTempPath = retainedTemps[clipId];
				} else {
					itemsById.set(clipId, {
						clipId,
						clipIndex: plan?.clipIndex ?? -1,
						status: "pending",
						retainedTempPath: retainedTemps[clipId],
					});
				}
			}
			for (const skipped of built.skipped) {
				if (!itemsById.has(skipped.clipId)) {
					itemsById.set(skipped.clipId, {
						clipId: skipped.clipId,
						clipIndex: skipped.clipIndex,
						status: "skipped",
						skipReason: skipped.reason,
					});
				}
			}

			const unpublishedTemps = new Set(Object.values(retainedTemps));
			const retryableTemps = new Set<string>(Object.values(retainedTemps));
			let outputWriteFailed = false;
			let renderResult: RenderBatchResult = { items: [], cancelled: false };

			try {
				if (cancelRef.current.cancelled) {
					await inputRef.current.cancelSession(batchId).catch(() => undefined);
					return false;
				}
				if (plansToRender.length > 0) {
					const replayPlans = getBatchReplayPlans(built.plans, plansToRender);
					const batch = await inputRef.current.createBatch(
						plansToRender,
						replayPlans,
						settings,
						{
							onClipStart: (plan) => {
								const item = itemsById.get(plan.clipId);
								if (item) item.status = "rendering";
							},
							onClipDone: (plan, status) => {
								if (
									status === "completed" ||
									status === "render-error" ||
									status === "write-error"
								)
									reportProgress(plan.clipId);
							},
							onProgress: () => undefined,
							isCancelled: () => cancelRef.current.cancelled,
						},
					);
					activeBatchRef.current = { batchId, cancel: batch.cancel };
					if (cancelRef.current.cancelled) {
						batch.cancel();
						await inputRef.current.cancelSession(batchId).catch(() => undefined);
					}
					renderResult = await batch.exportBatch();
				}

				const renderedById = new Map(
					renderResult.items.map((entry) => [entry.plan.clipId, entry]),
				);
				// Claim every temp before any cancellation/commit branch so an early
				// exit cannot orphan outputs returned for later clips.
				for (const entry of renderResult.items) {
					if (entry.tempFilePath) unpublishedTemps.add(entry.tempFilePath);
				}
				for (const clipId of workClipIds) {
					const item = itemsById.get(clipId)!;
					const plan = plansById.get(clipId);
					const rendered = renderedById.get(clipId);
					const tempPath = item.retainedTempPath ?? rendered?.tempFilePath;
					if (tempPath) unpublishedTemps.add(tempPath);

					if (rendered && rendered.status !== "completed") {
						const cancelled =
							rendered.status === "cancelled" ||
							(rendered.status === "skipped" &&
								(cancelRef.current.cancelled || renderResult.cancelled));
						if (cancelled) {
							item.status = "cancelled";
						} else if (rendered.status === "write-error") {
							item.status = "write-error";
							item.error =
								rendered.error ?? "Temporary clip output could not be finalized";
							outputWriteFailed = true;
						} else {
							item.status = "render-error";
							item.error = rendered.error ?? "Clip produced no output frames";
						}
						// An audio mux failure may leave the video-only input temp in the
						// result. It is incomplete and must never be published or retained.
						if (tempPath) {
							await inputRef.current.discardTemp(tempPath).catch(() => undefined);
							unpublishedTemps.delete(tempPath);
							retryableTemps.delete(tempPath);
						}
						continue;
					}

					if (cancelRef.current.cancelled || renderResult.cancelled) {
						item.status = "cancelled";
						if (retainedIds.has(clipId)) reportProgress(clipId);
						if (tempPath) {
							await inputRef.current.discardTemp(tempPath).catch(() => undefined);
							unpublishedTemps.delete(tempPath);
							retryableTemps.delete(tempPath);
						}
						continue;
					}
					if (!tempPath) {
						if (retainedIds.has(clipId)) reportProgress(clipId);
						if (rendered && rendered.status !== "completed") {
							item.status =
								rendered.status === "cancelled" ? "cancelled" : "render-error";
							item.error = rendered.error;
						} else if (!item.retainedTempPath) {
							item.status = "render-error";
							item.error = "Clip renderer produced no output";
						}
						continue;
					}
					if (outputWriteFailed) {
						if (retainedIds.has(clipId)) reportProgress(clipId);
						item.status = "write-error";
						item.error = "Not published because an earlier clip failed to save";
						item.retainedTempPath = tempPath;
						retryableTemps.add(tempPath);
						continue;
					}

					const sidecar = makeSidecarPayload(
						plan,
						inputRef.current.includeCaptionSidecar,
						inputRef.current.sidecarFormat,
					);
					let commit: Awaited<ReturnType<UseBatchClipExportInput["commitClip"]>>;
					try {
						commit = await inputRef.current.commitClip({
							batchId,
							tempPath,
							clipIndex: plan?.clipIndex ?? item.clipIndex,
							sidecar,
						});
					} catch (error) {
						commit = {
							success: false,
							errorKind: "write",
							error: error instanceof Error ? error.message : String(error),
						};
					}
					if (commit.success && commit.path) {
						item.status = "completed";
						item.outputPath = commit.path;
						item.sidecarWarning = commit.sidecarWarning || undefined;
						item.retainedTempPath = undefined;
						unpublishedTemps.delete(tempPath);
						retryableTemps.delete(tempPath);
					} else if (commit.errorKind === "cancelled") {
						item.status = "cancelled";
						await inputRef.current.discardTemp(tempPath).catch(() => undefined);
						unpublishedTemps.delete(tempPath);
						retryableTemps.delete(tempPath);
					} else {
						item.status = "write-error";
						item.error = commit.error || "Could not save the clip file";
						item.retainedTempPath = tempPath;
						retryableTemps.add(tempPath);
						outputWriteFailed = true;
					}
					if (retainedIds.has(clipId)) reportProgress(clipId);
				}

				const summaryItems = [...itemsById.values()].map((item) => ({ ...item }));
				const summary: BatchExportSummary = {
					items: summaryItems,
					completedCount: summaryItems.filter((item) => item.status === "completed")
						.length,
					failedCount: summaryItems.filter(
						(item) => item.status === "render-error" || item.status === "write-error",
					).length,
					skippedCount: summaryItems.filter((item) => item.status === "skipped").length,
					sidecarWarningCount: summaryItems.filter((item) => Boolean(item.sidecarWarning))
						.length,
					cancelled: cancelRef.current.cancelled || renderResult.cancelled,
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
				activeBatchRef.current = null;
				setIsBatchExporting(false);
				if (cancelRef.current.cancelled) {
					await inputRef.current.cancelSession(batchId).catch(() => undefined);
				}
				for (const tempPath of unpublishedTemps) {
					if (cancelRef.current.cancelled || !retryableTemps.has(tempPath)) {
						await inputRef.current.discardTemp(tempPath).catch(() => undefined);
					}
				}
				await inputRef.current.closeSession(batchId).catch(() => undefined);
			}
		},
		[],
	);

	const cancelBatchExport = useCallback(() => {
		cancelRef.current.cancelled = true;
		const active = activeBatchRef.current;
		active?.cancel();
		if (active) {
			// Notify the main process immediately; publication is linearized there.
			void inputRef.current.cancelSession(active.batchId);
		}
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
