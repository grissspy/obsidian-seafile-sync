import { App, normalizePath, TFile, TFolder } from "obsidian";
import { BaseStore, LocalEntry, LocalFS } from "./types";
import { dirname } from "./util";

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

	async write(path: string, data: ArrayBuffer): Promise<void> {
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

	async delete(path: string): Promise<void> {
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
		await this.adapter.rmdir(path, false);
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
