import { App, debounce, Modal, Notice, Platform, Plugin, requestUrl, setIcon, TAbstractFile, TFolder } from "obsidian";
import { AdapterBaseStore, ObsidianLocal } from "./local";
import { t } from "./i18n";
import { Http, SeafileApi, SeafileError, SeafileRemote } from "./seafile";
import { DEFAULT_SETTINGS, SeafileSettingTab, Settings } from "./settings";
import { emptyState, SyncEngine } from "./sync";
import { SyncResult, SyncState } from "./types";
import { extOf, globToRegExp } from "./util";

const NOTE_EXT = new Set(["md", "canvas", "base"]);
const TYPE_EXT: Record<"images" | "audio" | "video" | "pdf", Set<string>> = {
	images: new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "heic", "heif", "tif", "tiff", "ico"]),
	audio: new Set(["mp3", "wav", "m4a", "ogg", "oga", "flac", "aac", "opus", "3gp", "wma"]),
	video: new Set(["mp4", "mov", "mkv", "avi", "webm", "ogv", "m4v", "wmv"]),
	pdf: new Set(["pdf"]),
};

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

		this.ribbonEl = this.addRibbonIcon("refresh-cw", "Sync with Seafile", () => void this.sync("manual"));
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("mod-clickable");
			this.statusEl.onClickEvent(() => void this.sync("manual"));
			this.setStatus(this.settings.paused ? "paused" : "idle");
		}

		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync("manual") });
		this.addCommand({
			id: "toggle-pause",
			name: "Pause / resume automatic sync",
			callback: async () => {
				this.settings.paused = !this.settings.paused;
				await this.saveSettings();
				this.setStatus(this.settings.paused ? "paused" : "idle");
				new Notice(t(this.settings.paused ? "paused" : "resumed"));
			},
		});
		this.addCommand({ id: "show-log", name: "Show sync log", callback: () => new LogModal(this.app, this.logLines).open() });

		const onChange = (f: TAbstractFile) => this.onVaultChange(f.path, f instanceof TFolder);
		this.registerEvent(this.app.vault.on("modify", onChange));
		this.registerEvent(this.app.vault.on("create", onChange));
		this.registerEvent(this.app.vault.on("delete", onChange));
		this.registerEvent(this.app.vault.on("rename", (f, old) => {
			this.onVaultChange(f.path, f instanceof TFolder);
			this.onVaultChange(old, f instanceof TFolder);
		}));

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.settings.syncOnResume && this.isConfigured()) {
				if (!this.lastResult || Date.now() - this.lastResult.at > 30_000) void this.sync("resume");
			}
		});

		this.app.workspace.onLayoutReady(() => {
			// layout ready → vault index is loaded; give other plugins a moment.
			if (this.settings.syncOnStartup && this.isConfigured()) window.setTimeout(() => void this.sync("startup"), 3000);
			this.restartTimers();
		});
	}

	onunload() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
	}

	// ---------- secrets (OS keychain via Obsidian SecretStorage, never in data.json)

	private secretKey(kind: "token" | "repo-password"): string {
		return `seafile-vault-sync-${this.settings.secretId}-${kind}`;
	}
	getToken(): string {
		return this.app.secretStorage.getSecret(this.secretKey("token")) ?? "";
	}
	setToken(v: string) {
		this.app.secretStorage.setSecret(this.secretKey("token"), v);
	}
	getRepoPassword(): string {
		return this.app.secretStorage.getSecret(this.secretKey("repo-password")) ?? "";
	}
	setRepoPassword(v: string) {
		this.app.secretStorage.setSecret(this.secretKey("repo-password"), v);
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<Settings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
		let dirty = false;
		if (!this.settings.secretId) {
			this.settings.secretId = Math.random().toString(36).slice(2, 10);
			dirty = true;
		}
		// Move secrets saved by 1.0-1.1 out of data.json into the keychain.
		const legacy = this.settings as unknown as { token?: string; repoPassword?: string };
		if (legacy.token) {
			this.setToken(legacy.token);
			dirty = true;
		}
		if (legacy.repoPassword) {
			this.setRepoPassword(legacy.repoPassword);
			dirty = true;
		}
		delete legacy.token;
		delete legacy.repoPassword;
		if (dirty) await this.saveData(this.settings);
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
			this.intervalId = window.setInterval(() => {
				if (this.isConfigured()) void this.sync("interval");
			}, m * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	isConfigured(): boolean {
		const s = this.settings;
		return !!(s.server && s.repoId && this.getToken());
	}

	api(): SeafileApi {
		const token = this.getToken();
		if (!this.settings.server || !token) throw new Error("Not signed in");
		return new SeafileApi(this.http, this.settings.server, token, this.settings.rewriteFileServer);
	}

	// ---------- triggers

	private debouncedSync = debounce(() => void this.sync("change"), 15_000, true);
	private debounceMs = 15_000;

	private onVaultChange(path: string, isDir: boolean) {
		const t = this.selfWrites.get(path);
		if (t && Date.now() - t < 10_000) return; // caused by our own sync
		if (this.isIgnored(path, isDir)) return;
		const secs = this.settings.syncOnChangeSeconds;
		if (!secs || !this.isConfigured()) return;
		if (this.debounceMs !== secs * 1000) {
			this.debounceMs = secs * 1000;
			this.debouncedSync = debounce(() => void this.sync("change"), this.debounceMs, true);
		}
		this.debouncedSync();
	}

	// ---------- ignore rules

	private ignoreCache: { src: string; res: RegExp[] } | null = null;

	/** Settings-folder rules: which parts of .obsidian the user chose to sync. */
	private configAllowed(rel: string, isDir: boolean): boolean {
		const s = this.settings;
		if (!s.syncConfigDir) return false;
		if (rel === "") return true;
		const parts = rel.split("/");
		if (parts[0] === "plugins") {
			if (parts.length === 1 || (isDir && parts.length === 2)) return s.cfgPlugins || s.cfgPluginSettings;
			const isCode = parts.length === 3 && ["main.js", "manifest.json", "styles.css"].includes(parts[2]);
			return isCode ? s.cfgPlugins : s.cfgPluginSettings;
		}
		if (parts[0] === "themes" || parts[0] === "snippets" || rel === "appearance.json") return s.cfgAppearance;
		if (rel === "hotkeys.json") return s.cfgHotkeys;
		if (rel === "community-plugins.json") return s.cfgPlugins;
		return s.cfgCore; // app.json, core-plugins.json, graph.json, bookmarks.json, …
	}

	/** Attachment-type switches (notes themselves are always synced). */
	private typeAllowed(path: string): boolean {
		const s = this.settings;
		const ext = extOf(path);
		if (NOTE_EXT.has(ext)) return true;
		if (TYPE_EXT.images.has(ext)) return s.syncImages;
		if (TYPE_EXT.audio.has(ext)) return s.syncAudio;
		if (TYPE_EXT.video.has(ext)) return s.syncVideo;
		if (TYPE_EXT.pdf.has(ext)) return s.syncPdf;
		return s.syncOther;
	}

	isIgnored(path: string, isDir = false): boolean {
		const cfg = this.app.vault.configDir;
		const own = this.pluginDir;
		if (path === `${own}/data.json` || path === `${own}/sync-state.json` || path.startsWith(`${own}/sync-state.json`) || path === `${own}/base` || path.startsWith(`${own}/base/`)) return true;
		if (path === `${cfg}/workspace.json` || path === `${cfg}/workspace-mobile.json`) return true;
		if (path === cfg || path.startsWith(cfg + "/")) {
			if (!this.configAllowed(path === cfg ? "" : path.slice(cfg.length + 1), isDir)) return true;
		} else if (!isDir && !this.typeAllowed(path)) return true;
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

	private lastSummary = "";

	setStatus(kind: "idle" | "sync" | "ok" | "error" | "offline" | "paused", text = "") {
		if (kind !== "sync" && kind !== "error" && kind !== "offline" && this.settings.paused) kind = "paused";
		if (this.ribbonEl) this.ribbonEl.toggleClass("seafile-sync-spinning", kind === "sync");
		if (!this.statusEl) return;
		this.statusEl.empty();
		for (const k of ["idle", "sync", "ok", "error", "offline", "paused"]) this.statusEl.removeClass(`seafile-sync-${k}`);
		this.statusEl.addClass(`seafile-sync-${kind}`);
		const icon = this.statusEl.createSpan({ cls: "seafile-sync-icon" });
		const icons = { idle: "cloud", ok: "cloud", sync: "refresh-cw", error: "alert-triangle", offline: "cloud-off", paused: "pause-circle" };
		setIcon(icon, icons[kind]);
		if (kind === "sync") icon.addClass("seafile-sync-spinning");
		const label =
			text ||
			(kind === "sync" ? t("statusSyncing") : kind === "paused" ? t("statusPaused") : kind === "error" || kind === "offline" ? t("statusError") : t("statusIdle"));
		this.statusEl.createSpan({ cls: "seafile-sync-label", text: label });
		const last = this.lastResult
			? t("tooltipLast", { time: new Date(this.lastResult.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), summary: this.lastSummary }) + "\n"
			: "";
		this.statusEl.setAttr("aria-label", last + t("tooltip"));
		this.statusEl.setAttr("data-tooltip-position", "top");
	}

	/** Server version check, once per session (Seafile < 7 lacks replace-on-upload). */
	private versionChecked = false;
	private async checkServer(api: SeafileApi): Promise<void> {
		if (this.versionChecked) return;
		this.versionChecked = true;
		try {
			const v = await api.serverVersion();
			this.log(`server: Seafile ${v}`);
			if (parseInt(v, 10) < 7) new Notice(t("oldServer", { version: v }), 15000);
		} catch {
			/* not critical */
		}
	}

	// ---------- the sync

	private onCellular(): boolean {
		// Network Information API: available in Android WebView, absent elsewhere.
		const c = (navigator as unknown as { connection?: { type?: string } }).connection;
		return Platform.isMobile && c?.type === "cellular";
	}

	async sync(reason: "manual" | "startup" | "interval" | "change" | "resume"): Promise<void> {
		if (!this.isConfigured()) {
			if (reason === "manual") new Notice(t("notConfigured"));
			return;
		}
		if (reason !== "manual") {
			if (this.settings.paused) return;
			if (this.settings.wifiOnly && this.onCellular()) {
				this.log(`auto sync (${reason}) skipped: mobile data`);
				return;
			}
		}
		if (this.syncing) {
			this.pending = true;
			if (reason === "manual") new Notice(t("alreadyRunning"));
			return;
		}
		this.syncing = true;
		this.pending = false;
		this.setStatus("sync");
		const started = Date.now();
		this.log(`— sync (${reason})`);
		let result: SyncResult | null = null;
		try {
			const s = this.settings;
			const api = this.api();
			await this.checkServer(api);
			const remote = new SeafileRemote(api, s.repoId, s.remoteFolder, this.getRepoPassword() || undefined);
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
				isIgnored: (p, d) => this.isIgnored(p, d),
				filterKey: JSON.stringify([
					s.ignore, s.maxFileSizeMB, s.syncConfigDir, s.cfgCore, s.cfgAppearance, s.cfgHotkeys, s.cfgPlugins,
					s.cfgPluginSettings, s.syncImages, s.syncAudio, s.syncVideo, s.syncPdf, s.syncOther, s.syncEmptyDirs,
				]),
				confirmDeletes: (l, r) => new ConfirmDeleteModal(this.app, l, r).ask(),
				onProgress: (d, t) => t && this.setStatus("sync", `${d}/${t}`),
				log: (m) => this.log(m),
				saveState: (st) => this.saveState(st),
			});
			result = await engine.run();
			this.lastResult = { at: Date.now(), ok: result.errors.length === 0 };
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const parts: string[] = [];
			if (result.uploaded) parts.push(t("uploaded", { n: result.uploaded }));
			if (result.downloaded) parts.push(t("downloaded", { n: result.downloaded }));
			if (result.deletedLocal + result.deletedRemote) parts.push(t("deleted", { n: result.deletedLocal + result.deletedRemote }));
			if (result.merged) parts.push(t("merged", { n: result.merged }));
			const changed = parts.length > 0;
			this.lastSummary = changed ? parts.join(" · ") : t("upToDate").replace(/^\S+ Seafile: /, "");
			this.log(`done in ${secs}s: ${this.lastSummary}${result.conflicts ? `, ${result.conflicts} conflicts` : ""}${result.errors.length ? `, ${result.errors.length} errors` : ""}`);

			const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			const loud = s.notices === "all" || (reason === "manual" && s.notices !== "none");
			if (result.errors.length) {
				this.setStatus("error");
				if (s.notices !== "none") new Notice(t("fileErrors", { n: result.errors.length }) + "\n" + result.errors.slice(0, 3).join("\n"), 10000);
			} else {
				this.setStatus("ok", time);
				if (result.conflicts && s.notices !== "none") new Notice(t("conflicts", { n: result.conflicts }), 12000);
				else if (changed && loud) new Notice(`${t("synced")}\n${parts.join(" · ")}`, 5000);
				else if (!changed && reason === "manual" && s.notices !== "none") new Notice(t("upToDate"), 3000);
			}
		} catch (e) {
			const msg = (e as Error).message || String(e);
			this.lastResult = { at: Date.now(), ok: false };
			this.log("FAILED: " + msg);
			const status = e instanceof SeafileError ? e.status : 0;
			const offline = !status && /net::|Failed to fetch|ERR_|timed out|ENOTFOUND|ECONN|EAI_AGAIN|network/i.test(msg);
			this.setStatus(offline ? "offline" : "error");
			let text = t("failed", { msg });
			if (status === 401 || status === 403) text = t("authFailed");
			else if (offline) text = t("offline");
			else if (/encrypted/i.test(msg)) text = t("encrypted");
			const quiet = offline && reason !== "manual"; // don't nag on every interval while offline
			if (this.settings.notices !== "none" && !quiet) new Notice(text, 10000);
		} finally {
			this.syncing = false;
			// Drop old self-write markers.
			const cutoff = Date.now() - 60_000;
			for (const [p, t] of this.selfWrites) if (t < cutoff) this.selfWrites.delete(p);
			if (this.pending) {
				this.pending = false;
				window.setTimeout(() => void this.sync("change"), 2000);
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
		this.titleEl.setText(t("delTitle"));
		const n = this.localDel.length + this.remoteDel.length;
		contentEl.createEl("p", { text: t("delIntro", { n }) });
		const list = (title: string, items: string[]) => {
			if (!items.length) return;
			contentEl.createEl("h4", { text: `${title} (${items.length})` });
			const ul = contentEl.createEl("ul");
			for (const p of items.slice(0, 15)) ul.createEl("li", { text: p });
			if (items.length > 15) ul.createEl("li", { text: t("delMore", { n: items.length - 15 }) });
		};
		list(t("delLocal"), this.localDel);
		list(t("delRemote"), this.remoteDel);
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: t("delNotNow") }).onclick = () => this.finish("skip");
		row.createEl("button", { text: t("delRestore"), cls: "mod-cta" }).onclick = () => this.finish("restore");
		row.createEl("button", { text: t("delConfirm"), cls: "mod-warning" }).onclick = () => this.finish("delete");
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
		this.titleEl.setText(t("logTitle"));
		const pre = this.contentEl.createEl("pre", { cls: "seafile-sync-log" });
		pre.setText(this.lines.slice(-300).join("\n") || t("logEmpty"));
	}
	onClose() {
		this.contentEl.empty();
	}
}
