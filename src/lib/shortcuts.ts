export const SHORTCUT_ACTIONS = [
	"addZoom",
	"splitClip",
	"trimStart",
	"trimEnd",
	"addAnnotation",
	"addKeyframe",
	"deleteSelected",
	"duplicateSelected",
	"playPause",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export interface ShortcutBinding {
	key: string;
	/** Maps to Cmd on macOS, Ctrl on Windows/Linux */
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
}

export type ShortcutsConfig = Record<ShortcutAction, ShortcutBinding>;
export const SHORTCUTS_VERSION = 1;
export type StoredShortcutsConfig = Partial<ShortcutsConfig> & { version?: number };

export function serializeShortcuts(config: ShortcutsConfig) {
	return { ...config, version: SHORTCUTS_VERSION };
}

const SUPPORTED_GLOBAL_SHORTCUT_KEYS = new Set([
	" ",
	"space",
	"enter",
	"return",
	"tab",
	"escape",
	"esc",
	"backspace",
	"delete",
	"del",
	"home",
	"end",
	"pageup",
	"pagedown",
	"arrowup",
	"arrowdown",
	"arrowleft",
	"arrowright",
	"up",
	"down",
	"left",
	"right",
	"plus",
	"minus",
]);

export function isSupportedGlobalShortcutKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return (
		SUPPORTED_GLOBAL_SHORTCUT_KEYS.has(normalized) ||
		/^[a-z0-9]$/.test(normalized) ||
		/^f([1-9]|1\d|2[0-4])$/.test(normalized)
	);
}

export interface RecordingShortcutsConfig {
	start: ShortcutBinding;
	stop: ShortcutBinding;
	"pause-resume": ShortcutBinding;
}

export const RECORDING_SHORTCUT_ACTIONS = ["start", "stop", "pause-resume"] as const;
export type RecordingShortcutAction = (typeof RECORDING_SHORTCUT_ACTIONS)[number];

/** Global recording hotkeys shared by the renderer and Electron main process. */
export const DEFAULT_RECORDING_SHORTCUTS: RecordingShortcutsConfig = {
	start: { key: "r", ctrl: true, alt: true, shift: true },
	stop: { key: "s", ctrl: true, alt: true, shift: true },
	"pause-resume": { key: "p", ctrl: true, alt: true, shift: true },
};

export interface FixedShortcut {
	/** i18n key in the `shortcuts` namespace — translate with t() at render time. */
	label: string;
	display?: string;
	bindings: ShortcutBinding[];
}

export const CLEAR_ALL_ZOOMS_SHORTCUT: ShortcutBinding = {
	key: "backspace",
	ctrl: true,
	shift: true,
};

export const COPY_SELECTED_SHORTCUT: ShortcutBinding = { key: "c", ctrl: true };
export const PASTE_SHORTCUT: ShortcutBinding = { key: "v", ctrl: true };

export const FIXED_SHORTCUTS: FixedShortcut[] = [
	{ label: "shortcuts.actions.cycleForward", display: "Tab", bindings: [{ key: "tab" }] },
	{
		label: "shortcuts.actions.cycleBackward",
		display: "Shift + Tab",
		bindings: [{ key: "tab", shift: true }],
	},
	{
		label: "shortcuts.actions.deleteSelectedAlt",
		display: "Del / ⌫",
		bindings: [{ key: "delete" }, { key: "backspace" }],
	},
	{ label: "shortcuts.actions.panTimeline", display: "Shift + Scroll", bindings: [] },
	{ label: "shortcuts.actions.zoomTimeline", display: "Ctrl + Scroll", bindings: [] },
];

export type ShortcutConflict =
	| { type: "configurable"; action: ShortcutAction }
	| { type: "fixed"; label: string };

// `label` on a fixed conflict is an i18n key in the `shortcuts` namespace.

export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		!!a.ctrl === !!b.ctrl &&
		!!a.shift === !!b.shift &&
		!!a.alt === !!b.alt
	);
}

/** Prevent global recording shortcuts from hijacking ordinary typing. */
export function hasGlobalRecordingModifier(binding: ShortcutBinding): boolean {
	return !!binding.ctrl || !!binding.alt;
}

export function findConflict(
	binding: ShortcutBinding,
	forAction: ShortcutAction,
	config: ShortcutsConfig,
): ShortcutConflict | null {
	for (const fixed of FIXED_SHORTCUTS) {
		if (fixed.bindings.some((b) => bindingsEqual(b, binding))) {
			return { type: "fixed", label: fixed.label };
		}
	}
	for (const action of SHORTCUT_ACTIONS) {
		if (action !== forAction && bindingsEqual(config[action], binding)) {
			return { type: "configurable", action };
		}
	}
	return null;
}

export type RecordingShortcutConflict =
	| { type: "fixed"; label: string }
	| { type: "editor"; action: ShortcutAction }
	| { type: "recording"; action: RecordingShortcutAction };

/** Check a global recording binding against every fixed, editor, and other recording binding. */
export function findRecordingShortcutConflict(
	binding: ShortcutBinding,
	editor: ShortcutsConfig,
	recording: RecordingShortcutsConfig,
	exceptRecordingAction?: RecordingShortcutAction,
): RecordingShortcutConflict | null {
	const fixed = FIXED_SHORTCUTS.find((shortcut) =>
		shortcut.bindings.some((candidate) => bindingsEqual(candidate, binding)),
	);
	if (fixed) return { type: "fixed", label: fixed.label };

	const editorAction = SHORTCUT_ACTIONS.find((action) =>
		bindingsEqual(editor[action], binding),
	);
	if (editorAction) return { type: "editor", action: editorAction };

	const recordingAction = RECORDING_SHORTCUT_ACTIONS.find(
		(action) =>
			action !== exceptRecordingAction && bindingsEqual(recording[action], binding),
	);
	if (recordingAction) return { type: "recording", action: recordingAction };

	return null;
}

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
	addZoom: { key: "z" },
	splitClip: { key: "b", ctrl: true },
	trimStart: { key: "q" },
	trimEnd: { key: "w" },
	addAnnotation: { key: "a" },
	addKeyframe: { key: "f" },
	deleteSelected: { key: "d", ctrl: true },
	duplicateSelected: { key: "d", ctrl: true, shift: true },
	playPause: { key: " " },
};

/** i18n keys in the `shortcuts` namespace — translate with t() at render time. */
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
	addZoom: "shortcuts.actions.addZoom",
	splitClip: "shortcuts.actions.splitClip",
	addAnnotation: "shortcuts.actions.addAnnotation",
	addKeyframe: "shortcuts.actions.addKeyframe",
	deleteSelected: "shortcuts.actions.deleteSelected",
	playPause: "shortcuts.actions.playPause",
};

export function matchesShortcut(
	e: KeyboardEvent,
	binding: ShortcutBinding,
	isMacPlatform: boolean,
	allowOptionLetter = false,
): boolean {
	const key = binding.key.toLowerCase();
	const reportedKey = e.key.toLowerCase();
	const optionLetterMatches =
		allowOptionLetter &&
		isMacPlatform &&
		e.altKey &&
		/^[a-z]$/.test(key) &&
		!/^[a-z]$/.test(reportedKey) &&
		e.code === `Key${key.toUpperCase()}`;
	if (reportedKey !== key && !optionLetterMatches) return false;

	const primaryMod = isMacPlatform ? e.metaKey : e.ctrlKey;
	if (primaryMod !== !!binding.ctrl) return false;
	if (e.shiftKey !== !!binding.shift) return false;
	if (e.altKey !== !!binding.alt) return false;

	return true;
}

const KEY_LABELS: Record<string, string> = {
	" ": "Space",
	delete: "Del",
	backspace: "⌫",
	escape: "Esc",
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
};

export function formatBinding(binding: ShortcutBinding, isMac: boolean): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
	if (binding.shift) parts.push(isMac ? "⇧" : "Shift");
	if (binding.alt) parts.push(isMac ? "⌥" : "Alt");
	parts.push(KEY_LABELS[binding.key] ?? binding.key.toUpperCase());
	return parts.join(" + ");
}

export function mergeWithDefaults(partial: StoredShortcutsConfig): ShortcutsConfig {
	const merged = { ...DEFAULT_SHORTCUTS };
	for (const action of SHORTCUT_ACTIONS) {
		if (partial[action]) {
			merged[action] = partial[action] as ShortcutBinding;
		}
	}
	// Saved configurations include the previous C default. Upgrade that binding
	// while preserving custom shortcuts and avoiding collisions with other actions.
	if (
		(partial.version ?? 0) < SHORTCUTS_VERSION &&
		bindingsEqual(merged.splitClip, { key: "c" }) &&
		!findConflict(DEFAULT_SHORTCUTS.splitClip, "splitClip", merged)
	) {
		merged.splitClip = DEFAULT_SHORTCUTS.splitClip;
	}
	for (const action of ["trimStart", "trimEnd"] as const) {
		if (partial[action]) continue;
		const { key } = DEFAULT_SHORTCUTS[action];
		const modifiers = [
			{},
			{ shift: true },
			{ alt: true },
			{ alt: true, shift: true },
			{ ctrl: true },
			{ ctrl: true, shift: true },
			{ ctrl: true, alt: true },
			{ ctrl: true, alt: true, shift: true },
		];
		for (const modifier of modifiers) {
			const binding = { key, ...modifier };
			if (findConflict(binding, action, merged)) continue;
			merged[action] = binding;
			break;
		}
	}
	return merged;
}
