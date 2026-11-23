import { SettingsSections, SettingsCategory } from "../SettingsSections";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SettingsRow } from "../SettingsRow";
import { useI18n } from "@/contexts/I18nContext";
import { Switch } from "@/components/ui/switch";
import { supportsHudCaptureProtection } from "@/lib/hudCaptureProtection";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/contexts/I18nContext";
import { supportsHudCaptureProtection } from "@/lib/hudCaptureProtection";
import { SettingsInfo } from "../SettingsInfo";
import { SettingsRow } from "../SettingsRow";
import { SettingsCategory, type SettingsSection, SettingsSections } from "../SettingsSections";
import { AppUpdateSettings } from "./AppUpdateSettings";
import { SettingsSidebarFooter } from "./SettingsSidebarFooter";
import { ThemeAppearancePicker } from "./ThemeAppearancePicker";
import "./DashboardSettings.css";
export const DashboardSettingsContext = createContext<ReactNode>(null);
export function DashboardSettings({ onImportFile }: { onImportFile: () => Promise<void> }) {
	const { t } = useI18n();
	const settingsContent = useContext(DashboardSettingsContext);
	const [directory, setDirectory] = useState("");
	const [recordings, setRecordings] = useState("");
	const [hideHud, setHideHud] = useState<boolean>();
	const [captureSupported, setCaptureSupported] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [feedback, setFeedback] = useState<{ area: string; error?: string; message?: string }>();
	const [reload, setReload] = useState(0);
	const [folderErrors, setFolderErrors] = useState<Record<string, string>>({});
	const run = async (area: string, action: () => Promise<void>) => {
		if (busy) return;
		setBusy(area);
		setFeedback(undefined);
		try {
			await action();
		} catch (error) {
			setFeedback({ area, error: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(undefined);
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly retries location reads after a failure.
	useEffect(() => {
		let active = true;
		const loadFolder = async (
			area: string,
			get: () => Promise<{ success: boolean; path?: string }>,
			set: (path: string) => void,
		) => {
			try {
				const result = await get();
				if (!result.success || !result.path)
					throw Error(
						t(
							"settings.appPreferences.folderUnavailable",
							"Folder location is unavailable.",
						),
					);
				if (active) {
					set(result.path);
					setFolderErrors((errors) => ({ ...errors, [area]: "" }));
				}
			} catch (error) {
				if (active)
					setFolderErrors((errors) => ({
						...errors,
						[area]: error instanceof Error ? error.message : String(error),
					}));
			}
		};
		void loadFolder(
			"recordings",
			() => window.electronAPI.getRecordingsDirectory(),
			setRecordings,
		);
		void loadFolder("projects", () => window.electronAPI.getProjectsDirectory(), setDirectory);
		void (async () => {
			try {
				const [protection, platform] = await Promise.all([
					window.electronAPI.getHudOverlayCaptureProtection(),
					window.electronAPI.getPlatform(),
				]);
				if (!active) return;
				setCaptureSupported(supportsHudCaptureProtection(platform));
				if (!protection.success)
					throw Error(
						t(
							"settings.dashboard.captureProtectionFailed",
							"Could not load recording control visibility.",
						),
					);
				setHideHud(protection.enabled);
			} catch (error) {
				if (active)
					setFeedback({
						area: "hud",
						error: error instanceof Error ? error.message : String(error),
					});
			}
		})();
		return () => {
			active = false;
		};
	}, [t, reload]);
	const status = (area: string) =>
		feedback?.area === area ? (
			<p
				role={feedback.error ? "alert" : "status"}
				className={`settings-inline-feedback ${feedback.error ? "text-danger" : "text-success"}`}
			>
				{feedback.error ? <LocalizedError error={feedback.error} /> : feedback.message}
				{feedback.error && <ErrorReportButton error={feedback.error} context="settings" />}
			</p>
		) : null;
	const openFolder = async (kind: "recordings" | "projects") => {
		const result = await (kind === "recordings"
			? window.electronAPI.openRecordingsFolder()
			: window.electronAPI.openProjectsDirectory());
		if (result && !result.success)
			throw Error(
				t("settings.appPreferences.openFolderFailed", "Could not open this folder."),
			);
	};
	return (
		<section
			aria-label={t("settings.dashboard.sectionAria", "Dashboard settings")}
			className="dashboard-settings max-w-2xl py-10"
		>
			<h1 className="mb-8 text-lg font-semibold">{t("settings.dashboard.title", "Settings")}</h1>
			<SettingsSections categories={["general", "motion", "recording", "files", "advanced"]}>
				<SettingsCategory category={["general", "motion", "advanced"]}>
					{settingsContent}
				</SettingsCategory>
				<SettingsCategory category="files">
					<SettingsRow title={t("settings.dashboard.openVideoOrProject", "Open video or project")}>
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() => void run(onImportFile)}
						>
							{t("settings.dashboard.openFile", "Open file")}
						</Button>
					</SettingsRow>
				</SettingsCategory>
				<SettingsCategory category="recording">
					<SettingsRow
						title={t("settings.dashboard.recordingsFolder", "Recordings folder")}
						description={
							<span className="block truncate" title={recordings}>
								{recordings}
							</span>
						}
					>
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									const result =
										await window.electronAPI.chooseRecordingsDirectory();
									if (result.canceled) return;
									if (!result.success || !result.path)
										throw Error(t("settings.dashboard.couldNotChangeRecordingsFolder"));
									setRecordings(result.path);
								})
							}
						>
							{t("settings.dashboard.changeFolder", "Change folder")}
						</Button>
					</SettingsRow>
					{captureSupported && (
						<SettingsRow
							title={t("launch.recording.hideHudFromVideo", "Hide HUD from recordings")}
							description={t(
								"settings.dashboard.hideHudDescription",
								"Only while recording. The idle HUD stays visible in captures.",
							)}
						>
							<Switch
								aria-label={t("launch.recording.hideHudFromVideo", "Hide HUD from recordings")}
								checked={hideHud}
								disabled={busy}
								onCheckedChange={(enabled) =>
									void run(async () => {
										const result =
											await window.electronAPI.setHudOverlayCaptureProtection(
												enabled,
											);
										if (!result.success)
											throw Error(t("settings.dashboard.couldNotUpdateCaptureProtection"));
										setHideHud(result.enabled);
									})
								}
							/>
						</SettingsRow>
					)}
				</SettingsCategory>
				<SettingsCategory category="advanced">
					{import.meta.env.DEV && (
						<SettingsRow title={t("settings.dashboard.previewUpdateUi", "Preview update UI")}>
							<Button
								variant="secondary"
								size="sm"
								disabled={busy}
								onClick={() =>
									void run(async () => {
										await window.electronAPI.previewUpdateToast();
									})
								}
							>
								{t("settings.dashboard.preview", "Preview")}
							</Button>
						</SettingsRow>
					)}
				</SettingsCategory>
				<SettingsCategory category="files">
					<SettingsRow
						title={t("settings.dashboard.projectsFolder", "Projects folder")}
						description={
							directory ||
							t(
								"settings.dashboard.projectsAutoSaveHint",
								"Named projects save automatically.",
							)
						}
					>
						<Button
							size="sm"
							onClick={async () => {
								try {
									const result = await window.electronAPI.getProjectsDirectory();
									if (!result.success || !result.path)
										throw Error(t("settings.dashboard.couldNotOpenProjectsFolder"));
									setDirectory(result.path);
									await window.electronAPI.revealInFolder(result.path);
								} catch (e) {
									toast.error(String(e));
								}
							}}
						>
							{t("settings.dashboard.showFolder", "Show folder")}
						</Button>
					</SettingsRow>
					<p className="text-xs text-muted-foreground">
						{t(
							"settings.dashboard.projectsSaveHint",
							"Named projects save automatically. Previews refresh when you return to Projects.",
						)}
					</p>
				</SettingsCategory>
			</SettingsSections>
		</section>
	);
}
