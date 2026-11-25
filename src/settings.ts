import { App, getLanguage, Notice, Platform, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import { t } from "./i18n";
import type SeafileSyncPlugin from "./main";
import { SeafileApi } from "./seafile";
import { ConflictStrategy } from "./types";

export interface Settings {
	server: string;
	username: string;
	/** Random id naming this vault's secrets in Obsidian's keychain (token, library password). */
	secretId: string;
	repoId: string;
	repoName: string;
	remoteFolder: string;
	deviceName: string;
	conflict: ConflictStrategy;
	mergeExtensions: string;
	syncConfigDir: boolean;
	ignore: string;
	syncEmptyDirs: boolean;
	intervalMinutes: number;
	syncOnStartup: boolean;
	syncOnChangeSeconds: number;
	syncOnResume: boolean;
	maxFileSizeMB: number;
	deleteThreshold: number;
	concurrency: number;
	notices: "all" | "errors" | "none";
	rewriteFileServer: boolean;
	paused: boolean;
	wifiOnly: boolean;
	cfgCore: boolean;
	cfgAppearance: boolean;
	cfgHotkeys: boolean;
	cfgPlugins: boolean;
	cfgPluginSettings: boolean;
	syncImages: boolean;
	syncAudio: boolean;
	syncVideo: boolean;
	syncPdf: boolean;
	syncOther: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	server: "",
	username: "",
	secretId: "",
	repoId: "",
	repoName: "",
	remoteFolder: "",
	deviceName: "",
	conflict: "merge",
	mergeExtensions: "md, txt",
	syncConfigDir: false,
	ignore: [".trash/", ".git/", ".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp"].join("\n"),
	syncEmptyDirs: true,
	intervalMinutes: 5,
	syncOnStartup: true,
	syncOnChangeSeconds: 15,
	syncOnResume: true,
	maxFileSizeMB: 100,
	deleteThreshold: 20,
	concurrency: 4,
	notices: "errors",
	rewriteFileServer: false,
	paused: false,
	wifiOnly: false,
	cfgCore: true,
	cfgAppearance: true,
	cfgHotkeys: true,
	cfgPlugins: true,
	cfgPluginSettings: true,
	syncImages: true,
	syncAudio: true,
	syncVideo: true,
	syncPdf: true,
	syncOther: true,
};

export const FUNDING_URL = "https://boosty.to/grispy/donate";

/** Inline English / Russian text, chosen by Obsidian's interface language. */
function L(en: string, ru: string): string {
	try {
		return getLanguage().toLowerCase().startsWith("ru") ? ru : en;
	} catch {
		return en;
	}
}

type Key = keyof Settings | "autoSync";

export class SeafileSettingTab extends PluginSettingTab {
	private password = "";
	private otp = "";
	private pastedToken = "";
	private libraries: { id: string; label: string }[] | null = null;

	constructor(app: App, private plugin: SeafileSyncPlugin) {
		super(app, plugin);
		this.icon = "cloud";
	}

	// ---- values: plugin.settings, plus a virtual "autoSync" = !paused
	getControlValue(key: string): unknown {
		if (key === "autoSync") return !this.plugin.settings.paused;
		return this.plugin.settings[key as keyof Settings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === "autoSync") s.paused = !value;
		else s[key] = typeof value === "string" && key !== "ignore" ? value.trim() : value;
		if (key === "concurrency") this.plugin.settings.concurrency = Math.min(16, Math.max(1, Number(value) || 1));
		await this.plugin.saveSettings();
		if (key === "intervalMinutes") this.plugin.restartTimers();
		if (key === "autoSync") this.plugin.setStatus(this.plugin.settings.paused ? "paused" : "idle");
		if (key === "syncConfigDir") this.refreshDomState();
	}

	private signedIn = () => !!this.plugin.getToken();

	/** Re-run every render() with the new state (after sign-in, loading libraries…). */
	private rerender() {
		this.update();
		this.refreshDomState();
	}

	getSettingDefinitions(): SettingDefinitionItem<Key>[] {
		const p = this.plugin;
		const s = p.settings;
		const cfg = this.app.vault.configDir;

		return [
			// ------------------------------------------------ account
			{
				type: "group",
				heading: L("Server", "Сервер"),
				items: [
					{
						name: L("Server URL", "Адрес сервера"),
						desc: L("For example https://cloud.example.com (without /seafhttp).", "Например https://cloud.example.com (без /seafhttp)."),
						control: {
							type: "text",
							key: "server",
							placeholder: "https://seafile.example.com",
							validate: (v: string) => {
								if (v && !/^https?:\/\/[^/\s]+/i.test(v)) return L("Must start with https://", "Адрес должен начинаться с https://");
								if (/^http:\/\//i.test(v)) return t("insecure");
							},
						},
					},
					{
						name: L("Signed in", "Вход выполнен"),
						visible: () => this.signedIn(),
						render: (setting: Setting) => {
							setting.setDesc(s.username ? L(`As ${s.username}`, `Как ${s.username}`) : L("Using an API token", "По API-токену"));
							setting.addButton((b) =>
								b.setButtonText(L("Test connection", "Проверить связь")).onClick(async () => {
									try {
										const api = p.api();
										const version = await api.serverVersion();
										await api.ping();
										new Notice(t("connectionOk", { version }));
									} catch (e) {
										new Notice("❌ Seafile: " + (e as Error).message, 8000);
									}
								})
							);
							setting.addButton((b) =>
								b
									.setButtonText(L("Sign out", "Выйти"))
									.setDestructive()
									.onClick(() => {
										p.setToken("");
										this.rerender();
									})
							);
						},
					},
					{
						name: L("Username / email", "Логин / email"),
						visible: () => !this.signedIn(),
						control: { type: "text", key: "username" },
					},
					{
						name: L("Password", "Пароль"),
						desc: L("Used once to get an API token. The password itself is not stored.", "Нужен один раз, чтобы получить API-токен. Сам пароль не сохраняется."),
						visible: () => !this.signedIn(),
						render: (setting: Setting) => {
							setting.addText((tx) => {
								tx.inputEl.type = "password";
								tx.inputEl.autocomplete = "current-password";
								tx.onChange((v) => (this.password = v));
							});
						},
					},
					{
						name: L("Two-factor code", "Код двухфакторной защиты"),
						desc: L("Only if 2FA is enabled on your account.", "Только если в аккаунте включена 2FA."),
						visible: () => !this.signedIn(),
						render: (setting: Setting) => {
							setting.addText((tx) => {
								tx.inputEl.inputMode = "numeric";
								tx.inputEl.autocomplete = "one-time-code";
								tx.onChange((v) => (this.otp = v.trim()));
							});
						},
					},
					{
						name: L("Sign in", "Войти"),
						visible: () => !this.signedIn(),
						render: (setting: Setting) => {
							setting.addButton((b) =>
								b
									.setButtonText(L("Sign in", "Войти"))
									.setCta()
									.onClick(async () => {
										try {
											const token = await SeafileApi.login(p.http, s.server, s.username, this.password, this.otp || undefined);
											p.setToken(token);
											this.password = "";
											new Notice(t("signedIn", { user: s.username }));
											this.rerender();
										} catch (e) {
											new Notice("❌ Seafile: " + (e as Error).message, 8000);
										}
									})
							);
						},
					},
					{
						name: L("…or paste an API token", "…или вставьте API-токен"),
						desc: L("Instead of signing in. Stored in Obsidian's keychain on this device.", "Вместо входа. Хранится в связке ключей Obsidian на этом устройстве."),
						visible: () => !this.signedIn(),
						render: (setting: Setting) => {
							setting.addText((tx) => {
								tx.inputEl.type = "password";
								tx.onChange((v) => (this.pastedToken = v.trim()));
							});
							setting.addButton((b) =>
								b.setButtonText(L("Use token", "Использовать")).onClick(() => {
									if (!this.pastedToken) return;
									p.setToken(this.pastedToken);
									this.pastedToken = "";
									this.rerender();
								})
							);
						},
					},
				],
			},

			// ------------------------------------------------ library
			{
				type: "group",
				heading: L("Library", "Библиотека"),
				items: [
					{
						name: L("Library to sync", "Синхронизируемая библиотека"),
						render: (setting: Setting) => {
							setting.setDesc(s.repoId ? `✅ ${s.repoName || s.repoId}` : L("Load your libraries and pick one.", "Загрузите список и выберите библиотеку."));
							setting.addDropdown((d) => {
								d.addOption("", "—");
								const libs = this.libraries ?? (s.repoId ? [{ id: s.repoId, label: s.repoName || s.repoId }] : []);
								for (const l of libs) d.addOption(l.id, l.label);
								d.setValue(s.repoId);
								d.onChange(async (v) => {
									s.repoId = v;
									s.repoName = (d.selectEl.selectedOptions[0]?.text ?? "").replace(/ 🔒| \(read-only\)/g, "");
									await p.saveSettings();
									setting.setDesc(v ? `✅ ${s.repoName}` : "");
								});
							});
							setting.addButton((b) =>
								b.setButtonText(L("Load libraries", "Загрузить список")).onClick(async () => {
									try {
										const libs = await p.api().listLibraries();
										this.libraries = libs.map((l) => ({ id: l.id, label: l.name + (l.encrypted ? " 🔒" : "") + (l.permission === "r" ? " (read-only)" : "") }));
										this.rerender();
									} catch (e) {
										new Notice("❌ Seafile: " + (e as Error).message, 8000);
									}
								})
							);
						},
					},
					{
						name: L("Folder inside the library", "Папка внутри библиотеки"),
						desc: L("Leave empty to sync the whole library. Created if missing. Example: Obsidian/My vault", "Пусто — вся библиотека. Создаётся, если её нет. Пример: Obsidian/Мои заметки"),
						control: { type: "text", key: "remoteFolder", placeholder: "Obsidian/My vault" },
					},
					{
						name: L("Library password", "Пароль библиотеки"),
						desc: L("Only for encrypted libraries. Stored in Obsidian's keychain on this device.", "Только для зашифрованных библиотек. Хранится в связке ключей Obsidian на этом устройстве."),
						render: (setting: Setting) => {
							setting.addText((tx) => {
								tx.inputEl.type = "password";
								tx.setPlaceholder(p.getRepoPassword() ? "••••••••" : "");
								tx.onChange((v) => p.setRepoPassword(v));
							});
						},
					},
				],
			},

			// ------------------------------------------------ when
			{
				type: "group",
				heading: L("When to sync", "Когда синхронизировать"),
				items: [
					{
						name: L("Automatic sync", "Автоматическая синхронизация"),
						desc: L("Turn off to pause automatic syncs on this device. “Sync now” still works.", "Выключите, чтобы поставить автосинхронизацию на паузу. «Sync now» работает всегда."),
						control: { type: "toggle", key: "autoSync" },
					},
					{ name: L("Sync on startup", "При запуске"), control: { type: "toggle", key: "syncOnStartup" } },
					{
						name: L("Every N minutes", "Каждые N минут"),
						desc: L("0 = off. Picks up changes made on other devices.", "0 — выключено. Подхватывает изменения с других устройств."),
						control: { type: "number", key: "intervalMinutes", min: 0, step: 1 },
					},
					{
						name: L("N seconds after an edit", "Через N секунд после правки"),
						desc: L("0 = off. Waits until you stop typing.", "0 — выключено. Ждёт, пока вы перестанете печатать."),
						control: { type: "number", key: "syncOnChangeSeconds", min: 0, step: 1 },
					},
					{
						name: L("When the app returns to the foreground", "При возврате в приложение"),
						desc: L("Useful on phones.", "Полезно на телефоне."),
						control: { type: "toggle", key: "syncOnResume" },
					},
					{
						name: L("Auto-sync only on Wi-Fi", "Автосинхронизация только по Wi-Fi"),
						desc: L("Skip automatic syncs on mobile data (Android).", "Не синхронизировать автоматически по мобильной сети (Android)."),
						visible: Platform.isMobile,
						control: { type: "toggle", key: "wifiOnly" },
					},
				],
			},

			// ------------------------------------------------ what
			{
				type: "group",
				heading: L("What to sync", "Что синхронизировать"),
				items: [
					{
						name: L("Notes are always synced", "Заметки синхронизируются всегда"),
						desc: L(
							"Switching a file type off only stops syncing it on this device: nothing is deleted, here or on the server.",
							"Если выключить тип файлов, он просто перестаёт синхронизироваться на этом устройстве. Ничего не удаляется ни здесь, ни на сервере."
						),
					},
					{ name: L("🖼️ Images", "🖼️ Картинки"), desc: "png, jpg, gif, svg, webp, heic…", control: { type: "toggle", key: "syncImages" } },
					{ name: L("🎵 Audio", "🎵 Аудио"), desc: "mp3, m4a, wav, ogg, flac…", control: { type: "toggle", key: "syncAudio" } },
					{ name: L("🎬 Video", "🎬 Видео"), desc: "mp4, mov, mkv, webm…", control: { type: "toggle", key: "syncVideo" } },
					{ name: "📄 PDF", control: { type: "toggle", key: "syncPdf" } },
					{
						name: L("📦 Other files", "📦 Прочие файлы"),
						desc: L("Archives, office documents and everything else.", "Архивы, документы и всё остальное."),
						control: { type: "toggle", key: "syncOther" },
					},
					{
						type: "page",
						name: L(`⚙️ Settings folder (${cfg})`, `⚙️ Папка настроек (${cfg})`),
						desc: L("Themes, plugins, hotkeys and other Obsidian settings.", "Темы, плагины, горячие клавиши и другие настройки Obsidian."),
						displayValue: () => (s.syncConfigDir ? L("On", "Вкл.") : L("Off", "Выкл.")),
						items: [
							{
								type: "group",
								items: [
									{
										name: L("Sync the settings folder", "Синхронизировать папку настроек"),
										desc: L("This plugin's own login and sync state are never synced.", "Вход и состояние самого плагина не синхронизируются никогда."),
										control: { type: "toggle", key: "syncConfigDir" },
									},
									{
										name: L("Core settings", "Основные настройки"),
										desc: L("Editor, files & links, core plugins, bookmarks, graph…", "Редактор, файлы и ссылки, встроенные плагины, закладки, граф…"),
										visible: () => s.syncConfigDir,
										control: { type: "toggle", key: "cfgCore" },
									},
									{
										name: L("Appearance", "Оформление"),
										desc: L("Theme, fonts, installed themes and CSS snippets.", "Тема, шрифты, установленные темы и CSS-сниппеты."),
										visible: () => s.syncConfigDir,
										control: { type: "toggle", key: "cfgAppearance" },
									},
									{ name: L("Hotkeys", "Горячие клавиши"), visible: () => s.syncConfigDir, control: { type: "toggle", key: "cfgHotkeys" } },
									{
										name: L("Community plugins", "Сторонние плагины"),
										desc: L(
											"Installed plugins (their code) and which are enabled. Plugin code runs on every device: enable only if you trust everyone with write access to this library.",
											"Установленные плагины (их код) и какие из них включены. Код плагинов выполняется на всех устройствах: включайте, только если доверяете всем, кто может писать в эту библиотеку."
										),
										visible: () => s.syncConfigDir,
										control: { type: "toggle", key: "cfgPlugins" },
									},
									{
										name: L("Community plugin settings", "Настройки сторонних плагинов"),
										desc: L("Each plugin's data.json. Turn off if a plugin keeps device-specific data there.", "data.json каждого плагина. Выключите, если плагин хранит там данные конкретного устройства."),
										visible: () => s.syncConfigDir,
										control: { type: "toggle", key: "cfgPluginSettings" },
									},
								],
							},
						],
					},
					{ name: L("Empty folders", "Пустые папки"), control: { type: "toggle", key: "syncEmptyDirs" } },
					{
						name: L("Ignore", "Игнорировать"),
						desc: L("One pattern per line: `name` anywhere, `dir/` a folder, `a/*.pdf`, `**/x`.", "По шаблону в строке: `имя` где угодно, `папка/`, `a/*.pdf`, `**/x`."),
						control: { type: "textarea", key: "ignore", rows: 6 },
					},
					{
						name: L("Max file size (MB)", "Максимальный размер файла (МБ)"),
						desc: L("Bigger files are skipped, never deleted. 0 = no limit.", "Файлы больше пропускаются, но не удаляются. 0 — без ограничения."),
						control: { type: "number", key: "maxFileSizeMB", min: 0, step: 1 },
					},
				],
			},

			// ------------------------------------------------ safety
			{
				type: "group",
				heading: L("Conflicts and safety", "Конфликты и безопасность"),
				items: [
					{
						name: L("When a file changed on both sides", "Если файл изменён с обеих сторон"),
						desc: L("Merge combines edits in different places; overlapping edits keep both versions.", "Слияние объединяет правки в разных местах. Если правки пересекаются, сохраняются обе версии."),
						control: {
							type: "dropdown",
							key: "conflict",
							options: {
								merge: L("🔀 Merge notes, otherwise keep both", "🔀 Слить заметки, иначе сохранить обе"),
								"keep-both": L("📑 Keep both (conflict copy)", "📑 Сохранить обе (копия конфликта)"),
								newer: L("🕒 Newer file wins", "🕒 Побеждает более новый"),
								local: L("💻 This device wins", "💻 Побеждает это устройство"),
								remote: L("☁️ Server wins", "☁️ Побеждает сервер"),
							},
						},
					},
					{ name: L("Mergeable extensions", "Расширения для слияния"), desc: L("Comma-separated.", "Через запятую."), control: { type: "text", key: "mergeExtensions" } },
					{ name: L("Device name", "Имя устройства"), desc: L("Used in conflict file names.", "Используется в именах копий конфликтов."), control: { type: "text", key: "deviceName" } },
					{
						name: L("Ask before deleting more than N files", "Спрашивать перед удалением больше N файлов"),
						desc: L("Protects against mass deletion. 0 = never ask.", "Защита от массового удаления. 0 — не спрашивать."),
						control: { type: "number", key: "deleteThreshold", min: 0, step: 1 },
					},
				],
			},

			// ------------------------------------------------ advanced
			{
				type: "page",
				name: L("🛠️ Advanced", "🛠️ Дополнительно"),
				items: [
					{
						type: "group",
						items: [
							{
								name: L("Notifications", "Уведомления"),
								control: {
									type: "dropdown",
									key: "notices",
									options: {
										all: L("Every sync", "О каждой синхронизации"),
										errors: L("Only errors and conflicts", "Только ошибки и конфликты"),
										none: L("None", "Без уведомлений"),
									},
								},
							},
							{ name: L("Parallel transfers", "Параллельных передач"), control: { type: "number", key: "concurrency", min: 1, max: 16, step: 1 } },
							{
								name: L("Use server URL for file transfers", "Передавать файлы через адрес сервера"),
								desc: L(
									"Turn on if uploads/downloads fail because the server's SERVICE_URL / FILE_SERVER_ROOT is misconfigured.",
									"Включите, если списки открываются, а файлы не передаются: на сервере неверно задан SERVICE_URL / FILE_SERVER_ROOT."
								),
								control: { type: "toggle", key: "rewriteFileServer" },
							},
							{
								name: L("Reset sync state", "Сбросить состояние синхронизации"),
								desc: L(
									"Forget what was synced. The next sync compares everything file by file again; nothing is deleted.",
									"Забыть историю синхронизации. Следующая синхронизация заново сравнит все файлы; ничего не удаляется."
								),
								render: (setting: Setting) => {
									setting.addButton((b) =>
										b
											.setButtonText(L("Reset", "Сбросить"))
											.setDestructive()
											.onClick(async () => {
												await p.resetState();
												new Notice(L("🔄 Seafile: sync state reset", "🔄 Seafile: состояние синхронизации сброшено"));
											})
									);
								},
							},
						],
					},
				],
			},

			// ------------------------------------------------ support
			{
				type: "group",
				items: [
					{
						name: L("☕ Support development", "☕ Поддержать разработку"),
						desc: L("If the plugin saves you time, you can buy the author a coffee on Boosty.", "Если плагин экономит вам время, можно угостить автора кофе на Boosty."),
						action: () => window.open(FUNDING_URL),
					},
				],
			},
		];
	}
}
