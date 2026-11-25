import { App, debounce, Modal, Notice, Platform, Plugin, requestUrl, setIcon, TAbstractFile } from "obsidian";
import { AdapterBaseStore, ObsidianLocal } from "./local";
import { Http, SeafileApi, SeafileRemote } from "./seafile";
import { DEFAULT_SETTINGS, SeafileSettingTab, Settings } from "./settings";
import { emptyState, SyncEngine } from "./sync";
import { SyncResult, SyncState } from "./types";
import { globToRegExp } from "./util";

const obsidianHttp: Http = async (req) => {
	const r = await requestUrl({
		url: req.url,
		method: req.method || "GET",
		headers: req.headers,
		body: req.body,
		contentType: req.contentType,
		throw: false,
	});
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(r.headers || {})) headers[k.toLowerCase()] = String(v);
	return {
		status: r.status,
		headers,
		get text() {
			return r.text;
		},
		get arrayBuffer() {
			return r.arrayBuffer;
		},
	};
};

export default class SeafileSyncPlugin extends Plugin {
	settings!: Settings;
	http: Http = obsidianHttp;
	private syncing = false;
	private pending = false;
	private statusEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private intervalId: number | null = null;
	private logLines: string[] = [];
	private selfWrites = new Map<string, number>();
	private lastResult: { at: number; ok: boolean } | null = null;

	private get pluginDir() {
		return this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}
	private get statePath() {
		return `${this.pluginDir}/sync-state.json`;
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SeafileSettingTab(this.app, this));

		this.ribbonEl = this.addRibbonIcon("refresh-cw", "Sync with Seafile", () => this.sync("manual"));
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("mod-clickable");
			this.statusEl.onClickEvent(() => this.sync("manual"));
			this.setStatus("idle");
		}

		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync("manual") });
		this.addCommand({ id: "show-log", name: "Show sync log", callback: () => new LogModal(this.app, this.logLines).open() });

		const onChange = (f: TAbstractFile) => this.onVaultChange(f.path);
		this.registerEvent(this.app.vault.on("modify", onChange));
		this.registerEvent(this.app.vault.on("create", onChange));
		this.registerEvent(this.app.vault.on("delete", onChange));
		this.registerEvent(this.app.vault.on("rename", (f, old) => {
			this.onVaultChange(f.path);
			this.onVaultChange(old);
		}));

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.settings.syncOnResume && this.isConfigured()) {
				if (!this.lastResult || Date.now() - this.lastResult.at > 30_000) this.sync("resume");
			}
		});

		this.app.workspace.onLayoutReady(() => {
			// layout ready → vault index is loaded; give other plugins a moment.
			if (this.settings.syncOnStartup && this.isConfigured()) window.setTimeout(() => this.sync("startup"), 3000);
			this.restartTimers();
		});
	}

	onunload() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.deviceName) {
			this.settings.deviceName = Platform.isAndroidApp ? "Android" : Platform.isIosApp ? "iOS" : Platform.isMacOS ? "Mac" : Platform.isWin ? "Windows" : "Desktop";
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	restartTimers() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const m = this.settings.intervalMinutes;
		if (m > 0) {
			this.intervalId = window.setInterval(() => this.isConfigured() && this.sync("interval"), m * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	isConfigured(): boolean {
		const s = this.settings;
		return !!(s.server && s.token && s.repoId);
	}

	api(): SeafileApi {
		if (!this.settings.server || !this.settings.token) throw new Error("Not signed in");
		return new SeafileApi(this.http, this.settings.server, this.settings.token, this.settings.rewriteFileServer);
	}

	// ---------- triggers

	private debouncedSync = debounce(() => this.sync("change"), 15_000, true);
	private debounceMs = 15_000;

	private onVaultChange(path: string) {
		const t = this.selfWrites.get(path);
		if (t && Date.now() - t < 10_000) return; // caused by our own sync
		if (this.isIgnored(path)) return;
		const secs = this.settings.syncOnChangeSeconds;
		if (!secs || !this.isConfigured()) return;
		if (this.debounceMs !== secs * 1000) {
			this.debounceMs = secs * 1000;
			this.debouncedSync = debounce(() => this.sync("change"), this.debounceMs, true);
		}
		this.debouncedSync();
	}

	// ---------- ignore rules

	private ignoreCache: { src: string; res: RegExp[] } | null = null;

	isIgnored(path: string): boolean {
		const cfg = this.app.vault.configDir;
		const own = this.pluginDir;
		if (path === `${own}/data.json` || path === `${own}/sync-state.json` || path.startsWith(`${own}/base`)) return true;
		if (path === `${cfg}/workspace.json` || path === `${cfg}/workspace-mobile.json`) return true;
		if (!this.settings.syncConfigDir && (path === cfg || path.startsWith(cfg + "/"))) return true;
		const src = this.settings.ignore;
		if (!this.ignoreCache || this.ignoreCache.src !== src) {
			const res: RegExp[] = [];
			for (const line of src.split("\n")) {
				const l = line.trim();
				if (!l || l.startsWith("#")) continue;
				try {
					res.push(globToRegExp(l));
				} catch {
					/* bad pattern */
				}
			}
			this.ignoreCache = { src, res };
		}
		return this.ignoreCache.res.some((r) => r.test(path));
	}

	// ---------- state

	private targetKey(): string {
		const s = this.settings;
		return `${s.server.replace(/\/+$/, "")}|${s.repoId}|${s.remoteFolder.replace(/^\/+|\/+$/g, "")}`;
	}

	private async loadState(): Promise<SyncState> {
		const a = this.app.vault.adapter;
		try {
			if (await a.exists(this.statePath)) {
				const st = JSON.parse(await a.read(this.statePath)) as SyncState;
				if (st.version === 1 && st.target === this.targetKey()) return st;
				this.log("sync target changed — starting with a fresh state");
			}
		} catch (e) {
			this.log("could not read state: " + (e as Error).message);
		}
		return emptyState(this.targetKey());
	}

	private async saveState(st: SyncState) {
		const a = this.app.vault.adapter;
		const tmp = this.statePath + ".tmp";
		await a.write(tmp, JSON.stringify(st));
		if (await a.exists(this.statePath)) await a.remove(this.statePath);
		await a.rename(tmp, this.statePath);
	}

	async resetState() {
		const a = this.app.vault.adapter;
		if (await a.exists(this.statePath)) await a.remove(this.statePath);
	}

	// ---------- UI helpers

	private log(msg: string) {
		const d = new Date();
		const line = `${d.toLocaleTimeString()} ${msg}`;
		this.logLines.push(line);
		if (this.logLines.length > 500) this.logLines.splice(0, this.logLines.length - 500);
		console.debug("[seafile-sync]", msg);
	}

	private setStatus(kind: "idle" | "sync" | "ok" | "error", text = "") {
		if (this.ribbonEl) this.ribbonEl.toggleClass("seafile-sync-spinning", kind === "sync");
		if (!this.statusEl) return;
		this.statusEl.empty();
		const icon = this.statusEl.createSpan({ cls: "seafile-sync-icon" });
		setIcon(icon, kind === "error" ? "alert-triangle" : kind === "sync" ? "refresh-cw" : "cloud");
		if (kind === "sync") icon.addClass("seafile-sync-spinning");
		this.statusEl.createSpan({ text: " " + (text || (kind === "idle" ? "Seafile" : "")) });
		this.statusEl.setAttr("aria-label", "Seafile sync — click to sync now");
	}

	// ---------- the sync

	async sync(reason: "manual" | "startup" | "interval" | "change" | "resume"): Promise<void> {
		if (!this.isConfigured()) {
			if (reason === "manual") new Notice("Seafile: configure server, sign in and choose a library in settings first.");
			return;
		}
		if (this.syncing) {
			this.pending = true;
			if (reason === "manual") new Notice("Seafile: sync already running");
			return;
		}
		this.syncing = true;
		this.pending = false;
		this.setStatus("sync", "Syncing…");
		const started = Date.now();
		this.log(`— sync (${reason})`);
		let result: SyncResult | null = null;
		try {
			const s = this.settings;
			const api = this.api();
			const remote = new SeafileRemote(api, s.repoId, s.remoteFolder, s.repoPassword || undefined);
			await remote.prepare();
			const local = new ObsidianLocal(this.app, s.syncConfigDir, (p) => this.selfWrites.set(p, Date.now()));
			const bases = new AdapterBaseStore(this.app, `${this.pluginDir}/base`);
			const state = await this.loadState();
			const engine = new SyncEngine(local, remote, bases, state, {
				conflict: s.conflict,
				deviceName: s.deviceName || "device",
				mergeExtensions: s.mergeExtensions.split(",").map((x) => x.trim().toLowerCase().replace(/^\./, "")).filter(Boolean),
				maxFileSize: s.maxFileSizeMB * 1024 * 1024,
				concurrency: s.concurrency,
				syncEmptyDirs: s.syncEmptyDirs,
				deleteThreshold: s.deleteThreshold,
				isIgnored: (p) => this.isIgnored(p),
				confirmDeletes: (l, r) => new ConfirmDeleteModal(this.app, l, r).ask(),
				onProgress: (d, t) => t && this.setStatus("sync", `${d}/${t}`),
				log: (m) => this.log(m),
				saveState: (st) => this.saveState(st),
			});
			result = await engine.run();
			this.lastResult = { at: Date.now(), ok: result.errors.length === 0 };
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const parts: string[] = [];
			if (result.uploaded) parts.push(`↑${result.uploaded}`);
			if (result.downloaded) parts.push(`↓${result.downloaded}`);
			if (result.deletedLocal + result.deletedRemote) parts.push(`✕${result.deletedLocal + result.deletedRemote}`);
			if (result.merged) parts.push(`merged ${result.merged}`);
			if (result.conflicts) parts.push(`conflicts ${result.conflicts}`);
			const summary = parts.length ? parts.join(" ") : "up to date";
			this.log(`done in ${secs}s: ${summary}${result.errors.length ? `, ${result.errors.length} errors` : ""}`);

			const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			if (result.errors.length) {
				this.setStatus("error", `Seafile: ${result.errors.length} errors`);
				if (s.notices !== "none") new Notice(`Seafile: ${result.errors.length} file(s) failed — see “Show sync log”.\n${result.errors.slice(0, 3).join("\n")}`, 10000);
			} else {
				this.setStatus("ok", `Seafile ${time}`);
				if (result.conflicts && s.notices !== "none") new Notice(`Seafile: ${result.conflicts} conflict(s) — look for “(conflict …)” files.`, 10000);
				else if (s.notices === "all" || (reason === "manual" && s.notices !== "none")) new Notice(`Seafile: ${summary}`);
			}
		} catch (e) {
			const msg = (e as Error).message || String(e);
			this.lastResult = { at: Date.now(), ok: false };
			this.log("FAILED: " + msg);
			this.setStatus("error", "Seafile: error");
			const quiet = reason !== "manual" && /net::|Failed to fetch|ERR_|timed out|ENOTFOUND|ECONN/i.test(msg);
			if (this.settings.notices !== "none" && !quiet) new Notice("Seafile sync failed: " + msg, 10000);
		} finally {
			this.syncing = false;
			// Drop old self-write markers.
			const cutoff = Date.now() - 60_000;
			for (const [p, t] of this.selfWrites) if (t < cutoff) this.selfWrites.delete(p);
			if (this.pending) {
				this.pending = false;
				window.setTimeout(() => this.sync("change"), 2000);
			}
		}
	}
}

class ConfirmDeleteModal extends Modal {
	private resolve!: (v: "delete" | "restore" | "skip") => void;
	private answered = false;

	constructor(app: App, private localDel: string[], private remoteDel: string[]) {
		super(app);
	}

	ask(): Promise<"delete" | "restore" | "skip"> {
		return new Promise((res) => {
			this.resolve = res;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Seafile: many deletions");
		const n = this.localDel.length + this.remoteDel.length;
		contentEl.createEl("p", { text: `This sync would delete ${n} files. If you did not expect this (wrong library/folder, vault was moved), choose “Restore”.` });
		const list = (title: string, items: string[]) => {
			if (!items.length) return;
			contentEl.createEl("h4", { text: `${title} (${items.length})` });
			const ul = contentEl.createEl("ul");
			for (const p of items.slice(0, 15)) ul.createEl("li", { text: p });
			if (items.length > 15) ul.createEl("li", { text: `… and ${items.length - 15} more` });
		};
		list("Delete on this device (deleted on server)", this.localDel);
		list("Delete on server (deleted on this device)", this.remoteDel);
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: "Not now" }).onclick = () => this.finish("skip");
		row.createEl("button", { text: "Restore (copy back)" }).onclick = () => this.finish("restore");
		row.createEl("button", { text: "Delete", cls: "mod-warning" }).onclick = () => this.finish("delete");
	}

	private finish(v: "delete" | "restore" | "skip") {
		this.answered = true;
		this.resolve(v);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		if (!this.answered) this.resolve("skip");
	}
}

class LogModal extends Modal {
	constructor(app: App, private lines: string[]) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("Seafile sync log");
		const pre = this.contentEl.createEl("pre", { cls: "seafile-sync-log" });
		pre.setText(this.lines.slice(-300).join("\n") || "(empty)");
	}
	onClose() {
		this.contentEl.empty();
	}
}
