import { Button, Tooltip } from "@heroui/react";
import { PauseIcon, PlayIcon, Trash } from "@/components/ui/icons";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./LaunchWindow.module.css";

interface RecordingControlsProps {
	paused: boolean;
	busy?: boolean;
	elapsed: number;
	onPauseResume: () => void;
	onStopRecording: () => void;
	onCancelRecording: () => void | Promise<unknown>;
	formatTime: (seconds: number) => string;
}

export function RecordingControls({
	paused,
	busy = false,
	elapsed,
	onPauseResume,
	onStopRecording,
	onCancelRecording,
	formatTime,
}: RecordingControlsProps) {
	const t = useScopedT("launch");
	const captureT = useScopedT("capture");
	return (
		<div role="group" aria-label={t("recording.controlsAria", "Recording controls")} className="flex items-center gap-2">
			<Button
				isIconOnly
				variant="ghost"
				className={actionClass}
				aria-label={t("recording.home")}
				onPress={onHome}
			>
				<House weight="fill" className="size-4" />
			</Button>
			<div
				className="flex items-center gap-3 px-2"
				role="status"
				aria-label={paused ? t("recording.paused") : t("recording.rec")}
			>
				<span
					className={`size-2 rounded-full ${paused ? "bg-warning" : `bg-danger ${styles.recDotBlink}`}`}
				/>
				<span className="min-w-14 text-sm font-medium tabular-nums text-foreground">
					{formatTime(elapsed)}
				</span>
				{paused && (
					<span className="text-xs text-muted-foreground">{t("recording.paused")}</span>
				)}
			</div>
			<Tooltip>
				<Button
					isIconOnly
					variant="ghost"
					isDisabled={busy}
					className={styles.hudAction}
					aria-label={t("recording.stop")}
					onPress={onStopRecording}
				>
					<span aria-hidden="true" className="size-4 rounded-[3px] bg-danger" />
				</Button>
				<Tooltip.Content>{t("recording.stop")}</Tooltip.Content>
			</Tooltip>
			<div className={styles.recordingTimer}>
				<span role="timer" aria-live="off" className="text-base font-semibold tabular-nums">
					{formatTime(elapsed).replace(/^0(?=\d:)/, "")}
				</span>
			</div>
			<span aria-hidden="true" className={styles.captureDivider} />
			<Tooltip>
				<Button
					isIconOnly
					variant="ghost"
					isDisabled={busy}
					className={styles.hudAction}
					onPress={onPauseResume}
					aria-label={paused ? t("recording.resume") : t("recording.pause")}
				>
					{paused ? (
						<PlayIcon weight="fill" className="size-5" />
					) : (
						<PauseIcon weight="fill" className="size-5" />
					)}
				</Button>
				<Tooltip.Content>
					{paused ? t("recording.resume") : t("recording.pause")}
				</Tooltip.Content>
			</Tooltip>
			<Tooltip>
				<Button
					isIconOnly
					variant="ghost"
					isDisabled={busy}
					className={styles.hudAction}
					aria-label={captureT("discardRecording")}
					onPress={onCancelRecording}
				>
					<Trash className="size-5" />
				</Button>
				<Tooltip.Content>{captureT("discardRecording")}</Tooltip.Content>
			</Tooltip>
		</div>
	);
}
