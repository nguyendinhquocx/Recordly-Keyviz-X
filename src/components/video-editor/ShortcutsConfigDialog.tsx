import { Kbd, Description, Modal } from "@heroui/react";
import { Keyboard, ArrowCounterClockwise as RotateCcw } from "@/components/ui/icons";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useShortcuts, type RecordingShortcutsConfig } from "@/contexts/ShortcutsContext";
import {
	DEFAULT_SHORTCUTS,
	bindingsEqual,
	FIXED_SHORTCUTS,
	findConflict,
	findRecordingShortcutConflict,
	formatBinding,
	hasGlobalRecordingModifier,
	isSupportedGlobalShortcutKey,
	SHORTCUT_ACTIONS,
	SHORTCUT_LABELS,
	type ShortcutAction,
	type ShortcutBinding,
	type ShortcutConflict,
	type ShortcutsConfig,
} from "@/lib/shortcuts";
import {
	DEFAULT_RECORDING_SHORTCUTS,
	RECORDING_SHORTCUT_ACTIONS,
	type RecordingShortcutAction,
} from "@/contexts/ShortcutsContext";
import { useI18n, useScopedT } from "../../contexts/I18nContext";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

const RECORDING_LABEL_KEYS: Record<RecordingShortcutAction, string> = {
	start: "shortcutsConfig.recordingStart",
	stop: "shortcutsConfig.recordingStop",
	"pause-resume": "shortcutsConfig.recordingPauseResume",
};

export function ShortcutsConfigDialog() {
	const t = useScopedT("dialogs");
	const { t: tShortcuts } = useI18n();
	const {
		shortcuts,
		recordingShortcuts,
		isMac,
		isConfigOpen,
		closeConfig,
		persistShortcuts,
	} = useShortcuts();

	const editorActive = inline ? active : isConfigOpen;

	const [draft, setDraft] = useState<ShortcutsConfig>(shortcuts);
	const [recordingDraft, setRecordingDraft] = useState<RecordingShortcutsConfig>(recordingShortcuts);
	const [captureFor, setCaptureFor] = useState<ShortcutAction | null>(null);
	const [captureForRecording, setCaptureForRecording] = useState<RecordingShortcutAction | null>(
		null,
	);
	const [registerFailures, setRegisterFailures] = useState<Record<string, boolean>>({});
	const [registerInvalid, setRegisterInvalid] = useState<Record<string, boolean>>({});
	const captureActive = captureFor !== null || captureForRecording !== null;
	const wasConfigOpenRef = useRef(false);
	const [conflict, setConflict] = useState<{
		forAction: ShortcutAction;
		pending: ShortcutBinding;
		conflictWith: ShortcutConflict;
	} | null>(null);

	useEffect(() => {
		if (!isConfigOpen) {
			wasConfigOpenRef.current = false;
			return;
		}
		if (wasConfigOpenRef.current) return;
		wasConfigOpenRef.current = true;
		setDraft(shortcuts);
		setRecordingDraft(recordingShortcuts);
		setCaptureFor(null);
		setCaptureForRecording(null);
		setConflict(null);
	}, [isConfigOpen, shortcuts, recordingShortcuts]);

	useEffect(() => {
		if (!isConfigOpen) return;
		setRegisterFailures({});
		setRegisterInvalid({});
		let cancelled = false;
		const register = window.electronAPI?.registerGlobalRecordingHotkeys?.();
		if (!register) return;
		void register.then((results) => {
			if (cancelled) return;
			const statuses: Record<string, boolean> = {};
			const invalid: Record<string, boolean> = {};
			for (const result of results) {
				statuses[result.action] = !result.registered;
				invalid[result.action] = result.code === "invalid";
			}
			setRegisterFailures(statuses);
			setRegisterInvalid(invalid);
		}).catch(() => {
			if (cancelled) return;
			setRegisterFailures(
				Object.fromEntries(RECORDING_SHORTCUT_ACTIONS.map((action) => [action, true])),
			);
			setRegisterInvalid({});
		});
		return () => {
			cancelled = true;
		};
	}, [isConfigOpen]);

	useLayoutEffect(() => {
		if (!captureActive) return;
		window.electronAPI?.suspendGlobalRecordingHotkeys?.();
		return () => {
			const resume = window.electronAPI?.resumeGlobalRecordingHotkeys;
			if (!resume) return;
			void resume()
				.then((results) => {
					const statuses: Record<string, boolean> = {};
					const invalid: Record<string, boolean> = {};
					for (const result of results) {
						statuses[result.action] = !result.registered;
						invalid[result.action] = result.code === "invalid";
					}
					setRegisterFailures(statuses);
					setRegisterInvalid(invalid);
				})
				.catch(() => {
					setRegisterFailures(
						Object.fromEntries(RECORDING_SHORTCUT_ACTIONS.map((action) => [action, true])),
					);
					setRegisterInvalid({});
				});
		};
	}, [captureActive]);

	/** Chord recording có trùng binding cho không (dùng cho editor capture + recording capture). */
	const findRecordingConflict = useCallback(
		(binding: ShortcutBinding, exceptAction?: RecordingShortcutAction) => {
			for (const action of RECORDING_SHORTCUT_ACTIONS) {
				if (action === exceptAction) continue;
				if (recordingDraft[action] && bindingsEqual(recordingDraft[action], binding)) {
					return action;
				}
			}
			return null;
		},
		[recordingDraft],
	);

	useEffect(() => {
		if (!captureFor || !editorActive) return;

		const handleCapture = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();

			if (e.key === "Escape") {
				setCaptureFor(null);
				return;
			}

			if (MODIFIER_KEYS.has(e.key)) return;

			const binding: ShortcutBinding = {
				key: e.key.toLowerCase(),
				...(e.ctrlKey || e.metaKey ? { ctrl: true } : {}),
				...(e.shiftKey ? { shift: true } : {}),
				...(e.altKey ? { alt: true } : {}),
			};

			const found = findConflict(binding, captureFor, draft);
			const recordingConflict = findRecordingConflict(binding);
			setCaptureFor(null);

			if (found?.type === "fixed") {
				toast.error(t("shortcutsConfig.reserved", undefined, { label: tShortcuts(found.label) }));
				return;
			}

			if (recordingConflict) {
				toast.error(
					t("shortcutsConfig.conflictsWithRecording", undefined, {
						action: t(RECORDING_LABEL_KEYS[recordingConflict]),
					}),
				);
				return;
			}

			if (found?.type === "configurable") {
				setConflict({ forAction: captureFor, pending: binding, conflictWith: found });
				return;
			}

			setDraft((prev: ShortcutsConfig) => ({ ...prev, [captureFor]: binding }));
		};

		window.addEventListener("keydown", handleCapture, { capture: true });
		return () => window.removeEventListener("keydown", handleCapture, { capture: true });
	}, [captureFor, draft, t, tShortcuts, findRecordingConflict]);

	// Capture phím cho global recording hotkeys — cùng cơ chế với editor.
	useEffect(() => {
		if (!captureForRecording) return;

		const handleCapture = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();

			if (e.key === "Escape") {
				setCaptureForRecording(null);
				return;
			}

			if (MODIFIER_KEYS.has(e.key)) return;

			const binding: ShortcutBinding = {
				key: e.key.toLowerCase(),
				...(e.ctrlKey || e.metaKey ? { ctrl: true } : {}),
				...(e.shiftKey ? { shift: true } : {}),
				...(e.altKey ? { alt: true } : {}),
			};
			const target = captureForRecording;
			setCaptureForRecording(null);
			if (!hasGlobalRecordingModifier(binding)) {
				toast.error(t("shortcutsConfig.globalModifierRequired"));
				return;
			}
			if (!isSupportedGlobalShortcutKey(binding.key)) {
				toast.error(t("shortcutsConfig.globalInvalid"));
				return;
			}

			// Check every fixed, editor, and recording binding; no editor action is exempt.
			const crossConflict = findRecordingShortcutConflict(
				binding,
				draft,
				recordingDraft,
				target,
			);
			if (crossConflict?.type === "fixed") {
				toast.error(
					t("shortcutsConfig.reserved", undefined, {
						label: tShortcuts(crossConflict.label),
					}),
				);
				return;
			}
			if (crossConflict?.type === "editor") {
				toast.error(
					t("shortcutsConfig.alreadyUsedBy", undefined, {
						action: tShortcuts(SHORTCUT_LABELS[crossConflict.action]),
					}),
				);
				return;
			}
			if (crossConflict?.type === "recording") {
				toast.error(
					t("shortcutsConfig.conflictsWithRecording", undefined, {
						action: t(RECORDING_LABEL_KEYS[crossConflict.action]),
					}),
				);
				return;
			}

			setRecordingDraft((prev) => ({ ...prev, [target]: binding }));
			setRegisterFailures((prev) => {
				const next = { ...prev };
				delete next[target];
				return next;
			});
			setRegisterInvalid((prev) => {
				const next = { ...prev };
				delete next[target];
				return next;
			});
		};

		window.addEventListener("keydown", handleCapture, { capture: true });
		return () => window.removeEventListener("keydown", handleCapture, { capture: true });
	}, [captureForRecording, draft, t, tShortcuts, findRecordingConflict]);

	const handleSwap = useCallback(() => {
		if (!conflict || conflict.conflictWith.type !== "configurable") return;
		const { forAction, pending, conflictWith } = conflict;
		setDraft((prev: ShortcutsConfig) => ({
			...prev,
			[forAction]: pending,
			[conflictWith.action]: prev[forAction],
		}));
		setConflict(null);
	}, [conflict]);

	const handleCancelConflict = useCallback(() => setConflict(null), []);

	const handleSave = useCallback(async () => {
		try {
			// Save cả hai nhóm trong một IPC để editor draft không bị ghi đè bởi closure cũ.
			await persistShortcuts(draft, recordingDraft);
		} catch {
			toast.error(t("shortcutsConfig.saveFailed", "Could not save shortcuts."));
			return;
		}

		try {
			const results = await window.electronAPI?.registerGlobalRecordingHotkeys?.();
			if (results) {
				const failures: Record<string, boolean> = {};
				const invalid: Record<string, boolean> = {};
				for (const result of results) {
					failures[result.action] = !result.registered;
					invalid[result.action] = result.code === "invalid";
				}
				setRegisterFailures(failures);
				setRegisterInvalid(invalid);
				if (Object.values(failures).some(Boolean)) {
					toast.warning(t("shortcutsConfig.globalUnavailable"));
					return;
				}
			}
		} catch {
			setRegisterFailures(
				Object.fromEntries(RECORDING_SHORTCUT_ACTIONS.map((action) => [action, true])),
			);
			setRegisterInvalid({});
			toast.warning(t("shortcutsConfig.globalUnavailable"));
			return;
		}

		toast.success(t("shortcutsConfig.saved"));
		setCaptureFor(null);
		setCaptureForRecording(null);
		setConflict(null);
		closeConfig();
	}, [draft, recordingDraft, persistShortcuts, closeConfig, t]);

	const handleReset = useCallback(() => {
		setDraft({ ...DEFAULT_SHORTCUTS });
		setRecordingDraft({ ...DEFAULT_RECORDING_SHORTCUTS });
		setCaptureFor(null);
		setCaptureForRecording(null);
		setConflict(null);
		setRegisterFailures({});
		setRegisterInvalid({});
		toast.info(t("shortcutsConfig.resetNotice"));
	}, [t]);

	const handleClose = useCallback(() => {
		setCaptureFor(null);
		setCaptureForRecording(null);
		setConflict(null);
		if (inline) setDraft(shortcuts);
		else closeConfig();
	}, [closeConfig, inline, shortcuts]);

	const actions = (
		<div
			className={`flex shrink-0 flex-wrap items-center justify-between gap-3 ${inline ? "settings-shortcuts-actions" : "mt-4"}`}
		>
			<Button
				title={t("shortcutsConfig.resetToDefaults")}
				variant="ghost"
				size="sm"
				className="gap-1.5 max-w-[200px]"
				onClick={handleReset}
			>
				<RotateCcw className="w-3 h-3" />
				<span className="truncate">{t("shortcutsConfig.resetToDefaults")}</span>
			</Button>
			<div className="flex gap-2">
				<Button variant="ghost" size="sm" onClick={handleClose}>
					{t("shortcutsConfig.cancel")}
				</Button>
				<Button size="sm" onClick={handleSave}>
					{t("shortcutsConfig.save")}
				</Button>
			</div>
		</div>
	);

	const editor = (
		<div
			className={`flex min-h-0 min-w-0 flex-col${inline ? " settings-shortcuts-editor" : ""}`}
		>
			<Description className="mt-2 text-xs">{t("shortcutsConfig.instructions")}</Description>
			{inline && actions}
			<div className="min-h-0 space-y-6 overflow-y-auto">
				<div className="space-y-0.5">
					<p className="mb-3 text-[13px] font-medium text-foreground">
						{t("shortcutsConfig.configurable")}
					</p>
					{SHORTCUT_ACTIONS.map((action) => {
						const isCapturing = captureFor === action;
						const hasConflict = conflict?.forAction === action;
						return (
							<div key={action}>
								<div className="flex flex-wrap items-center justify-between gap-4 border-b border-separator py-3">
									<span className="text-[13px] text-foreground">
										{actionLabel(action)}
									</span>
									<Button
										type="button"
										variant="secondary"
										size="sm"
										aria-label={
											isCapturing
												? `${actionLabel(action)}: ${t("shortcutsConfig.pressAKey")}`
												: te(
														"changeShortcut",
														"Change {{action}} shortcut, currently {{binding}}",
														{
															action: actionLabel(action),
															binding: bindingLabel(
																formatBinding(draft[action], isMac),
															),
														},
													)
										}
										onClick={() => {
											setConflict(null);
											setCaptureFor(isCapturing ? null : action);
										}}
										title={
											isCapturing
												? t("shortcutsConfig.pressEscToCancel")
												: t("shortcutsConfig.clickToChange")
										}
										className={[
											"px-2 py-1 text-xs min-w-[90px] text-center select-none",
											isCapturing
												? "animate-pulse"
												: hasConflict
													? "text-warning"
													: "cursor-pointer",
										].join(" ")}
									>
										{isCapturing
											? t("shortcutsConfig.pressAKey")
											: bindingLabel(formatBinding(draft[action], isMac))}
									</Button>
								</div>
								{hasConflict && conflict?.conflictWith.type === "configurable" && (
									<div className="flex items-center justify-between px-1 py-1.5 mb-0.5 bg-warning-soft border border-warning/20 rounded text-xs">
										<span className="text-warning">
											{t("shortcutsConfig.alreadyUsedBy", undefined, {
												action: actionLabel(conflict.conflictWith.action),
											})}
										</span>
										<div className="flex gap-1.5">
											<Button
												variant="ghost"
												type="button"
												onClick={handleSwap}
												className="px-2 py-0.5 text-warning"
											>
												{t("shortcutsConfig.swap")}
											</Button>
											<Button
												variant="ghost"
												type="button"
												onClick={handleCancelConflict}
												className="px-2 py-0.5"
											>
												{t("shortcutsConfig.cancel")}
											</Button>
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>

				<div className="space-y-0.5 mt-2">
					<p className="mb-3 text-[13px] font-medium text-foreground">
						{t("shortcutsConfig.fixed")}
					</p>
					{FIXED_SHORTCUTS.map(({ label, display, bindings }) => (
						<div
							key={label}
							className="flex flex-wrap items-center justify-between gap-4 border-b border-separator py-3 last:border-0"
						>
							<span className="text-[13px] text-foreground">{fixedLabel(label)}</span>
							<Kbd className="min-w-[90px] justify-center">
								{bindingLabel(
									display ??
										bindings
											.map((binding) => formatBinding(binding, isMac))
											.join(" / "),
								)}
							</Kbd>
						</div>
					))}
				</div>
			</div>

			{!inline && actions}
		</div>
	);
	if (inline) return editor;

	return (
		<Dialog
			open={isConfigOpen}
			onOpenChange={(open: boolean) => {
				if (!open) handleClose();
			}}
		>
			<DialogContent
				data-hud-interactive
				className="max-w-lg max-h-[85vh] overflow-hidden pointer-events-auto"
			>
				<DialogHeader className="shrink-0">
					<DialogTitle className="flex items-center gap-2 text-base font-semibold">
						<Keyboard className="w-4 h-4 text-accent" />
						{t("shortcutsConfig.title")}
					</DialogTitle>
				</DialogHeader>

				<Modal.Body className="min-h-0 space-y-6 overflow-y-auto">
					<div className="space-y-0.5">
						<p className="mb-3 text-[13px] font-medium text-foreground">
							{t("shortcutsConfig.configurable")}
						</p>
						{SHORTCUT_ACTIONS.map((action) => {
							const isCapturing = captureFor === action;
							const hasConflict = conflict?.forAction === action;
							return (
								<div key={action}>
									<div className="flex items-center justify-between gap-4 border-b border-separator py-3">
										<span className="text-[13px] text-foreground">
											{tShortcuts(SHORTCUT_LABELS[action])}
										</span>
										<Button
											type="button"
											variant="secondary"
											size="sm"
											aria-label={
												isCapturing
													? `${tShortcuts(SHORTCUT_LABELS[action])}: ${t("shortcutsConfig.pressAKey")}`
												: t("shortcutsConfig.changeShortcut", undefined, {
														action: tShortcuts(SHORTCUT_LABELS[action]),
														binding: formatBinding(draft[action], isMac),
													})
											}
											onClick={() => {
												setConflict(null);
												setCaptureForRecording(null);
								setCaptureFor(isCapturing ? null : action);
											}}
											title={
												isCapturing
													? t("shortcutsConfig.pressEscToCancel")
													: t("shortcutsConfig.clickToChange")
											}
											className={[
												"px-2 py-1 text-xs min-w-[90px] text-center select-none",
												isCapturing
													? "animate-pulse"
													: hasConflict
														? "text-warning"
														: "cursor-pointer",
											].join(" ")}
										>
											{isCapturing
												? t("shortcutsConfig.pressAKey")
												: formatBinding(draft[action], isMac)}
										</Button>
									</div>
									{hasConflict &&
										conflict?.conflictWith.type === "configurable" && (
											<div className="flex items-center justify-between px-1 py-1.5 mb-0.5 bg-warning-soft border border-warning/20 rounded text-xs">
												<span className="text-warning">
													{t("shortcutsConfig.alreadyUsedBy", undefined, {
														action: tShortcuts(
															SHORTCUT_LABELS[conflict.conflictWith.action],
														),
													})}
												</span>
												<div className="flex gap-1.5">
													<Button
														variant="ghost"
														type="button"
														onClick={handleSwap}
														className="px-2 py-0.5 text-warning"
													>
														{t("shortcutsConfig.swap")}
													</Button>
													<Button
														variant="ghost"
														type="button"
														onClick={handleCancelConflict}
														className="px-2 py-0.5"
													>
														{t("shortcutsConfig.cancel")}
													</Button>
												</div>
											</div>
										)}
								</div>
							);
						})}
					</div>

					<div className="space-y-0.5 mt-2">
						<p className="mb-3 text-[13px] font-medium text-foreground">
							{t("shortcutsConfig.recordingGroup")}
						</p>
						{RECORDING_SHORTCUT_ACTIONS.map((action) => {
							const isCapturing = captureForRecording === action;
							const registerFailed = registerFailures[action] === true;
							const registerActive = !captureActive && registerFailures[action] === false;
							return (
								<div key={action}>
									<div className="flex items-center justify-between gap-4 border-b border-separator py-3">
										<span className="text-[13px] text-foreground">
											{t(RECORDING_LABEL_KEYS[action])}
										</span>
										<Button
											type="button"
											variant="secondary"
											size="sm"
											aria-label={
												isCapturing
													? `${t(RECORDING_LABEL_KEYS[action])}: ${t("shortcutsConfig.pressAKey")}`
													: t("shortcutsConfig.changeShortcut", undefined, {
															action: t(RECORDING_LABEL_KEYS[action]),
															binding: formatBinding(recordingDraft[action], isMac),
														})
												}
											onClick={() => {
													setConflict(null);
													setCaptureFor(null);
								setCaptureForRecording(isCapturing ? null : action);
												}}
											title={
												isCapturing
													? t("shortcutsConfig.pressEscToCancel")
													: t("shortcutsConfig.clickToChange")
												}
											className={[
												"px-2 py-1 text-xs min-w-[90px] text-center select-none",
												isCapturing
													? "animate-pulse"
													: registerFailed
														? "text-warning"
														: "cursor-pointer",
											].join(" ")}
										>
											{isCapturing
												? t("shortcutsConfig.pressAKey")
												: formatBinding(recordingDraft[action], isMac)}
										</Button>
									</div>
									{registerFailed ? (
										<p className="px-1 py-1 mb-0.5 text-xs text-warning">
											{registerInvalid[action]
								? t("shortcutsConfig.globalInvalid")
								: t("shortcutsConfig.globalUnavailable")}
										</p>
									) : registerActive ? (
										<p className="px-1 py-1 mb-0.5 text-xs text-muted">
											{t("shortcutsConfig.globalActive")}
										</p>
									) : null}
							</div>
						);
						})}
					</div>

					<div className="space-y-0.5 mt-2">
						<p className="mb-3 text-[13px] font-medium text-foreground">
							{t("shortcutsConfig.fixed")}
						</p>
						{FIXED_SHORTCUTS.map(({ label, display }) => (
							<div
								key={label}
								className="flex items-center justify-between gap-4 border-b border-separator py-3 last:border-0"
							>
								<span className="text-[13px] text-foreground">{tShortcuts(label)}</span>
								<Kbd className="min-w-[90px] justify-center">{display}</Kbd>
							</div>
						))}
					</div>

					<Description className="mt-2 text-xs">
						{t("shortcutsConfig.instructions")}
					</Description>
				</Modal.Body>

				<DialogFooter className="flex shrink-0 gap-2 sm:justify-between mt-2">
					<Button
						title={t("shortcutsConfig.resetToDefaults")}
						variant="ghost"
						size="sm"
						className="gap-1.5 max-w-[200px]"
						onClick={handleReset}
					>
						<RotateCcw className="w-3 h-3" />
						<span className="truncate">{t("shortcutsConfig.resetToDefaults")}</span>
					</Button>
					<div className="flex gap-2">
						<Button variant="ghost" size="sm" onClick={handleClose}>
							{t("shortcutsConfig.cancel")}
						</Button>
						<Button size="sm" onClick={handleSave} disabled={captureActive}>
							{t("shortcutsConfig.save")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
