import { useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "@/contexts/I18nContext";
import { EditorExportMenu } from "@/components/video-editor/layout/EditorExportMenu";
import "@/index.css";
import { loadEditorPreferences } from "@/components/video-editor/editorPreferences";
import { useExportSettings } from "@/components/video-editor/export/useExportSettings";
import type { BatchClipExportController } from "@/components/video-editor/export/useBatchClipExport";

const noop = () => undefined;

// Minimal Electron mock: switching to the Link destination mounts
// CloudShareButton, which queries cloud share state on render.
window.electronAPI = {
	cloudShareManage: async () => ({ success: true, videos: [] }),
	onCloudShareProgress: () => () => undefined,
	discardExportedTemp: async () => ({}),
} as unknown as typeof window.electronAPI;

type BatchScenario = "idle" | "progress" | "partial" | "complete" | "cancelled";

function scenarioParam(): string {
	return new URLSearchParams(location.search).get("state") ?? "idle";
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
		handleStartBatchExport: async () => undefined,
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
					{ clipId: "a", clipIndex: 1, status: "completed", outputPath: "C:/out/clip-01.mp4" },
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
						sidecarWarning: true,
					},
				],
				completedCount: 2,
				failedCount: 2,
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
					{ clipId: "a", clipIndex: 1, status: "completed", outputPath: "C:/out/clip-01.mp4" },
					{ clipId: "b", clipIndex: 2, status: "cancelled" },
				],
				completedCount: 1,
				failedCount: 0,
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
	const [open, setOpen] = useState(false);
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
			{scenario === "idle" && (
				<div>
					<button type="button" onClick={() => exportSettings.setExportMode("separate-clips")}>
						Fixture separate clips
					</button>
					<button type="button" onClick={() => exportSettings.setExportFormat("gif")}>
						Fixture gif format
					</button>
					<button type="button" onClick={() => exportSettings.setPublishDestination("link")}>
						Fixture link destination
					</button>
					<button type="button" onClick={() => exportSettings.setPublishDestination("local")}>
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
