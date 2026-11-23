import { Card } from "@heroui/react";
import { useMemo, useRef, useState } from "react";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Palette } from "@/components/ui/icons";
import { AnnotationSettingsPanel } from "@/components/video-editor/AnnotationSettingsPanel";
import { loadEditorPreferences } from "@/components/video-editor/editorPreferences";
import { CaptionGenerationSettings } from "@/components/video-editor/settings/CaptionGenerationSettings";
import { WebcamSettings } from "@/components/video-editor/settings/WebcamSettings";
import type { EditorEffectSection } from "@/components/video-editor/types";
import { AppSettings, appSettingsKeys as appSettingsKeysForView } from "./settings/AppSettings";
import { AudioSettings, audioSettingsKeys } from "./settings/AudioSettings";
import { BackgroundDetails, backgroundDetailsKeys } from "./settings/BackgroundDetails";
import {
	BackgroundSettings,
	backgroundSettingsKeys as backgroundSettingsKeysForView,
} from "./settings/BackgroundSettings";
import { CaptionItemSettings, captionItemSettingsKeys } from "./settings/CaptionItemSettings";
import { ClipSettings, clipSettingsKeys } from "./settings/ClipSettings";
import { CropSettings, cropSettingsKeys } from "./settings/CropSettings";
import {
	CursorSettings,
	cursorSettingsKeys as cursorSettingsKeysForView,
} from "./settings/CursorSettings";
import { developerMotionSettingsKeys } from "./settings/DeveloperMotionSettings";
import {
	FrameSettings,
	frameSettingsKeys as frameSettingsKeysForView,
} from "./settings/FrameSettings";
import { SettingsPanelShell, settingsPanelShellKeys } from "./settings/SettingsPanelShell";
import { pickSettingsProps, resolveSettingsPanelProps } from "./settings/settingsPanelDefaults";
import type { SettingsPanelProps } from "./settings/settingsPanelProps";
import { appSettingsKeys, useAppSettings } from "./settings/useAppSettings";
import { backgroundSettingsKeys, useBackgroundSettings } from "./settings/useBackgroundSettings";
import { cursorSettingsKeys, useCursorSettings } from "./settings/useCursorSettings";
import { frameSettingsKeys, useFrameSettings } from "./settings/useFrameSettings";
import { useScrollFade } from "./settings/useScrollFade";
import { useSettingsTranslations } from "./settings/useSettingsTranslations";
import { ZoomSettings, zoomSettingsKeys } from "./settings/ZoomSettings";
import { getPreviewPlaybackRateRange } from "./videoPlayback/playbackRate";

const tahoeCursorUrl = cursorSetAssets.tahoe.arrow.url;
const BUILTIN_CURSOR_PREVIEW_SIZE = 28;
const BUILTIN_CURSOR_PREVIEW_FRAME_SIZE = 48;

const GRADIENTS = [
	"linear-gradient( 111.6deg,  rgba(114,167,232,1) 9.4%, rgba(253,129,82,1) 43.9%, rgba(253,129,82,1) 54.8%, rgba(249,202,86,1) 86.3% )",
	"linear-gradient(120deg, #d4fc79 0%, #96e6a1 100%)",
	"radial-gradient( circle farthest-corner at 3.2% 49.6%,  rgba(80,12,139,0.87) 0%, rgba(161,10,144,0.72) 83.6% )",
	"linear-gradient( 111.6deg,  rgba(0,56,68,1) 0%, rgba(163,217,185,1) 51.5%, rgba(231, 148, 6, 1) 88.6% )",
	"linear-gradient( 107.7deg,  rgba(235,230,44,0.55) 8.4%, rgba(252,152,15,1) 90.3% )",
	"linear-gradient( 91deg,  rgba(72,154,78,1) 5.2%, rgba(251,206,70,1) 95.9% )",
	"radial-gradient( circle farthest-corner at 10% 20%,  rgba(2,37,78,1) 0%, rgba(4,56,126,1) 19.7%, rgba(85,245,221,1) 100.2% )",
	"linear-gradient( 109.6deg,  rgba(15,2,2,1) 11.2%, rgba(36,163,190,1) 91.1% )",
	"linear-gradient(135deg, #FBC8B4, #2447B1)",
	"linear-gradient(109.6deg, #F635A6, #36D860)",
	"linear-gradient(90deg, #FF0101, #4DFF01)",
	"linear-gradient(315deg, #EC0101, #5044A9)",
	"linear-gradient(45deg, #ff9a9e 0%, #fad0c4 99%, #fad0c4 100%)",
	"linear-gradient(to top, #a18cd1 0%, #fbc2eb 100%)",
	"linear-gradient(to right, #ff8177 0%, #ff867a 0%, #ff8c7f 21%, #f99185 52%, #cf556c 78%, #b12a5b 100%)",
	"linear-gradient(120deg, #84fab0 0%, #8fd3f4 100%)",
	"linear-gradient(to right, #4facfe 0%, #00f2fe 100%)",
	"linear-gradient(to top, #fcc5e4 0%, #fda34b 15%, #ff7882 35%, #c8699e 52%, #7046aa 71%, #0c1db8 87%, #020f75 100%)",
	"linear-gradient(to right, #fa709a 0%, #fee140 100%)",
	"linear-gradient(to top, #30cfd0 0%, #330867 100%)",
	"linear-gradient(to top, #c471f5 0%, #fa71cd 100%)",
	"linear-gradient(to right, #f78ca0 0%, #f9748f 19%, #fd868c 60%, #fe9a8b 100%)",
	"linear-gradient(to top, #48c6ef 0%, #6f86d6 100%)",
	"linear-gradient(to right, #0acffe 0%, #495aff 100%)",
];

const CAPTION_ANIMATION_OPTIONS: Array<{ value: AutoCaptionAnimation; label: string }> = [
	{ value: "none", label: "Off" },
	{ value: "fade", label: "Fade" },
	{ value: "rise", label: "Rise" },
	{ value: "pop", label: "Pop" },
];

const CLICK_EFFECT_COLOR_OPTIONS = [
	"#2563EB",
	"#EF4444",
	"#F59E0B",
	"#22C55E",
	"#A855F7",
	"#EC4899",
	"#14B8A6",
	"#F97316",
] as const;

type BackgroundTab = "image" | "video" | "color" | "gradient";
function isHexWallpaper(value: string): boolean {
	return /^#(?:[0-9a-f]{3}){1,2}$/i.test(value);
}

function hexToRgba(hex: string, alpha: number) {
	const normalized = isHexWallpaper(hex) ? hex : DEFAULT_CURSOR_CLICK_EFFECT_COLOR;
	const value =
		normalized.length === 4
			? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
			: normalized;
	const color = Number.parseInt(value.slice(1), 16);
	const red = (color >> 16) & 255;
	const green = (color >> 8) & 255;
	const blue = color & 255;
	return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getBackgroundTabForWallpaper(value: string): BackgroundTab {
	if (GRADIENTS.includes(value)) {
		return "gradient";
	}

	if (isHexWallpaper(value)) {
		return "color";
	}

	if (isVideoWallpaperSource(value)) {
		return "video";
	}

	return "image";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return <Label className="text-[13px]">{children}</Label>;
}

const MOTION_PRESET_ORDER: CursorMotionPresetId[] = ["focused", "smooth"];

const CURSOR_CLICK_EFFECT_OPTIONS: Array<{
	id: CursorClickEffectStyle;
	label: string;
	description: string;
}> = [
	{
		id: "none",
		label: "Off",
		description: "No click animation. Keeps the pointer steady on every tap.",
	},
	{
		id: "spotlight",
		label: "Spotlight",
		description: "A soft pulse that blooms behind the cursor on click.",
	},
	{
		id: "ripple",
		label: "Ripple",
		description: "Concentric rings that expand from the click point.",
	},
	{
		id: "echo",
		label: "Echo",
		description: "A pair of soft rings that spread outward with a cleaner pulse.",
	},
];

function MotionPresetCards({
	title,
	activePresetId,
	onApply,
	tSettings,
}: {
	title: string;
	activePresetId: CursorMotionPresetId | null;
	onApply: (presetId: CursorMotionPresetId) => void;
	tSettings: (key: string, fallback?: string) => string;
}) {
	return (
		<RadioGroup
			value={activePresetId ?? undefined}
			onChange={(value) => onApply(value as CursorMotionPresetId)}
		>
			<Label className="text-[13px] font-medium">{title}</Label>
			{MOTION_PRESET_ORDER.map((presetId) => (
				<Radio
					key={presetId}
					value={presetId}
					className="rounded-xl border border-separator p-3"
				>
					<Radio.Content>
						<Radio.Control>
							<Radio.Indicator />
						</Radio.Control>
						<div className="flex min-w-0 flex-col gap-1">
							<Label className="text-[13px] font-medium">
								{tSettings(`effects.motionPresets.${presetId}.label`)}
							</Label>
							<Description className="text-xs leading-relaxed">
								{tSettings(`effects.motionPresets.${presetId}.description`)}
							</Description>
						</div>
					</Radio.Content>
				</Radio>
			))}
		</RadioGroup>
	);
}

function CursorClickEffectPreview({
	effect,
	color = DEFAULT_CURSOR_CLICK_EFFECT_COLOR,
}: {
	effect: CursorClickEffectStyle;
	color?: string;
}) {
	return (
		<div
			className="relative flex items-center justify-center"
			style={{
				width: `${BUILTIN_CURSOR_PREVIEW_FRAME_SIZE}px`,
				height: `${BUILTIN_CURSOR_PREVIEW_FRAME_SIZE}px`,
			}}
		>
			{effect === "none" ? (
				<svg
					className="absolute h-10 w-10 text-foreground/40"
					viewBox="0 0 40 40"
					aria-hidden="true"
				>
					<circle
						cx="20"
						cy="20"
						r="11.5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						opacity="0.75"
					/>
					<path
						d="M12.5 27.5 27.5 12.5"
						fill="none"
						stroke="currentColor"
						strokeLinecap="round"
						strokeWidth="2.2"
						opacity="0.92"
					/>
				</svg>
			) : null}
			{effect === "ripple" ? (
				<svg
					className="absolute h-12 w-12"
					style={{ color }}
					viewBox="0 0 48 48"
					aria-hidden="true"
				>
					<circle
						cx="24"
						cy="24"
						r="13"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						opacity="0.72"
					/>
				</svg>
			) : null}
			{effect === "spotlight" ? (
				<svg
					className="absolute h-12 w-12"
					style={{ color: hexToRgba(color, 0.92) }}
					viewBox="0 0 48 48"
					aria-hidden="true"
				>
					<g fill="none" stroke="currentColor">
						<circle cx="24" cy="24" r="13.5" strokeWidth="1.5" opacity="0.3" />
						<circle cx="24" cy="24" r="9.75" strokeWidth="1.7" opacity="0.56" />
					</g>
				</svg>
			) : null}
			{effect === "echo" ? (
				<svg
					className="absolute h-12 w-12"
					style={{ color: hexToRgba(color, 0.92) }}
					viewBox="0 0 48 48"
					aria-hidden="true"
				>
					<g fill="none" stroke="currentColor">
						<circle cx="24" cy="24" r="9" strokeWidth="1.8" opacity="0.72" />
						<circle cx="24" cy="24" r="14.5" strokeWidth="1.5" opacity="0.4" />
						<circle
							cx="24"
							cy="24"
							r="4.25"
							fill="currentColor"
							opacity="0.22"
							stroke="none"
						/>
					</g>
				</svg>
			) : null}
		</div>
	);
}

function CursorClickEffectCards({
	title,
	activeEffectId,
	effectColor,
	onApply,
	tSettings,
}: {
	title: string;
	activeEffectId: CursorClickEffectStyle;
	effectColor: string;
	onApply: (effectId: CursorClickEffectStyle) => void;
	tSettings: (key: string, fallback?: string) => string;
}) {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<Label>{title}</Label>
			</div>
			<ChoiceGroup
				type="single"
				value={activeEffectId}
				onValueChange={(value) => {
					if (value) {
						onApply(value as CursorClickEffectStyle);
					}
				}}
				className="grid grid-cols-4 gap-2"
				aria-label={title}
			>
				{CURSOR_CLICK_EFFECT_OPTIONS.map((effect) => {
					const label = tSettings(
						`effects.cursorClickEffects.${effect.id}.label`,
						effect.label,
					);
					const description = tSettings(
						`effects.cursorClickEffects.${effect.id}.description`,
						effect.description,
					);

					return (
						<ChoiceItem
							key={effect.id}
							value={effect.id}
							aria-label={label}
							title={`${label} - ${description}`}
							className={cn("group aspect-square h-auto min-w-0 p-3 text-left")}
						>
							<div className="flex h-full flex-col items-center justify-between gap-3">
								<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[8px] px-2 py-1.5">
									<CursorClickEffectPreview
										effect={effect.id}
										color={effectColor}
									/>
								</div>
							</div>
						</ChoiceItem>
					);
				})}
			</ChoiceGroup>
		</div>
	);
}

interface SettingsPanelProps {
	onShowOnboarding?: () => void;
	advanced?: boolean;
	panelMode?: "editor" | "background";
	activeEffectSection?: EditorEffectSection;
	selected: string;
	onWallpaperChange: (path: string) => void;
	selectedZoomDepth?: ZoomDepth | null;
	onZoomDepthChange?: (depth: ZoomDepth) => void;
	selectedZoomId?: string | null;
	selectedZoomMode?: ZoomMode | null;
	onZoomModeChange?: (mode: ZoomMode) => void;
	onZoomDelete?: (id: string) => void;
	selectedClipId?: string | null;
	selectedClipSpeed?: number | null;
	selectedClipMuted?: boolean | null;
	hasClipAudioOverrides?: boolean;
	onResetClipAudio?: () => void;
	onClipSpeedChange?: (speed: number) => void;
	onClipMutedChange?: (muted: boolean) => void;
	onClipDelete?: (id: string) => void;
	selectedAudioId?: string | null;
	selectedAudioVolume?: number | null;
	selectedAudioNormalize?: boolean | null;
	onAudioVolumeChange?: (volume: number) => void;
	onAudioNormalizeChange?: (normalize: boolean) => void;
	onAudioDelete?: (id: string) => void;
	shadowIntensity?: number;
	onShadowChange?: (intensity: number) => void;
	backgroundBlur?: number;
	onBackgroundBlurChange?: (amount: number) => void;
	connectZooms?: boolean;
	onConnectZoomsChange?: (enabled: boolean) => void;
	autoApplyFreshRecordingAutoZooms?: boolean;
	onAutoApplyFreshRecordingAutoZoomsChange?: (enabled: boolean) => void;
	zoomInDurationMs?: number;
	onZoomInDurationMsChange?: (duration: number) => void;
	zoomInOverlapMs?: number;
	onZoomInOverlapMsChange?: (duration: number) => void;
	zoomOutDurationMs?: number;
	onZoomOutDurationMsChange?: (duration: number) => void;
	connectedZoomGapMs?: number;
	onConnectedZoomGapMsChange?: (duration: number) => void;
	connectedZoomDurationMs?: number;
	onConnectedZoomDurationMsChange?: (duration: number) => void;
	zoomInEasing?: ZoomTransitionEasing;
	onZoomInEasingChange?: (easing: ZoomTransitionEasing) => void;
	zoomOutEasing?: ZoomTransitionEasing;
	onZoomOutEasingChange?: (easing: ZoomTransitionEasing) => void;
	connectedZoomEasing?: ZoomTransitionEasing;
	onConnectedZoomEasingChange?: (easing: ZoomTransitionEasing) => void;
	showCursor?: boolean;
	onShowCursorChange?: (enabled: boolean) => void;
	loopCursor?: boolean;
	onLoopCursorChange?: (enabled: boolean) => void;
	cursorStyle?: CursorStyle;
	onCursorStyleChange?: (style: CursorStyle) => void;
	cursorSize?: number;
	onCursorSizeChange?: (size: number) => void;
	cursorSmoothing?: number;
	onCursorSmoothingChange?: (smoothing: number) => void;
	cursorSpringStiffnessMultiplier?: number;
	onCursorSpringStiffnessMultiplierChange?: (multiplier: number) => void;
	cursorSpringDampingMultiplier?: number;
	onCursorSpringDampingMultiplierChange?: (multiplier: number) => void;
	cursorSpringMassMultiplier?: number;
	onCursorSpringMassMultiplierChange?: (multiplier: number) => void;
	cameraSpringStiffnessMultiplier?: number;
	onCameraSpringStiffnessMultiplierChange?: (multiplier: number) => void;
	cameraSpringDampingMultiplier?: number;
	onCameraSpringDampingMultiplierChange?: (multiplier: number) => void;
	cameraSpringMassMultiplier?: number;
	onCameraSpringMassMultiplierChange?: (multiplier: number) => void;
	zoomClassicMode?: boolean;
	onZoomClassicModeChange?: (enabled: boolean) => void;
	cursorClickEffect?: CursorClickEffectStyle;
	onCursorClickEffectChange?: (effect: CursorClickEffectStyle) => void;
	cursorClickEffectColor?: string;
	onCursorClickEffectColorChange?: (color: string) => void;
	cursorClickEffectScale?: number;
	onCursorClickEffectScaleChange?: (scale: number) => void;
	cursorClickEffectOpacity?: number;
	onCursorClickEffectOpacityChange?: (opacity: number) => void;
	cursorClickEffectDurationMs?: number;
	onCursorClickEffectDurationMsChange?: (duration: number) => void;
	cursorClickBounce?: number;
	onCursorClickBounceChange?: (amount: number) => void;
	cursorClickBounceDuration?: number;
	onCursorClickBounceDurationChange?: (duration: number) => void;
	cursorSway?: number;
	onCursorSwayChange?: (amount: number) => void;
	borderRadius?: number;
	onBorderRadiusChange?: (radius: number) => void;
	webcam?: WebcamOverlaySettings;
	webcamPreviewSrc?: string | null;
	webcamPreviewCurrentTime?: number;
	webcamPreviewPlaying?: boolean;
	onWebcamChange?: (webcam: WebcamOverlaySettings) => void;
	onUploadWebcam?: () => void;
	onClearWebcam?: () => void;
	padding?: Padding;
	onPaddingChange?: (padding: Padding) => void;
	cropRegion?: CropRegion;
	onCropChange?: (region: CropRegion) => void;
	aspectRatio: AspectRatio;
	onAspectRatioChange?: (ratio: AspectRatio) => void;
	selectedAnnotationId?: string | null;
	annotationRegions?: AnnotationRegion[];
	onAnnotationContentChange?: (id: string, content: string) => void;
	onAnnotationTypeChange?: (id: string, type: AnnotationType) => void;
	onAnnotationStyleChange?: (id: string, style: Partial<AnnotationRegion["style"]>) => void;
	onAnnotationFigureDataChange?: (id: string, figureData: FigureData) => void;
	onAnnotationBlurIntensityChange?: (id: string, intensity: number) => void;
	onAnnotationBlurColorChange?: (id: string, color: string) => void;
	onAnnotationDelete?: (id: string) => void;
	autoCaptions?: CaptionCue[];
	autoCaptionSettings?: AutoCaptionSettings;
	whisperExecutablePath?: string | null;
	whisperModelPath?: string | null;
	whisperModelDownloadStatus?: "idle" | "downloading" | "downloaded" | "error";
	whisperModelDownloadProgress?: number;
	isGeneratingCaptions?: boolean;
	onAutoCaptionSettingsChange?: (settings: AutoCaptionSettings) => void;
	onPickWhisperExecutable?: () => void;
	onPickWhisperModel?: () => void;
	onGenerateAutoCaptions?: () => void;
	onClearAutoCaptions?: () => void;
	onDownloadWhisperSmallModel?: () => void;
	onDeleteWhisperSmallModel?: () => void;
	captionCurrentTimeMs?: number;
	selectedCaptionId?: string | null;
	onBeginCaptionEdit?: (id: string) => void;
	onCaptionTextEdit?: (id: string, text: string) => void;
	onCaptionRetime?: (id: string, span: CaptionRetimeSpan) => void;
	onCaptionSplit?: (id: string, atMs: number) => void;
	onCaptionMerge?: (idA: string, idB: string) => void;
	onCaptionDelete?: (id: string) => void;
	nativeCaptureUnavailableSession?: boolean;
	onOpenNativeCaptureUnavailableModal?: () => void;
}

const ZOOM_DEPTH_OPTIONS: Array<{ depth: ZoomDepth; label: string }> = [
	{ depth: 1, label: "1.25×" },
	{ depth: 2, label: "1.5×" },
	{ depth: 3, label: "1.8×" },
	{ depth: 4, label: "2.2×" },
	{ depth: 5, label: "3.5×" },
	{ depth: 6, label: "5×" },
];

const WEBCAM_POSITION_PRESETS: Array<{
	preset: Exclude<WebcamPositionPreset, "custom">;
	label: string;
}> = [
	{ preset: "top-left", label: "↖" },
	{ preset: "top-center", label: "↑" },
	{ preset: "top-right", label: "↗" },
	{ preset: "center-left", label: "←" },
	{ preset: "center", label: "•" },
	{ preset: "center-right", label: "→" },
	{ preset: "bottom-left", label: "↙" },
	{ preset: "bottom-center", label: "↓" },
	{ preset: "bottom-right", label: "↘" },
];

type CursorStyleOption = { value: CursorStyle; label: string };

type WallpaperTile = {
	key: string;
	label: string;
	value: string;
	previewUrl: string;
};

const BUILTIN_CURSOR_STYLE_OPTIONS: CursorStyleOption[] = [
	{ value: "macos", label: "macOS" },
	{ value: "tahoe", label: "Tahoe" },
	{ value: "tahoe-inverted", label: "Tahoe Inverted" },
	{ value: "windows11", label: "Windows 11" },
	{ value: "dot", label: "Dot" },
	{ value: "figma", label: "Minimal" },
];

const CAPTION_LANGUAGE_OPTIONS = [
	{ value: "auto", label: "Auto Detect" },
	{ value: "en", label: "English" },
	{ value: "es", label: "Spanish" },
	{ value: "fr", label: "French" },
	{ value: "de", label: "German" },
	{ value: "it", label: "Italian" },
	{ value: "pt", label: "Portuguese" },
	{ value: "zh", label: "Chinese (Simplified)" },
	{ value: "ja", label: "Japanese" },
	{ value: "ko", label: "Korean" },
] as const;

const APP_LANGUAGE_LABELS: Record<AppLocale, string> = {
	en: "English",
	vi: "Tiếng Việt",
	es: "Español",
	fr: "Français",
	de: "Deutsch",
	it: "Italiano",
	nl: "Nederlands",
	ko: "한국어",
	"pt-BR": "Português",
	"zh-CN": "簡體中文",
	"zh-TW": "繁體中文",
};

function loadPreviewImage(url: string) {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Failed to load preview asset: ${url}`));
		image.src = url;
	});
}

function trimCanvasToAlpha(canvas: HTMLCanvasElement, hotspot?: { x: number; y: number }) {
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return {
			dataUrl: canvas.toDataURL("image/png"),
			width: canvas.width,
			height: canvas.height,
			hotspot,
		};
	}

	const { width, height } = canvas;
	const imageData = ctx.getImageData(0, 0, width, height);
	const { data } = imageData;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const alpha = data[(y * width + x) * 4 + 3];
			if (alpha === 0) {
				continue;
			}

			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}

	if (maxX < minX || maxY < minY) {
		return {
			dataUrl: canvas.toDataURL("image/png"),
			width,
			height,
			hotspot,
		};
	}

	const croppedWidth = maxX - minX + 1;
	const croppedHeight = maxY - minY + 1;
	const croppedCanvas = document.createElement("canvas");
	croppedCanvas.width = croppedWidth;
	croppedCanvas.height = croppedHeight;
	const croppedCtx = croppedCanvas.getContext("2d")!;
	croppedCtx.drawImage(
		canvas,
		minX,
		minY,
		croppedWidth,
		croppedHeight,
		0,
		0,
		croppedWidth,
		croppedHeight,
	);

	return {
		dataUrl: croppedCanvas.toDataURL("image/png"),
		width: croppedWidth,
		height: croppedHeight,
		hotspot: hotspot
			? {
					x: hotspot.x - minX,
					y: hotspot.y - minY,
				}
			: undefined,
	};
}

async function createTrimmedSvgPreview(
	url: string,
	sampleSize: number,
	trim?: { x: number; y: number; width: number; height: number },
) {
	const image = await loadPreviewImage(url);
	const sourceCanvas = document.createElement("canvas");
	sourceCanvas.width = sampleSize;
	sourceCanvas.height = sampleSize;
	const sourceCtx = sourceCanvas.getContext("2d")!;
	sourceCtx.drawImage(image, 0, 0, sampleSize, sampleSize);

	if (trim) {
		const croppedCanvas = document.createElement("canvas");
		croppedCanvas.width = trim.width;
		croppedCanvas.height = trim.height;
		const croppedCtx = croppedCanvas.getContext("2d")!;
		croppedCtx.drawImage(
			sourceCanvas,
			trim.x,
			trim.y,
			trim.width,
			trim.height,
			0,
			0,
			trim.width,
			trim.height,
		);
		return croppedCanvas.toDataURL("image/png");
	}

	return trimCanvasToAlpha(sourceCanvas).dataUrl;
}

async function createInvertedPreview(url: string) {
	const image = await loadPreviewImage(url);
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(image, 0, 0);
	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const { data } = imageData;
	for (let index = 0; index < data.length; index += 4) {
		if (data[index + 3] === 0) {
			continue;
		}
		data[index] = 255 - data[index];
		data[index + 1] = 255 - data[index + 1];
		data[index + 2] = 255 - data[index + 2];
	}
	ctx.putImageData(imageData, 0, 0);
	return canvas.toDataURL("image/png");
}

function CursorStylePreview({
	style,
	previewUrls,
	frameSize = BUILTIN_CURSOR_PREVIEW_FRAME_SIZE,
	previewSize,
}: {
	style: CursorStyle;
	previewUrls: Partial<Record<string, string>>;
	frameSize?: number;
	previewSize?: number;
}) {
	const previewSrc =
		style === "macos"
			? (previewUrls.macos ?? tahoeCursorUrl)
			: style === "tahoe"
				? (previewUrls.tahoe ?? tahoeCursorUrl)
				: style === "windows11"
					? (previewUrls.windows11 ?? tahoeCursorUrl)
					: style === "figma"
						? (previewUrls.figma ?? minimalCursorUrl)
						: style === "tahoe-inverted"
							? (previewUrls["tahoe-inverted"] ?? tahoeCursorUrl)
							: previewUrls[style];

	if (
		style === "macos" ||
		style === "tahoe" ||
		style === "tahoe-inverted" ||
		style === "windows11"
	) {
		const resolvedPreviewSize =
			(previewSize ?? BUILTIN_CURSOR_PREVIEW_SIZE) *
			(style === "windows11" ? 1 : getCursorStyleSizeMultiplier(style));
		return (
			<div
				className="flex items-center justify-center"
				style={{
					width: `${frameSize}px`,
					height: `${frameSize}px`,
				}}
			>
				<img
					src={previewSrc ?? tahoeCursorUrl}
					alt=""
					className="max-w-none object-contain drop-shadow-[0_8px_12px_rgba(15,23,42,0.18)]"
					draggable={false}
					style={{
						width: `${resolvedPreviewSize}px`,
						height: `${resolvedPreviewSize}px`,
					}}
				/>
			</div>
		);
	}

	if (style === "figma") {
		const resolvedPreviewSize = previewSize ?? 28;
		return (
			<div
				className="flex items-center justify-center"
				style={{ width: `${frameSize}px`, height: `${frameSize}px` }}
			>
				<img
					src={previewSrc}
					alt=""
					className="object-contain"
					draggable={false}
					style={{
						width: `${resolvedPreviewSize}px`,
						height: `${resolvedPreviewSize}px`,
					}}
				/>
			</div>
		);
	}

	if (style === "dot") {
		const resolvedPreviewSize = previewSize ?? 14;
		return (
			<div
				className="flex items-center justify-center"
				style={{ width: `${frameSize}px`, height: `${frameSize}px` }}
			>
				<span
					className="rounded-full border-[2.5px] border-neutral-800 bg-white shadow-[0_8px_12px_rgba(15,23,42,0.16)]"
					style={{
						width: `${resolvedPreviewSize}px`,
						height: `${resolvedPreviewSize}px`,
					}}
				/>
			</div>
		);
	}

	const resolvedPreviewSize = previewSize ?? 28;
	return (
		<div
			className="flex items-center justify-center"
			style={{ width: `${frameSize}px`, height: `${frameSize}px` }}
		>
			<img
				src={previewSrc ?? tahoeCursorUrl}
				alt=""
				className="object-contain"
				draggable={false}
				style={{ width: `${resolvedPreviewSize}px`, height: `${resolvedPreviewSize}px` }}
			/>
		</div>
	);
}

export function SettingsPanel({
	onShowOnboarding,
	advanced = false,
	panelMode = "editor",
	activeEffectSection: activeEffectSectionProp,
	selected,
	onWallpaperChange,
	selectedZoomDepth,
	onZoomDepthChange,
	selectedZoomId,
	selectedZoomMode,
	onZoomModeChange,
	onZoomDelete,
	selectedClipId,
	selectedClipSpeed,
	selectedClipMuted,
	hasClipAudioOverrides = false,
	onResetClipAudio,
	onClipSpeedChange,
	onClipMutedChange,
	onClipDelete,
	selectedAudioId,
	selectedAudioVolume,
	selectedAudioNormalize,
	onAudioVolumeChange,
	onAudioNormalizeChange,
	onAudioDelete,
	shadowIntensity = 0.67,
	onShadowChange,
	backgroundBlur = 0,
	onBackgroundBlurChange,
	connectZooms = true,
	onConnectZoomsChange,
	autoApplyFreshRecordingAutoZooms = true,
	onAutoApplyFreshRecordingAutoZoomsChange,
	zoomInDurationMs = DEFAULT_ZOOM_IN_DURATION_MS,
	onZoomInDurationMsChange,
	zoomOutDurationMs = DEFAULT_ZOOM_OUT_DURATION_MS,
	onZoomOutDurationMsChange,
	showCursor = false,
	onShowCursorChange,
	loopCursor = false,
	onLoopCursorChange,
	cursorStyle = DEFAULT_CURSOR_STYLE,
	onCursorStyleChange,
	cursorSize = 5,
	onCursorSizeChange,
	cursorSmoothing = 2,
	onCursorSmoothingChange,
	cursorSpringStiffnessMultiplier = 1,
	onCursorSpringStiffnessMultiplierChange,
	cursorSpringDampingMultiplier = 1,
	onCursorSpringDampingMultiplierChange,
	cursorSpringMassMultiplier = 1,
	onCursorSpringMassMultiplierChange,
	cameraSpringStiffnessMultiplier = 1,
	onCameraSpringStiffnessMultiplierChange,
	cameraSpringDampingMultiplier = 1.13,
	onCameraSpringDampingMultiplierChange,
	cameraSpringMassMultiplier = 1.12,
	onCameraSpringMassMultiplierChange,
	zoomClassicMode = false,
	onZoomClassicModeChange,
	cursorClickEffect = DEFAULT_CURSOR_CLICK_EFFECT,
	onCursorClickEffectChange,
	cursorClickEffectColor = DEFAULT_CURSOR_CLICK_EFFECT_COLOR,
	onCursorClickEffectColorChange,
	cursorClickEffectScale = DEFAULT_CURSOR_CLICK_EFFECT_SCALE,
	onCursorClickEffectScaleChange,
	cursorClickEffectOpacity = DEFAULT_CURSOR_CLICK_EFFECT_OPACITY,
	onCursorClickEffectOpacityChange,
	cursorClickEffectDurationMs = DEFAULT_CURSOR_CLICK_EFFECT_DURATION_MS,
	onCursorClickEffectDurationMsChange,
	cursorClickBounce = 1,
	onCursorClickBounceChange,
	cursorClickBounceDuration = DEFAULT_CURSOR_CLICK_BOUNCE_DURATION,
	onCursorClickBounceDurationChange,
	cursorSway = DEFAULT_CURSOR_SWAY,
	onCursorSwayChange,
	borderRadius = getDefaultBorderRadiusPercent(),
	onBorderRadiusChange,
	webcam,
	webcamPreviewSrc = null,
	webcamPreviewCurrentTime = 0,
	webcamPreviewPlaying = false,
	onWebcamChange,
	onUploadWebcam,
	onClearWebcam,
	padding = DEFAULT_PADDING,
	onPaddingChange,
	cropRegion,
	onCropChange,
	aspectRatio,
	onAspectRatioChange,
	selectedAnnotationId,
	annotationRegions = [],
	onAnnotationContentChange,
	onAnnotationTypeChange,
	onAnnotationStyleChange,
	onAnnotationFigureDataChange,
	onAnnotationBlurIntensityChange,
	onAnnotationBlurColorChange,
	onAnnotationDelete,
	autoCaptions = [],
	autoCaptionSettings = DEFAULT_AUTO_CAPTION_SETTINGS,
	whisperModelPath,
	whisperModelDownloadStatus = "idle",
	whisperModelDownloadProgress = 0,
	isGeneratingCaptions = false,
	onAutoCaptionSettingsChange,
	onPickWhisperModel,
	onGenerateAutoCaptions,
	onClearAutoCaptions,
	onDownloadWhisperSmallModel,
	onDeleteWhisperSmallModel,
	captionCurrentTimeMs = 0,
	selectedCaptionId = null,
	onBeginCaptionEdit,
	onCaptionTextEdit,
	onCaptionRetime,
	onCaptionSplit,
	onCaptionMerge,
	onCaptionDelete,
	nativeCaptureUnavailableSession = false,
	onOpenNativeCaptureUnavailableModal,
}: SettingsPanelProps) {
	const tSettings = useScopedT("settings");
	const { locale, setLocale, t } = useI18n();
	const { preference: themePreference, setPreference: setThemePreference } = useTheme();
	const isBackgroundPanel = panelMode === "background";
	const initialEditorPreferences = useMemo(() => loadEditorPreferences(), []);
	const clipSpeedRange = useMemo(getPreviewPlaybackRateRange, []);
	const [internalActiveEffectSection] = useState<EditorEffectSection>("scene");
	const activeEffectSection = activeEffectSectionProp ?? internalActiveEffectSection;
	const background = useBackgroundSettings(
		pickSettingsProps(props, backgroundSettingsKeys),
		initialEditorPreferences,
		isBackgroundPanel ||
			["scene", "frame", "crop", "extensions"].includes(activeEffectSection) ||
			activeEffectSection.startsWith("ext:"),
	);
	const frame = useFrameSettings(
		pickSettingsProps(props, frameSettingsKeys),
		initialEditorPreferences,
	);
	const cursor = useCursorSettings(pickSettingsProps(props, cursorSettingsKeys));
	const app = useAppSettings(pickSettingsProps(props, appSettingsKeys));
	const {
		webcam,
		webcamPreviewSrc,
		webcamPreviewCurrentTime,
		webcamPreviewPlaying,
		onWebcamChange,
		onUploadWebcam,
		autoCaptions,
		autoCaptionSettings,
		captionModelId,
		captionModelLoading,
		onCaptionModelChange,
		whisperModelPath,
		whisperModelDownloadStatus,
		whisperModelDownloadProgress,
		isGeneratingCaptions,
		onAutoCaptionSettingsChange,
		onPickWhisperModel,
		onGenerateAutoCaptions,
		onClearAutoCaptions,
		onDeleteWhisperSmallModel,
	} = props;
	const backgroundScrollRef = useRef<HTMLDivElement>(null);
	const backgroundScrollFade = useScrollFade(backgroundScrollRef, isBackgroundPanel);
	const backgroundSettingsContent = (
		<BackgroundSettings
			{...pickSettingsProps(props, backgroundSettingsKeysForView)}
			background={background}
		/>
	);
	const backgroundDetails = (
		<BackgroundDetails {...pickSettingsProps(props, backgroundDetailsKeys)} />
	);
	// Find selected annotation
	const selectedAnnotation = selectedAnnotationId
		? annotationRegions.find((a) => a.id === selectedAnnotationId)
		: null;
	// If an annotation is selected, show annotation settings instead
	if (
		!isBackgroundPanel &&
		selectedAnnotation &&
		onAnnotationContentChange &&
		onAnnotationTypeChange &&
		onAnnotationStyleChange &&
		onAnnotationDelete
	) {
		return (
			<AnnotationSettingsPanel
				annotation={selectedAnnotation}
				onContentChange={(content) =>
					onAnnotationContentChange(selectedAnnotation.id, content)
				}
				onTypeChange={(type) => onAnnotationTypeChange(selectedAnnotation.id, type)}
				onStyleChange={(style) => onAnnotationStyleChange(selectedAnnotation.id, style)}
				onFigureDataChange={
					onAnnotationFigureDataChange
						? (figureData) =>
								onAnnotationFigureDataChange(selectedAnnotation.id, figureData)
						: undefined
				}
				onBlurIntensityChange={
					onAnnotationBlurIntensityChange
						? (intensity) =>
								onAnnotationBlurIntensityChange(selectedAnnotation.id, intensity)
						: undefined
				}
				onBlurColorChange={
					onAnnotationBlurColorChange
						? (color) => onAnnotationBlurColorChange(selectedAnnotation.id, color)
						: undefined
				}
				onDelete={() => onAnnotationDelete(selectedAnnotation.id)}
			/>
		);
	}

	if (isBackgroundPanel) {
		return (
			<Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-none bg-transparent p-0 shadow-none">
				<div
					className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pb-6 pt-1 scroll-shadow scroll-shadow--vertical scroll-shadow--fade scroll-shadow--hide-scrollbar [--scroll-shadow-size:16px]"
					ref={backgroundScrollRef}
					data-scroll-shadow-mode={backgroundScrollFade}
					style={{ scrollbarGutter: "stable" }}
				>
					<div className="mb-4 flex items-center gap-2">
						<Palette className="w-4 h-4 text-accent" />
						<span className="text-sm font-medium text-foreground">
							{tSettings("background.title")}
						</span>
					</div>
					{backgroundSettingsContent}
					{backgroundDetails}
				</div>
			</Card>
		);
	}
	const sceneSectionContent = (
		<div className="space-y-5">
			{backgroundSettingsContent}
			<FrameSettings {...pickSettingsProps(props, frameSettingsKeysForView)} frame={frame} />
			{advanced && (
				<Accordion>
					<AccordionItem id="crop-details">
						<AccordionTrigger>
							{tSettings("crop.details", "Crop details")}
						</AccordionTrigger>
						<AccordionContent>
							<CropSettings {...pickSettingsProps(props, cropSettingsKeys)} />
						</AccordionContent>
					</AccordionItem>
				</Accordion>
			)}
		</div>
	);
	const effectSectionContent = (() => {
		switch (activeEffectSection) {
			case "settings":
				return (
					<AppSettings
						{...pickSettingsProps(props, appSettingsKeysForView)}
						{...pickSettingsProps(props, developerMotionSettingsKeys)}
						app={app}
					/>
				);
			case "zoom":
				return <ZoomSettings {...pickSettingsProps(props, zoomSettingsKeys)} />;
			case "clip":
				return (
					<ClipSettings
						{...pickSettingsProps(props, clipSettingsKeys)}
						clipSpeedRange={clipSpeedRange}
					/>
				);
			case "audio":
				return <AudioSettings {...pickSettingsProps(props, audioSettingsKeys)} />;
			case "caption":
				return (
					<CaptionItemSettings {...pickSettingsProps(props, captionItemSettingsKeys)} />
				);
			case "cursor":
				return (
					<CursorSettings
						{...pickSettingsProps(props, cursorSettingsKeysForView)}
						cursor={cursor}
					/>
				);
			case "captions":
				return (
					<CaptionGenerationSettings
						advanced={advanced}
						captionCueCount={autoCaptions.length}
						autoCaptionSettings={autoCaptionSettings}
						captionModelId={captionModelId}
						captionModelLoading={captionModelLoading}
						onCaptionModelChange={onCaptionModelChange}
						whisperModelPath={whisperModelPath}
						whisperModelDownloadStatus={whisperModelDownloadStatus}
						whisperModelDownloadProgress={whisperModelDownloadProgress}
						isGeneratingCaptions={isGeneratingCaptions}
						onAutoCaptionSettingsChange={onAutoCaptionSettingsChange}
						onPickWhisperModel={onPickWhisperModel}
						onGenerateAutoCaptions={onGenerateAutoCaptions}
						onClearAutoCaptions={onClearAutoCaptions}
						onDeleteWhisperSmallModel={onDeleteWhisperSmallModel}
					/>
				);
			case "webcam":
				return (
					<WebcamSettings
						advanced={advanced}
						webcam={webcam}
						webcamPreviewSrc={webcamPreviewSrc}
						webcamPreviewCurrentTime={webcamPreviewCurrentTime}
						webcamPreviewPlaying={webcamPreviewPlaying}
						onWebcamChange={onWebcamChange}
						onUploadWebcam={onUploadWebcam}
					/>
				);
			default:
				return sceneSectionContent;
		}
	})();
	return (
		<SettingsPanelShell
			{...pickSettingsProps(props, settingsPanelShellKeys)}
			activeEffectSection={activeEffectSection}
		>
			{effectSectionContent}
		</SettingsPanelShell>
	);
}
