// End-to-end test: runs the real Obsidian app with the built plugin against a fake
// Seafile server, checks real sync behaviour on this OS and optionally takes screenshots.
//
//   node test/out/e2e.js --obsidian <path to Obsidian executable> [--shots docs/screenshots]
//
// Obsidian runs with its own --user-data-dir, so the user's vaults and settings are never touched.
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cdp, targets, waitTarget } from "./cdp";
import { startServer } from "./server";
import { checks } from "./checks";
import { Camera, PRE, takeShots } from "./shots";

const args = process.argv.slice(2);
const arg = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const OBSIDIAN = arg("--obsidian");
const SHOTS = arg("--shots");
const CDP_PORT = Number(arg("--port") ?? 9241);
/** Obsidian app update (obsidian-x.y.z.asar); a fresh profile otherwise runs the installer's bundled version. */
const ASAR = arg("--asar");
if (!OBSIDIAN) {
	console.error("usage: e2e --obsidian <executable> [--shots dir]");
	process.exit(2);
}

const ID = "seafile-vault-sync";
const root = path.resolve(path.dirname(process.argv[1]), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "seafile-e2e-"));
const vault = path.join(work, "My Vault");
const userData = path.join(work, "user-data");

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, info?: unknown) {
	if (ok) {
		passes++;
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}${info !== undefined ? "  " + JSON.stringify(info).slice(0, 600) : ""}`);
	}
}


function writeVault(serverUrl: string, lang: string) {
	const pdir = path.join(vault, ".obsidian", "plugins", ID);
	fs.mkdirSync(pdir, { recursive: true });
	for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(root, f), path.join(pdir, f));
	fs.writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([ID]));
	fs.writeFileSync(path.join(vault, ".obsidian", "appearance.json"), JSON.stringify({ theme: "obsidian" }));
	fs.writeFileSync(
		path.join(pdir, "data.json"),
		JSON.stringify({
			server: serverUrl,
			username: "alex@example.com",
			secretId: "e2e",
			repoId: "repo-1",
			repoName: "Notes",
			remoteFolder: "Vault",
			deviceName: "Laptop",
			syncOnStartup: false,
			intervalMinutes: 0,
			syncOnChangeSeconds: 0,
			pollSeconds: 0,
			notices: "all",
			deleteThreshold: 20,
		})
	);
	fs.mkdirSync(userData, { recursive: true });
	if (ASAR) fs.copyFileSync(ASAR, path.join(userData, path.basename(ASAR)));
	fs.writeFileSync(path.join(userData, "obsidian.json"), JSON.stringify({ vaults: { e2e0000000000001: { path: vault, ts: Date.now(), open: true } } }));
	void lang;
}

async function launch(): Promise<{ proc: ChildProcess; page: Cdp }> {
	const extra = process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
	const proc = spawn(OBSIDIAN!, [`--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT}`, ...extra], { stdio: "ignore", detached: false });
	// Wait for the vault to load, then turn on community plugins (fresh profile = restricted mode).
	// On a first start the window can reload once (seen on macOS CI), so reconnect if it does.
	let page!: Cdp;
	for (let attempt = 1; ; attempt++) {
		const t = await waitTarget(CDP_PORT, (x) => x.url.includes("index.html"), 90_000);
		page = await Cdp.connect(t);
		try {
			await page.eval(`for (let i = 0; i < 120 && !(window.app && app.workspace && app.workspace.layoutReady); i++) await new Promise((r) => setTimeout(r, 500)); return true;`);
			break;
		} catch (e) {
			if (attempt >= 5 || !/context was destroyed|Cannot find context|closed/i.test(String(e))) throw e;
			page.close();
			console.log(`  (window reloaded, reconnecting: ${String(e)})`);
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	await page.eval(`
		app.vault.setConfig("spellcheck", false);
		if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
		if (!app.plugins.plugins["${ID}"]) await app.plugins.enablePluginAndSave("${ID}");
		for (let i = 0; i < 40 && !app.plugins.plugins["${ID}"]; i++) await new Promise((r) => setTimeout(r, 250));
		app.plugins.plugins["${ID}"].setToken("T");
		return true;`);
	return { proc, page };
}

function manifestVersion(): string {
	return (JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as { version: string }).version;
}

async function main() {
	const srv = await startServer();
	const { mock } = srv;
	writeVault(srv.url, "en");
	console.log(`Obsidian e2e on ${process.platform}/${process.arch}, vault: ${vault}`);
	const { proc, page } = await launch();
	const run = <T = unknown>(body: string) => page.eval<T>(PRE + body);

	try {
		await checks(run, mock, check, manifestVersion());
		if (SHOTS) await screenshots(page, run, mock);
	} finally {
		page.close();
		proc.kill();
		srv.close();
	}
	console.log(`\n${passes} passed, ${failures} failed (${process.platform})`);
	process.exit(failures ? 1 : 0);
}

// ------------------------------------------------------------------ screenshots for the README

async function screenshots(page: Cdp, run: <T = unknown>(b: string) => Promise<T>, mock: import("../mock").MockSeafile) {
	const out = path.resolve(SHOTS!);
	fs.mkdirSync(out, { recursive: true });
	await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
	const save = (name: string, b64: string) => {
		fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(b64, "base64"));
		console.log(`  📸 ${name}.png`);
	};
	type Rect = { x: number; y: number; width: number; height: number };
	const cam: Camera = {
		phone: false,
		async shot(name, selector) {
			await new Promise((r) => setTimeout(r, 400));
			let clip: Rect | undefined;
			if (selector) {
				const r = await run<Rect | null>(`const el = [...document.querySelectorAll(${JSON.stringify(selector)})].pop(); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
				if (!r) return void console.log(`  (screenshot ${name}: ${selector} not found)`);
				clip = r;
			}
			save(name, (await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })).data);
		},
		async settings(name) {
			await run(`app.setting.open(); app.setting.openTabById("${ID}"); await sleep(1500); return true;`);
			const popout = (await targets(CDP_PORT)).find((t) => t.url === "about:blank" || /Settings|Настройки/.test(t.title));
			const sp = popout ? await Cdp.connect(popout) : page;
			await sp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 6000, deviceScaleFactor: 2, mobile: false });
			await new Promise((r) => setTimeout(r, 1000));
			// Two pictures: the first three groups, and "More libraries" + "Tools".
			const parts = await sp.eval<Rect[]>(`
				const c = [...document.querySelectorAll(".vertical-tab-content")].pop();
				c.style.maxHeight = "none"; c.style.overflow = "visible";
				const heads = [...c.querySelectorAll(".setting-item-heading, .setting-group-heading, .setting-group > .setting-item-name")];
				let groups = [...c.querySelectorAll(".setting-group")];
				if (!groups.length) groups = heads.map((h) => h.parentElement);
				const box = (a, b) => { const r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect(), rc = c.getBoundingClientRect(); return { x: rc.x, y: r1.y - 16, width: rc.width, height: r2.bottom - r1.y + 32 }; };
				return groups.length >= 6 ? [box(groups[0], groups[2]), box(groups[4], groups[5])] : [];`);
			const names = [name, name + "-tools"];
			for (let i = 0; i < parts.length; i++) save(names[i].replace(/(-ru)-tools$/, "-tools$1"), (await sp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...parts[i], scale: 1 }, captureBeyondViewport: true })).data);
			if (!parts.length) console.log("  (settings groups not found)");
			if (sp !== page) {
				await sp.send("Emulation.clearDeviceMetricsOverride");
				sp.close();
			}
			await run(`app.setting.close(); await sleep(400); return true;`);
		},
	};
	for (const lang of ["en", "ru"] as const) {
		await run(`window.localStorage.setItem("language", "${lang}"); setTimeout(() => location.reload(), 50); return true;`).catch(() => undefined);
		await new Promise((r) => setTimeout(r, 3000));
		await page.eval(`for (let i = 0; i < 120 && !(window.app && app.workspace && app.workspace.layoutReady && app.plugins.plugins["${ID}"]); i++) await new Promise((r) => setTimeout(r, 250)); return true;`);
		await takeShots(run, mock, cam, lang);
	}
	await page.send("Emulation.clearDeviceMetricsOverride");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
