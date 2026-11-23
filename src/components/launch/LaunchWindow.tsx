import { Spinner } from "@heroui/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	ArrowClockwiseIcon,
	CaretUpIcon,
	GearSix,
	House,
	Keyboard,
	DotsThreeVerticalIcon,
	MicrophoneIcon,
	MicrophoneSlashIcon,
	MonitorIcon,
	SpeakerHighIcon,
	VideoCameraIcon,
	VideoCameraSlashIcon,
	XIcon,
} from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { useScopedT } from "../../contexts/I18nContext";
import { ShortcutsProvider, useShortcuts } from "../../contexts/ShortcutsContext";
import { useKeyvizSidecar } from "../../hooks/useKeyvizSidecar";
import { useMicrophoneDevices } from "../../hooks/useMicrophoneDevices";
import { useScreenRecorder } from "../../hooks/useScreenRecorder";
import { useVideoDevices } from "../../hooks/useVideoDevices";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { HudInteractionContext } from "./contexts/HudInteractionContext";
import { FloatingWebcamPreviewView } from "./FloatingWebcamPreviewView";
import { canToggleFloatingWebcamPreview } from "./floatingWebcamPreview";
import { HudTooltip } from "./HudTooltip";
import { useCameraPermission } from "./hooks/useCameraPermission";
import { useHudBarDrag } from "./hooks/useHudBarDrag";
import { useHudHideAnimation } from "./hooks/useHudHideAnimation";
import { useHudStateTransition } from "./hooks/useHudStateTransition";
import { useLaunchHudInteractionState } from "./hooks/useLaunchHudInteractionState";
import { useLaunchWindowActions } from "./hooks/useLaunchWindowActions";
import { useLaunchWindowSystemState } from "./hooks/useLaunchWindowSystemState";
import { useRecordingTimer } from "./hooks/useRecordingTimer";
import { useWebcamPreviewOverlay } from "./hooks/useWebcamPreviewOverlay";
import { getHudInteractiveBounds } from "./hudMousePassthrough";
import styles from "./LaunchWindow.module.css";
import { MarqueeText } from "./MarqueeText";
import { KeyvizStartupErrorDialog, KeyvizUnexpectedExitBanner } from "./KeyvizDialogs";
import { CountdownPopover } from "./popovers/CountdownPopover";
import {
	LaunchPopoverCoordinatorProvider,
	useLaunchPopoverCoordinator,
} from "./popovers/LaunchPopoverCoordinator";
import { DropdownItem, HudPopover } from "./popovers/PopoverScaffold";
import { MicPopover } from "./popovers/MicPopover";
import { WebcamPopover } from "./popovers/WebcamPopover";
import { RecordButton } from "./RecordButton";
import { RecordingControls } from "./RecordingControls";
import { ShortcutsConfigDialog } from "../video-editor/ShortcutsConfigDialog";

export function LaunchWindow() {
	return (
		<LaunchPopoverCoordinatorProvider>
			<ShortcutsProvider>
				<LaunchWindowContent />
				<ShortcutsConfigDialog />
			</ShortcutsProvider>
		</LaunchPopoverCoordinatorProvider>
	);
}

function LaunchWindowContent() {
	const t = useScopedT("launch");
	const { openId, requestOpen, requestClose } = useLaunchPopoverCoordinator();
	const { openConfig: openShortcutsConfig, isConfigOpen, recordingShortcuts } = useShortcuts();
	const keyviz = useKeyvizSidecar();

	const {
		recording,
		paused,
		finalizing,
		restarting,
		countdownActive,
		toggleRecording,
		pauseRecording,
		resumeRecording,
		cancelRecording,
		cancelRecordingStart,
		microphoneEnabled,
		setMicrophoneEnabled,
		microphoneDeviceId,
		setMicrophoneDeviceId,
		systemAudioEnabled,
		setSystemAudioEnabled,
		webcamEnabled,
		webcamRecordingError,
		setWebcamEnabled,
		webcamDeviceId,
		setWebcamDeviceId,
		countdownDelay,
		setCountdownDelay,
		preparePermissions,
	} = useScreenRecorder(keyviz);

	const { elapsed, formatTime } = useRecordingTimer(recording, paused);
	const hudContentRef = useRef<HTMLDivElement>(null);
	const hudBarRef = useRef<HTMLDivElement>(null);
	const hideHud = useHudHideAnimation(hudBarRef);

	const { selectedSource, hasSelectedSource, syncSelectedSource } = useLaunchWindowActions();
	const sourceDescriptionId = useId();

	const { hudOverlayMousePassthroughSupported, platform, dragX11Window } =
		useLaunchWindowSystemState(preparePermissions);
	const webcamPopoverOpen = openId === "webcam";
	const cameraPermission = useCameraPermission(platform, webcamPopoverOpen, webcamEnabled);
	const cameraAllowed = cameraPermission === "granted";
	const showWebcamControls =
		webcamEnabled && !recording && (cameraAllowed || Boolean(webcamRecordingError));
	const { devices, selectedDeviceId, setSelectedDeviceId } = useMicrophoneDevices(
		microphoneEnabled || openId === "mic",
		microphoneDeviceId,
	);
	useEffect(() => {
		if (!selectedDeviceId || selectedDeviceId === "default") {
			return;
		}

		setMicrophoneDeviceId(selectedDeviceId);
	}, [selectedDeviceId, setMicrophoneDeviceId]);

	const webcamPreview = useWebcamPreviewOverlay({
		webcamEnabled: webcamEnabled && (cameraAllowed || Boolean(webcamRecordingError)),
		webcamDeviceId,
		webcamRecordingError,
		showWebcamControls,
		webcamPopoverOpen,
		hudOverlayMousePassthroughSupported,
		hudBarRef,
	});
	const {
		devices: videoDevices,
		selectedDeviceId: selectedVideoDeviceId,
		setSelectedDeviceId: setSelectedVideoDeviceId,
	} = useVideoDevices(
		cameraAllowed && (webcamEnabled || webcamPopoverOpen),
		webcamDeviceId,
		webcamPopoverOpen && !webcamPreview.editorMode,
	);
	useEffect(() => {
		if (selectedVideoDeviceId && selectedVideoDeviceId !== "default") {
			setWebcamDeviceId(selectedVideoDeviceId);
		}
	}, [selectedVideoDeviceId, setWebcamDeviceId]);

	const {
		webcamPreviewRoundness,
		webcamPreviewShape,
		showFloatingWebcamPreview,
		setShowFloatingWebcamPreview,
		showRecordingWebcamPreview,
		recordingWebcamPreviewContainerRef,
		isWebcamPreviewDraggingRef,
		webcamPreviewDragStartRef,
		setWebcamPreviewNode,
	} = webcamPreview;

	useEffect(() => {
		window.electronAPI?.hudOverlaySetWebcamPreviewVisible?.(showRecordingWebcamPreview);
	}, [showRecordingWebcamPreview]);

	// Global shortcut hotkey = bấm nút HUD — state luôn nhất quán (spec Task 4).
	useEffect(() => {
		const unsubscribe = window.electronAPI?.onRecordingHotkey?.((action) => {
			if (isConfigOpen || keyviz.pendingDecision !== null) return;
			if (action === "start" && !recording && !finalizing) {
				toggleRecording();
			} else if (action === "stop" && recording) {
				toggleRecording();
			} else if (action === "pause-resume" && recording) {
				if (paused) {
					resumeRecording();
				} else {
					pauseRecording();
				}
			}
		});
		return () => unsubscribe?.();
	}, [isConfigOpen, keyviz.pendingDecision, recording, paused, finalizing, toggleRecording, pauseRecording, resumeRecording]);

	// Chord điều khiển quay bị lọc khỏi overlay trước mỗi lần quay (spec Task 3/4).
	useEffect(() => {
		keyviz.setSuppressedShortcuts([
			recordingShortcuts.start,
			recordingShortcuts.stop,
			recordingShortcuts["pause-resume"],
		]);
	}, [keyviz, recordingShortcuts]);

	useEffect(() => {
		return () => {
			window.electronAPI?.hudOverlaySetWebcamPreviewVisible?.(false);
		};
	}, []);

	const {
		recordingHudOffset,
		isHudDragging,
		hudBarTransformRef,
		isHudDraggingRef,
		handleHudBarPointerDown,
		handleHudBarPointerMove,
		handleHudBarPointerUp,
	} = useHudBarDrag({
		hudContentRef,
		hudBarRef,
		recordingWebcamPreviewContainerRef,
		docked: showRecordingWebcamPreview,
		dragX11Window,
	});

	const useRecordingShape = dragX11Window && (recording || restarting || finalizing);
	useEffect(() => {
		const reportInteractiveBounds = () => {
			const interactiveBounds = getHudInteractiveBounds(document);
			const recordingShape = useRecordingShape
				? interactiveBounds.concat(
						Array.from(document.querySelectorAll('[role="tooltip"]'), (element) => {
							const { left, top, right, bottom } = element.getBoundingClientRect();
							return { left, top, right, bottom };
						}),
					)
				: undefined;
			window.electronAPI?.hudOverlaySetInteractiveBounds?.(
				interactiveBounds.map((rect) => ({
					left: window.screenX + rect.left,
					top: window.screenY + rect.top,
					right: window.screenX + rect.right,
					bottom: window.screenY + rect.bottom,
					shape: rect.shape,
				})),
				recordingShape,
			);
		};

		reportInteractiveBounds();
		// Keep native recovery current even when Windows stops forwarding mouse
		// events. Include popovers and toasts, not just the main bar and webcam.
		const boundsTimer = window.setInterval(reportInteractiveBounds, 100);
		const resizeObserver = new ResizeObserver(reportInteractiveBounds);
		if (hudBarRef.current) resizeObserver.observe(hudBarRef.current);
		if (recordingWebcamPreviewContainerRef.current) {
			resizeObserver.observe(recordingWebcamPreviewContainerRef.current);
		}
		window.addEventListener("mousemove", reportInteractiveBounds);
		window.addEventListener("resize", reportInteractiveBounds);

		return () => {
			window.clearInterval(boundsTimer);
			resizeObserver.disconnect();
			window.removeEventListener("mousemove", reportInteractiveBounds);
			window.removeEventListener("resize", reportInteractiveBounds);
			window.electronAPI?.hudOverlaySetInteractiveBounds?.(null);
		};
	}, [useRecordingShape, recordingWebcamPreviewContainerRef]);

	const { handleHudMouseEnter, handleHudMouseLeave, beginInteractiveHudAction } =
		useLaunchHudInteractionState({
			openId,
			hudDialogOpen: isConfigOpen || keyviz.pendingDecision !== null,
			isHudDraggingRef,
			isWebcamPreviewDraggingRef,
			webcamPreviewDragStartRef,
		});

	const pickerPending = useRef(false);
	const [isPickerPending, setIsPickerPending] = useState(false);
	const [sourceReady, setSourceReady] = useState(false);
	const handlePickOnScreen = useCallback(async () => {
		if (pickerPending.current || recording || finalizing) return false;
		pickerPending.current = true;
		setIsPickerPending(true);
		beginInteractiveHudAction();
		try {
			if (!(await cancelRecordingStart())) return false;
			if (!(await preparePermissions())) return false;
			const result = await window.electronAPI.pickCaptureTarget();
			const source = result.success && !result.canceled ? result.source : undefined;
			if (source) syncSelectedSource(source);
			if (result.message && !result.canceled) {
				if (result.success) toast.info(result.message);
				else toast.error(result.message);
			}
			return Boolean(source);
		} catch {
			toast.error(captureT("pickerError"));
			return false;
		} finally {
			pickerPending.current = false;
			setIsPickerPending(false);
			// The native picker temporarily overrides passthrough outside this hook.
			beginInteractiveHudAction();
		}
	}, [
		captureT,
		recording,
		cancelRecordingStart,
		preparePermissions,
		finalizing,
		beginInteractiveHudAction,
		syncSelectedSource,
	]);
	const recordAfterPickingSource = async () => {
		if (!(await handlePickOnScreen())) return;
		const recordingPlatform =
			platform ?? (await window.electronAPI.getPlatform().catch(() => null));
		if (recordingPlatform === "win32" || recordingPlatform === "darwin") {
			await toggleRecording();
		}
	};

	useEffect(() => {
		let mounted = true;
		let selectionEventSeen = false;

		void window.electronAPI
			.getSelectedSource()
			.then((source) => {
				if (mounted) setSourceReady(true);
				if (mounted && !selectionEventSeen) {
					syncSelectedSource(source);
				}
			})
			.catch(() => {
				if (mounted) {
					setSourceReady(true);
					toast.error(captureT("sourceLoadError"));
				}
			});

		const cleanup = window.electronAPI.onSelectedSourceChanged((source) => {
			selectionEventSeen = true;
			if (mounted) syncSelectedSource(source);
		});

		return () => {
			mounted = false;
			cleanup?.();
		};
	}, [syncSelectedSource, captureT]);

	const cancelPendingStart = useCallback(async () => {
		try {
			return await cancelRecordingStart();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
			return false;
		}
	}, [cancelRecordingStart]);
	const openHome = async () => {
		if (!(await cancelPendingStart())) return;
		localStorage.setItem("recordly.open-dashboard", String(Date.now()));
		void window.electronAPI.showProjectDashboard();
	};
	const homeButton = (
		<HudTooltip label={t("recording.home")}>
			<Button
				variant="ghost"
				size="icon"
				iconSize="lg"
				aria-label={t("recording.home")}
				onClick={openHome}
			>
				<House weight="fill" className="size-5" />
			</Button>
		</HudTooltip>
	);

	const recordingControls = (
		<RecordingControls
			busy={restarting || discarding}
			paused={paused}
			elapsed={elapsed}
			onPauseResume={paused ? resumeRecording : pauseRecording}
			onStopRecording={toggleRecording}
			onCancelRecording={async () => {
				if (discarding) return;
				setDiscarding(true);
				try {
					await cancelRecording();
				} finally {
					setDiscarding(false);
				}
			}}
			formatTime={formatTime}
		/>
	);
	let recordingAnnouncement = "";
	if (discarding) recordingAnnouncement = captureT("discardingRecording");
	else if (finalizing && !restarting) recordingAnnouncement = captureT("finishingRecording");
	else if (recording || restarting)
		recordingAnnouncement = paused ? t("recording.paused") : captureT("recording");

	const idleControls = (
		<div
			role="group"
			aria-label={captureT("recordingSetup")}
			className={styles.recordingControls}
		>
			<RecordButton
				countdownActive={countdownActive}
				countdownDelay={countdownDelay}
				disabled={isPickerPending || !sourceReady}
				onRecord={hasSelectedSource ? toggleRecording : recordAfterPickingSource}
				onCancel={() => void cancelPendingStart()}
			/>
			<HudTooltip
				label={
					hasSelectedSource
						? t("recording.settingValue", "{{setting}}: {{value}}", {
								setting: captureT("chooseSource"),
								value: selectedSource,
							})
						: captureT("chooseSource")
				}
			>
				<Button
					variant="ghost"
					size="lg"
					className={`${styles.electronNoDrag} ${styles.sourceControl} group gap-2`}
					aria-label={captureT("chooseSource")}
					aria-describedby={hasSelectedSource ? sourceDescriptionId : undefined}
					disabled={isPickerPending || !sourceReady || recording || finalizing}
					onClick={() => void handlePickOnScreen()}
				>
					<MonitorIcon size={18} className="size-5 shrink-0" />
					<div className="min-w-0 overflow-hidden">
						{hasSelectedSource ? (
							<MarqueeText text={selectedSource} />
						) : (
							<span>{captureT("pickSource")}</span>
						)}
					</div>
				</Button>
			</HudTooltip>
			{hasSelectedSource && (
				<span id={sourceDescriptionId} className="sr-only">
					{selectedSource}
				</span>
			)}
			<span aria-hidden="true" className={styles.sourceDivider} />
			<MicPopover
				disabled={recording || countdownActive}
				systemAudioEnabled={systemAudioEnabled}
				onToggleSystemAudio={() => setSystemAudioEnabled(!systemAudioEnabled)}
				microphoneEnabled={microphoneEnabled}
				onDisableMicrophone={() => setMicrophoneEnabled(false)}
				devices={devices}
				microphoneDeviceId={microphoneDeviceId}
				selectedDeviceId={selectedDeviceId}
				onSelectDevice={(deviceId) => {
					setMicrophoneEnabled(true);
					setSelectedDeviceId(deviceId);
					setMicrophoneDeviceId(deviceId === "default" ? undefined : deviceId);
				}}
				trigger={
					<Button
						variant="ghost"
						size="icon"
						iconSize="lg"
						disabled={countdownActive}
						aria-label={t("recording.audioSettings", "Audio settings")}
						className={microphoneEnabled || systemAudioEnabled ? "text-accent" : ""}
					>
						{microphoneEnabled ? (
							<MicrophoneIcon
								weight={microphoneEnabled ? "fill" : "regular"}
								className="size-5"
								size={18}
							/>
						) : systemAudioEnabled ? (
							<SpeakerHighIcon className="size-5" />
						) : (
							<MicrophoneSlashIcon className="size-5" />
						)}
					</Button>
				}
			/>

			<WebcamPopover
				disabled={recording || countdownActive}
				cameraPermission={cameraPermission}
				webcamEnabled={webcamEnabled}
				onDisableWebcam={() => setWebcamEnabled(false)}
				canToggleFloatingPreview={
					cameraAllowed &&
					canToggleFloatingWebcamPreview(hudOverlayMousePassthroughSupported)
				}
				showFloatingWebcamPreview={showFloatingWebcamPreview}
				onToggleFloatingPreview={() => setShowFloatingWebcamPreview((current) => !current)}
				showWebcamControls={showWebcamControls && !showRecordingWebcamPreview}
				previewError={webcamPreview.webcamPreviewError}
				roundness={webcamPreviewRoundness}
				shape={webcamPreviewShape}
				setWebcamPreviewNode={setWebcamPreviewNode}
				videoDevices={videoDevices}
				webcamDeviceId={webcamDeviceId}
				selectedVideoDeviceId={selectedVideoDeviceId}
				onSelectVideoDevice={(deviceId) => {
					setWebcamEnabled(true);
					setSelectedVideoDeviceId(deviceId);
					setWebcamDeviceId(deviceId);
				}}
				trigger={
					<Button
						variant="ghost"
						size="icon"
						iconSize="lg"
						disabled={countdownActive}
						aria-label={t("recording.cameraSettings", "Camera settings")}
						className={webcamEnabled ? "text-accent" : ""}
					>
						{webcamEnabled ? (
							<VideoCameraIcon
								weight={webcamEnabled ? "fill" : "regular"}
								className="size-5"
								size={18}
							/>
						) : (
							<VideoCameraSlashIcon className="size-5" />
						)}
					</Button>
				}
			/>

			<CountdownPopover
				countdownDelay={countdownDelay}
				onSelectDelay={setCountdownDelay}
				trigger={
					<Button
						variant="ghost"
						size="icon"
						iconSize="lg"
						disabled={countdownActive}
						aria-label={t("recording.countdownDelay")}
						className={countdownDelay > 0 ? "text-accent" : ""}
					>
						<CountdownDelayIcon seconds={countdownDelay} className="size-5" />
					</Button>
				}
			/>

			{keyviz.supported && (
				<Button
					variant="ghost"
					size="icon"
					iconSize="lg"
					aria-pressed={keyviz.enabled === true}
					aria-label={
						keyviz.enabled
							? t("keyviz.toggleOff", "Disable keyboard overlay")
							: t("keyviz.toggleOn", "Enable keyboard overlay")
					}
					title={
						keyviz.enabled
							? t("keyviz.toggleOff", "Disable keyboard overlay")
							: t("keyviz.toggleOn", "Enable keyboard overlay")
					}
					className={keyviz.enabled ? "text-accent" : ""}
					onClick={() => keyviz.setEnabled(!keyviz.enabled)}
				>
					<Keyboard weight={keyviz.enabled ? "fill" : "regular"} className="size-5" />
				</Button>
			)}

			<HudPopover
				open={openId === "keyviz-config"}
				onOpenChange={(open) =>
					open ? requestOpen("keyviz-config") : requestClose("keyviz-config")
				}
				trigger={
					<Button
						variant="ghost"
						size="icon"
						iconSize="lg"
						aria-label={t("keyviz.configMenu", "Recording configuration")}
						title={t("keyviz.configMenu", "Recording configuration")}
						className={
							openId === "keyviz-config"
								? "border-[var(--launch-border-strong)] bg-[var(--launch-hover)]"
								: ""
						}
					>
						<GearSix
							weight={openId === "keyviz-config" ? "fill" : "regular"}
							className="size-5"
						/>
					</Button>
				}
			>
				<div className="flex min-w-52 flex-col gap-1 p-2">
					<DropdownItem
						onClick={() => {
							beginInteractiveHudAction();
						openShortcutsConfig();
						requestClose("keyviz-config");
						}}
						icon={<Keyboard size={16} />}
					>
						{t("keyviz.configShortcuts", "Keyboard shortcuts")}
					</DropdownItem>
					{keyviz.supported && (
						<DropdownItem
							onClick={() => {
								void keyviz.openSettings().then((result) => {
									if (result.success) return;
									const errorKey =
										result.error === "binary_missing"
										? "keyviz.settingsMissing"
										: result.error === "unsupported_platform"
											? "keyviz.settingsUnsupported"
											: result.error === "capturing"
												? "keyviz.settingsDuringRecording"
												: "keyviz.settingsFailed";
								toast.error(t(errorKey));
								});
							}}
							icon={<GearSix size={16} />}
						>
							{t("keyviz.configKeyvizSettings", "Keyviz settings")}
						</DropdownItem>
					)}
				</div>
			</HudPopover>

			<Button
				type="button"
				variant="destructive"
				size="icon"
				className={styles.electronNoDrag}
				onClick={
					hasSelectedSource || platform === "linux"
						? toggleRecording
						: () => {
								beginInteractiveHudAction();
								requestOpen("sources");
							}
				}
				disabled={countdownActive}
				title={t("recording.record")}
			>
				<div className={styles.recDot} />
			</Button>

			<Separator orientation="vertical" className="mx-[5px] h-6 self-center" />

			{homeButton}
			<HudTooltip label={t("recording.hideHud")}>
				<Button
					variant="ghost"
					size="icon"
					iconSize="lg"
					onClick={hideHud}
					disabled={countdownActive}
					aria-label={t("recording.hideHud")}
				>
					<XIcon className="size-5" />
				</Button>
			</HudTooltip>
		</div>
	);

	const useNativeHudBarDrag =
		!dragX11Window && (platform === "linux" || hudOverlayMousePassthroughSupported === false);
	const finishHudTransition = useHudStateTransition(
		hudBarRef,
		finalizing && !restarting ? "finalizing" : recording || restarting ? "recording" : "idle",
		showRecordingWebcamPreview,
	);

	const hudBar = (
		<div
			ref={hudBarTransformRef}
			className={showRecordingWebcamPreview ? styles.webcamHudDock : undefined}
			style={{
				transform: showRecordingWebcamPreview
					? undefined
					: `translate3d(${recordingHudOffset.x}px, ${recordingHudOffset.y}px, 0)`,
			}}
		>
			<div
				ref={hudBarRef}
				data-hud-surface
				onPointerDownCapture={finishHudTransition}
				data-hud-dragging={isHudDragging}
				className={`${styles.bar} ${styles.recordingBar} ${useNativeHudBarDrag ? styles.electronDrag : ""} launch-theme pointer-events-auto`}
				data-recording-state={
					finalizing
						? "finalizing"
						: recording
							? paused
								? "paused"
								: "recording"
							: "idle"
				}
				onPointerDown={
					showRecordingWebcamPreview || useNativeHudBarDrag
						? undefined
						: handleHudBarPointerDown
				}
				onPointerMove={showRecordingWebcamPreview ? undefined : handleHudBarPointerMove}
				onPointerUp={showRecordingWebcamPreview ? undefined : handleHudBarPointerUp}
				onPointerCancel={showRecordingWebcamPreview ? undefined : handleHudBarPointerUp}
				onLostPointerCapture={
					showRecordingWebcamPreview ? undefined : handleHudBarPointerUp
				}
				onMouseEnter={handleHudMouseEnter}
				onMouseLeave={handleHudMouseLeave}
			>
				<div className={styles.barStateViewport}>
					<div className={styles.barState}>
						{finalizing && !restarting ? (
							<div
								className={`${styles.recordingControls} ${styles.recordingFinalizing} gap-2 text-sm text-muted-foreground`}
							>
								<Spinner size="sm" />
								{captureT("finishingRecording", "Finishing recording…")}
							</div>
						) : recording || restarting ? (
							recordingControls
						) : (
							idleControls
						)}
					</div>
				</div>
			</div>
		</div>
	);

	return (
		<HudInteractionContext.Provider
			value={{ onMouseEnter: handleHudMouseEnter, onMouseLeave: handleHudMouseLeave }}
		>
			<span className="sr-only" role="status" aria-atomic="true">
				{recordingAnnouncement}
			</span>
			<div
				className="w-full flex justify-center bg-transparent overflow-visible items-end pb-6 pointer-events-none"
				style={{ height: "100vh" }}
			>
				<div
					ref={hudContentRef}
					className="flex items-center overflow-visible flex-col-reverse pointer-events-none"
				>
					<div className="flex flex-col items-center pointer-events-none p-2">
						<div
							ref={hudBarTransformRef}
							style={{
								transform: `translate3d(${recordingHudOffset.x}px, ${recordingHudOffset.y}px, 0)`,
							}}
						>
							<KeyvizUnexpectedExitBanner keyviz={keyviz} onStopRecording={toggleRecording} />
							<motion.div
								ref={hudBarRef}
								layout={shouldAnimateHudLayout}
								transition={hudStateTransition}
								className={`${styles.bar} launch-theme mb-2 pointer-events-auto`}
								onMouseEnter={handleHudMouseEnter}
								onMouseLeave={handleHudMouseLeave}
							>
								<div
									// Linux compositors and non-passthrough Windows fallback windows
									// need native window dragging; the JS drag path only translates
									// content inside the HUD window.
									className={`flex items-center px-0.5 cursor-grab active:cursor-grabbing ${
										useNativeHudBarDrag ? styles.electronDrag : ""
									}`}
									onPointerDown={handleHudBarPointerDown}
									onPointerMove={handleHudBarPointerMove}
									onPointerUp={handleHudBarPointerUp}
									onPointerCancel={handleHudBarPointerUp}
								>
									<DotsThreeVerticalIcon
										weight="fill"
										size={18}
										className="text-[#6b6b78]"
									/>
								</div>

								<div className={styles.barStateViewport}>
									<AnimatePresence initial={false} mode="wait">
										<motion.div
											key={hudMode}
											layout={shouldAnimateHudLayout}
											className={styles.barState}
											initial={{
												opacity: 0,
												y: 10,
												scale: 0.985,
												filter: "blur(8px)",
											}}
											animate={{
												opacity: 1,
												y: 0,
												scale: 1,
												filter: "blur(0px)",
											}}
											exit={{
												opacity: 0,
												y: -10,
												scale: 0.985,
												filter: "blur(6px)",
											}}
											transition={hudStateTransition}
										>
											{finalizing
												? finalizingControls
												: recording
													? recordingControls
													: idleControls}
										</motion.div>
									</AnimatePresence>
								</div>
							</motion.div>
						</div>
						{showRecordingWebcamPreview && (
							<FloatingWebcamPreviewView
								preview={webcamPreview}
								hudBar={hudBar}
								finishHudTransition={finishHudTransition}
								handleHudMouseEnter={handleHudMouseEnter}
								handleHudMouseLeave={handleHudMouseLeave}
								title={t("recording.webcam")}
							/>
						)}
					</div>
				</div>
			</div>
			<KeyvizStartupErrorDialog keyviz={keyviz} />
		</HudInteractionContext.Provider>
	);
}
