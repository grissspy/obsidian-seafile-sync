import { LocalEntry, LocalFS } from "./types";

/** A folder of the vault seen as its own root (for extra library mappings). */
export class PrefixLocal implements LocalFS {
	constructor(private inner: LocalFS, private prefix: string) {}

	private full(p: string): string {
		return p ? `${this.prefix}/${p}` : this.prefix;
	}

	async list(): Promise<{ files: LocalEntry[]; dirs: string[] }> {
		const pre = this.prefix + "/";
		const all = await this.inner.list();
		return {
			files: all.files.filter((f) => f.path.startsWith(pre)).map((f) => ({ ...f, path: f.path.slice(pre.length) })),
			dirs: all.dirs.filter((d) => d.startsWith(pre)).map((d) => d.slice(pre.length)),
		};
	}
	async stat(path: string): Promise<LocalEntry | null> {
		const st = await this.inner.stat(this.full(path));
		return st ? { ...st, path } : null;
	}
	read(path: string): Promise<ArrayBuffer> {
		return this.inner.read(this.full(path));
	}
	replace(path: string, data: ArrayBuffer, expectHash: string | null): Promise<boolean> {
		return this.inner.replace(this.full(path), data, expectHash);
	}
	deleteIf(path: string, expectHash: string): Promise<boolean> {
		return this.inner.deleteIf(this.full(path), expectHash);
	}
	mkdir(path: string): Promise<void> {
		return this.inner.mkdir(this.full(path));
	}
	rmdirIfEmpty(path: string): Promise<boolean> {
		return this.inner.rmdirIfEmpty(this.full(path));
	}
}
