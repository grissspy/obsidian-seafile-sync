import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SeafileSyncPlugin from "./main";
import { SeafileApi } from "./seafile";
import { ConflictStrategy } from "./types";

export interface Settings {
	server: string;
	username: string;
	token: string;
	repoId: string;
	repoName: string;
	remoteFolder: string;
	repoPassword: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
	server: "",
	username: "",
	token: "",
	repoId: "",
	repoName: "",
	remoteFolder: "",
	repoPassword: "",
	deviceName: "",
	conflict: "merge",
	mergeExtensions: "md, txt",
	syncConfigDir: false,
	ignore: [".trash/", ".git/", ".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp", ".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".obsidian/cache"].join("\n"),
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
};

export class SeafileSettingTab extends PluginSettingTab {
	private password = "";
	private otp = "";

	constructor(app: App, private plugin: SeafileSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		// ---------- Account
		new Setting(containerEl).setName("Server").setHeading();
		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("For example https://cloud.example.com (without /seafhttp).")
			.addText((t) =>
				t
					.setPlaceholder("https://seafile.example.com")
					.setValue(s.server)
					.onChange(async (v) => {
						s.server = v.trim();
						await save();
					})
			);

		if (s.token) {
			new Setting(containerEl)
				.setName("Signed in")
				.setDesc(s.username ? `As ${s.username}` : "Using an API token")
				.addButton((b) =>
					b.setButtonText("Test connection").onClick(async () => {
						try {
							await this.plugin.api().ping();
							new Notice("Seafile: connection OK");
						} catch (e) {
							new Notice("Seafile: " + (e as Error).message);
						}
					})
				)
				.addButton((b) =>
					b
						.setButtonText("Sign out")
						.setWarning()
						.onClick(async () => {
							s.token = "";
							await save();
							this.display();
						})
				);
		} else {
			new Setting(containerEl).setName("Username / email").addText((t) =>
				t.setValue(s.username).onChange(async (v) => {
					s.username = v.trim();
					await save();
				})
			);
			new Setting(containerEl)
				.setName("Password")
				.setDesc("Used once to obtain an API token. The password itself is not stored.")
				.addText((t) => {
					t.inputEl.type = "password";
					t.onChange((v) => (this.password = v));
				});
			new Setting(containerEl)
				.setName("Two-factor code")
				.setDesc("Only if 2FA is enabled on your account.")
				.addText((t) => t.onChange((v) => (this.otp = v.trim())));
			new Setting(containerEl).addButton((b) =>
				b
					.setButtonText("Sign in")
					.setCta()
					.onClick(async () => {
						try {
							s.token = await SeafileApi.login(this.plugin.http, s.server, s.username, this.password, this.otp || undefined);
							this.password = "";
							await save();
							new Notice("Seafile: signed in");
							this.display();
						} catch (e) {
							new Notice("Seafile: " + (e as Error).message, 8000);
						}
					})
			);
			new Setting(containerEl)
				.setName("…or paste an API token")
				.setDesc("Alternative to signing in (e.g. a token from another device).")
				.addText((t) => {
					t.inputEl.type = "password";
					t.onChange(async (v) => {
						s.token = v.trim();
						await save();
					});
				})
				.addButton((b) => b.setButtonText("Use token").onClick(() => this.display()));
		}

		// ---------- Library
		new Setting(containerEl).setName("Library").setHeading();
		const lib = new Setting(containerEl)
			.setName("Library")
			.setDesc(s.repoId ? `Selected: ${s.repoName || s.repoId}` : "Load your libraries and pick one.");
		lib.addDropdown((d) => {
			d.addOption("", s.repoId ? s.repoName || s.repoId : "—");
			if (s.repoId) d.addOption(s.repoId, s.repoName || s.repoId);
			d.setValue(s.repoId);
			d.onChange(async (v) => {
				s.repoId = v;
				s.repoName = d.selectEl.selectedOptions[0]?.text ?? "";
				await save();
				lib.setDesc(`Selected: ${s.repoName}`);
			});
			lib.addButton((b) =>
				b.setButtonText("Load libraries").onClick(async () => {
					try {
						const libs = await this.plugin.api().listLibraries();
						d.selectEl.empty();
						d.addOption("", "—");
						for (const l of libs) d.addOption(l.id, l.name + (l.encrypted ? " 🔒" : "") + (l.permission === "r" ? " (read-only)" : ""));
						d.setValue(s.repoId);
					} catch (e) {
						new Notice("Seafile: " + (e as Error).message, 8000);
					}
				})
			);
		});

		new Setting(containerEl)
			.setName("Folder inside the library")
			.setDesc("Leave empty to sync the whole library. Created if missing. Example: Obsidian/My vault")
			.addText((t) =>
				t.setValue(s.remoteFolder).onChange(async (v) => {
					s.remoteFolder = v.trim();
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Library password")
			.setDesc("Only for encrypted libraries. Stored in this plugin's data.json on this device.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.repoPassword).onChange(async (v) => {
					s.repoPassword = v;
					await save();
				});
			});

		// ---------- Sync
		new Setting(containerEl).setName("When to sync").setHeading();
		new Setting(containerEl).setName("Sync on startup").addToggle((t) =>
			t.setValue(s.syncOnStartup).onChange(async (v) => {
				s.syncOnStartup = v;
				await save();
			})
		);
		new Setting(containerEl)
			.setName("Sync every N minutes")
			.setDesc("0 = off. Picks up changes made on other devices.")
			.addText((t) =>
				t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
					s.intervalMinutes = Math.max(0, Number(v) || 0);
					await save();
					this.plugin.restartTimers();
				})
			);
		new Setting(containerEl)
			.setName("Sync N seconds after an edit")
			.setDesc("0 = off. Waits until you stop typing for this long.")
			.addText((t) =>
				t.setValue(String(s.syncOnChangeSeconds)).onChange(async (v) => {
					s.syncOnChangeSeconds = Math.max(0, Number(v) || 0);
					await save();
				})
			);
		new Setting(containerEl)
			.setName("Sync when the app comes back to foreground")
			.setDesc("Useful on Android/iOS.")
			.addToggle((t) =>
				t.setValue(s.syncOnResume).onChange(async (v) => {
					s.syncOnResume = v;
					await save();
				})
			);

		new Setting(containerEl).setName("Behaviour").setHeading();
		new Setting(containerEl)
			.setName("When a file changed on both sides")
			.setDesc("Merge combines non-overlapping edits in notes; if edits overlap, both versions are kept.")
			.addDropdown((d) =>
				d
					.addOptions({
						merge: "Merge notes, otherwise keep both",
						"keep-both": "Keep both (conflict copy)",
						newer: "Newer file wins",
						local: "This device wins",
						remote: "Server wins",
					})
					.setValue(s.conflict)
					.onChange(async (v) => {
						s.conflict = v as ConflictStrategy;
						await save();
					})
			);
		new Setting(containerEl)
			.setName("Mergeable extensions")
			.setDesc("Comma-separated.")
			.addText((t) =>
				t.setValue(s.mergeExtensions).onChange(async (v) => {
					s.mergeExtensions = v;
					await save();
				})
			);
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Used in conflict file names.")
			.addText((t) =>
				t.setValue(s.deviceName).onChange(async (v) => {
					s.deviceName = v.trim();
					await save();
				})
			);
		new Setting(containerEl)
			.setName(`Sync settings folder (${this.app.vault.configDir})`)
			.setDesc("Themes, plugins, hotkeys. This plugin's own login and state are never synced.")
			.addToggle((t) =>
				t.setValue(s.syncConfigDir).onChange(async (v) => {
					s.syncConfigDir = v;
					await save();
				})
			);
		new Setting(containerEl).setName("Sync empty folders").addToggle((t) =>
			t.setValue(s.syncEmptyDirs).onChange(async (v) => {
				s.syncEmptyDirs = v;
				await save();
			})
		);
		new Setting(containerEl)
			.setName("Ignore")
			.setDesc("One pattern per line. `name` matches anywhere, `dir/` a folder, `a/*.pdf`, `**/x` are supported.")
			.addTextArea((t) => {
				t.inputEl.rows = 8;
				t.inputEl.addClass("seafile-sync-ignore");
				t.setValue(s.ignore).onChange(async (v) => {
					s.ignore = v;
					await save();
				});
			});
		new Setting(containerEl)
			.setName("Max file size (MB)")
			.setDesc("Bigger files are skipped. 0 = no limit (careful on phones).")
			.addText((t) =>
				t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
					s.maxFileSizeMB = Math.max(0, Number(v) || 0);
					await save();
				})
			);
		new Setting(containerEl)
			.setName("Ask before deleting more than N files")
			.setDesc("Protects against mass deletion (wrong folder, broken vault). 0 = never ask.")
			.addText((t) =>
				t.setValue(String(s.deleteThreshold)).onChange(async (v) => {
					s.deleteThreshold = Math.max(0, Number(v) || 0);
					await save();
				})
			);
		new Setting(containerEl).setName("Parallel transfers").addText((t) =>
			t.setValue(String(s.concurrency)).onChange(async (v) => {
				s.concurrency = Math.min(16, Math.max(1, Number(v) || 1));
				await save();
			})
		);
		new Setting(containerEl).setName("Notifications").addDropdown((d) =>
			d
				.addOptions({ all: "Every sync", errors: "Only errors and conflicts", none: "None" })
				.setValue(s.notices)
				.onChange(async (v) => {
					s.notices = v as Settings["notices"];
					await save();
				})
		);
		new Setting(containerEl)
			.setName("Use server URL for file transfers")
			.setDesc("Turn on if uploads/downloads fail because the server's FILE_SERVER_ROOT / SERVICE_URL is misconfigured (e.g. points to an internal address or http).")
			.addToggle((t) =>
				t.setValue(s.rewriteFileServer).onChange(async (v) => {
					s.rewriteFileServer = v;
					await save();
				})
			);

		new Setting(containerEl).setName("Maintenance").setHeading();
		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc("Forget what was synced. The next sync compares everything file by file again (nothing is deleted; differing files become conflicts).")
			.addButton((b) =>
				b
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						await this.plugin.resetState();
						new Notice("Seafile: sync state reset");
					})
			);
	}
}
