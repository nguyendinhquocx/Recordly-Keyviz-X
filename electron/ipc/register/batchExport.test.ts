import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dialog } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getAppPath: () => process.cwd(),
		getPath: () => process.env.TEMP ?? process.cwd(),
		isPackaged: false,
	},
	BrowserWindow: {
		fromWebContents: () => null,
	},
	dialog: {
		showOpenDialog: vi.fn(),
	},
	ipcMain: {
		handle: vi.fn(),
	},
}));

import {
	BatchNameCollisionError,
	buildClipBundleBase,
	commitBatchClip,
	commitFileNoClobber,
	getClipOrdinalWidth,
	isBatchNameCollisionError,
	resetBatchExportSessionsForTests,
	sanitizeBatchBaseName,
} from "./batchExport";
import { serializeSrt, serializeVtt } from "./exportCaptionSidecars";

const tempDirs: string[] = [];
const ownedTemps = new Set<string>();

async function makeTempDir(label: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `recordly-batch-${label}-`));
	tempDirs.push(dir);
	return dir;
}

/** Stands in for the stream/mux temp ownership registry. */
async function createOwnedTemp(dir: string, contents: string, name = "clip.mp4") {
	const tempPath = path.join(dir, name);
	await fs.writeFile(tempPath, contents);
	ownedTemps.add(tempPath);
	return { tempPath, contents };
}

vi.mock("../export/exportStream", () => ({
	isOwnedExportPath: (candidate: string) => ownedTemps.has(path.resolve(candidate)),
	releaseOwnedExportPath: (candidate: string) => ownedTemps.delete(path.resolve(candidate)),
	registerOwnedExportPath: (candidate: string) => ownedTemps.add(path.resolve(candidate)),
}));

function createSession(overrides?: Partial<{ clipCount: number; sourceBaseName: string }>) {
	const id = `recordly-batch-test-${Math.random().toString(36).slice(2)}`;
	return {
		id,
		clipCount: overrides?.clipCount ?? 10,
		sourceBaseName: overrides?.sourceBaseName ?? "my-recording",
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	resetBatchExportSessionsForTests();
	ownedTemps.clear();
	await Promise.allSettled(
		tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
	);
});

describe("batch clip naming", () => {
	it("pads the ordinal by clip count and applies collision suffixes", () => {
		expect(getClipOrdinalWidth(10)).toBe(2);
		expect(getClipOrdinalWidth(100)).toBe(3);
		expect(getClipOrdinalWidth(3)).toBe(2);
		expect(buildClipBundleBase("my-recording", 3, 1, 10)).toBe("my-recording-clip-03");
		expect(buildClipBundleBase("my-recording", 3, 2, 10)).toBe("my-recording-clip-03-2");
		expect(buildClipBundleBase("my-recording", 3, 3, 10)).toBe("my-recording-clip-03-3");
		expect(sanitizeBatchBaseName("../evil/name.mp4")).toBe("name");
		expect(sanitizeBatchBaseName("bad:name*here")).toBe("bad_name_here");
	});
});

describe("commitFileNoClobber", () => {
	it("publishes atomically via link and keeps the bytes byte-for-byte", async () => {
		const dir = await makeTempDir("link");
		const source = await createOwnedTemp(dir, "video-bytes");
		const destination = path.join(dir, "out.mp4");

		await commitFileNoClobber(source.tempPath, destination);

		await expect(fs.readFile(destination, "utf8")).resolves.toBe("video-bytes");
		// Hard link: the source name is unlinked by the caller, the file lives on.
		await expect(fs.access(source.tempPath)).resolves.toBeUndefined();
	});

	it("throws a collision error instead of replacing an existing file", async () => {
		const dir = await makeTempDir("collision");
		const source = await createOwnedTemp(dir, "new-bytes");
		const destination = path.join(dir, "out.mp4");
		await fs.writeFile(destination, "old-bytes");

		await expect(commitFileNoClobber(source.tempPath, destination)).rejects.toThrow(
			BatchNameCollisionError,
		);
		// Existing bytes are untouched.
		await expect(fs.readFile(destination, "utf8")).resolves.toBe("old-bytes");
	});

	it("falls back to same-directory staging across volumes without replacing", async () => {
		const dir = await makeTempDir("exdev");
		const source = path.join(dir, "other-volume.mp4");
		await fs.writeFile(source, "cross-volume-bytes");
		const destination = path.join(dir, "out.mp4");

		const linkSpy = vi.spyOn(fs, "link");
		linkSpy.mockImplementationOnce(async () => {
			const error = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
			error.code = "EXDEV";
			throw error;
		});

		await commitFileNoClobber(source, destination);

		await expect(fs.readFile(destination, "utf8")).resolves.toBe("cross-volume-bytes");
		linkSpy.mockRestore();
	});
});

describe("commitBatchClip", () => {
	async function seedSession(overrides?: Partial<{ clipCount: number; sourceBaseName: string }>) {
		const directory = await makeTempDir("session");
		const session = createSession(overrides);
		// Emulate batch-export-open session registration.
		const { getSession } = await import("./batchExport");
		void getSession;
		const mod = await import("./batchExport");
		const registerSpy = vi.mocked(
			(await import("electron")).ipcMain.handle,
			{ deep: false },
		);
		void registerSpy;
		// Sessions are private; go through the exported handler registration path.
		// For unit tests we expose commitBatchClip with a session seeded via the
		// module's own registration handler simulation below.
		const handlers = new Map<string, unknown>();
		((await import("electron")).ipcMain.handle as ReturnType<typeof vi.fn>).mockImplementation(
			(channel: string, handler: unknown) => {
				handlers.set(channel, handler);
			},
		);
		const { registerBatchExportHandlers } = await import("./batchExport");
		vi.mocked(dialogShowOpen).mockResolvedValue({
			canceled: false,
			filePaths: [directory],
		} as never);
		registerBatchExportHandlers();
		const openHandler = handlers.get("batch-export-open") as (
			event: unknown,
			payload: { clipCount: number; sourceBaseName: string },
		) => Promise<{ success: boolean; batchId?: string; directoryPath?: string }>;
		const opened = await openHandler(null, {
			clipCount: session.clipCount,
			sourceBaseName: session.sourceBaseName,
		});
		expect(opened.success).toBe(true);
		return { directory, batchId: opened.batchId! };
	}

	const dialogShowOpen = dialog.showOpenDialog as ReturnType<typeof vi.fn>;

	it("commits video and sidecars as one no-clobber bundle and reports the real path", async () => {
		const { directory, batchId } = await seedSession();
		const temp = await createOwnedTemp(directory, "clip-one-bytes", "temp-a.mp4");

		const result = await commitBatchClip({
			batchId,
			tempPath: temp.tempPath,
			clipIndex: 1,
			captionSidecar: {
				format: "both",
				cues: [{ startMs: 0, endMs: 500, text: "hello" }],
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.path).toBe(path.join(directory, "my-recording-clip-01.mp4"));
		expect(result.sidecarWarning).toBeNull();
		await expect(fs.readFile(result.path, "utf8")).resolves.toBe("clip-one-bytes");
		await expect(
			fs.readFile(path.join(directory, "my-recording-clip-01.srt"), "utf8"),
		).resolves.toBe(serializeSrt([{ startMs: 0, endMs: 500, text: "hello" }]));
		await expect(
			fs.readFile(path.join(directory, "my-recording-clip-01.vtt"), "utf8"),
		).resolves.toBe(serializeVtt([{ startMs: 0, endMs: 500, text: "hello" }]));
		// The temp file was consumed by the atomic publication.
		await expect(fs.access(temp.tempPath)).rejects.toThrow();
	});

	it("never replaces a pre-existing video; the bundle takes the next suffix", async () => {
		const { directory, batchId } = await seedSession();
		const existingPath = path.join(directory, "my-recording-clip-01.mp4");
		await fs.writeFile(existingPath, "existing-video");
		const temp = await createOwnedTemp(directory, "new-clip", "temp-b.mp4");

		const result = await commitBatchClip({ batchId, tempPath: temp.tempPath, clipIndex: 1 });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.path).toBe(path.join(directory, "my-recording-clip-01-2.mp4"));
		await expect(fs.readFile(existingPath, "utf8")).resolves.toBe("existing-video");
	});

	it("treats a pre-existing sidecar as a taken bundle name", async () => {
		const { directory, batchId } = await seedSession();
		const existingSidecar = path.join(directory, "my-recording-clip-01.srt");
		await fs.writeFile(existingSidecar, "old captions");
		const temp = await createOwnedTemp(directory, "clip-bytes", "temp-c.mp4");

		const result = await commitBatchClip({
			batchId,
			tempPath: temp.tempPath,
			clipIndex: 1,
			captionSidecar: { format: "srt", cues: [{ startMs: 0, endMs: 100, text: "new" }] },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.path).toBe(path.join(directory, "my-recording-clip-01-2.mp4"));
		await expect(fs.readFile(existingSidecar, "utf8")).resolves.toBe("old captions");
		await expect(
			fs.readFile(path.join(directory, "my-recording-clip-01-2.srt"), "utf8"),
		).resolves.toBe(serializeSrt([{ startMs: 0, endMs: 100, text: "new" }]));
	});

	it("picks the next suffix when a file appears after preflight (commit race)", async () => {
		const { directory, batchId } = await seedSession();
		const racedPath = path.join(directory, "my-recording-clip-01.mp4");
		await fs.writeFile(racedPath, "raced-in");
		const temp = await createOwnedTemp(directory, "race-clip", "temp-d.mp4");

		// Pretend the preflight miss: every pathExists check returns false, the
		// real filesystem makes the hard link fail with EEXIST.
		const result = await commitBatchClip(
			{ batchId, tempPath: temp.tempPath, clipIndex: 1 },
			{ pathExists: async () => false },
		);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.path).toBe(path.join(directory, "my-recording-clip-01-2.mp4"));
		await expect(fs.readFile(racedPath, "utf8")).resolves.toBe("raced-in");
	});

	it("reports a sidecar write failure as a warning while the video stays committed", async () => {
		const { directory, batchId } = await seedSession();
		const temp = await createOwnedTemp(directory, "warning-clip", "temp-e.mp4");
		// Race the sidecar: preflight misses it, but the srt exists at write time.
		const existingSrt = path.join(directory, "my-recording-clip-01.srt");
		await fs.writeFile(existingSrt, "captions-raced-in");

		const result = await commitBatchClip(
			{
				batchId,
				tempPath: temp.tempPath,
				clipIndex: 1,
				captionSidecar: { format: "srt", cues: [{ startMs: 0, endMs: 100, text: "x" }] },
			},
			{ pathExists: async () => false },
		);
		// Video + srt both preflight-free would have been fine; only the video
		// path raced here, so the video commits and the sidecar warns.
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.sidecarWarning).toBeTruthy();
		await expect(fs.readFile(result.path, "utf8")).resolves.toBe("warning-clip");
		await expect(fs.readFile(existingSrt, "utf8")).resolves.toBe("captions-raced-in");
	});

	it("refuses to publish after cancel and reports a typed cancelled error", async () => {
		const { directory, batchId } = await seedSession();
		const temp = await createOwnedTemp(directory, "cancelled-clip", "temp-f.mp4");
		const handlers = new Map<string, unknown>();
		((await import("electron")).ipcMain.handle as ReturnType<typeof vi.fn>).mockImplementation(
			(channel: string, handler: unknown) => {
				handlers.set(channel, handler);
			},
		);
		const { registerBatchExportHandlers } = await import("./batchExport");
		registerBatchExportHandlers();
		const cancelHandler = handlers.get("batch-export-cancel") as (
			event: unknown,
			batchId: string,
		) => Promise<{ success: boolean }>;
		expect((await cancelHandler(null, batchId)).success).toBe(true);

		const result = await commitBatchClip({ batchId, tempPath: temp.tempPath, clipIndex: 1 });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.errorKind).toBe("cancelled");
		// Nothing was published; the temp stays owned for renderer discard.
		await expect(fs.access(temp.tempPath)).resolves.toBeUndefined();
		const remaining = await fs.readdir(directory);
		expect(remaining.filter((name) => name.endsWith(".mp4"))).toEqual(["temp-f.mp4"]);
		expect(remaining.some((name) => name.includes("clip-01"))).toBe(false);
	});

	it("rejects unowned temp paths and missing temp files with typed write errors", async () => {
		const { directory, batchId } = await seedSession();
		const foreign = path.join(directory, "not-owned.mp4");
		await fs.writeFile(foreign, "foreign");

		const unowned = await commitBatchClip({ batchId, tempPath: foreign, clipIndex: 1 });
		expect(unowned.success).toBe(false);
		if (!unowned.success) expect(unowned.errorKind).toBe("write");

		const ghostPath = path.join(directory, "ghost.mp4");
		ownedTemps.add(ghostPath);
		const missing = await commitBatchClip({
			batchId,
			tempPath: ghostPath,
			clipIndex: 1,
		});
		expect(missing.success).toBe(false);
		if (!missing.success) {
			expect(missing.errorKind).toBe("write");
			expect(missing.error).toContain("missing");
		}
	});
});
