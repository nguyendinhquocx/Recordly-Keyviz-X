import { ExportErrorReportButton } from "@/components/feedback/ExportErrorReportButton";
import { LinkSimple, HardDrive, Export } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CloudShareButton } from "../cloud/CloudShareButton";
import { Card, TagGroup, Tag } from "@heroui/react";
import { motion, useReducedMotion } from "motion/react";
import { ProgressBar } from "@heroui/react";

import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { useI18n } from "@/contexts/I18nContext";
import { ExportSettingsMenu } from "../ExportSettingsMenu";
import type { useExportDimensions } from "../export/useExportDimensions";
import type { useExportSession } from "../export/useExportSession";
import type { useExportSettings } from "../export/useExportSettings";
import type { BatchClipExportController } from "../export/useBatchClipExport";
import type { useExportStatusViewModel } from "../export/useExportStatusViewModel";

type Props = {
	projectPath?: string | null;
	t: ReturnType<typeof useI18n>["t"];
	exportSettings: ReturnType<typeof useExportSettings>;
	exportSession: ReturnType<typeof useExportSession>;
	exportDimensions: ReturnType<typeof useExportDimensions>;
	exportStatus: ReturnType<typeof useExportStatusViewModel>;
	hasCaptionsForSidecar: boolean;
	nvidiaCudaExportAvailable: boolean;
	experimentalNvidiaCudaExport: boolean;
	setExperimentalNvidiaCudaExport: (enabled: boolean) => void;
	handleOpenExportDropdown: () => void;
	handleExportDropdownClose: () => void;
	handleCancelExport: () => void;
	handleRetrySaveExport: () => void;
	handleStartExportFromDropdown: () => void;
	revealExportedFile: () => void;
	exportMessage: string | null;
	batchExport: BatchClipExportController & {
		handleStartBatchExport: (retry?: {
			onlyClipIds: string[];
			retainedTemps: Record<string, string>;
		}) => Promise<void>;
	};
	projectTitle: string;
	prepareExportForShare: () => Promise<string | undefined>;
	onRequestShareSignIn: () => void;
	shareRequestNonce: number;
	authToken?: string;
	accountId?: string;
};

export function EditorExportMenu(props: Props) {
	const { publishDestination: destination, setPublishDestination: setDestination } =
		props.exportSettings;
	const [shareBusy, setShareBusy] = useState(false);
	const reducedMotion = useReducedMotion();
	const handledShareRequest = useRef(0);
	const contentRef = useRef<HTMLDivElement>(null);
	const [contentHeight, setContentHeight] = useState<number>();
	useLayoutEffect(() => {
		if (!props.exportSession.showExportDropdown) return;
		const content = contentRef.current;
		if (!content) return;
		// The popover scales in on entry. Its bounding rect includes that scale,
		// so measuring it would lock the wrapper to a height smaller than its content.
		const measure = () => setContentHeight(content.offsetHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		return () => observer.disconnect();
	}, [props.exportSession.showExportDropdown]);
	useEffect(() => {
		if (props.shareRequestNonce > handledShareRequest.current) {
			handledShareRequest.current = props.shareRequestNonce;
			setDestination("link");
			props.handleOpenExportDropdown();
		}
	}, [props.shareRequestNonce, props.handleOpenExportDropdown, setDestination]);

	const {
		t,
		exportSettings,
		exportSession,
		exportDimensions,
		exportStatus,
		hasCaptionsForSidecar,
		nvidiaCudaExportAvailable,
		experimentalNvidiaCudaExport,
		setExperimentalNvidiaCudaExport,
		handleOpenExportDropdown,
		handleExportDropdownClose,
		handleCancelExport,
		handleRetrySaveExport,
		handleStartExportFromDropdown,
		revealExportedFile,
		exportMessage,
		batchExport,
	} = props;
	const {
		exportQuality,
		setExportQuality,
		exportEncodingMode,
		setExportEncodingMode,
		exportPipelineModel,
		mp4FrameRate,
		setMp4FrameRate,
		exportFormat,
		setExportFormat,
		gifFrameRate,
		setGifFrameRate,
		gifLoop,
		setGifLoop,
		gifSizePreset,
		setGifSizePreset,
		includeCaptionSidecar,
		setIncludeCaptionSidecar,
	} = exportSettings;
	const {
		isExporting,
		exportProgress,
		exportError,
		showExportDropdown,
		setShowExportDropdown,
		exportedFilePath,
		hasPendingExportSave,
	} = exportSession;
	const {
		exportMode,
		setExportMode,
	} = exportSettings;
	const {
		isBatchExporting,
		batchProgress,
		batchSummary,
		batchError,
		validClipCount,
		cancelBatchExport,
		dismissBatchResult,
		handleStartBatchExport,
	} = batchExport;
	const batchModeActive = destination === "local" && exportMode === "separate-clips";
	const batchFormatBlocked = exportFormat === "gif";
	const { gifOutputDimensions, mp4OutputDimensions } = exportDimensions;
	const {
		isExportPreparing,
		isExportSaving,
		isRenderingAudio,
		isExportFinalSaveIndeterminate,
		isLightningExportInProgress,
		isLegacyExportInProgress,
		exportFinalizingProgress,
		exportRenderSpeedLabel,
		exportPercentLabel,
		runtimeLabel: exportRuntimeLabel,
		nativeSkipLabel: exportNativeSkipLabel,
	} = exportStatus;

	const settingsForm = (
		<ExportSettingsMenu
			exportFormat={destination === "link" ? "mp4" : exportFormat}
			onExportFormatChange={setExportFormat}
			exportEncodingMode={exportEncodingMode}
			onExportEncodingModeChange={setExportEncodingMode}
			mp4FrameRate={mp4FrameRate}
			onMp4FrameRateChange={setMp4FrameRate}
			exportPipelineModel={exportPipelineModel}
			experimentalNvidiaCudaExport={experimentalNvidiaCudaExport && nvidiaCudaExportAvailable}
			onExperimentalNvidiaCudaExportChange={setExperimentalNvidiaCudaExport}
			nvidiaCudaExportAvailable={nvidiaCudaExportAvailable}
			exportQuality={exportQuality}
			onExportQualityChange={setExportQuality}
			gifFrameRate={gifFrameRate}
			onGifFrameRateChange={setGifFrameRate}
			gifLoop={gifLoop}
			onGifLoopChange={setGifLoop}
			gifSizePreset={gifSizePreset}
			onGifSizePresetChange={setGifSizePreset}
			showCaptionSidecarOption={hasCaptionsForSidecar && exportFormat === "mp4"}
			includeCaptionSidecar={includeCaptionSidecar}
			onIncludeCaptionSidecarChange={setIncludeCaptionSidecar}
			mp4OutputDimensions={mp4OutputDimensions}
			gifOutputDimensions={gifOutputDimensions}
			onExport={
				batchModeActive && !batchFormatBlocked
					? () => void handleStartBatchExport()
					: handleStartExportFromDropdown
			}
			exportActionLabel={
				batchModeActive && !batchFormatBlocked
					? validClipCount > 1
						? t(
								"editor.exportActions.exportSeparateClips",
								"Export {{count}} clips",
								{ count: validClipCount },
							)
						: validClipCount === 1
							? t(
									"editor.exportActions.exportSeparateClipsOne",
									"Export 1 clip",
								)
							: t("editor.exportActions.noValidClips", "No valid clips to export")
					: undefined
			}
			exportActionDisabled={batchModeActive && !batchFormatBlocked && validClipCount === 0}
			exportActionHint={
				batchModeActive && !batchFormatBlocked && validClipCount === 0
					? t(
							"editor.exportActions.noValidClipsHint",
							"Trim the timeline to keep at least one clip before exporting.",
						)
					: undefined
			}
			hideHeading
			hideAction={destination === "link"}
			linkMode={destination === "link"}
			className="rounded-none bg-transparent px-5 pb-5 pt-0 shadow-none"
		/>
	);

	return (
		<>
			<Popover
				open={showExportDropdown}
				onOpenChange={(open) => {
					if (shareBusy) return;
					if (open) {
						handleOpenExportDropdown();
					} else setShowExportDropdown(false);
				}}
				modal={true}
			>
				<PopoverTrigger asChild>
					<Button
						type="button"
						className="inline-flex h-9 min-w-[104px] items-center justify-center gap-2 px-4.5"
					>
						<Export className="h-4 w-4" />
						<span className="text-sm font-semibold tracking-tight">Publish</span>
					</Button>
				</PopoverTrigger>
				<PopoverContent
					aria-label="Publish"
					align="end"
					sideOffset={10}
					className="w-[360px] max-h-none overflow-hidden p-0"
					// Batch commits must not be dismissible mid-flight (UX contract).
					isKeyboardDismissDisabled={shareBusy || isBatchExporting}
					shouldCloseOnInteractOutside={() => !shareBusy && !isBatchExporting}
				>
					<motion.div
						initial={false}
						animate={{ height: contentHeight ?? "auto" }}
						transition={{ duration: reducedMotion ? 0 : 0.22, ease: "easeInOut" }}
						className="overflow-hidden"
					>
						<div ref={contentRef}>
							<div className="p-5 space-y-3">
								<h2 className="text-sm font-semibold">Publish</h2>
								<TagGroup
									aria-label="Publish destination"
									selectionMode="single"
									disallowEmptySelection
									selectedKeys={[destination]}
									onSelectionChange={(keys) => {
										if (
											keys !== "all" &&
											keys.size > 0 &&
											!isExporting &&
											!shareBusy
										)
											setDestination(keys.has("link") ? "link" : "local");
									}}
								>
									<TagGroup.List className="flex gap-2">
										<Tag
											id="link"
											isDisabled={isExporting || shareBusy}
											className="h-24 flex-1 flex-col justify-center gap-2 rounded-xl border border-foreground/10"
										>
											<LinkSimple className="size-6" />
											Link
										</Tag>
										<Tag
											id="local"
											isDisabled={isExporting || shareBusy}
											className="h-24 flex-1 flex-col justify-center gap-2 rounded-xl border border-foreground/10"
										>
											<HardDrive className="size-6" />
											Local
										</Tag>
									</TagGroup.List>
								</TagGroup>
								{destination === "local" && (
									<div className="space-y-1.5">
										<TagGroup
											aria-label={t(
												"editor.exportMode.title",
												"Output",
											)}
											selectionMode="single"
											disallowEmptySelection
											selectedKeys={[exportMode]}
											onSelectionChange={(keys) => {
												if (keys === "all" || keys.size === 0) return;
												setExportMode(
													keys.has("separate-clips")
														? "separate-clips"
														: "full-timeline",
												);
											}}
										>
											<TagGroup.List className="flex gap-2">
												<Tag
													id="full-timeline"
													textValue={t(
														"editor.exportMode.fullTimeline",
														"Full timeline",
													)}
													className="h-auto min-h-10 flex-1 justify-center gap-0.5 rounded-xl border border-foreground/10 py-2"
												>
													{t(
														"editor.exportMode.fullTimeline",
														"Full timeline",
													)}
												</Tag>
												<Tag
													id="separate-clips"
													isDisabled={batchFormatBlocked}
													textValue={t(
														"editor.exportMode.separateClips",
														"Separate clips",
													)}
													className="h-auto min-h-10 flex-1 justify-center gap-0.5 rounded-xl border border-foreground/10 py-2"
												>
													{t(
														"editor.exportMode.separateClips",
														"Separate clips",
													)}
												</Tag>
											</TagGroup.List>
										</TagGroup>
										{batchModeActive && batchFormatBlocked ? (
											<p className="text-[11px] text-muted-foreground">
												{t(
													"editor.exportMode.gifUnsupported",
													"Separate clips exports MP4 only. Switch the format to MP4, or keep GIF on Full timeline.",
												)}
											</p>
										) : null}
										{batchModeActive && !batchFormatBlocked ? (
											<p className="text-[11px] text-muted-foreground">
												{t(
													"editor.exportMode.separateClipsHint",
													"Saves one MP4 per timeline clip into the folder you pick once.",
												)}
											</p>
										) : null}
										{batchError && !isBatchExporting && !batchSummary ? (
											<p className="text-[11px] text-destructive">{batchError}</p>
										) : null}
									</div>
								)}
							</div>
							<div>
								{destination === "link" ? (
									<div className="px-5 pb-5">
										<CloudShareButton
											inline
											projectPath={props.projectPath}
											projectTitle={props.projectTitle}
											prepareFile={props.prepareExportForShare}
											onCancelPrepare={handleCancelExport}
											preparationProgress={exportProgress?.percentage ?? 0}
											authToken={props.authToken}
											accountId={props.accountId}
											onBusyChange={setShareBusy}
											onRequestSignIn={() => {
												setShowExportDropdown(false);
												props.onRequestShareSignIn();
											}}
										/>
										{exportError && !shareBusy && (
											<ExportErrorReportButton
												key={exportError}
												error={exportError}
												format="mp4"
											/>
										)}
									</div>
								) : isExporting ? (
									<Card className="rounded-none bg-transparent p-5 text-foreground shadow-none">
										<div className="mb-3 flex items-center justify-between gap-3">
											<div>
												<p className="text-sm font-semibold text-foreground">
													{t(
														"editor.exportStatus.exporting",
														"Exporting",
													)}
												</p>
												<p className="text-xs text-muted-foreground">
													{t(
														"editor.exportStatus.renderingFile",
														"Rendering your file.",
													)}
												</p>
												{isLightningExportInProgress && exportMessage ? (
													<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
														{exportMessage}
													</p>
												) : null}
												{isLegacyExportInProgress ? (
													<p className="mt-1 text-[11px] text-muted-foreground/70">
														Export too slow? Cancel and try Lightning
														export!
													</p>
												) : null}
											</div>
											<Button
												type="button"
												variant="outline"
												onClick={handleCancelExport}
												className="h-8 px-3 text-xs"
											>
												{t("common.actions.cancel")}
											</Button>
										</div>
										<ProgressBar
											aria-label={t(
												"editor.exportStatus.exporting",
												"Exporting",
											)}
											isIndeterminate={
												isExportPreparing ||
												isExportSaving ||
												isExportFinalSaveIndeterminate
											}
											value={Math.min(
												isRenderingAudio
													? (exportProgress?.audioProgress ?? 0) * 100
													: (exportFinalizingProgress ??
															exportProgress?.percentage ??
															8),
												100,
											)}
										>
											<ProgressBar.Track>
												<ProgressBar.Fill />
											</ProgressBar.Track>
										</ProgressBar>
										<p className="mt-2 text-xs text-muted-foreground">
											{exportPercentLabel}
										</p>
										{isRenderingAudio ? (
											<p className="mt-1 text-[11px] text-muted-foreground/70">
												{t(
													"editor.export.processingAudioEdits",
													"Processing audio with speed/overlay edits",
												)}
											</p>
										) : exportRenderSpeedLabel ? (
											<p className="mt-1 text-[11px] text-muted-foreground/70">
												{exportRenderSpeedLabel}
											</p>
										) : null}
										{exportRuntimeLabel ? (
											<p className="mt-1 text-[11px] text-muted-foreground/70">
												Path: {exportRuntimeLabel}
											</p>
										) : null}
										{exportNativeSkipLabel ? (
											<p className="mt-1 text-[11px] text-amber-500/80">
												{exportNativeSkipLabel}
											</p>
										) : null}
									</Card>
								) : destination === "local" && isBatchExporting ? (
									<Card className="rounded-none bg-transparent p-5 text-foreground shadow-none">
										<div className="mb-3 flex items-center justify-between gap-3">
											<div>
												<p
													className="text-sm font-semibold text-foreground"
													role="status"
												>
													{t(
														"editor.batchExport.exporting",
														"Exporting clips",
													)}
												</p>
												<p className="text-xs text-muted-foreground" aria-live="polite">
													{t("editor.batchExport.progress", "{{current}} of {{total}} clips", {
														current: batchProgress?.current ?? 0,
														total: batchProgress?.total ?? 0,
													})}
												</p>
											</div>
											<Button
												type="button"
												variant="outline"
												onClick={cancelBatchExport}
												className="h-8 px-3 text-xs"
											>
												{t("common.actions.cancel")}
											</Button>
										</div>
										<ProgressBar
											aria-label={t("editor.batchExport.exporting", "Exporting clips")}
											value={
												batchProgress && batchProgress.total > 0
													? (batchProgress.current / batchProgress.total) * 100
													: 0
											}
										>
											<ProgressBar.Track>
												<ProgressBar.Fill />
											</ProgressBar.Track>
										</ProgressBar>
									</Card>
								) : destination === "local" && batchSummary ? (
									<Card className="rounded-none bg-transparent p-5 text-foreground shadow-none">
										<p className="text-sm font-semibold text-foreground" role="status">
											{batchSummary.cancelled
												? t("editor.batchExport.cancelledTitle", "Export cancelled")
												: batchSummary.failedCount > 0
													? t(
															"editor.batchExport.partialTitle",
															"Export finished with issues",
														)
													: t("editor.batchExport.completeTitle", "All clips exported")}
										</p>
										<p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
											{t(
												"editor.batchExport.resultSummary",
												"{completed} of {total} clips saved.",
												{
													completed: batchSummary.completedCount,
													total: batchSummary.items.filter(
														(item) => item.status !== "skipped",
													).length,
												},
											)}
										</p>
										{batchSummary.sidecarWarningCount > 0 ? (
											<p className="mt-1 text-[11px] text-amber-500/80">
												{t(
													"editor.batchExport.sidecarWarning",
													"{{count}} clip(s) saved without caption files.",
													{ count: batchSummary.sidecarWarningCount },
												)}
											</p>
										) : null}
										{batchSummary.items
											.filter(
												(item) =>
													item.status === "render-error" || item.status === "write-error",
											)
											.slice(0, 3)
											.map((item) => (
												<p
													key={item.clipId}
													className="mt-1 select-text break-words text-[11px] text-muted-foreground/80"
												>
													{t("editor.batchExport.clipFailed", "Clip {{index}}: {{error}}", {
														index: item.clipIndex,
														error: item.error ?? "",
													})}
												</p>
											))}
										<div className="mt-4 flex gap-2">
											{batchSummary.failedCount > 0 ? (
												<Button
													type="button"
													onClick={() => {
														const failedItems = batchSummary.items.filter(
															(item) =>
																item.status === "render-error" ||
																item.status === "write-error",
														);
														const retainedTemps: Record<string, string> = {};
														const onlyClipIds: string[] = [];
														for (const item of failedItems) {
															onlyClipIds.push(item.clipId);
															if (item.retainedTempPath) {
																retainedTemps[item.clipId] = item.retainedTempPath;
															}
														}
														dismissBatchResult();
														void handleStartBatchExport({
															onlyClipIds,
															retainedTemps,
														});
													}}
													className="h-8 flex-1 text-xs"
												>
													{t("editor.batchExport.retryFailed", "Retry failed clips")}
												</Button>
											) : null}
											<Button
												type="button"
												variant="outline"
												onClick={() => {
													dismissBatchResult();
													handleExportDropdownClose();
												}}
												className="h-8 flex-1 text-xs"
											>
												{t("common.actions.close", "Close")}
											</Button>
										</div>
										{batchError ? (
											<p className="mt-2 select-text break-words text-[11px] text-muted-foreground/80">
												{batchError}
											</p>
										) : null}
									</Card>
								) : exportError ? (
									<Card className="rounded-none bg-transparent p-5 text-foreground shadow-none">
										<p className="text-sm font-semibold text-foreground">
											{t("editor.exportStatus.issue", "Export issue")}
										</p>
										{exportRuntimeLabel ? (
											<p className="mt-1 text-[11px] text-muted-foreground/70">
												Path: {exportRuntimeLabel}
											</p>
										) : null}
										<p className="mt-1 select-text whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
											{exportError}
										</p>
										<div className="mt-4 flex gap-2">
											<Button
												type="button"
												variant="outline"
												className="h-8 text-xs"
												onClick={async () => {
													try {
														await navigator.clipboard.writeText(
															exportError,
														);
														toast.success(
															t(
																"editor.exportStatus.errorCopied",
																"Error copied",
															),
														);
													} catch {
														toast.error(
															t(
																"editor.exportStatus.errorCopyFailed",
																"Couldn't copy. Select the error text and copy it manually.",
															),
														);
													}
												}}
											>
												{t("editor.exportStatus.copyError", "Copy error")}
											</Button>
											<ExportErrorReportButton
												key={exportError}
												error={exportError}
												format={exportFormat}
											/>
											{hasPendingExportSave ? (
												<Button
													type="button"
													onClick={handleRetrySaveExport}
													className="h-8 flex-1 text-xs"
												>
													{t("editor.actions.saveAgain", "Save Again")}
												</Button>
											) : null}
											<Button
												type="button"
												variant="outline"
												onClick={handleExportDropdownClose}
												className="h-8 flex-1 text-xs"
											>
												{t("common.actions.close", "Close")}
											</Button>
										</div>
									</Card>
								) : exportedFilePath ? (
									<Card className="rounded-none bg-transparent p-5 text-foreground shadow-none">
										<p className="text-sm font-semibold text-foreground">
											{t("editor.exportStatus.complete", "Export complete")}
										</p>
										<p className="mt-1 text-xs text-muted-foreground">
											{t(
												"editor.exportStatus.savedSuccessfully",
												"Your file was saved successfully.",
											)}
										</p>
										{exportRuntimeLabel ? (
											<p className="mt-1 text-[11px] text-muted-foreground/70">
												Path: {exportRuntimeLabel}
											</p>
										) : null}
										<p className="mt-3 truncate text-xs text-muted-foreground/70">
											{exportedFilePath.split(/[\\/]/).pop()}
										</p>
										<div className="mt-4 flex gap-2">
											<Button
												type="button"
												onClick={revealExportedFile}
												className="h-8 flex-1 text-xs"
											>
												{t("editor.actions.showInFolder", "Show In Folder")}
											</Button>
											<Button
												type="button"
												variant="outline"
												onClick={handleExportDropdownClose}
												className="h-8 flex-1 text-xs"
											>
												{t("editor.cloud.done")}
											</Button>
										</div>
									</Card>
								) : (
									<>{settingsForm}</>
								)}
							</div>
						</div>
					</motion.div>
				</PopoverContent>
			</Popover>
		</>
	);
}
