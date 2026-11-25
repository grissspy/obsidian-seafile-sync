import { App, MarkdownView, normalizePath, TFile, TFolder } from "obsidian";
import { BaseStore, LocalEntry, LocalFS } from "./types";
import { dirname, looksLikeText, sha256 } from "./util";

/** Vault access. Regular notes go through the Vault API (so open editors update);
 *  the config folder (.obsidian) goes through the raw adapter. */
export class ObsidianLocal implements LocalFS {
	constructor(private app: App, private includeConfig: boolean, private onSelfWrite: (path: string) => void) {}

	private get adapter() {
		return this.app.vault.adapter;
	}

	private isConfig(path: string): boolean {
		const c = this.app.vault.configDir;
		return path === c || path.startsWith(c + "/");
	}

	async list(): Promise<{ files: LocalEntry[]; dirs: string[] }> {
		const files: LocalEntry[] = [];
		const dirs: string[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f instanceof TFile) files.push({ path: f.path, size: f.stat.size, mtime: f.stat.mtime });
			else if (f instanceof TFolder && !f.isRoot()) dirs.push(f.path);
		}
		if (this.includeConfig) {
			const walk = async (dir: string) => {
				const l = await this.adapter.list(dir);
				for (const fp of l.files) {
					const st = await this.adapter.stat(fp);
					if (st && st.type === "file") files.push({ path: normalizePath(fp), size: st.size, mtime: st.mtime });
				}
				for (const sub of l.folders) {
					dirs.push(normalizePath(sub));
					await walk(sub);
				}
			};
			const c = this.app.vault.configDir;
			if (await this.adapter.exists(c)) {
				dirs.push(c);
				await walk(c);
			}
		}
		return { files, dirs };
	}

	async stat(path: string): Promise<LocalEntry | null> {
		const st = await this.adapter.stat(path);
		if (!st || st.type !== "file") return null;
		return { path, size: st.size, mtime: st.mtime };
	}

	read(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(path);
	}

	private async ensureFolder(dir: string): Promise<void> {
		if (!dir || (await this.adapter.exists(dir))) return;
		await this.ensureFolder(dirname(dir));
		this.onSelfWrite(dir);
		try {
			if (this.isConfig(dir)) await this.adapter.mkdir(dir);
			else await this.app.vault.createFolder(dir);
		} catch (e) {
			if (!(await this.adapter.exists(dir))) throw e;
		}
	}

	/** Save any open editor of this file so the disk has what the user typed. */
	private async flushEditors(path: string): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file?.path === path) {
				try {
					await v.save();
				} catch {
					/* view closing */
				}
			}
		}
	}

	async replace(path: string, data: ArrayBuffer, expectHash: string | null): Promise<boolean> {
		this.onSelfWrite(path);
		await this.flushEditors(path);
		const st = await this.adapter.stat(path);
		if (!st) {
			if (expectHash !== null) return false; // deleted meanwhile: don't resurrect
			await this.write(path, data);
			return true;
		}
		if (expectHash === null || st.type !== "file") return false; // appeared meanwhile
		const cur = await this.adapter.readBinary(path);
		if ((await sha256(cur)) !== expectHash) return false;

		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile && !this.isConfig(path) && looksLikeText(cur) && looksLikeText(data)) {
			// vault.process is a synchronous read-compare-write: no keystroke can slip in between.
			const strip = (t: string) => t.replace(/^\uFEFF/, "");
			const dec = new TextDecoder("utf-8", { ignoreBOM: true }); // keep BOM bytes exactly
			const before = strip(dec.decode(cur));
			const next = dec.decode(data);
			let ok = false;
			await this.app.vault.process(f, (now) => {
				if (strip(now) === before) {
					ok = true;
					return next;
				}
				return now;
			});
			if (ok) return true;
			// Text differed only by decoding details? Re-check bytes before giving up.
			if ((await sha256(await this.adapter.readBinary(path))) !== expectHash) return false;
		}
		await this.write(path, data);
		return true;
	}

	async deleteIf(path: string, expectHash: string): Promise<boolean> {
		await this.flushEditors(path);
		const st = await this.adapter.stat(path);
		if (!st) return true;
		if ((await sha256(await this.adapter.readBinary(path))) !== expectHash) return false;
		await this.delete(path);
		return true;
	}

	private async write(path: string, data: ArrayBuffer): Promise<void> {
		this.onSelfWrite(path);
		await this.ensureFolder(dirname(path));
		if (this.isConfig(path)) {
			await this.adapter.writeBinary(path, data);
			return;
		}
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) {
			await this.app.vault.modifyBinary(f, data);
			return;
		}
		try {
			await this.app.vault.createBinary(path, data);
		} catch (e) {
			// File exists on disk but isn't indexed yet.
			if (await this.adapter.exists(path)) await this.adapter.writeBinary(path, data);
			else throw e;
		}
	}

	private async delete(path: string): Promise<void> {
		this.onSelfWrite(path);
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) {
			await this.app.fileManager.trashFile(f); // respects the user's trash setting
			return;
		}
		if (!(await this.adapter.exists(path))) return;
		if (!(await this.adapter.trashSystem(path))) await this.adapter.trashLocal(path);
	}

	async mkdir(path: string): Promise<void> {
		await this.ensureFolder(path);
	}

	async rmdirIfEmpty(path: string): Promise<boolean> {
		if (!(await this.adapter.exists(path))) return true;
		const l = await this.adapter.list(path);
		if (l.files.length || l.folders.length) return false;
		this.onSelfWrite(path);
		// Checked empty above. adapter.rmdir(path, false) fails with EISDIR on desktop,
		// so trash the (empty) folder like Obsidian itself would.
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFolder) await this.app.fileManager.trashFile(f);
		else await this.adapter.rmdir(path, true);
		return true;
	}
}

/** Last-synced copies of notes, used as the common ancestor for 3-way merges. */
export class AdapterBaseStore implements BaseStore {
	constructor(private app: App, private dir: string) {}

	private p(hash: string) {
		return `${this.dir}/${hash}`;
	}

	async get(hash: string): Promise<string | null> {
		const a = this.app.vault.adapter;
		return (await a.exists(this.p(hash))) ? a.read(this.p(hash)) : null;
	}

	async put(hash: string, text: string): Promise<void> {
		const a = this.app.vault.adapter;
		if (!(await a.exists(this.dir))) await a.mkdir(this.dir);
		if (!(await a.exists(this.p(hash)))) await a.write(this.p(hash), text);
	}

	async gc(keep: Set<string>): Promise<void> {
		const a = this.app.vault.adapter;
		if (!(await a.exists(this.dir))) return;
		const l = await a.list(this.dir);
		for (const f of l.files) {
			const name = f.slice(f.lastIndexOf("/") + 1);
			if (!keep.has(name)) await a.remove(f);
		}
	}
}
