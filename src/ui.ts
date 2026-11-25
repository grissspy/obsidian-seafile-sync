import { App, Modal, Notice, Setting, SuggestModal, TFile } from "obsidian";
import { t } from "./i18n";
import type SeafileSyncPlugin from "./main";
import { diffHunks } from "./merge";
import { FileVersion, TrashItem } from "./seafile";
import { looksLikeText, parseConflictName, toText } from "./util";

function when(ms: number): string {
	return ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "?";
}

function size(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function splitLines(s: string): string[] {
	return s.split("\n");
}

/** Read-only diff of two texts: changed blocks with a little context. */
function renderDiff(el: HTMLElement, before: string, after: string, beforeLabel: string, afterLabel: string) {
	const a = splitLines(before);
	const b = splitLines(after);
	const hunks = diffHunks(a, b);
	const box = el.createDiv({ cls: "seafile-sync-diff" });
	const legend = box.createDiv({ cls: "seafile-sync-diff-legend" });
	legend.createSpan({ cls: "seafile-sync-del", text: `− ${beforeLabel}` });
	legend.createSpan({ cls: "seafile-sync-add", text: `+ ${afterLabel}` });
	if (hunks === null) {
		box.createDiv({ text: t("diffTooBig") });
		return;
	}
	if (!hunks.length) {
		box.createDiv({ cls: "seafile-sync-muted", text: t("diffSame") });
		return;
	}
	hunks.forEach((h, idx) => {
		const prevEnd = idx > 0 ? hunks[idx - 1].e : 0;
		const nextStart = idx + 1 < hunks.length ? hunks[idx + 1].s : a.length;
		const block = box.createDiv({ cls: "seafile-sync-hunk" });
		const ctxFrom = Math.max(prevEnd, h.s - 2);
		block.createDiv({ cls: "seafile-sync-muted", text: t("diffLine", { n: h.s + 1 }) });
		for (let i = ctxFrom; i < h.s; i++) block.createDiv({ cls: "seafile-sync-ctx", text: a[i] || " " });
		for (let i = h.s; i < h.e; i++) block.createDiv({ cls: "seafile-sync-del", text: a[i] || " " });
		for (const l of h.lines) block.createDiv({ cls: "seafile-sync-add", text: l || " " });
		for (let i = h.e; i < Math.min(nextStart, h.e + 2); i++) block.createDiv({ cls: "seafile-sync-ctx", text: a[i] || " " });
	});
}

const OPS = new Set(["create", "edit", "rename", "move", "recover"]);
function opName(op: string): string {
	return OPS.has(op) ? t(`op_${op}` as "op_edit") : op;
}

// ------------------------------------------------------------------ version history

export class HistoryModal extends Modal {
	private versions: FileVersion[] = [];
	private page = 1;
	private more = false;
	private listEl!: HTMLElement;
	private viewEl!: HTMLElement;

	constructor(app: App, private plugin: SeafileSyncPlugin, private file: TFile) {
		super(app);
	}

	async onOpen() {
		this.titleEl.setText(t("histTitle", { name: this.file.name }));
		this.modalEl.addClass("seafile-sync-wide");
		this.listEl = this.contentEl.createDiv();
		this.viewEl = this.contentEl.createDiv();
		await this.load();
	}

	private async load() {
		const where = this.plugin.resolveRemote(this.file.path);
		if (!where) {
			this.listEl.setText(t("notSynced"));
			return;
		}
		this.listEl.setText(t("loading"));
		try {
			const r = await this.plugin.api().fileHistory(where.repo, where.abs, this.page);
			this.versions.push(...r.items);
			this.more = r.more;
			this.renderList();
		} catch (e) {
			this.listEl.setText("❌ " + (e as Error).message);
		}
	}

	private renderList() {
		const el = this.listEl;
		el.empty();
		if (!this.versions.length) {
			el.setText(t("histEmpty"));
			return;
		}
		const text = this.plugin.isTextPath(this.file.path);
		this.versions.forEach((v, i) => {
			const s = new Setting(el)
				.setName(`${i === 0 ? "🟢 " : "🕘 "}${when(v.time)}`)
				.setDesc([v.author, size(v.size), opName(v.op)].filter(Boolean).join(" · "));
			if (text) s.addButton((b) => b.setButtonText(t("histCompare")).onClick(() => void this.compare(v)));
			if (i > 0 || this.versions.length === 1)
				s.addButton((b) =>
					b
						.setButtonText(t("histRestore"))
						.setCta()
						.onClick(() => void this.restore(v))
				);
		});
		if (this.more) {
			new Setting(el).addButton((b) =>
				b.setButtonText(t("loadMore")).onClick(async () => {
					this.page++;
					await this.load();
				})
			);
		}
	}

	private async fetch(v: FileVersion): Promise<ArrayBuffer> {
		const where = this.plugin.resolveRemote(this.file.path)!;
		return this.plugin.api().downloadRevision(where.repo, v.path, v.commitId);
	}

	private async compare(v: FileVersion) {
		this.viewEl.empty();
		this.viewEl.createEl("h4", { text: t("histDiffTitle", { time: when(v.time) }) });
		try {
			const old = await this.fetch(v);
			const cur = await this.app.vault.read(this.file);
			if (!looksLikeText(old)) {
				this.viewEl.setText(t("diffBinary"));
				return;
			}
			renderDiff(this.viewEl, toText(old), cur, t("histThatVersion"), t("histNow"));
			this.viewEl.scrollIntoView({ behavior: "smooth", block: "start" });
		} catch (e) {
			this.viewEl.setText("❌ " + (e as Error).message);
		}
	}

	private async restore(v: FileVersion) {
		try {
			const data = await this.fetch(v);
			// Write it locally like a normal edit: the next sync uploads it, and the
			// current version stays in the server's history, so this is undoable.
			if (looksLikeText(data) && this.plugin.isTextPath(this.file.path)) await this.app.vault.modify(this.file, toText(data));
			else await this.app.vault.modifyBinary(this.file, data);
			new Notice(t("histRestored", { time: when(v.time) }));
			this.close();
			void this.plugin.sync("manual");
		} catch (e) {
			new Notice("❌ Seafile: " + (e as Error).message, 8000);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------------ server trash

export class TrashModal extends Modal {
	private items: TrashItem[] = [];
	private cursor: string | null = "";
	private chosen = new Set<TrashItem>();
	private listEl!: HTMLElement;
	private filter = "";

	constructor(app: App, private plugin: SeafileSyncPlugin) {
		super(app);
	}

	async onOpen() {
		this.titleEl.setText(t("trashTitle"));
		this.modalEl.addClass("seafile-sync-wide");
		this.contentEl.createEl("p", { cls: "seafile-sync-muted", text: t("trashIntro") });
		new Setting(this.contentEl).setName(t("trashSearch")).addText((tx) =>
			tx.onChange((v) => {
				this.filter = v.trim().toLowerCase();
				this.render();
			})
		);
		this.listEl = this.contentEl.createDiv({ cls: "seafile-sync-trash" });
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: t("loadMore") }).onclick = () => void this.load();
		row.createEl("button", { text: t("trashRestore"), cls: "mod-cta" }).onclick = () => void this.restore();
		await this.load();
	}

	private async load() {
		if (this.cursor === null) {
			new Notice(t("trashNoMore"));
			return;
		}
		const targets = this.plugin.targets();
		this.listEl.setText(t("loading"));
		try {
			const api = this.plugin.api();
			// Fetch pages until we have something relevant (the trash may be full of other folders).
			let added = 0;
			for (let i = 0; i < 5 && this.cursor !== null && added < 30; i++) {
				const r = await api.trash(targets[0].repoId, this.cursor);
				this.cursor = r.cursor;
				for (const it of r.items) {
					if (!this.plugin.trashRelevant(targets[0].repoId, it.path)) continue;
					if (this.items.some((x) => x.path === it.path && x.commitId === it.commitId)) continue;
					this.items.push(it);
					added++;
				}
			}
			this.render();
		} catch (e) {
			this.listEl.setText("❌ " + (e as Error).message);
		}
	}

	private render() {
		const el = this.listEl;
		el.empty();
		const shown = this.items.filter((i) => !this.filter || i.path.toLowerCase().includes(this.filter));
		if (!shown.length) {
			el.setText(t("trashEmpty"));
			return;
		}
		for (const it of shown) {
			const s = new Setting(el)
				.setName(`${it.isDir ? "📁" : "📄"} ${this.plugin.displayPath(it.path)}`)
				.setDesc(`${t("trashDeleted")} ${when(it.deleted)}${it.isDir ? "" : " · " + size(it.size)}`);
			s.addToggle((tg) =>
				tg.setValue(this.chosen.has(it)).onChange((v) => {
					if (v) this.chosen.add(it);
					else this.chosen.delete(it);
				})
			);
		}
	}

	private async restore() {
		if (!this.chosen.size) return;
		const api = this.plugin.api();
		const repo = this.plugin.targets()[0].repoId;
		let ok = 0;
		const errors: string[] = [];
		for (const it of this.chosen) {
			try {
				await api.revert(repo, it.path, it.commitId, it.isDir);
				ok++;
			} catch (e) {
				errors.push(`${it.path}: ${(e as Error).message}`);
			}
		}
		new Notice(t("trashRestored", { n: ok }) + (errors.length ? "\n" + errors.slice(0, 3).join("\n") : ""), errors.length ? 10000 : 5000);
		this.close();
		void this.plugin.sync("manual");
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------------ conflict helper

type Choice = "mine" | "theirs" | "both";

/** Pick, block by block, what goes into the note: the main file, the conflict copy, or both. */
export class ConflictModal extends Modal {
	private choices: Choice[] = [];

	constructor(app: App, private plugin: SeafileSyncPlugin, private main: TFile, private copy: TFile, private device: string) {
		super(app);
	}

	async onOpen() {
		this.titleEl.setText(t("cfTitle", { name: this.main.name }));
		this.modalEl.addClass("seafile-sync-wide");
		const a = await this.app.vault.read(this.main);
		const b = await this.app.vault.read(this.copy);
		const A = splitLines(a);
		const B = splitLines(b);
		const hunks = diffHunks(A, B);
		const el = this.contentEl;
		el.createEl("p", { cls: "seafile-sync-muted", text: t("cfIntro", { device: this.device }) });
		if (hunks === null) {
			el.createEl("p", { text: t("diffTooBig") });
			return;
		}
		if (!hunks.length) {
			el.createEl("p", { text: t("cfSame") });
			this.buttons(() => a);
			return;
		}
		this.choices = hunks.map(() => "both");
		hunks.forEach((h, i) => {
			const block = el.createDiv({ cls: "seafile-sync-hunk" });
			block.createDiv({ cls: "seafile-sync-muted", text: t("diffLine", { n: h.s + 1 }) });
			const mine = block.createDiv({ cls: "seafile-sync-side" });
			mine.createDiv({ cls: "seafile-sync-side-title", text: t("cfMain") });
			for (let k = h.s; k < h.e; k++) mine.createDiv({ cls: "seafile-sync-del", text: A[k] || " " });
			if (h.e === h.s) mine.createDiv({ cls: "seafile-sync-muted", text: t("cfNothing") });
			const theirs = block.createDiv({ cls: "seafile-sync-side" });
			theirs.createDiv({ cls: "seafile-sync-side-title", text: t("cfCopy", { device: this.device }) });
			for (const l of h.lines) theirs.createDiv({ cls: "seafile-sync-add", text: l || " " });
			if (!h.lines.length) theirs.createDiv({ cls: "seafile-sync-muted", text: t("cfNothing") });
			new Setting(block).setName(t("cfKeep")).addDropdown((d) =>
				d
					.addOption("both", t("cfBoth"))
					.addOption("mine", t("cfMain"))
					.addOption("theirs", t("cfCopy", { device: this.device }))
					.setValue("both")
					.onChange((v) => (this.choices[i] = v as Choice))
			);
		});
		this.buttons(() => {
			const out: string[] = [];
			let pos = 0;
			hunks.forEach((h, i) => {
				out.push(...A.slice(pos, h.s));
				const c = this.choices[i];
				if (c === "mine" || c === "both") out.push(...A.slice(h.s, h.e));
				if (c === "theirs" || c === "both") out.push(...h.lines);
				pos = h.e;
			});
			out.push(...A.slice(pos));
			return out.join("\n");
		});
	}

	private buttons(result: () => string) {
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: t("cfCancel") }).onclick = () => this.close();
		row.createEl("button", { text: t("cfApply"), cls: "mod-cta" }).onclick = async () => {
			try {
				await this.app.vault.modify(this.main, result());
				await this.app.fileManager.trashFile(this.copy);
				new Notice(t("cfDone"));
				this.close();
				void this.plugin.sync("manual");
			} catch (e) {
				new Notice("❌ Seafile: " + (e as Error).message, 8000);
			}
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Find the conflict pair for the active file: either it is a copy, or it has copies next to it. */
export function findConflict(app: App, file: TFile): { main: TFile; copy: TFile; device: string } | null {
	const p = parseConflictName(file.path);
	if (p) {
		const main = app.vault.getFileByPath(p.original);
		return main ? { main, copy: file, device: p.device } : null;
	}
	const copies = (file.parent?.children ?? [])
		.filter((f): f is TFile => f instanceof TFile && parseConflictName(f.path)?.original === file.path)
		.sort((x, y) => y.stat.mtime - x.stat.mtime);
	if (!copies.length) return null;
	return { main: file, copy: copies[0], device: parseConflictName(copies[0].path)!.device };
}

// ------------------------------------------------------------------ device profiles

export class ProfilePicker extends SuggestModal<string> {
	constructor(app: App, private names: string[], private pick: (name: string) => void) {
		super(app);
		this.setPlaceholder(t("profPick"));
	}
	getSuggestions(q: string): string[] {
		return this.names.filter((n) => n.toLowerCase().includes(q.toLowerCase()));
	}
	renderSuggestion(n: string, el: HTMLElement) {
		el.setText("📱 " + n);
	}
	onChooseSuggestion(n: string) {
		this.pick(n);
	}
}
