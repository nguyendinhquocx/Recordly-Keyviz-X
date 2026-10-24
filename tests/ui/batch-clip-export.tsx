import { useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "@/contexts/I18nContext";
import { EditorExportMenu } from "@/components/video-editor/layout/EditorExportMenu";
import "@/index.css";
import { loadEditorPreferences } from "@/components/video-editor/editorPreferences";
import { useExportSettings } from "@/components/video-editor/export/useExportSettings";
import type { BatchClipExportController } from "@/components/video-editor/export/useBatchClipExport";
import { useBatchClipExport } from "@/components/video-editor/export/useBatchClipExport";
import { buildClipExportPlans } from "@/components/video-editor/export/clipExportPlan";
import type { ExportSettings } from "@/lib/exporter/types";

const noop = () => undefined;

// Minimal Electron mock: switching to the Link destination mounts
// CloudShareButton, which queries cloud share state on render.
window.electronAPI = {
	cloudShareManage: async () => ({ success: true, videos: [] }),
	onCloudShareProgress: () => () => undefined,
	discardExportedTemp: async () => ({}),
} as unknown as typeof window.electronAPI;

type BatchScenario =
	| "idle"
	| "progress"
	| "partial"
	| "complete"
	| "cancelled"
	| "retry-result"
	| "hook-retry"
	| "hook-retry-cancel"
	| "hook-retry-render"
	| "hook-cancel";

function scenarioParam(): string {
	return new URLSearchParams(location.search).get("state") ?? "idle";
}

function HookRetryPreview() {
	const [renderedIds, setRenderedIds] = useState<string[]>([]);
	const [committedIds, setCommittedIds] = useState<string[]>([]);
	const [writeAttemptsById, setWriteAttemptsById] = useState<Record<string, number>>({});
	const scenario = scenarioParam();
	const cancelRetryPicker = scenario === "hook-retry-cancel";
	const renderFailureRetry = scenario === "hook-retry-render";
	const folderPickCountRef = useRef(0);
	const batchCreateCountRef = useRef(0);
	const [replayedIds, setReplayedIds] = useState<string[]>([]);
	const plansResult = buildClipExportPlans({
		clips: [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
			{ id: "c", startMs: 2000, endMs: 3000, speed: 1 },
		],
		sourceDurationMs: 5000,
		fps: 30,
	});
	const controller = useBatchClipExport({
		buildPlans: () => plansResult,
		includeCaptionSidecar: false,
		createBatch: async (plans, replayPlans) => {
			batchCreateCountRef.current += 1;
			setRenderedIds((old) => [...old, ...plans.map((plan) => plan.clipId)]);
			setReplayedIds(replayPlans.map((plan) => plan.clipId));
			return {
				exportBatch: async () => ({
					cancelled: false,
					items: plans.map((plan) =>
						renderFailureRetry &&
						batchCreateCountRef.current === 1 &&
						plan.clipId === "b"
							? {
									plan,
									status: "render-error" as const,
									error: "simulated render failure",
								}
							: {
									plan,
									status: "completed" as const,
									tempFilePath: `temp-${plan.clipId}.mp4`,
								},
					),
				}),
				cancel: noop,
			};
		},
		openFolderSession: async () => {
			folderPickCountRef.current += 1;
			if (cancelRetryPicker && folderPickCountRef.current > 1) {
				return { success: false, canceled: true };
			}
			return { success: true, batchId: `batch-${folderPickCountRef.current}` };
		},
		commitClip: async ({ clipIndex }) => {
			const clipId = ["a", "b", "c"][clipIndex - 1];
			setCommittedIds((old) => [...old, clipId]);
			const attempt = (writeAttemptsById[clipId] ?? 0) + 1;
			setWriteAttemptsById((old) => ({ ...old, [clipId]: attempt }));
			if (!renderFailureRetry && clipId === "b" && attempt === 1) {
				return { success: false, errorKind: "write", error: "simulated write failure" };
			}
			return { success: true, path: `out-${clipId}.mp4`, sidecarWarning: null };
		},
		cancelSession: async () => undefined,
		closeSession: async () => undefined,
		discardTemp: async () => undefined,
	});
	const settings = { format: "mp4", includeCaptionSidecar: false } as ExportSettings;
	const runInitial = () => void controller.startBatchExport(settings, "recording");
	const retryFailed = () => {
		const failed =
			controller.batchSummary?.items.filter(
				(item) => item.status === "render-error" || item.status === "write-error",
			) ?? [];
		const retainedTemps: Record<string, string> = {};
		for (const item of failed) {
			if (item.retainedTempPath) retainedTemps[item.clipId] = item.retainedTempPath;
		}
		void controller.startBatchExport(settings, "recording", {
			onlyClipIds: failed.map((item) => item.clipId),
			retainedTemps,
			previousItems: controller.batchSummary?.items ?? [],
		});
	};
	return (
		<div>
			<button type="button" onClick={runInitial}>
				Start hook batch
			</button>
			{controller.batchSummary ? (
				<div>
					<p role="status">
						{controller.batchSummary.completedCount} complete /{" "}
						{controller.batchSummary.failedCount} failed
					</p>
					<p data-testid="retry-retained-temps">
						{controller.batchSummary.items
							.map((item) => item.retainedTempPath)
							.filter(Boolean)
							.join(",")}
					</p>
					<button type="button" onClick={retryFailed}>
						Retry failed only
					</button>
				</div>
			) : null}
			<p data-testid="rendered-clip-ids">{renderedIds.join(",")}</p>
			<p data-testid="replayed-clip-ids">{replayedIds.join(",")}</p>
			<p data-testid="committed-clip-ids">{committedIds.join(",")}</p>
		</div>
	);
}

function HookCancelPreview() {
	const [canReleaseRender, setCanReleaseRender] = useState(false);
	const [committedCount, setCommittedCount] = useState(0);
	const [discardedTemps, setDiscardedTemps] = useState<string[]>([]);
	const [cancelCount, setCancelCount] = useState(0);
	const [closedCount, setClosedCount] = useState(0);
	const releaseRenderRef = useRef<(() => void) | null>(null);
	const plansResult = buildClipExportPlans({
		clips: [{ id: "a", startMs: 0, endMs: 1000, speed: 1 }],
		sourceDurationMs: 5000,
		fps: 30,
	});
	const controller = useBatchClipExport({
		buildPlans: () => plansResult,
		includeCaptionSidecar: false,
		createBatch: async (plans) => ({
			exportBatch: () =>
				new Promise((resolve) => {
					releaseRenderRef.current = () => {
						resolve({
							cancelled: false,
							items: plans.map((plan) => ({
								plan,
								status: "completed" as const,
								tempFilePath: `temp-${plan.clipId}.mp4`,
							})),
						});
					};
					setCanReleaseRender(true);
				}),
			cancel: noop,
		}),
		openFolderSession: async () => ({ success: true, batchId: "cancel-test-batch" }),
		commitClip: async () => {
			setCommittedCount((count) => count + 1);
			return { success: true, path: "unexpected.mp4" };
		},
		cancelSession: async () => setCancelCount((count) => count + 1),
		closeSession: async () => setClosedCount((count) => count + 1),
		discardTemp: async (tempPath) => setDiscardedTemps((paths) => [...paths, tempPath]),
	});
	const settings = { format: "mp4", includeCaptionSidecar: false } as ExportSettings;
	return (
		<div>
			<button
				type="button"
				onClick={() => void controller.startBatchExport(settings, "recording")}
			>
				Start cancel test
			</button>
			<button type="button" onClick={controller.cancelBatchExport}>
				Cancel before commit
			</button>
			<button
				type="button"
				disabled={!canReleaseRender}
				onClick={() => releaseRenderRef.current?.()}
			>
				Release rendered output
			</button>
			<p role="status">{controller.batchSummary?.cancelled ? "cancelled" : "waiting"}</p>
			<p data-testid="cancel-cleanup">
				{`commits=${committedCount}; discards=${discardedTemps.join(",")}; cancels=${cancelCount}; closes=${closedCount}`}
			</p>
		</div>
	);
}

/**
 * Fixture controller mirroring useBatchClipExport: the Playwright spec drives
 * the fake lifecycle through fixture buttons so states are deterministic.
 */
function createBatchController(
	setState: (scenario: BatchScenario) => void,
): BatchClipExportController & { handleStartBatchExport: () => Promise<void> } {
	const scenario = scenarioParam();
	const base = {
		startBatchExport: async () => true,
		cancelBatchExport: () => setState("cancelled"),
		dismissBatchResult: () => setState("idle"),
		handleStartBatchExport: async (retry?: {
			onlyClipIds: string[];
			retainedTemps: Record<string, string>;
			previousItems: Array<{ clipId: string; status: string }>;
		}) => {
			if (!retry) return;
			const rerender = retry.onlyClipIds.filter((id) => !retry.retainedTemps[id]);
			const recommit = Object.keys(retry.retainedTemps);
			const completed = retry.previousItems
				.filter((item) => item.status === "completed")
				.map((item) => item.clipId);
			localStorage.setItem(
				"recordly.batchRetryObservation",
				JSON.stringify({ rerender, recommit, completed }),
			);
			setState("retry-result");
		},
		cancelTokenRef: { current: { cancelled: false } },
	};
	if (scenario === "progress") {
		return {
			...base,
			isBatchExporting: true,
			batchProgress: { current: 3, total: 10 },
			batchSummary: null,
			batchError: null,
			validClipCount: 10,
		};
	}
	if (scenario === "partial") {
		return {
			...base,
			isBatchExporting: false,
			batchProgress: null,
			batchError: null,
			validClipCount: 10,
			batchSummary: {
				items: [
					{
						clipId: "a",
						clipIndex: 1,
						status: "completed",
						outputPath: "C:/out/clip-01.mp4",
					},
					{
						clipId: "b",
						clipIndex: 2,
						status: "render-error",
						error: "encoder boom",
					},
					{
						clipId: "c",
						clipIndex: 3,
						status: "write-error",
						error: "destination is read-only",
						retainedTempPath: "C:/temp/clip-03.mp4",
					},
					{
						clipId: "d",
						clipIndex: 4,
						status: "completed",
						outputPath: "C:/out/clip-04.mp4",
						sidecarWarning: "VTT: file is locked",
					},
					{
						clipId: "e",
						clipIndex: 5,
						status: "skipped",
						skipReason: "outside-source",
					},
				],
				completedCount: 2,
				failedCount: 2,
				skippedCount: 1,
				sidecarWarningCount: 1,
				cancelled: false,
			},
		};
	}
	if (scenario === "complete") {
		return {
			...base,
			isBatchExporting: false,
			batchProgress: null,
			batchError: null,
			validClipCount: 3,
			batchSummary: {
				items: Array.from({ length: 3 }, (_, index) => ({
					clipId: `clip-${index}`,
					clipIndex: index + 1,
					status: "completed" as const,
					outputPath: `C:/out/clip-0${index + 1}.mp4`,
				})),
				completedCount: 3,
				failedCount: 0,
				skippedCount: 0,
				sidecarWarningCount: 0,
				cancelled: false,
			},
		};
	}
	if (scenario === "cancelled") {
		return {
			...base,
			isBatchExporting: false,
			batchProgress: null,
			batchError: null,
			validClipCount: 10,
			batchSummary: {
				items: [
					{
						clipId: "a",
						clipIndex: 1,
						status: "completed",
						outputPath: "C:/out/clip-01.mp4",
					},
					{ clipId: "b", clipIndex: 2, status: "cancelled" },
				],
				completedCount: 1,
				failedCount: 0,
				skippedCount: 0,
				sidecarWarningCount: 0,
				cancelled: true,
			},
		};
	}
	return {
		...base,
		isBatchExporting: false,
		batchProgress: null,
		batchSummary: null,
		batchError: null,
		validClipCount: Number(new URLSearchParams(location.search).get("clips") ?? "10"),
	};
}

function Preview() {
	const [open, setOpen] = useState(() => scenarioParam() === "progress");
	const [, forceRender] = useState(0);
	const { t } = useI18n();
	const [preferences] = useState(loadEditorPreferences);
	// Batch scenarios live on the Local destination; the publish fixture covers
	// the Link flows separately.
	const exportSettings = useExportSettings(
		{ ...preferences, publishDestination: "local" },
		[],
		[],
	);
	const scenario = scenarioParam();
	if (
		scenario === "hook-retry" ||
		scenario === "hook-retry-cancel" ||
		scenario === "hook-retry-render"
	)
		return <HookRetryPreview />;
	if (scenario === "hook-cancel") return <HookCancelPreview />;
	if (scenario === "retry-result") {
		return (
			<div role="status" data-testid="retry-observation">
				{localStorage.getItem("recordly.batchRetryObservation") ?? "missing"}
			</div>
		);
	}
	const props = {
		t,
		projectTitle: "Preview",
		shareRequestNonce: 0,
		exportSettings,
		exportSession: {
			showExportDropdown: open,
			setShowExportDropdown: setOpen,
			exportProgress: { percentage: 0 },
			exportError: undefined,
		},
		exportDimensions: { gifOutputDimensions: { width: 800, height: 450 } },
		exportStatus: {},
		handleOpenExportDropdown: () => setOpen(true),
		handleExportDropdownClose: () => setOpen(false),
		handleCancelExport: noop,
		handleStartExportFromDropdown: noop,
		prepareExportForShare: async () => undefined,
		onRequestShareSignIn: noop,
		batchExport: createBatchController((next) => {
			const url = new URL(location.href);
			url.searchParams.set("state", next);
			location.replace(url.toString());
			forceRender((value) => value + 1);
		}),
	} as unknown as ComponentProps<typeof EditorExportMenu>;
	return (
		<div className="flex justify-end p-12">
			{(scenario === "idle" || scenario === "progress") && (
				<div>
					<button
						type="button"
						onClick={() => exportSettings.setExportMode("separate-clips")}
					>
						Fixture separate clips
					</button>
					<button type="button" onClick={() => exportSettings.setExportFormat("gif")}>
						Fixture gif format
					</button>
					<button
						type="button"
						onClick={() => exportSettings.setPublishDestination("link")}
					>
						Fixture link destination
					</button>
					<button
						type="button"
						onClick={() => exportSettings.setPublishDestination("local")}
					>
						Fixture local destination
					</button>
				</div>
			)}
			<EditorExportMenu {...props} />
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<I18nProvider>
		<Preview />
	</I18nProvider>,
);
