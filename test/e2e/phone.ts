// End-to-end checks and screenshots on a real Android phone (USB debugging, Obsidian open).
//
//   node test/out/phone.js --adb <path to adb> [--shots docs/screenshots]
//
// Creates a separate demo vault on the phone, switches Obsidian to it, runs the checks against a fake
// server on this computer (reached through `adb reverse`), then switches back and deletes the demo vault.
// The phone's own vaults are never opened or changed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cdp, targets } from "./cdp";
import { checks } from "./checks";
import { startServer } from "./server";
import { Camera, ID, PRE, takeShots } from "./shots";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const ADB = arg("--adb") ?? "adb";
const SHOTS = arg("--shots");
const PORT = 8799;
const CDP = 9335;
const root = path.resolve(path.dirname(process.argv[1]), "../..");
const DEMO = "/storage/emulated/0/Documents/Obsidian/Seafile Demo";

const adb = (...a: string[]) => execFileSync(ADB, a, { maxBuffer: 64 * 1024 * 1024 });

let failures = 0;
let passes = 0;
const check = (name: string, ok: boolean, info?: unknown) => {
	if (ok) passes++;
	else failures++;
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || info === undefined ? "" : "  " + JSON.stringify(info).slice(0, 400)}`);
};

async function connect(): Promise<Cdp> {
	for (let i = 0; i < 60; i++) {
		const sockets = String(adb("shell", "cat", "/proc/net/unix")).match(/@webview_devtools_remote_\d+/g) ?? [];
		for (const s of new Set(sockets)) {
			adb("forward", `tcp:${CDP}`, `localabstract:${s.slice(1)}`);
			try {
				const t = (await targets(CDP)).find((x) => x.url.startsWith("http://localhost") && /Obsidian/.test(x.title));
				if (t) return await Cdp.connect(t);
			} catch {
				/* not this one */
			}
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error("Obsidian is not open on the phone (or USB debugging is off)");
}

async function waitReady(): Promise<Cdp> {
	await new Promise((r) => setTimeout(r, 2500));
	const page = await connect();
	await page.eval(`for (let i = 0; i < 160 && !(window.app && app.workspace && app.workspace.layoutReady); i++) await new Promise((r) => setTimeout(r, 250)); return true;`);
	return page;
}

async function main() {
	const srv = await startServer(PORT);
	srv.mock.fsBase = `http://127.0.0.1:${PORT}`;
	adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`);
	let page = await connect();
	const before = await page.eval<{ vault: string | null; lang: string | null; android: string }>(
		`return { vault: localStorage.getItem("mobile-selected-vault"), lang: localStorage.getItem("language"), android: navigator.userAgent.match(/Android [\\d.]+/)?.[0] ?? "?" };`
	);
	console.log(`Phone: ${before.android}`);

	const files: Record<string, string> = {};
	for (const f of ["main.js", "manifest.json", "styles.css"]) files[`.obsidian/plugins/${ID}/${f}`] = fs.readFileSync(path.join(root, f), "utf8");
	files[`.obsidian/plugins/${ID}/data.json`] = JSON.stringify({
		server: `http://127.0.0.1:${PORT}`, username: "alex@example.com", secretId: "e2e-phone", repoId: "repo-1", repoName: "Notes",
		remoteFolder: "Vault", deviceName: "Phone", syncOnStartup: false, intervalMinutes: 0, syncOnChangeSeconds: 0, pollSeconds: 0, notices: "all", deleteThreshold: 20,
	});
	files[".obsidian/community-plugins.json"] = JSON.stringify([ID]);
	files[".obsidian/appearance.json"] = JSON.stringify({ theme: "obsidian" });
	files[".obsidian/app.json"] = JSON.stringify({ spellcheck: false });

	try {
		await page.eval(`
			const FS = Capacitor.Plugins.Filesystem;
			const root = ${JSON.stringify(DEMO)};
			try { await FS.rmdir({ path: root, recursive: true }); } catch {}
			const files = ${JSON.stringify(files)};
			for (const [p, c] of Object.entries(files)) await FS.writeFile({ path: root + "/" + p, data: c, encoding: "utf8", recursive: true });
			const v = JSON.parse(localStorage.getItem("mobile-external-vaults") || "[]");
			if (!v.includes(root)) v.push(root);
			localStorage.setItem("mobile-external-vaults", JSON.stringify(v));
			localStorage.setItem("enable-plugin-" + root, "true");
			localStorage.setItem("mobile-selected-vault", root);
			setTimeout(() => location.reload(), 100);
			return true;`);
		page = await waitReady();
		await page.eval(`
			if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
			if (!app.plugins.plugins["${ID}"]) await app.plugins.enablePluginAndSave("${ID}");
			for (let i = 0; i < 40 && !app.plugins.plugins["${ID}"]; i++) await new Promise((r) => setTimeout(r, 250));
			app.plugins.plugins["${ID}"].setToken("T");
			return app.vault.getName();`);
		const run = <T = unknown>(b: string) => page.eval<T>(PRE + b);

		console.log("Checks:");
		await checks(run, srv.mock, check, (JSON.parse(files[`.obsidian/plugins/${ID}/manifest.json`]) as { version: string }).version);

		if (SHOTS) {
			const out = path.resolve(SHOTS);
			fs.mkdirSync(out, { recursive: true });
			const tmp = path.join(os.tmpdir(), "seafile-phone-shot.png");
			const cam: Camera = {
				phone: true,
				async shot(name) {
					// Cut off Android's status bar and navigation bar: only the app is kept.
					const m = await run<{ top: number; bottom: number; dpr: number; h: number; w: number }>(`
						const d = document.createElement("div");
						d.style.cssText = "position:fixed;top:0;left:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);visibility:hidden";
						document.body.appendChild(d); const cs = getComputedStyle(d);
						const r = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0, dpr: devicePixelRatio, h: innerHeight, w: innerWidth };
						d.remove(); await sleep(500); return r;`);
					fs.writeFileSync(tmp, adb("exec-out", "screencap", "-p"));
					// Scale to 1400 px high, then cut the status bar (top) and the gesture bar (bottom).
					const file = path.join(out, name + ".png");
					fs.copyFileSync(tmp, file);
					execFileSync("sips", ["-Z", "1400", file], { stdio: "ignore" });
					const w = Math.round((1400 * m.w) / m.h);
					const top = Math.max(52, Math.round((m.top / m.h) * 1400) + 8);
					const bottom = Math.max(30, Math.round((m.bottom / m.h) * 1400));
					execFileSync("sips", ["-c", String(1400 - top - bottom), String(w), "--cropOffset", String(top), "0", file], { stdio: "ignore" });
					console.log(`  📸 ${name}.png`);
				},
				async settings(name) {
					await run(`app.setting.open(); app.setting.openTabById("${ID}"); await sleep(1500); return true;`);
					await this.shot(name, null);
					await run(`app.setting.close(); await sleep(500); return true;`);
				},
			};
			for (const lang of ["en", "ru"] as const) {
				await page.eval(`localStorage.setItem("language", "${lang}"); setTimeout(() => location.reload(), 100); return true;`).catch(() => undefined);
				page = await waitReady();
				await page.eval(`for (let i = 0; i < 40 && !app.plugins.plugins["${ID}"]; i++) await new Promise((r) => setTimeout(r, 250)); return true;`);
				await takeShots(run, srv.mock, cam, lang);
			}
		}
	} finally {
		// Back to the phone's own vault and language; remove the demo vault.
		await page
			.eval(`
				const root = ${JSON.stringify(DEMO)};
				const v = JSON.parse(localStorage.getItem("mobile-external-vaults") || "[]").filter((x) => x !== root);
				localStorage.setItem("mobile-external-vaults", JSON.stringify(v));
				localStorage.removeItem("enable-plugin-" + root);
				${before.lang === null ? `localStorage.removeItem("language");` : `localStorage.setItem("language", ${JSON.stringify(before.lang)});`}
				${before.vault ? `localStorage.setItem("mobile-selected-vault", ${JSON.stringify(before.vault)});` : ""}
				setTimeout(() => location.reload(), 100);
				return true;`)
			.catch((e) => console.log("restore failed:", e));
		page.close();
		const p2 = await waitReady();
		await p2.eval(`try { await Capacitor.Plugins.Filesystem.rmdir({ path: ${JSON.stringify(DEMO)}, recursive: true }); } catch {} return app.vault.getName();`).then((n) => console.log(`Phone is back on its own vault (${n})`));
		p2.close();
		adb("reverse", "--remove", `tcp:${PORT}`);
		adb("forward", "--remove", `tcp:${CDP}`);
		srv.close();
	}
	console.log(`\n${passes} passed, ${failures} failed (Android)`);
	process.exit(failures ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
