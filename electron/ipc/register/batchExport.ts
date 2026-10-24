import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { isOwnedExportPath, releaseOwnedExportPath } from "../export/exportStream";
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
 * commits every video + sidecar without replacing existing files. Hard-link
 * publication is atomic where supported; the exclusive-copy fallback also
 * never overwrites, though its new destination can be visible while copying.
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
	reservedBases: Set<string>;
	committedCount: number;
	webContentsId: number;
	cancelled: boolean;
	cancelRequested: boolean;
	publicationInFlight: boolean;
}

const batchExportSessions = new Map<string, BatchExportSession>();

export class BatchNameCollisionError extends Error {
	constructor() {
		super("batch-export-name-collision");
		this.name = "BatchNameCollisionError";
	}
}

export class BatchCommitCancelledError extends Error {
	constructor() {
		super("batch-export-cancelled-before-publication");
		this.name = "BatchCommitCancelledError";
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
 * No-clobber publication: hard-link the source into place when the filesystem
 * supports it (atomic, and fails with EEXIST on collision). Unsupported volumes
 * use an exclusive-copy fallback that never replaces an existing destination.
 */
export async function commitFileNoClobber(
	sourcePath: string,
	destinationPath: string,
	isCancelled: () => boolean = () => false,
): Promise<void> {
	// This check immediately before the atomic operation is the cancel/commit
	// linearization point on the same-volume fast path.
	if (isCancelled()) throw new BatchCommitCancelledError();
	try {
		await fs.link(sourcePath, destinationPath);
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			throw new BatchNameCollisionError();
		}
		// EXDEV: cross-volume. EPERM/ENOTSUP/EOPNOTSUPP: filesystem without
		// hardlinks (exFAT/FAT32 USB drives). Both take the staging fallback.
		if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
			throw error;
		}
	}

	// Stage the source inside the destination directory. Hard-link publication
	// keeps the destination whole where supported; COPYFILE_EXCL on no-hardlink
	// volumes still prevents replacement but may expose a partial new file while copying.
	const stagingPath = `${destinationPath}.recordly-batch-${randomUUID()}`;
	try {
		if (isCancelled()) throw new BatchCommitCancelledError();
		await fs.copyFile(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
		if (isCancelled()) throw new BatchCommitCancelledError();
		try {
			await fs.link(stagingPath, destinationPath);
			return;
		} catch (linkError) {
			const linkCode = (linkError as NodeJS.ErrnoException).code;
			if (linkCode === "EEXIST") {
				throw new BatchNameCollisionError();
			}
			if (linkCode !== "EPERM" && linkCode !== "ENOTSUP" && linkCode !== "EOPNOTSUPP") {
				throw linkError;
			}
			try {
				// No-hardlink volume: exclusive copy is the no-clobber publication.
				if (isCancelled()) throw new BatchCommitCancelledError();
				await fs.copyFile(stagingPath, destinationPath, fs.constants.COPYFILE_EXCL);
			} catch (copyError) {
				if ((copyError as NodeJS.ErrnoException).code === "EEXIST") {
					throw new BatchNameCollisionError();
				}
				throw copyError;
			}
		}
	} finally {
		await fs.rm(stagingPath, { force: true }).catch(() => undefined);
	}
}

/** Sidecars are staged and published by hard-link or exclusive-copy fallback. */
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
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") throw new BatchNameCollisionError();
			if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
			try {
				// No-hardlink volumes still get exclusive no-clobber publication.
				await fs.copyFile(stagingPath, destinationPath, fs.constants.COPYFILE_EXCL);
			} catch (copyError) {
				if ((copyError as NodeJS.ErrnoException).code === "EEXIST") {
					throw new BatchNameCollisionError();
				}
				throw copyError;
			}
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
	deps?: {
		pathExists?: (candidate: string) => Promise<boolean>;
		commitFile?: (
			sourcePath: string,
			destinationPath: string,
			isCancelled?: () => boolean,
		) => Promise<void>;
	},
): Promise<BatchCommitResult> {
	const pathExistsOverride = deps?.pathExists;
	const commitFile = deps?.commitFile ?? commitFileNoClobber;
	const session = batchExportSessions.get(input.batchId);
	if (!session) {
		return {
			success: false,
			errorKind: "write",
			error: "Unknown batch export session",
			canceled: false,
		};
	}
	// Cancel is checked after async preflight and immediately before the atomic
	// no-replace publication. If cancel arrives during fs.link/COPYFILE_EXCL,
	// the atomic operation's result determines the winner: success is completed.
	if (session.cancelled || session.cancelRequested) {
		return {
			success: false,
			errorKind: "cancelled",
			error: "Batch export was cancelled",
			canceled: false,
		};
	}
	if (typeof input.tempPath !== "string" || !isOwnedExportPath(input.tempPath)) {
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
			if (session.cancelled || session.cancelRequested) {
				return {
					success: false,
					errorKind: "cancelled",
					error: "Batch export was cancelled before publication",
					canceled: false,
				};
			}
			session.publicationInFlight = true;
			let publicationError: unknown;
			try {
				await commitFile(
					input.tempPath,
					videoPath,
					() => session.cancelled || session.cancelRequested,
				);
			} catch (error) {
				publicationError = error;
			} finally {
				session.publicationInFlight = false;
				if (session.cancelRequested) {
					session.cancelRequested = false;
					session.cancelled = true;
				}
			}
			if (publicationError) {
				if (session.cancelled || publicationError instanceof BatchCommitCancelledError) {
					return {
						success: false,
						errorKind: "cancelled",
						error: "Batch export was cancelled before publication",
						canceled: false,
					};
				}
				if (isBatchNameCollisionError(publicationError)) {
					// Created between preflight and commit — take the next suffix.
					continue;
				}
				throw publicationError;
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
		if (session.cancelled || session.cancelRequested) {
			return {
				success: false,
				errorKind: "cancelled",
				error: "Batch export was cancelled before publication",
				canceled: false,
			};
		}
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
		const extensions: Array<"srt" | "vtt"> =
			sidecarPayload.format === "both" ? ["srt", "vtt"] : [sidecarPayload.format];
		const warnings: string[] = [];
		for (const extension of extensions) {
			try {
				const contents =
					extension === "srt"
						? serializeSrt(sidecarPayload.cues)
						: serializeVtt(sidecarPayload.cues);
				await writeSidecarNoClobber(basePath, extension, contents);
			} catch (error) {
				// Video and any already-written sidecar stay untouched. A race on a
				// sidecar after video publication is a precise non-fatal warning.
				const message =
					error instanceof Error ? error.message : "Caption sidecar write failed";
				warnings.push(`${extension.toUpperCase()}: ${message}`);
			}
		}
		sidecarWarning = warnings.length > 0 ? warnings.join("; ") : null;
	}

	// The session record lives only while clips are still expected; a fully
	// committed batch is closed so main-process state cannot leak.
	session.committedCount += 1;
	if (session.committedCount >= session.clipCount) {
		batchExportSessions.delete(session.id);
	}

	return {
		success: true,
		path: committedVideoPath,
		sidecarWarning,
		canceled: false,
	};
}

/** Registers folder-open, clip-commit, cancel, and terminal-close batch IPC channels. */
export function registerBatchExportHandlers(): void {
	ipcMain.handle(
		"batch-export-open",
		async (_event, payload: { clipCount?: number; sourceBaseName?: string }) => {
			const clipCount = Number(payload?.clipCount);
			if (!Number.isInteger(clipCount) || clipCount < 1 || clipCount > MAX_BATCH_CLIPS) {
				return { success: false, error: "Invalid batch clip count" };
			}
			const sourceBaseName = sanitizeBatchBaseName(
				String(payload?.sourceBaseName ?? "export"),
			);

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
				cancelRequested: false,
				publicationInFlight: false,
				reservedBases: new Set<string>(),
				committedCount: 0,
				webContentsId: _event.sender.id,
			};
			batchExportSessions.set(session.id, session);
			return { success: true, batchId: session.id, directoryPath: session.directory };
		},
	);

	ipcMain.handle("batch-export-commit", async (_event, payload: CommitBatchClipInput) => {
		const owner = batchExportSessions.get(payload?.batchId);
		if (!owner || owner.webContentsId !== _event.sender.id) {
			return {
				success: false,
				errorKind: "write" as BatchExportErrorKind,
				error: "Unknown or unauthorized batch export session",
				canceled: false,
			};
		}
		const clipIndex = Number(payload?.clipIndex);
		if (
			typeof payload?.batchId !== "string" ||
			typeof payload?.tempPath !== "string" ||
			!Number.isInteger(clipIndex) ||
			clipIndex < 1
		) {
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
			clipIndex,
			captionSidecar: payload.captionSidecar ?? null,
		});
	});

	ipcMain.handle("batch-export-cancel", (_event, batchId: string) => {
		const session = typeof batchId === "string" ? batchExportSessions.get(batchId) : undefined;
		if (!session || session.webContentsId !== _event.sender.id) {
			return { success: false };
		}
		if (session.publicationInFlight) {
			// Let the atomic no-replace operation resolve. A successful operation
			// wins this clip; cancellation blocks every subsequent publication.
			session.cancelRequested = true;
		} else {
			session.cancelled = true;
		}
		return { success: true };
	});

	ipcMain.handle("batch-export-close", (_event, batchId: string) => {
		const session = typeof batchId === "string" ? batchExportSessions.get(batchId) : undefined;
		if (!session || session.webContentsId !== _event.sender.id) {
			return { success: false };
		}
		if (session.publicationInFlight) {
			return { success: false, error: "Cannot close while a clip publication is in flight" };
		}
		batchExportSessions.delete(batchId);
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
