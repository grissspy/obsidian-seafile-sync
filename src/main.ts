import { App, debounce, Menu, Modal, Notice, Platform, Plugin, requestUrl, setIcon, TAbstractFile, TFile, TFolder } from "obsidian";
import { fmt } from "./time";
import { AdapterBaseStore, ObsidianLocal } from "./local";
import { t } from "./i18n";
import { Http, SeafileApi, SeafileError, SeafileRemote } from "./seafile";
import { DEFAULT_SETTINGS, SeafileSettingTab, Settings } from "./settings";
import { PrefixLocal } from "./prefix";
import { ConflictModal, findConflict, HistoryModal, ProfilePicker, TrashModal } from "./ui";
import { emptyState, SyncEngine } from "./sync";
import { LocalFS, SyncResult, SyncState } from "./types";
import { extOf, globToRegExp, normalizeRel } from "./util";

const NOTE_EXT = new Set(["md", "canvas", "base"]);
const TEXT_EXT = new Set(["md", "txt", "canvas", "base", "json", "css", "js", "csv", "html", "xml", "yml", "yaml", "svg"]);
/** Server-side folder (inside the synced folder) for device setting profiles; never synced as files. */
const PROFILE_DIR = ".seafile-vault-sync";

/** One synced pair: the whole vault ↔ the main library, or a vault folder ↔ another place. */
export interface Target {
	id: string; // "main" or "x0", "x1", …
	local: string; // vault folder ("" = whole vault)
	repoId: string;
	remoteFolder: string;
}

function absIn(remoteFolder: string, rel: string): string {
	const b = normalizeRel(remoteFolder);
	return "/" + [b, rel].filter(Boolean).join("/");
}
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
	/** Last synced size/mtime of every vault file (for the explorer badges). */
	private synced = new Map<string, { m: number; s: number }>();
	/** Library change tokens after the last sync, per library (for cheap polling). */
	private tokens = new Map<string, string | null>();
	private progressNotice: Notice | null = null;

	private get pluginDir() {
		return this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}
	private statePath(tg: Target) {
		return `${this.pluginDir}/sync-state${tg.id === "main" ? "" : "-" + tg.id}.json`;
	}
	private baseDir(tg: Target) {
		return `${this.pluginDir}/base${tg.id === "main" ? "" : "-" + tg.id}`;
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
		this.addCommand({ id: "show-log", name: "Show sync log", callback: () => this.showLog() });
		this.addCommand({
			id: "version-history",
			name: "Show version history of this file",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !this.isConfigured()) return false;
				if (!checking) new HistoryModal(this.app, this, f).open();
				return true;
			},
		});
		this.addCommand({
			id: "restore-deleted",
			name: "Restore deleted files from the server trash",
			checkCallback: (checking) => {
				if (!this.isConfigured()) return false;
				if (!checking) new TrashModal(this.app, this).open();
				return true;
			},
		});
		this.addCommand({
			id: "resolve-conflict",
			name: "Resolve conflict in this file",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				const c = f && this.isTextPath(f.path) ? findConflict(this.app, f) : null;
				if (!c) return false;
				if (!checking) new ConflictModal(this.app, this, c.main, c.copy, c.device).open();
				return true;
			},
		});
		this.addCommand({
			id: "copy-share-link",
			name: "Copy share link of this file",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !this.isConfigured()) return false;
				if (!checking) void this.copyShareLink(f);
				return true;
			},
		});
		this.addCommand({ id: "save-profile", name: "Save this device's settings to the server", callback: () => void this.saveProfile() });
		this.addCommand({ id: "load-profile", name: "Copy settings from another device", callback: () => void this.loadProfile() });

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, f: TAbstractFile) => {
				if (!(f instanceof TFile) || !this.isConfigured() || !this.resolveRemote(f.path)) return;
				menu.addItem((i) => i.setTitle(t("menuHistory")).setIcon("history").setSection("action").onClick(() => new HistoryModal(this.app, this, f).open()));
				menu.addItem((i) => i.setTitle(t("menuShare")).setIcon("link").setSection("action").onClick(() => void this.copyShareLink(f)));
				const c = this.isTextPath(f.path) ? findConflict(this.app, f) : null;
				if (c) menu.addItem((i) => i.setTitle(t("menuConflict")).setIcon("git-merge").setSection("action").onClick(() => new ConflictModal(this.app, this, c.main, c.copy, c.device).open()));
			})
		);

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
			void this.loadSyncedIndex();
			this.watchExplorer();
		});
		this.registerEvent(this.app.workspace.on("layout-change", () => this.watchExplorer()));
	}

	showLog() {
		new LogModal(this.app, this.logLines).open();
	}

	onunload() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		if (this.pollId !== null) window.clearInterval(this.pollId);
		for (const o of this.observers) o.disconnect();
		document.body.removeClass("seafile-sync-badges");
		this.progressNotice?.hide();
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

	private pollId: number | null = null;

	restartTimers() {
		if (this.pollId !== null) window.clearInterval(this.pollId);
		this.pollId = null;
		const p = this.settings.pollSeconds;
		if (p > 0) {
			this.pollId = window.setInterval(() => void this.poll(), Math.max(10, p) * 1000);
			this.registerInterval(this.pollId);
		}
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

	/** One small request per library: has anything changed since our last sync? */
	private polling = false;
	private async poll() {
		if (this.polling || this.syncing || !this.isConfigured() || this.settings.paused) return;
		if (Platform.isMobile && document.visibilityState !== "visible") return; // save phone battery
		if (this.lastResult && !this.lastResult.ok) return; // the regular interval retries failures
		if (this.settings.wifiOnly && this.onCellular()) return;
		this.polling = true;
		try {
			const api = this.api();
			for (const repo of new Set(this.targets().map((x) => x.repoId))) {
				const info = await api.repoInfo(repo);
				if (!this.tokens.has(repo) || info.root !== this.tokens.get(repo)) {
					this.log(`server changed (${repo.slice(0, 8)}) → sync`);
					void this.sync("interval");
					return;
				}
			}
		} catch {
			/* offline: the regular sync reports it */
		} finally {
			this.polling = false;
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
		this.badgesSoon();
		if (!this.isWatched(path, isDir)) return;
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

	/** Rules shared by every target: plugin's own files, settings folder, file types, patterns. */
	private ignoredCommon(path: string, isDir: boolean): boolean {
		const cfg = this.app.vault.configDir;
		const own = this.pluginDir;
		if (path === `${own}/data.json` || path.startsWith(`${own}/sync-state`) || path.startsWith(`${own}/base`)) return true;
		if (path === `${cfg}/workspace.json` || path === `${cfg}/workspace-mobile.json`) return true;
		if (path === PROFILE_DIR || path.startsWith(PROFILE_DIR + "/")) return true;
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

	private under(path: string, folder: string): boolean {
		return path === folder || path.startsWith(folder + "/");
	}

	private onlyFolders(): string[] {
		return this.settings.onlyFolders.split("\n").map(normalizeRel).filter(Boolean);
	}

	/** Is `path` excluded from the main vault ↔ library sync? */
	isIgnored(path: string, isDir = false): boolean {
		if (this.ignoredCommon(path, isDir)) return true;
		for (const x of this.targets()) if (x.local && this.under(path, x.local)) return true;
		const cfg = this.app.vault.configDir;
		const only = this.onlyFolders();
		if (only.length && path.includes("/") && !this.under(path, cfg)) {
			const inside = only.some((f) => this.under(path, f));
			const ancestor = isDir && only.some((f) => f.startsWith(path + "/"));
			if (!inside && !ancestor) return true;
		}
		return false;
	}

	/** Is this vault path synced by any target? */
	isWatched(path: string, isDir = false): boolean {
		const x = this.targetFor(path);
		if (!x) return false;
		return x.id === "main" ? !this.isIgnored(path, isDir) : !this.ignoredCommon(path, isDir);
	}

	isTextPath(path: string): boolean {
		const ext = extOf(path);
		return TEXT_EXT.has(ext) || this.settings.mergeExtensions.split(",").some((e) => e.trim().replace(/^\./, "").toLowerCase() === ext);
	}

	// ---------- targets

	targets(): Target[] {
		const s = this.settings;
		const out: Target[] = [{ id: "main", local: "", repoId: s.repoId, remoteFolder: s.remoteFolder }];
		const cfg = this.app.vault.configDir;
		s.extraLibraries.forEach((x, i) => {
			const local = normalizeRel(x.local);
			if (!local || !x.repoId || this.under(local, cfg)) return;
			if (out.some((o) => o.local && (this.under(local, o.local) || this.under(o.local, local)))) return; // no nesting
			out.push({ id: "x" + i, local, repoId: x.repoId, remoteFolder: x.remote });
		});
		return out;
	}

	private targetFor(path: string): Target | null {
		for (const x of this.targets()) if (x.local && this.under(path, x.local)) return x;
		return this.targets()[0];
	}

	/** Where a vault file lives on the server, if it is synced. */
	resolveRemote(path: string): { repo: string; abs: string } | null {
		const x = this.targetFor(path);
		if (!x || !x.repoId || !this.isWatched(path)) return null;
		const rel = x.local ? path.slice(x.local.length + 1) : path;
		return { repo: x.repoId, abs: absIn(x.remoteFolder, rel) };
	}

	/** Is a trash entry (absolute path in the main library) inside the synced folder? */
	trashRelevant(repo: string, abs: string): boolean {
		const base = absIn(this.settings.remoteFolder, "");
		const pre = base === "/" ? "/" : base + "/";
		if (repo !== this.settings.repoId || !abs.startsWith(pre)) return false;
		const rel = abs.slice(pre.length);
		return !!rel && !(rel === PROFILE_DIR || rel.startsWith(PROFILE_DIR + "/"));
	}

	displayPath(abs: string): string {
		const base = absIn(this.settings.remoteFolder, "");
		return base === "/" ? abs.slice(1) : abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
	}

	// ---------- state

	private targetKey(tg: Target): string {
		const s = this.settings;
		return `${s.server.replace(/\/+$/, "")}|${tg.repoId}|${normalizeRel(tg.remoteFolder)}${tg.local ? "|" + tg.local : ""}`;
	}

	private async loadState(tg: Target): Promise<SyncState> {
		const a = this.app.vault.adapter;
		const path = this.statePath(tg);
		try {
			if (await a.exists(path)) {
				const st = JSON.parse(await a.read(path)) as SyncState;
				if (st.version === 1 && st.target === this.targetKey(tg)) return st;
				this.log(`${tg.local || "vault"}: sync target changed — starting with a fresh state`);
			}
		} catch (e) {
			this.log("could not read state: " + (e as Error).message);
		}
		return emptyState(this.targetKey(tg));
	}

	private async saveState(tg: Target, st: SyncState) {
		const a = this.app.vault.adapter;
		const path = this.statePath(tg);
		const tmp = path + ".tmp";
		await a.write(tmp, JSON.stringify(st));
		if (await a.exists(path)) await a.remove(path);
		await a.rename(tmp, path);
	}

	async resetState() {
		const a = this.app.vault.adapter;
		for (const tg of this.targets()) if (await a.exists(this.statePath(tg))) await a.remove(this.statePath(tg));
		this.synced.clear();
		this.tokens.clear();
		this.refreshBadges();
	}

	private remember(tg: Target, st: SyncState) {
		const pre = tg.local ? tg.local + "/" : "";
		if (!tg.local) {
			for (const k of [...this.synced.keys()]) if (!this.targets().some((x) => x.local && this.under(k, x.local))) this.synced.delete(k);
		} else for (const k of [...this.synced.keys()]) if (k.startsWith(pre)) this.synced.delete(k);
		for (const [p, f] of Object.entries(st.files)) this.synced.set(pre + p, { m: f.lm, s: f.ls });
		this.tokens.set(tg.repoId, st.changeToken);
	}

	private async loadSyncedIndex() {
		if (!this.isConfigured()) return;
		for (const tg of this.targets()) this.remember(tg, await this.loadState(tg));
		this.indexReady = true;
		this.refreshBadges();
	}

	// ---------- file explorer badges

	private indexReady = false;
	private observers: MutationObserver[] = [];
	private badgesSoon = debounce(() => this.refreshBadges(), 700, true);

	private watchExplorer() {
		for (const o of this.observers) o.disconnect();
		this.observers = [];
		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			const o = new MutationObserver(() => this.badgesSoon());
			o.observe(leaf.view.containerEl, { childList: true, subtree: true });
			this.observers.push(o);
		}
		this.badgesSoon();
	}

	refreshBadges() {
		const on = this.settings.explorerBadges && this.isConfigured();
		document.body.toggleClass("seafile-sync-badges", on);
		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			leaf.view.containerEl.querySelectorAll<HTMLElement>(".nav-file-title[data-path]").forEach((el) => {
				const path = el.dataset.path ?? "";
				let pending = false;
				if (on && this.indexReady) {
					const f = this.app.vault.getFileByPath(path);
					const st = this.synced.get(path);
					pending = !!f && this.isWatched(path) && (!st || st.m !== f.stat.mtime || st.s !== f.stat.size);
				}
				if (el.hasClass("seafile-sync-pending") !== pending) {
					el.toggleClass("seafile-sync-pending", pending);
					if (pending) el.setAttr("data-seafile-tip", t("badgePending"));
				}
			});
		}
	}

	// ---------- share links and device profiles

	async copyShareLink(f: TFile) {
		const where = this.resolveRemote(f.path);
		if (!where) {
			new Notice(t("notSynced"));
			return;
		}
		try {
			const api = this.api();
			if (!(await api.fileId(where.repo, where.abs))) {
				new Notice(t("notSynced"));
				return;
			}
			const link = await api.shareLink(where.repo, where.abs);
			await navigator.clipboard.writeText(link);
			new Notice(t("linkCopied", { link }), 6000);
		} catch (e) {
			new Notice("❌ Seafile: " + (e as Error).message, 8000);
		}
	}

	private profileDir(): string {
		return absIn(this.settings.remoteFolder, PROFILE_DIR + "/devices");
	}

	/** Settings worth copying between devices: everything except identity and connection. */
	private portableSettings(): Partial<Settings> {
		const copy: Partial<Settings> = { ...this.settings };
		for (const k of ["secretId", "deviceName", "server", "username", "repoId", "repoName", "remoteFolder", "paused"] as const) delete copy[k];
		return copy;
	}

	async saveProfile() {
		if (!this.isConfigured()) return void new Notice(t("notConfigured"));
		const name = (this.settings.deviceName || "device").replace(/[\\/:*?"<>|]/g, "-");
		try {
			await this.api().putText(this.settings.repoId, `${this.profileDir()}/${name}.json`, JSON.stringify(this.portableSettings(), null, 2));
			new Notice(t("profSaved", { name }));
		} catch (e) {
			new Notice("❌ Seafile: " + (e as Error).message, 8000);
		}
	}

	async loadProfile() {
		if (!this.isConfigured()) return void new Notice(t("notConfigured"));
		try {
			const api = this.api();
			const dir = this.profileDir();
			const names = (await api.dirExists(this.settings.repoId, dir))
				? (await api.listDir(this.settings.repoId, dir)).filter((e) => e.type === "file" && e.name.endsWith(".json")).map((e) => e.name.slice(0, -5))
				: [];
			if (!names.length) return void new Notice(t("profNone"));
			new ProfilePicker(this.app, names, (name) => {
				void (async () => {
					try {
						const data = JSON.parse(await api.getText(this.settings.repoId, `${dir}/${name}.json`)) as Partial<Settings>;
						const keep = { ...this.settings };
						this.settings = { ...DEFAULT_SETTINGS, ...keep, ...data,
							secretId: keep.secretId, deviceName: keep.deviceName, server: keep.server, username: keep.username,
							repoId: keep.repoId, repoName: keep.repoName, remoteFolder: keep.remoteFolder, paused: keep.paused,
						};
						await this.saveSettings();
						this.restartTimers();
						new Notice(t("profLoaded", { name }));
					} catch (e) {
						new Notice("❌ Seafile: " + (e as Error).message, 8000);
					}
				})();
			}).open();
		} catch (e) {
			new Notice("❌ Seafile: " + (e as Error).message, 8000);
		}
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
			? t("tooltipLast", { time: fmt("LT", this.lastResult.at), summary: this.lastSummary }) + "\n"
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

	private async runTarget(tg: Target, api: SeafileApi): Promise<SyncResult> {
		const s = this.settings;
		const remote = new SeafileRemote(api, tg.repoId, tg.remoteFolder, tg.id === "main" ? this.getRepoPassword() || undefined : undefined);
		await remote.prepare();
		const vault = new ObsidianLocal(this.app, tg.id === "main" && s.syncConfigDir, (p) => this.selfWrites.set(p, Date.now()));
		let local: LocalFS = vault;
		if (tg.local) {
			await vault.mkdir(tg.local);
			local = new PrefixLocal(vault, tg.local);
		}
		const bases = new AdapterBaseStore(this.app, this.baseDir(tg));
		const state = await this.loadState(tg);
		let saved = state;
		const full = (p: string) => (tg.local ? (p ? `${tg.local}/${p}` : tg.local) : p);
		const engine = new SyncEngine(local, remote, bases, state, {
			conflict: s.conflict,
			deviceName: s.deviceName || "device",
			mergeExtensions: s.mergeExtensions.split(",").map((x) => x.trim().toLowerCase().replace(/^\./, "")).filter(Boolean),
			maxFileSize: s.maxFileSizeMB * 1024 * 1024,
			concurrency: s.concurrency,
			syncEmptyDirs: s.syncEmptyDirs,
			deleteThreshold: s.deleteThreshold,
			isIgnored: tg.id === "main" ? (p, d) => this.isIgnored(p, d) : (p, d) => this.ignoredCommon(full(p), !!d),
			filterKey: JSON.stringify([
				s.ignore, s.maxFileSizeMB, s.syncConfigDir, s.cfgCore, s.cfgAppearance, s.cfgHotkeys, s.cfgPlugins,
				s.cfgPluginSettings, s.syncImages, s.syncAudio, s.syncVideo, s.syncPdf, s.syncOther, s.syncEmptyDirs,
				tg.id === "main" ? [s.onlyFolders, this.targets().map((x) => x.local)] : null,
			]),
			confirmDeletes: (l, r) => new ConfirmDeleteModal(this.app, l.map(full), r.map(full)).ask(),
			onProgress: (d, total) => this.progress(d, total),
			log: (m) => this.log(tg.local ? `[${tg.local}] ${m}` : m),
			saveState: (st) => {
				saved = st;
				return this.saveState(tg, st);
			},
		});
		const r = await engine.run();
		this.remember(tg, saved);
		return r;
	}

	private progress(done: number, total: number) {
		if (!total) return;
		this.setStatus("sync", `${done}/${total}`);
		// Phones have no status bar: show a live notice for bigger syncs.
		if (Platform.isMobile && total >= 20 && this.settings.notices !== "none") {
			const msg = t("progress", { done, total });
			if (!this.progressNotice) this.progressNotice = new Notice(msg, 0);
			else this.progressNotice.setMessage(msg);
		}
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
			result = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflicts: 0, errors: [], skipped: true };
			for (const tg of this.targets()) {
				let r: SyncResult;
				try {
					r = await this.runTarget(tg, api);
				} catch (e) {
					if (tg.id === "main") throw e;
					result.errors.push(`${tg.local}: ${(e as Error).message}`);
					this.log(`${tg.local}: FAILED ${(e as Error).message}`);
					continue;
				}
				for (const k of ["uploaded", "downloaded", "deletedLocal", "deletedRemote", "merged", "conflicts"] as const) result[k] += r[k];
				result.errors.push(...r.errors.map((m) => (tg.local ? `${tg.local}: ${m}` : m)));
				result.skipped &&= r.skipped;
			}

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

			const time = fmt("LT");
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
			this.progressNotice?.hide();
			this.progressNotice = null;
			this.indexReady = true;
			this.refreshBadges();
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
