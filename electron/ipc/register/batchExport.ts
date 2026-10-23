import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
	isOwnedExportPath,
	releaseOwnedExportPath,
} from "../export/exportStream";
import {
	type CaptionSidecarPayload,
	parseCaptionSidecarPayload,
	serializeSrt,
	serializeVtt,
} from "./exportCaptionSidecars";

/**
 * One-shot batch export sessions (Separate-clips mode).
 *
 * The renderer picks a destination folder once through the main process and
 * afterwards only speaks in opaque batch ids + app-managed temp paths. The main
 * process owns naming (`<source>-clip-01.mp4`, `-2`/`-3`… on collision) and
 * commits every video + sidecar with atomic no-clobber semantics, so an
 * existing file is never replaced — not even in a post-preflight race.
 */

const MAX_BATCH_CLIPS = 5000;
const MAX_NAME_SUFFIX = 1000;

export type BatchExportErrorKind = "write" | "cancelled";

export type BatchCommitResult =
	| {
			success: true;
			path: string;
			sidecarWarning: string | null;
			canceled: false;
	  }
	| {
			success: false;
			errorKind: BatchExportErrorKind;
			error: string;
			canceled: false;
	  };

interface BatchExportSession {
	id: string;
	directory: string;
	clipCount: number;
	sourceBaseName: string;
	cancelled: boolean;
	reservedBases: Set<string>;
}

const batchExportSessions = new Map<string, BatchExportSession>();

export class BatchNameCollisionError extends Error {
	constructor() {
		super("batch-export-name-collision");
		this.name = "BatchNameCollisionError";
	}
}

export function isBatchNameCollisionError(error: unknown): boolean {
	return error instanceof BatchNameCollisionError;
}

/** Ordinal width grows with the clip count: 10 clips -> `01`, 100 -> `001`. */
export function getClipOrdinalWidth(clipCount: number): number {
	const digits = String(Math.max(1, Math.min(clipCount, MAX_BATCH_CLIPS))).length;
	return Math.max(2, digits);
}

export function sanitizeBatchBaseName(sourceBaseName: string): string {
	const stripped = path.basename(String(sourceBaseName || "export")).replace(/\.[a-z0-9]+$/i, "");
	const cleaned = stripped.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
	return cleaned.length > 0 ? cleaned.slice(0, 120) : "export";
}

/** Bundle base for a clip: `-clip-01`, first collision takes `-2`, `-3`, … */
export function buildClipBundleBase(
	sourceBaseName: string,
	clipIndex: number,
	suffix: number,
	clipCount: number,
): string {
	const pad = String(Math.max(1, clipIndex)).padStart(getClipOrdinalWidth(clipCount), "0");
	const stem = `${sanitizeBatchBaseName(sourceBaseName)}-clip-${pad}`;
	return suffix <= 1 ? stem : `${stem}-${suffix}`;
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await fs.access(candidate);
		return true;
	} catch {
		return false;
	}
}

/**
 * Atomic no-clobber publication: hard-link the source into place (fails with
 * EEXIST when the destination exists) and drop the source name afterwards, so
 * the destination bytes appear whole or not at all and are never replaced.
 */
export async function commitFileNoClobber(
	sourcePath: string,
	destinationPath: string,
): Promise<void> {
	try {
		await fs.link(sourcePath, destinationPath);
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			throw new BatchNameCollisionError();
		}
		if (code !== "EXDEV") {
			throw error;
		}
	}

	// Cross-volume: stage a copy inside the destination directory (same volume
	// as the destination) and hard-link the staged bytes into place.
	const stagingPath = `${destinationPath}.recordly-batch-${randomUUID()}`;
	try {
		await fs.copyFile(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
		try {
			await fs.link(stagingPath, destinationPath);
		} catch (linkError) {
			if ((linkError as NodeJS.ErrnoException).code === "EEXIST") {
				throw new BatchNameCollisionError();
			}
			throw linkError;
		}
	} finally {
		await fs.rm(stagingPath, { force: true }).catch(() => undefined);
	}
}

/** Sidecars are small: stage + hard-link keeps the same no-clobber guarantee. */
async function writeSidecarNoClobber(
	basePath: string,
	extension: "srt" | "vtt",
	content: string,
): Promise<void> {
	const destinationPath = `${basePath}.${extension}`;
	const stagingPath = `${destinationPath}.recordly-batch-${randomUUID()}`;
	await fs.writeFile(stagingPath, content, "utf8");
	try {
		try {
			await fs.link(stagingPath, destinationPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new BatchNameCollisionError();
			}
			throw error;
		}
	} finally {
		await fs.rm(stagingPath, { force: true }).catch(() => undefined);
	}
}

export function getSession(batchId: string): BatchExportSession | null {
	return batchExportSessions.get(batchId) ?? null;
}

export function closeSession(batchId: string): void {
	batchExportSessions.delete(batchId);
}

export interface CommitBatchClipInput {
	batchId: string;
	tempPath: string;
	clipIndex: number;
	captionSidecar?: CaptionSidecarPayload | null;
}

/**
 * Commit one clip's video + sidecar bundle. Video failure stops the caller's
 * batch; sidecar failure leaves the committed video intact and is surfaced as
 * a non-fatal warning.
 */
export async function commitBatchClip(
	input: CommitBatchClipInput,
	deps?: { pathExists?: (candidate: string) => Promise<boolean> },
): Promise<BatchCommitResult> {
	const pathExistsOverride = deps?.pathExists;
	const session = batchExportSessions.get(input.batchId);
	if (!session) {
		return {
			success: false,
			errorKind: "write",
			error: "Unknown batch export session",
			canceled: false,
		};
	}
	// The cancel token is tested right before publication. A commit that won
	// the race before cancel stays completed; cancel afterwards never touches
	// the published file.
	if (session.cancelled) {
		return {
			success: false,
			errorKind: "cancelled",
			error: "Batch export was cancelled",
			canceled: false,
		};
	}
	if (
		typeof input.tempPath !== "string" ||
		!isOwnedExportPath(input.tempPath)
	) {
		return {
			success: false,
			errorKind: "write",
			error: "Temp path is not an app-managed export temp",
			canceled: false,
		};
	}
	try {
		await fs.access(input.tempPath);
	} catch {
		return {
			success: false,
			errorKind: "write",
			error: `Exported clip temp file is missing: ${input.tempPath}`,
			canceled: false,
		};
	}

	const sidecarPayload = parseCaptionSidecarPayload(input.captionSidecar);
	const sidecarExtensions: Array<"srt" | "vtt"> =
		sidecarPayload === null
			? []
			: sidecarPayload.format === "both"
				? ["srt", "vtt"]
				: [sidecarPayload.format];

	let committedVideoPath: string | null = null;
	try {
		for (let suffix = 1; suffix <= MAX_NAME_SUFFIX; suffix++) {
			const base = buildClipBundleBase(
				session.sourceBaseName,
				input.clipIndex,
				suffix,
				session.clipCount,
			);
			if (session.reservedBases.has(base)) {
				continue;
			}
			session.reservedBases.add(base);
			const videoPath = path.join(session.directory, `${base}.mp4`);
			// The basename is one bundle: any pre-existing MP4 or enabled sidecar
			// pushes the whole bundle to the next suffix.
			const exists = pathExistsOverride ?? pathExists;
			const bundleTaken =
				(await exists(videoPath)) ||
				(await (async () => {
					for (const extension of sidecarExtensions) {
						if (await exists(path.join(session.directory, `${base}.${extension}`))) {
							return true;
						}
					}
					return false;
				})());
			if (bundleTaken) {
				continue;
			}
			try {
				await commitFileNoClobber(input.tempPath, videoPath);
			} catch (error) {
				if (isBatchNameCollisionError(error)) {
					// Created between preflight and commit — take the next suffix.
					continue;
				}
				throw error;
			}
			committedVideoPath = videoPath;
			break;
		}
		if (!committedVideoPath) {
			throw new Error("No available clip name in the destination folder");
		}

		// The temp name is redundant now; the published link owns the bytes.
		await fs.rm(input.tempPath, { force: true }).catch(() => undefined);
		releaseOwnedExportPath(input.tempPath);
	} catch (error) {
		return {
			success: false,
			errorKind: "write",
			error: error instanceof Error ? error.message : String(error),
			canceled: false,
		};
	}

	let sidecarWarning: string | null = null;
	if (sidecarPayload) {
		const basePath = committedVideoPath.slice(0, -path.extname(committedVideoPath).length);
		try {
			if (sidecarPayload.format === "srt" || sidecarPayload.format === "both") {
				await writeSidecarNoClobber(basePath, "srt", serializeSrt(sidecarPayload.cues));
			}
			if (sidecarPayload.format === "vtt" || sidecarPayload.format === "both") {
				await writeSidecarNoClobber(basePath, "vtt", serializeVtt(sidecarPayload.cues));
			}
		} catch (error) {
			// The video stays committed; a missing sidecar is a per-clip warning.
			sidecarWarning =
				error instanceof Error ? error.message : "Caption sidecar could not be saved";
		}
	}

	return {
		success: true,
		path: committedVideoPath,
		sidecarWarning,
		canceled: false,
	};
}

/** Registers the three batch IPC channels on the default ipcMain. */
export function registerBatchExportHandlers(): void {
	ipcMain.handle(
		"batch-export-open",
		async (
			_event,
			payload: { clipCount?: number; sourceBaseName?: string },
		) => {
			const clipCount = Number(payload?.clipCount);
			if (!Number.isInteger(clipCount) || clipCount < 1 || clipCount > MAX_BATCH_CLIPS) {
				return { success: false, error: "Invalid batch clip count" };
			}
			const sourceBaseName = sanitizeBatchBaseName(String(payload?.sourceBaseName ?? "export"));

			const parentWindow = BrowserWindow.fromWebContents(_event?.sender);
			const openOptions: Electron.OpenDialogOptions = {
				title: "Choose Export Folder",
				buttonLabel: "Export Clips Here",
				properties: ["openDirectory", "createDirectory"],
			};
			const result = parentWindow
				? await dialog.showOpenDialog(parentWindow, openOptions)
				: await dialog.showOpenDialog(openOptions);
			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true };
			}

			const session: BatchExportSession = {
				id: `recordly-batch-${randomUUID()}`,
				directory: result.filePaths[0],
				clipCount,
				sourceBaseName,
				cancelled: false,
				reservedBases: new Set<string>(),
			};
			batchExportSessions.set(session.id, session);
			return { success: true, batchId: session.id, directoryPath: session.directory };
		},
	);

	ipcMain.handle(
		"batch-export-commit",
		async (_event, payload: CommitBatchClipInput) => {
			if (typeof payload?.batchId !== "string" || typeof payload?.tempPath !== "string") {
				return {
					success: false,
					errorKind: "write" as BatchExportErrorKind,
					error: "Invalid batch-export-commit payload",
					canceled: false,
				};
			}
			return commitBatchClip({
				batchId: payload.batchId,
				tempPath: payload.tempPath,
				clipIndex: Number(payload.clipIndex),
				captionSidecar: payload.captionSidecar ?? null,
			});
		},
	);

	ipcMain.handle("batch-export-cancel", (_event, batchId: string) => {
		const session = typeof batchId === "string" ? batchExportSessions.get(batchId) : undefined;
		if (!session) {
			return { success: false };
		}
		session.cancelled = true;
		// Keep the record so an in-flight commit observes the cancelled state;
		// the renderer discards any still-owned temp files itself.
		return { success: true };
	});
}

/** Test/teardown helper: drop every session record. */
export function resetBatchExportSessionsForTests(): void {
	batchExportSessions.clear();
}

// Re-exported so callers (and tests) share one source of truth for the temp
// directory contract used by stream/mux temp ownership checks.
export const BATCH_TEMP_ROOT = () => app.getPath("temp");
