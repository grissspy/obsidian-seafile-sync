import { merge3 } from "./merge";
import { BaseStore, FileState, LocalEntry, LocalFS, RemoteEntry, RemoteFS, SyncOptions, SyncResult, SyncState } from "./types";
import { extOf, formatConflictName, fromText, looksLikeText, parentDirs, pool, sha256, toText } from "./util";

export function emptyState(target: string): SyncState {
	return { version: 1, target, changeToken: null, files: {}, dirs: [], lastSync: 0 };
}

type Action =
	| { k: "upload"; path: string; expectRemote: string | null; why: string }
	| { k: "download"; path: string; r: RemoteEntry; expectLocal: string | null; why: string }
	| { k: "delLocal"; path: string; expectLocal: string }
	| { k: "delRemote"; path: string; expectRemote: string }
	| { k: "conflict"; path: string; r: RemoteEntry; expectLocal: string; prev: FileState | undefined }
	| { k: "forget"; path: string };

const MAX_BASE_SIZE = 2 * 1024 * 1024;

export class SyncEngine {
	private hashCache = new Map<string, string>();
	private remoteModified = false;
	private deletedRemote = new Set<string>();
	/** Something was postponed: don't trust the change token next time. */
	private retryNeeded = false;

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

	/** Write to the local file only if it still has the content we planned against
	 *  (null = file must not exist). The check-and-write is atomic in LocalFS.replace. */
	private async safeLocalWrite(path: string, data: ArrayBuffer, expectLocal: string | null): Promise<boolean> {
		const ok = await this.local.replace(path, data, expectLocal);
		this.hashCache.delete(path);
		return ok;
	}

	/** True if the server still has the version we planned against (null = absent). */
	private async remoteIs(path: string, expectId: string | null): Promise<boolean> {
		const cur = await this.remote.stat(path);
		if (cur === expectId) return true;
		this.retryNeeded = true;
		return false;
	}

	async run(): Promise<SyncResult> {
		const res: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflicts: 0, errors: [], skipped: false };
		const { opt, state } = this;
		const ign = (p: string, isDir = false) => opt.isIgnored(p, isDir);

		// ---- 0. Forget paths that are excluded now (e.g. a file type was switched off),
		// so switching them back on later compares contents instead of treating a
		// missing file as "deleted" and propagating that deletion.
		let forgot = false;
		for (const p of Object.keys(state.files)) {
			if (ign(p)) {
				delete state.files[p];
				forgot = true;
			}
		}
		const keptDirs = state.dirs.filter((d) => !ign(d, true));
		if (keptDirs.length !== state.dirs.length) {
			state.dirs = keptDirs;
			forgot = true;
		}

		// ---- 1. Local scan
		const tokenBefore = await this.remote.changeToken();
		const loc = await this.local.list();
		const L = new Map<string, LocalEntry>();
		// Paths we must leave alone this run (too large, name clash). Never treated as deleted.
		const skip = new Set<string>();
		for (const f of loc.files) {
			if (ign(f.path)) continue;
			if (opt.maxFileSize > 0 && f.size > opt.maxFileSize) {
				opt.log(`skip (too large): ${f.path}`);
				skip.add(f.path);
				continue;
			}
			L.set(f.path, f);
		}
		const Ld = new Set(opt.syncEmptyDirs ? loc.dirs.filter((d) => !ign(d, true)) : []);

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
			Object.keys(state.files).some((p) => !L.has(p) && !ign(p) && !skip.has(p)) ||
			(opt.syncEmptyDirs && (state.dirs.some((d) => !Ld.has(d)) || [...Ld].some((d) => !state.dirs.includes(d))));

		const filtersChanged = (state.filterKey ?? "") !== opt.filterKey;
		if (!anyLocalChange && !filtersChanged && tokenBefore && tokenBefore === state.changeToken) {
			if (forgot) await opt.saveState(state);
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
				skip.add(f.path);
				continue;
			}
			const low = f.path.toLowerCase();
			const prev = lowerSeen.get(low);
			if (prev) {
				res.errors.push(`"${f.path}" and "${prev}" differ only by letter case; skipped both`);
				skip.add(f.path);
				skip.add(prev);
				continue;
			}
			lowerSeen.set(low, f.path);
			R.set(f.path, f);
		}
		for (const p of skip) R.delete(p);
		const Rd = new Set(opt.syncEmptyDirs ? rem.dirs.filter((d) => !ign(d, true)) : []);

		// ---- 3. Plan
		const actions: Action[] = [];
		const paths = new Set<string>([...L.keys(), ...R.keys(), ...Object.keys(state.files)]);
		for (const p of paths) {
			if (ign(p)) {
				// Excluded now (e.g. a file type was switched off): forget it, so turning it
				// back on later compares contents instead of treating it as deleted.
				delete state.files[p];
				continue;
			}
			if (skip.has(p)) continue;
			const l = L.get(p);
			const r = R.get(p);
			const s = state.files[p];
			if (l && r) {
				if (s) {
					const lc = localChanged.has(p);
					const rc = r.id !== s.rid;
					if (!lc && !rc) continue;
					if (lc && !rc) actions.push({ k: "upload", path: p, expectRemote: r.id, why: "changed locally" });
					else if (!lc && rc) actions.push({ k: "download", path: p, r, expectLocal: s.lh, why: "changed remotely" });
					else actions.push({ k: "conflict", path: p, r, expectLocal: await this.localHash(p), prev: s });
				} else {
					actions.push({ k: "conflict", path: p, r, expectLocal: await this.localHash(p), prev: undefined });
				}
			} else if (l && !r) {
				if (s && !localChanged.has(p)) actions.push({ k: "delLocal", path: p, expectLocal: s.lh });
				else actions.push({ k: "upload", path: p, expectRemote: null, why: s ? "changed locally, deleted remotely" : "new" });
			} else if (!l && r) {
				if (s && r.id === s.rid) actions.push({ k: "delRemote", path: p, expectRemote: r.id });
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
					if (a.k === "delLocal") actions[i] = { k: "upload", path: a.path, expectRemote: null, why: "restore" };
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
				opt.log(`ERROR folders: ${(e as Error).message}`);
			}
		} else state.dirs = [];

		// ---- 7. Finish
		// The pre-listing token is only valid if we did not change the library ourselves.
		state.changeToken = this.remoteModified || this.retryNeeded || res.errors.length ? null : tokenBefore;
		state.lastSync = Date.now();
		state.filterKey = opt.filterKey;
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
				// Someone may have uploaded a newer version after we listed the server:
				// never overwrite it blindly, resolve it as a conflict instead.
				const cur = await this.remote.stat(a.path);
				if (cur !== null && cur !== a.expectRemote) {
					opt.log(`${a.path}: changed on server during sync → resolving as conflict`);
					const r: RemoteEntry = { path: a.path, id: cur, size: 0, mtime: Date.now() };
					return this.resolveConflict({ k: "conflict", path: a.path, r, expectLocal: h, prev: state.files[a.path] }, res);
				}
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
					this.retryNeeded = true;
					opt.log(`skip ${a.path}: changed locally during sync, will merge next time`);
					return;
				}
				await this.record(a.path, data, await sha256(data), a.r.id);
				res.downloaded++;
				opt.log(`↓ ${a.path} (${a.why})`);
				return;
			}
			case "delLocal": {
				if (!(await this.local.deleteIf(a.path, a.expectLocal))) {
					this.retryNeeded = true;
					opt.log(`skip delete ${a.path}: changed locally during sync`);
					return;
				}
				this.hashCache.delete(a.path);
				delete state.files[a.path];
				res.deletedLocal++;
				opt.log(`✕ local ${a.path} (deleted on server)`);
				return;
			}
			case "delRemote": {
				if (!(await this.remoteIs(a.path, a.expectRemote))) {
					opt.log(`skip delete ${a.path}: changed on server during sync`);
					return;
				}
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

	/** Upload to a.path only if the server still has the version we resolved against. */
	private async guardedUpload(path: string, data: ArrayBuffer, expectId: string): Promise<string | null> {
		if (!(await this.remoteIs(path, expectId))) {
			this.opt.log(`skip ${path}: changed on server during sync, will retry`);
			return null;
		}
		const rid = await this.remote.upload(path, data);
		this.remoteModified = true;
		return rid;
	}

	private async resolveConflict(a: Extract<Action, { k: "conflict" }>, res: SyncResult): Promise<void> {
		const { opt } = this;
		const rdata = await this.remote.download(a.path);
		const rhash = await sha256(rdata);
		const lst = await this.local.stat(a.path);
		if (!lst) {
			this.retryNeeded = true;
			return; // deleted locally meanwhile; next run decides
		}
		const ldata = await this.local.read(a.path);
		const lhash = await sha256(ldata);
		if (lhash !== a.expectLocal) {
			this.retryNeeded = true;
			opt.log(`skip ${a.path}: changed locally during sync`);
			return;
		}
		if (rhash === lhash) {
			// Same content on both sides — just remember it.
			await this.record(a.path, ldata, lhash, a.r.id);
			return;
		}

		let strategy = opt.conflict;
		if (strategy === "newer") strategy = lst.mtime >= a.r.mtime ? "local" : "remote";

		if (strategy === "merge") {
			if (a.prev && this.canMerge(a.path) && looksLikeText(ldata) && looksLikeText(rdata)) {
				const base = await this.bases.get(a.prev.lh);
				if (base !== null) {
					const merged = merge3(base, toText(ldata), toText(rdata));
					if (merged !== null) {
						const mdata = fromText(merged);
						if (!(await this.remoteIs(a.path, a.r.id))) return;
						if (!(await this.safeLocalWrite(a.path, mdata, lhash))) {
							this.retryNeeded = true;
							opt.log(`skip ${a.path}: changed locally during sync`);
							return;
						}
						// Local file now holds the merge. If the upload is skipped, the next run
						// sees "both changed" again and merges again — nothing is lost.
						const mhash = await sha256(mdata);
						const rid = await this.guardedUpload(a.path, mdata, a.r.id);
						if (rid === null) return;
						await this.record(a.path, mdata, mhash, rid);
						res.merged++;
						opt.log(`⇄ merged ${a.path}`);
						return;
					}
				}
			}
			strategy = "keep-both";
		}

		if (strategy === "local") {
			const rid = await this.guardedUpload(a.path, ldata, a.r.id);
			if (rid === null) return;
			await this.record(a.path, ldata, lhash, rid);
			res.uploaded++;
			opt.log(`↑ ${a.path} (conflict: kept local; old server version is in Seafile file history)`);
			return;
		}
		if (strategy === "remote") {
			if (!(await this.safeLocalWrite(a.path, rdata, lhash))) {
				this.retryNeeded = true;
				return;
			}
			await this.record(a.path, rdata, rhash, a.r.id);
			res.downloaded++;
			opt.log(`↓ ${a.path} (conflict: kept server version, local edits discarded)`);
			return;
		}

		// keep-both: newer version keeps the name, the other becomes a conflict copy.
		// The copy is written first, so whatever happens next both versions exist.
		const localNewer = lst.mtime >= a.r.mtime;
		const now = new Date();
		if (localNewer) {
			const copy = formatConflictName(a.path, "server", now);
			if (!(await this.safeLocalWrite(copy, rdata, null))) throw new Error(`cannot create ${copy}`);
			const ridCopy = await this.remote.upload(copy, rdata);
			this.remoteModified = true;
			await this.record(copy, rdata, rhash, ridCopy);
			const rid = await this.guardedUpload(a.path, ldata, a.r.id);
			if (rid !== null) await this.record(a.path, ldata, lhash, rid);
			opt.log(`⚠ conflict ${a.path}: server version saved as ${copy}`);
		} else {
			const copy = formatConflictName(a.path, opt.deviceName, now);
			if (!(await this.safeLocalWrite(copy, ldata, null))) throw new Error(`cannot create ${copy}`);
			const ridCopy = await this.remote.upload(copy, ldata);
			this.remoteModified = true;
			await this.record(copy, ldata, lhash, ridCopy);
			if (await this.safeLocalWrite(a.path, rdata, lhash)) await this.record(a.path, rdata, rhash, a.r.id);
			else this.retryNeeded = true;
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
		for (const p of Object.keys(state.files)) for (const d of parentDirs(p)) if (!opt.isIgnored(d, true)) final.add(d);
		state.dirs = [...final].sort();
		void res;
	}
}
