// README screenshots: a clean demo vault with made-up content (no real names, servers or accounts).
// The same steps run on the desktop app and on a phone; only the camera differs.
import type { MockSeafile } from "../mock";

export const ID = "seafile-vault-sync";

export type Run = <T = unknown>(body: string) => Promise<T>;

export interface Camera {
	/** Capture an element (last match), or the whole screen when selector is null. */
	shot(name: string, selector: string | null): Promise<void>;
	/** Capture the plugin's settings page (may live in another window). */
	settings(name: string): Promise<void>;
	phone: boolean;
}

/** Page-side helpers (prepended to every script). */
export const PRE = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = app.plugins.plugins["${ID}"];
const W = async (p, t) => { const f = app.vault.getAbstractFileByPath(p); if (f) await app.vault.modify(f, t); else { const d = p.split("/").slice(0, -1).join("/"); if (d && !app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d); await app.vault.create(p, t); } };
const WB = async (p, bytes) => { const d = p.split("/").slice(0, -1).join("/"); if (d && !app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d); await app.vault.createBinary(p, new Uint8Array(bytes).buffer); };
const Rd = async (p) => { const f = app.vault.getAbstractFileByPath(p); return f ? app.vault.read(f) : null; };
const D = async (p) => { const f = app.vault.getAbstractFileByPath(p); if (f) await app.fileManager.trashFile(f); };
const MV = async (a, b) => app.fileManager.renameFile(app.vault.getAbstractFileByPath(a), b);
const L = () => app.vault.getFiles().map((f) => f.path).sort();
const SY = async () => { const n = P.logLines.length; await P.sync("manual"); return P.logLines.slice(n).join(" | "); };
const closeModals = async () => { document.querySelectorAll(".modal-close-button").forEach((b) => b.click()); await sleep(450); };
`;

/** Settings that look good in a screenshot (restored afterwards). */
const SHOW_SETTINGS = `{ server: "https://cloud.example.com", intervalMinutes: 5, pollSeconds: 30, syncOnChangeSeconds: 15, syncOnStartup: true }`;

export async function takeShots(run: Run, mock: MockSeafile, cam: Camera, lang: "en" | "ru") {
	const ru = lang === "ru";
	const T = (en: string, r: string) => (ru ? r : en);
	const sfx = (cam.phone ? "-phone" : "") + (ru ? "-ru" : "");

	// Clean demo vault: remove everything else (here and on the server).
	await run(`
		await closeModals();
		P.settings.deleteThreshold = 0; await P.saveSettings();
		for (const f of [...app.vault.getRoot().children]) await app.fileManager.trashFile(f);
		await SY();
		P.settings.deleteThreshold = 20; await P.saveSettings();
		document.body.classList.add("seafile-demo-shots");
		if (!document.getElementById("seafile-demo-css")) { const st = document.createElement("style"); st.id = "seafile-demo-css"; st.textContent = ".seafile-demo-shots .status-bar { display: none !important; }"; document.head.appendChild(st); }
		return true;`);

	const garden = T("Projects/Garden.md", "Проекты/Сад.md");
	const trip = T("Projects/Trip to the mountains.md", "Проекты/Поездка в горы.md");
	const reading = T("Reading list.md", "Что почитать.md");
	const ideas = T("Ideas.md", "Идеи.md");
	const ideasCopy = T("Ideas (conflict Phone 2026-11-25 184512).md", "Идеи (conflict Phone 2026-11-25 184512).md");
	const daily = T("Daily/2026-11-25.md", "Дневник/2026-11-25.md");
	const inbox = T("Inbox.md", "Входящие.md");
	const files: Record<string, string> = {
		[garden]: T("- [x] Order seeds\n- [ ] Build raised beds\n- [ ] Plant tomatoes in May\n", "- [x] Заказать семена\n- [ ] Сделать грядки\n- [ ] Посадить томаты в мае\n"),
		[trip]: T("Train on Friday, back on Sunday.\n", "Поезд в пятницу, обратно в воскресенье.\n"),
		[reading]: T("- The Pragmatic Programmer\n- Deep Work\n", "- Мастер и Маргарита\n- Deep Work\n"),
		[ideas]: T("- A garden in the backyard\n- Learn to play guitar\n- Weekend hike\n", "- Сад во дворе\n- Научиться играть на гитаре\n- Поход на выходных\n"),
		[daily]: T("- Call the dentist\n- Buy milk\n- Review the plan\n", "- Позвонить стоматологу\n- Купить молоко\n- Посмотреть план\n"),
	};
	for (const [p, c] of Object.entries(files)) await run(`await W(${JSON.stringify(p)}, ${JSON.stringify(c)}); return true;`);
	await run(`return await SY();`);
	// "The phone" edits: a new version of the daily note and a conflict copy.
	mock.put("/Vault/" + daily, T("- Call the dentist ✓\n- Buy milk and bread\n- Review the plan\n- Book train tickets\n", "- Позвонить стоматологу ✓\n- Купить молоко и хлеб\n- Посмотреть план\n- Купить билеты на поезд\n"));
	mock.put("/Vault/" + ideasCopy, T("- A greenhouse in the backyard\n- Learn to play guitar\n- Weekend hike with friends\n", "- Теплица во дворе\n- Научиться играть на гитаре\n- Поход на выходных с друзьями\n"));
	await run(`return await SY();`);
	mock.put("/Vault/" + garden, files[garden].replace(T("- [ ] Build", "- [ ] Сделать"), T("- [x] Build", "- [x] Сделать")));

	// 1) overview: explorer with status dots, an open note, a "synced" notice
	await run(`
		await closeModals();
		const ex = app.workspace.getLeavesOfType("file-explorer")[0];
		if (ex) app.workspace.revealLeaf(ex);
		for (const f of app.vault.getAllLoadedFiles()) if (f.children) { const el = document.querySelector('.nav-folder-title[data-path="' + f.path + '"]'); if (el && el.parentElement.classList.contains("is-collapsed")) el.click(); }
		await app.workspace.getLeaf().openFile(app.vault.getFileByPath(${JSON.stringify(garden)}));
		document.querySelectorAll(".notice").forEach((n) => n.remove());
		await P.sync("manual");
		await W(${JSON.stringify(inbox)}, ${JSON.stringify(T("Call Anna about the weekend", "Позвонить Ане насчёт выходных"))});
		await sleep(900);
		P.refreshBadges();
		await sleep(400);
		return true;`);
	if (cam.phone) {
		await cam.shot("note" + sfx, null);
		await run(`document.querySelectorAll(".notice").forEach((n) => n.remove()); app.workspace.leftSplit.expand(); await sleep(900); P.refreshBadges(); await sleep(300); return true;`);
		await cam.shot("explorer" + sfx, null);
		await run(`app.workspace.leftSplit.collapse(); await sleep(500); return true;`);
	} else await cam.shot("overview" + sfx, null);

	// 2) version history with a comparison
	await run(`
		await closeModals();
		document.querySelectorAll(".notice").forEach((n) => n.remove());
		await app.workspace.getLeaf().openFile(app.vault.getFileByPath(${JSON.stringify(daily)}));
		app.commands.executeCommandById("${ID}:version-history");
		await sleep(1200);
		const md = [...document.querySelectorAll(".modal.seafile-sync-wide")].pop();
		const cmp = [...md.querySelectorAll("button")].filter((b) => !b.classList.contains("mod-cta"));
		cmp[cmp.length - 1].click();
		await sleep(900);
		return true;`);
	await cam.shot("history" + sfx, cam.phone ? null : ".modal.seafile-sync-wide");

	// 3) conflict helper
	await run(`await closeModals(); await app.workspace.getLeaf().openFile(app.vault.getFileByPath(${JSON.stringify(ideas)})); app.commands.executeCommandById("${ID}:resolve-conflict"); await sleep(1000); document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
	await cam.shot("conflict" + sfx, cam.phone ? null : ".modal.seafile-sync-wide");

	// 4) server trash
	await run(`await closeModals(); await D(${JSON.stringify(reading)}); await D(${JSON.stringify(trip)}); await SY(); document.querySelectorAll(".notice").forEach((n) => n.remove()); app.commands.executeCommandById("${ID}:restore-deleted"); await sleep(1300); return true;`);
	await cam.shot("trash" + sfx, cam.phone ? null : ".modal.seafile-sync-wide");
	await run(`await closeModals(); return true;`);

	// 5) settings, with a nice-looking server address
	await run(`window.__seafileSaved = JSON.stringify(P.settings); Object.assign(P.settings, ${SHOW_SETTINGS}); return true;`);
	await cam.settings("settings" + sfx);
	await run(`Object.assign(P.settings, JSON.parse(window.__seafileSaved)); await P.saveSettings(); document.body.classList.remove("seafile-demo-shots"); return true;`);
}
