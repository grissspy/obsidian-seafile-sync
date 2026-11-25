import { merge3 } from "./merge";
import { BaseStore, FileState, LocalEntry, LocalFS, RemoteEntry, RemoteFS, SyncOptions, SyncResult, SyncState } from "./types";
import { extOf, formatConflictName, fromText, looksLikeText, parentDirs, pool, sha256, toText } from "./util";

export function emptyState(target: string): SyncState {
	return { version: 1, target, changeToken: null, files: {}, dirs: [], lastSync: 0 };
}

type Action =
	| { k: "upload"; path: string; why: string }
	| { k: "download"; path: string; r: RemoteEntry; expectLocal: string | null; why: string }
	| { k: "delLocal"; path: string; expectLocal: string }
	| { k: "delRemote"; path: string }
	| { k: "conflict"; path: string; r: RemoteEntry; expectLocal: string; prev: FileState | undefined }
	| { k: "forget"; path: string };

const MAX_BASE_SIZE = 2 * 1024 * 1024;

export class SyncEngine {
	private hashCache = new Map<string, string>();
	private remoteModified = false;
	private deletedRemote = new Set<string>();

	constructor(private local: LocalFS, private remote: RemoteFS, private bases: BaseStore, private state: SyncState, private opt: SyncOptions) {}

	private async localHash(path: string): Promise<string> {
		const c = this.hashCache.get(path);
		if (c) return c;
		const h = await sha256(await this.local.read(path));
		this.hashCache.set(path, h);
		return h;
	}

	private canMerge(path: string): boolean {
		return this.opt.mergeExtensions.includes(extOf(path));
	}

	private async rememberBase(path: string, hash: string, data: ArrayBuffer): Promise<void> {
		if (!this.canMerge(path) || data.byteLength > MAX_BASE_SIZE || !looksLikeText(data)) return;
		await this.bases.put(hash, toText(data));
	}

	private async record(path: string, data: ArrayBuffer, hash: string, rid: string): Promise<void> {
		const st = await this.local.stat(path);
		this.state.files[path] = { lh: hash, lm: st ? st.mtime : 0, ls: st ? st.size : data.byteLength, rid };
		await this.rememberBase(path, hash, data);
	}

	/** Write to the local file only if it still has the content we planned against. */
	private async safeLocalWrite(path: string, data: ArrayBuffer, expectLocal: string | null): Promise<boolean> {
		const st = await this.local.stat(path);
		if (st) {
			if (expectLocal === null) return false; // appeared during sync
			this.hashCache.delete(path);
			if ((await this.localHash(path)) !== expectLocal) return false;
		} else if (expectLocal !== null) {
			// deleted during sync; recreating it would resurrect it, skip
			return false;
		}
		await this.local.write(path, data);
		this.hashCache.delete(path);
		return true;
	}

	async run(): Promise<SyncResult> {
		const res: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflicts: 0, errors: [], skipped: false };
		const { opt, state } = this;
		const ign = (p: string) => opt.isIgnored(p);

		// ---- 1. Local scan
		const tokenBefore = await this.remote.changeToken();
		const loc = await this.local.list();
		const L = new Map<string, LocalEntry>();
		for (const f of loc.files) {
			if (ign(f.path)) continue;
			if (opt.maxFileSize > 0 && f.size > opt.maxFileSize) {
				opt.log(`skip (too large): ${f.path}`);
				continue;
			}
			L.set(f.path, f);
		}
		const Ld = new Set(opt.syncEmptyDirs ? loc.dirs.filter((d) => !ign(d)) : []);

		// Which local files changed since last sync?
		const localChanged = new Set<string>();
		for (const [p, f] of L) {
			const s = state.files[p];
			if (!s) {
				localChanged.add(p);
				continue;
			}
			if (s.lm === f.mtime && s.ls === f.size) {
				this.hashCache.set(p, s.lh);
				continue;
			}
			try {
				if ((await this.localHash(p)) !== s.lh) localChanged.add(p);
			} catch (e) {
				res.errors.push(`${p}: cannot read (${(e as Error).message})`);
			}
		}
		const anyLocalChange =
			localChanged.size > 0 ||
			Object.keys(state.files).some((p) => !L.has(p) && !ign(p)) ||
			(opt.syncEmptyDirs && (state.dirs.some((d) => !Ld.has(d)) || [...Ld].some((d) => !state.dirs.includes(d))));

		if (!anyLocalChange && tokenBefore && tokenBefore === state.changeToken) {
			res.skipped = true;
			return res;
		}

		// ---- 2. Remote scan
		const rem = await this.remote.list();
		const allRemotePaths = rem.files.map((f) => f.path).concat(rem.dirs);
		const R = new Map<string, RemoteEntry>();
		const lowerSeen = new Map<string, string>();
		for (const f of rem.files) {
			if (ign(f.path)) continue;
			if (opt.maxFileSize > 0 && f.size > opt.maxFileSize) {
				opt.log(`skip (too large): ${f.path}`);
				continue;
			}
			const low = f.path.toLowerCase();
			const prev = lowerSeen.get(low);
			if (prev) {
				res.errors.push(`"${f.path}" and "${prev}" differ only by letter case; skipped "${f.path}"`);
				continue;
			}
			lowerSeen.set(low, f.path);
			R.set(f.path, f);
		}
		const Rd = new Set(opt.syncEmptyDirs ? rem.dirs.filter((d) => !ign(d)) : []);

		// ---- 3. Plan
		const actions: Action[] = [];
		const paths = new Set<string>([...L.keys(), ...R.keys(), ...Object.keys(state.files)]);
		for (const p of paths) {
			if (ign(p)) continue;
			const l = L.get(p);
			const r = R.get(p);
			const s = state.files[p];
			if (l && r) {
				if (s) {
					const lc = localChanged.has(p);
					const rc = r.id !== s.rid;
					if (!lc && !rc) continue;
					if (lc && !rc) actions.push({ k: "upload", path: p, why: "changed locally" });
					else if (!lc && rc) actions.push({ k: "download", path: p, r, expectLocal: s.lh, why: "changed remotely" });
					else actions.push({ k: "conflict", path: p, r, expectLocal: await this.localHash(p), prev: s });
				} else {
					actions.push({ k: "conflict", path: p, r, expectLocal: await this.localHash(p), prev: undefined });
				}
			} else if (l && !r) {
				if (s && !localChanged.has(p)) actions.push({ k: "delLocal", path: p, expectLocal: s.lh });
				else actions.push({ k: "upload", path: p, why: s ? "changed locally, deleted remotely" : "new" });
			} else if (!l && r) {
				if (s && r.id === s.rid) actions.push({ k: "delRemote", path: p });
				else actions.push({ k: "download", path: p, r, expectLocal: null, why: s ? "changed remotely, deleted locally" : "new" });
			} else {
				actions.push({ k: "forget", path: p });
			}
		}

		// ---- 4. Mass-deletion guard
		const delL = actions.filter((a) => a.k === "delLocal").map((a) => a.path);
		const delR = actions.filter((a) => a.k === "delRemote").map((a) => a.path);
		if (opt.deleteThreshold > 0 && delL.length + delR.length > opt.deleteThreshold) {
			const answer = await opt.confirmDeletes(delL, delR);
			if (answer === "restore") {
				opt.log(`deletions declined: restoring ${delL.length + delR.length} files instead`);
				for (let i = 0; i < actions.length; i++) {
					const a = actions[i];
					if (a.k === "delLocal") actions[i] = { k: "upload", path: a.path, why: "restore" };
					else if (a.k === "delRemote") actions[i] = { k: "download", path: a.path, r: R.get(a.path)!, expectLocal: null, why: "restore" };
				}
			} else if (answer === "skip") {
				opt.log(`deletions postponed (${delL.length + delR.length} files)`);
				for (let i = actions.length - 1; i >= 0; i--) if (actions[i].k === "delLocal" || actions[i].k === "delRemote") actions.splice(i, 1);
			}
		}

		// ---- 5. Execute file actions
		const work = actions.filter((a) => a.k !== "forget");
		for (const a of actions) if (a.k === "forget") delete state.files[a.path];
		let done = 0;
		let sinceSave = 0;
		const total = work.length;
		if (total) opt.log(`plan: ${total} file operations`);
		opt.onProgress?.(0, total, "");

		await pool(work, opt.concurrency, async (a) => {
			try {
				await this.exec(a, res);
			} catch (e) {
				const msg = `${a.path}: ${(e as Error).message || e}`;
				res.errors.push(msg);
				opt.log("ERROR " + msg);
			}
			done++;
			opt.onProgress?.(done, total, a.path);
			if (++sinceSave >= 25) {
				sinceSave = 0;
				await opt.saveState(state);
			}
		});

		// ---- 6. Folders
		if (opt.syncEmptyDirs) {
			try {
				await this.syncDirs(Ld, Rd, allRemotePaths, res);
			} catch (e) {
				res.errors.push(`folders: ${(e as Error).message}`);
			}
		} else state.dirs = [];

		// ---- 7. Finish
		// The pre-listing token is only valid if we did not change the library ourselves.
		state.changeToken = this.remoteModified || res.errors.length ? null : tokenBefore;
		state.lastSync = Date.now();
		await opt.saveState(state);
		try {
			const keep = new Set(Object.values(state.files).map((f) => f.lh));
			await this.bases.gc(keep);
		} catch {
			/* not critical */
		}
		return res;
	}

	private async exec(a: Action, res: SyncResult): Promise<void> {
		const { opt, state } = this;
		switch (a.k) {
			case "upload": {
				const data = await this.local.read(a.path);
				const h = await sha256(data);
				const rid = await this.remote.upload(a.path, data);
				this.remoteModified = true;
				await this.record(a.path, data, h, rid);
				res.uploaded++;
				opt.log(`↑ ${a.path} (${a.why})`);
				return;
			}
			case "download": {
				const data = await this.remote.download(a.path);
				if (!(await this.safeLocalWrite(a.path, data, a.expectLocal))) {
					opt.log(`skip ${a.path}: changed locally during sync`);
					return;
				}
				await this.record(a.path, data, await sha256(data), a.r.id);
				res.downloaded++;
				opt.log(`↓ ${a.path} (${a.why})`);
				return;
			}
			case "delLocal": {
				const st = await this.local.stat(a.path);
				if (st) {
					this.hashCache.delete(a.path);
					if ((await this.localHash(a.path)) !== a.expectLocal) {
						opt.log(`skip delete ${a.path}: changed locally during sync`);
						return;
					}
					await this.local.delete(a.path);
				}
				delete state.files[a.path];
				res.deletedLocal++;
				opt.log(`✕ local ${a.path} (deleted on server)`);
				return;
			}
			case "delRemote": {
				await this.remote.deleteFile(a.path);
				this.remoteModified = true;
				this.deletedRemote.add(a.path);
				delete state.files[a.path];
				res.deletedRemote++;
				opt.log(`✕ server ${a.path} (deleted locally)`);
				return;
			}
			case "conflict":
				return this.resolveConflict(a, res);
			case "forget":
				delete state.files[a.path];
				return;
		}
	}

	private async resolveConflict(a: Extract<Action, { k: "conflict" }>, res: SyncResult): Promise<void> {
		const { opt } = this;
		const rdata = await this.remote.download(a.path);
		const rhash = await sha256(rdata);
		if (rhash === a.expectLocal) {
			// Same content on both sides — just remember it.
			const ldata = await this.local.read(a.path);
			await this.record(a.path, ldata, rhash, a.r.id);
			return;
		}
		const lst = await this.local.stat(a.path);
		const ldata = await this.local.read(a.path);
		if ((await sha256(ldata)) !== a.expectLocal) {
			opt.log(`skip ${a.path}: changed locally during sync`);
			return;
		}

		let strategy = opt.conflict;
		if (strategy === "newer") strategy = (lst?.mtime ?? 0) >= a.r.mtime ? "local" : "remote";

		if (strategy === "merge") {
			if (a.prev && this.canMerge(a.path) && looksLikeText(ldata) && looksLikeText(rdata)) {
				const base = await this.bases.get(a.prev.lh);
				if (base !== null) {
					const merged = merge3(base, toText(ldata), toText(rdata));
					if (merged !== null) {
						const mdata = fromText(merged);
						if (!(await this.safeLocalWrite(a.path, mdata, a.expectLocal))) {
							opt.log(`skip ${a.path}: changed locally during sync`);
							return;
						}
						const rid = await this.remote.upload(a.path, mdata);
						this.remoteModified = true;
						await this.record(a.path, mdata, await sha256(mdata), rid);
						res.merged++;
						opt.log(`⇄ merged ${a.path}`);
						return;
					}
				}
			}
			strategy = "keep-both";
		}

		if (strategy === "local") {
			const rid = await this.remote.upload(a.path, ldata);
			this.remoteModified = true;
			await this.record(a.path, ldata, a.expectLocal, rid);
			res.uploaded++;
			opt.log(`↑ ${a.path} (conflict: kept local)`);
			return;
		}
		if (strategy === "remote") {
			if (!(await this.safeLocalWrite(a.path, rdata, a.expectLocal))) return;
			await this.record(a.path, rdata, rhash, a.r.id);
			res.downloaded++;
			opt.log(`↓ ${a.path} (conflict: kept server)`);
			return;
		}

		// keep-both: newer version keeps the name, the other becomes a conflict copy.
		const localNewer = (lst?.mtime ?? 0) >= a.r.mtime;
		const now = new Date();
		if (localNewer) {
			const copy = formatConflictName(a.path, "server", now);
			await this.local.write(copy, rdata);
			const ridCopy = await this.remote.upload(copy, rdata);
			const rid = await this.remote.upload(a.path, ldata);
			this.remoteModified = true;
			await this.record(copy, rdata, rhash, ridCopy);
			await this.record(a.path, ldata, a.expectLocal, rid);
			opt.log(`⚠ conflict ${a.path}: server version saved as ${copy}`);
		} else {
			const copy = formatConflictName(a.path, opt.deviceName, now);
			await this.local.write(copy, ldata);
			const ridCopy = await this.remote.upload(copy, ldata);
			this.remoteModified = true;
			if (!(await this.safeLocalWrite(a.path, rdata, a.expectLocal))) return;
			await this.record(copy, ldata, a.expectLocal, ridCopy);
			await this.record(a.path, rdata, rhash, a.r.id);
			opt.log(`⚠ conflict ${a.path}: local version saved as ${copy}`);
		}
		res.conflicts++;
	}

	private async syncDirs(Ld: Set<string>, Rd: Set<string>, allRemotePaths: string[], res: SyncResult): Promise<void> {
		const { state, opt } = this;
		const Sd = new Set(state.dirs);
		const final = new Set<string>();
		const localFilesNow = await this.local.list();
		const localPaths = localFilesNow.files.map((f) => f.path).concat(localFilesNow.dirs);
		// Remote view after our file operations: what we uploaded is in state.
		const remoteNow = new Set<string>(allRemotePaths.filter((p) => !this.deletedRemote.has(p)));
		for (const p of Object.keys(state.files)) {
			remoteNow.add(p);
			for (const d of parentDirs(p)) remoteNow.add(d);
		}

		const hasChildren = (paths: Iterable<string>, d: string, except: Set<string>) => {
			const pre = d + "/";
			for (const p of paths) if (p.startsWith(pre) && !except.has(p)) return true;
			return false;
		};

		const union = [...new Set([...Ld, ...Rd, ...Sd])].sort((a, b) => b.length - a.length); // deepest first
		const removedLocal = new Set<string>();
		const removedRemote = new Set<string>();
		const toCreateRemote: string[] = [];
		const toCreateLocal: string[] = [];

		for (const d of union) {
			const inL = Ld.has(d);
			const inR = Rd.has(d);
			const inS = Sd.has(d);
			if (inL && inR) final.add(d);
			else if (inL && !inR) {
				if (inS && !hasChildren(localPaths, d, removedLocal)) {
					if (await this.local.rmdirIfEmpty(d)) {
						removedLocal.add(d);
						opt.log(`✕ local folder ${d}`);
					} else final.add(d);
				} else toCreateRemote.push(d);
			} else if (!inL && inR) {
				if (inS && !hasChildren(remoteNow, d, removedRemote)) {
					await this.remote.deleteDir(d);
					this.remoteModified = true;
					removedRemote.add(d);
					opt.log(`✕ server folder ${d}`);
				} else toCreateLocal.push(d);
			}
		}
		for (const d of toCreateRemote.reverse()) {
			if (!remoteNow.has(d)) {
				await this.remote.mkdir(d);
				this.remoteModified = true;
				opt.log(`+ server folder ${d}`);
			}
			final.add(d);
		}
		for (const d of toCreateLocal.reverse()) {
			await this.local.mkdir(d);
			opt.log(`+ local folder ${d}`);
			final.add(d);
		}
		// Folders that hold synced files exist on both sides too.
		for (const p of Object.keys(state.files)) for (const d of parentDirs(p)) if (!opt.isIgnored(d)) final.add(d);
		state.dirs = [...final].sort();
		void res;
	}
}
