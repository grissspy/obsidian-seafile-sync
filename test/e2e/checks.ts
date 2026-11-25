// The end-to-end checks, shared by the desktop runner and the Android runner.
import type { MockSeafile } from "../mock";
import { ID, Run } from "./shots";

export async function checks(run: Run, mock: MockSeafile, check: (name: string, ok: boolean, info?: unknown) => void, version: string) {
	const text = (abs: string) => mock.get(abs);
		const info = await run<{ v: string; app: string }>(`return { v: P.manifest.version, app: navigator.userAgent.split("obsidian/")[1]?.split(" ")[0] ?? (await window.Capacitor?.Plugins?.App?.getInfo?.())?.version ?? "?" };`);
		console.log(`Obsidian ${info.app}, plugin ${info.v}`);
		check("plugin loads", info.v === version, info);

		// --- 1. first upload: notes, unicode, nested folders, binary, empty folder
		console.log("· 1. first upload: notes, unicode, nested folders, binary, empty folder");
		const png = Array.from({ length: 3000 }, (_, i) => (i * 7) % 256);
		await run(`
			await W("Welcome.md", "# Welcome\\nfirst line\\nsecond line\\nthird line\\n");
			await W("Projects/Plan.md", "- [ ] one\\n- [ ] two\\n");
			await W("Заметки/Привет мир.md", "юникод ✓");
			await W("Deep/a/b/c/note.md", "deep");
			await WB("attachments/pic.png", ${JSON.stringify(png)});
			await app.vault.createFolder("Empty folder");
			return await SY();`);
		check("upload: notes", text("/Vault/Welcome.md")?.startsWith("# Welcome") === true && text("/Vault/Projects/Plan.md") === "- [ ] one\n- [ ] two\n");
		check("upload: unicode names", text("/Vault/Заметки/Привет мир.md") === "юникод ✓");
		check("upload: deep folders", text("/Vault/Deep/a/b/c/note.md") === "deep");
		const pic = mock.files.get("/Vault/attachments/pic.png");
		check("upload: binary bytes identical", !!pic && pic.data.length === png.length && pic.data.every((b, i) => b === png[i]));
		check("upload: empty folder", mock.dirs.has("/Vault/Empty folder"));

		// --- 2. download a server change
		console.log("· 2. download a server change");
		mock.put("/Vault/Projects/Plan.md", "- [x] one\n- [ ] two\n");
		mock.put("/Vault/From server.md", "hello from the phone");
		await run(`return await SY();`);
		const r2 = await run<string[]>(`return [await Rd("Projects/Plan.md"), await Rd("From server.md")];`);
		check("download: changed + new file", r2[0] === "- [x] one\n- [ ] two\n" && r2[1] === "hello from the phone", r2);

		// --- 3. both sides edit different lines → merged
		console.log("· 3. both sides edit different lines → merged");
		mock.put("/Vault/Welcome.md", "# Welcome\nfirst line\nsecond line\nthird line (server)\n");
		await run(`await W("Welcome.md", "# Welcome\\nfirst line (laptop)\\nsecond line\\nthird line\\n"); return await SY();`);
		const merged = "# Welcome\nfirst line (laptop)\nsecond line\nthird line (server)\n";
		const r3 = await run<string>(`return await Rd("Welcome.md");`);
		check("merge: local file", r3 === merged, r3);
		check("merge: server file", text("/Vault/Welcome.md") === merged, text("/Vault/Welcome.md"));

		// --- 4. same line on both sides → both versions kept
		console.log("· 4. same line on both sides → both versions kept");
		mock.put("/Vault/Welcome.md", merged.replace("second line", "second line (server)"));
		await run(`await W("Welcome.md", ${JSON.stringify(merged.replace("second line", "second line (laptop)"))}); return await SY();`);
		const r4 = await run<{ files: string[]; main: string }>(`return { files: L().filter((p) => p.startsWith("Welcome")), main: await Rd("Welcome.md") };`);
		const copy = r4.files.find((p) => p.includes("(conflict "));
		const copyText = copy ? await run<string>(`return await Rd(${JSON.stringify(copy)});`) : "";
		const both = [r4.main, copyText].join("\n");
		check("conflict: copy created, nothing lost", !!copy && both.includes("second line (server)") && both.includes("second line (laptop)"), r4);

		// --- 5. conflict helper keeps both blocks
		console.log("· 5. conflict helper keeps both blocks");
		if (copy) {
			await run(`
				const c = app.vault.getFileByPath(${JSON.stringify(copy)});
				await app.workspace.getLeaf().openFile(c);
				app.commands.executeCommandById("${ID}:resolve-conflict");
				await sleep(800);
				const md = document.querySelector(".modal.seafile-sync-wide");
				[...md.querySelectorAll("button")].find((b) => b.classList.contains("mod-cta")).click();
				await sleep(800);
				return await SY();`);
			const r5 = await run<{ files: string[]; main: string }>(`return { files: L().filter((p) => p.startsWith("Welcome")), main: await Rd("Welcome.md") };`);
			check("conflict helper: merged into main, copy removed", r5.files.length === 1 && r5.main.includes("(server)") && r5.main.includes("(laptop)"), r5);
		}

		// --- 6. deletions both ways
		console.log("· 6. deletions both ways");
		mock.remove("/Vault/From server.md");
		await run(`await D("Deep/a/b/c/note.md"); return await SY();`);
		const r6 = await run<string[]>(`return L();`);
		check("delete: server → local", !r6.includes("From server.md"), r6);
		check("delete: local → server", !mock.files.has("/Vault/Deep/a/b/c/note.md"));

		// --- 7. renames (folder, and case-only on case-insensitive file systems)
		console.log("· 7. renames (folder, and case-only on case-insensitive file systems)");
		await run(`await MV("Projects", "Work"); return await SY();`);
		check("rename folder", text("/Vault/Work/Plan.md") !== undefined && !mock.files.has("/Vault/Projects/Plan.md"));
		const renamed = await run<boolean>(`await W("Case.md", "case test"); await SY(); try { await MV("Case.md", "case.md"); } catch { return false; } await SY(); return true;`);
		const caseLocal = await run<string[]>(`return L().filter((p) => p.toLowerCase() === "case.md");`);
		if (!renamed) console.log("  – rename: case only (skipped: this system does not allow it)");
		else check("rename: case only", caseLocal.length === 1 && caseLocal[0] === "case.md" && text("/Vault/case.md") === "case test" && !mock.files.has("/Vault/Case.md"), { caseLocal, srv: [...mock.files.keys()].filter((k) => /case/i.test(k)) });

		// --- 8. a 5 MB file
		console.log("· 8. a 5 MB file");
		const big = Array.from({ length: 5 * 1024 * 1024 }, (_, i) => (i * 31 + 7) % 251);
		await run(`const a = new Uint8Array(${big.length}); for (let i = 0; i < a.length; i++) a[i] = (i * 31 + 7) % 251; await app.vault.createBinary("attachments/big.bin", a.buffer); return await SY();`);
		const bigSrv = mock.files.get("/Vault/attachments/big.bin");
		check("upload: 5 MB file", !!bigSrv && bigSrv.data.length === big.length && bigSrv.data[123457] === big[123457]);

		// --- 9. mass deletion guard
		console.log("· 9. mass deletion guard");
		for (let i = 0; i < 25; i++) mock.put(`/Vault/bulk/n${i}.md`, "n" + i);
		await run(`return await SY();`);
		for (let i = 0; i < 25; i++) mock.remove(`/Vault/bulk/n${i}.md`);
		const guard = (labels: string[]) =>
			run<{ asked: boolean; left: number }>(`
			for (let i = 0; i < 50 && document.querySelector(".modal"); i++) await sleep(100);
			const p = P.sync("manual");
			let asked = false;
			for (let i = 0; i < 400; i++) { await sleep(150); const b = [...([...document.querySelectorAll(".modal")].pop()?.querySelectorAll("button") ?? [])].find((x) => ${JSON.stringify(labels)}.includes(x.textContent.trim())); if (b) { asked = true; b.click(); break; } }
			await p;
			return { asked, left: L().filter((x) => x.startsWith("bulk/")).length };`);
		const r9 = await guard(["Not now", "Не сейчас"]);
		check("deletion guard asks, “Not now” keeps files", r9.asked && r9.left === 25, r9);
		const r9b = await guard(["Delete", "Удалить"]);
		check("deletion guard: “Delete” applies", r9b.asked && r9b.left === 0, r9b);

		// --- 10. version history: restore an older version
		console.log("· 10. version history: restore an older version");
		mock.put("/Vault/Work/Plan.md", "- [x] one\n- [x] two\n");
		await run(`return await SY();`);
		const r10 = await run<string>(`
			const f = app.vault.getFileByPath("Work/Plan.md");
			await app.workspace.getLeaf().openFile(f);
			app.commands.executeCommandById("${ID}:version-history");
			await sleep(1000);
			const md = document.querySelector(".modal.seafile-sync-wide");
			const restore = [...md.querySelectorAll("button.mod-cta")];
			restore[restore.length - 1].click();
			await sleep(1500);
			return await Rd("Work/Plan.md");`);
		check("history: older version restored", r10 === "- [x] one\n- [ ] two\n", r10); // the version before the server edit

		// --- 11. trash: bring back a deleted file
		console.log("· 11. trash: bring back a deleted file");
		await run(`await D("Заметки/Привет мир.md"); return await SY();`);
		const r11 = await run<string | null>(`
			app.commands.executeCommandById("${ID}:restore-deleted");
			await sleep(1200);
			const md = document.querySelector(".modal.seafile-sync-wide");
			const row = [...md.querySelectorAll(".seafile-sync-trash .setting-item")].find((r) => r.textContent.includes("Привет мир.md"));
			row.querySelector(".checkbox-container").click();
			md.querySelector(".modal-button-container button.mod-cta").click();
			await sleep(2000);
			return await Rd("Заметки/Привет мир.md");`);
		check("trash: file restored", r11 === "юникод ✓", r11);

		// --- 12. explorer badge and share link
		console.log("· 12. explorer badge and share link");
		const r12 = await run<{ pending: boolean; afterSync: boolean; notice: string }>(`
			app.workspace.leftSplit?.expand?.(); // phones keep the file list in a closed drawer
			await sleep(600);
			await W("Draft.md", "not synced yet");
			await sleep(1200);
			const el = () => document.querySelector('.nav-file-title[data-path="Draft.md"]');
			const pending = !!el() && el().classList.contains("seafile-sync-pending");
			await SY();
			await sleep(800);
			const afterSync = !!el() && el().classList.contains("seafile-sync-pending");
			if (app.isMobile) app.workspace.leftSplit?.collapse?.();
			await P.copyShareLink(app.vault.getFileByPath("Draft.md"));
			const n = [...document.querySelectorAll(".notice")].map((x) => x.textContent).filter((t) => t.includes("🔗")).pop() || "";
			return { pending, afterSync, notice: n };`);
		check("explorer: pending dot until synced", r12.pending && !r12.afterSync, r12);
		check("share link created", r12.notice.includes("https://cloud.example.com/f/"), r12.notice);

		// --- 13. only some folders + a second library
		console.log("· 13. only some folders + a second library");
		await run(`P.settings.onlyFolders = "Work"; P.settings.extraLibraries = [{ local: "Team", repoId: "repo-1", repoName: "Notes", remote: "Team" }]; await P.saveSettings(); await W("attachments/new.txt", "x"); await W("Team/shared.md", "team"); return await SY();`);
		check("only-folders: other folders not uploaded", !mock.files.has("/Vault/attachments/new.txt"));
		check("second library: folder synced to its own place", text("/Team/shared.md") === "team" && !mock.files.has("/Vault/Team/shared.md"));
		const kept = await run<boolean>(`return L().includes("attachments/pic.png");`);
		check("only-folders: nothing deleted locally", kept);
		await run(`P.settings.onlyFolders = ""; P.settings.extraLibraries = []; await P.saveSettings(); return await SY();`);
		check("only-folders off: catches up", text("/Vault/attachments/new.txt") === "x");

		// --- 14. idle sync is quick
		console.log("· 14. idle sync is quick");
		const t0 = Date.now();
		const idle = await run<string>(`return await SY();`);
		check("idle sync: nothing to do", /up to date|актуально/.test(idle) && Date.now() - t0 < 5000, idle);

}
