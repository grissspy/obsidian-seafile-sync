import { merge3 } from "../src/merge";
import { SeafileApi, SeafileRemote } from "../src/seafile";
import { emptyState, SyncEngine } from "../src/sync";
import { ConflictStrategy, SyncState } from "../src/types";
import { formatConflictName, globToRegExp, parseConflictName } from "../src/util";
import { PrefixLocal } from "../src/prefix";
import { LocalFS } from "../src/types";
import { MemBases, MemLocal, MockSeafile } from "./mock";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (cond) passes++;
	else {
		failures++;
		console.log("FAIL:", name, extra !== undefined ? JSON.stringify(extra) : "");
	}
}

class Device {
	local = new MemLocal();
	bases = new MemBases();
	state: SyncState = emptyState("t");
	logs: string[] = [];
	deleteAnswer: "delete" | "restore" | "skip" = "delete";
	asked = 0;
	maxFileSize = 0;
	view: LocalFS | null = null;
	constructor(public name: string, public server: MockSeafile, public conflict: ConflictStrategy = "merge", public folder = "Vault", public ignore: string[] = []) {}

	async sync() {
		const api = new SeafileApi(this.server.http, "https://seaf.test/", "T");
		const remote = new SeafileRemote(api, this.server.repo, this.folder);
		await remote.prepare();
		const res = new RegExpList(this.ignore);
		const self = this;
		const eng = new SyncEngine(this.view ?? this.local, remote, this.bases, this.state, {
			conflict: this.conflict,
			deviceName: this.name,
			mergeExtensions: ["md", "txt"],
			maxFileSize: this.maxFileSize,
			filterKey: this.ignore.join("\n") + "|" + this.maxFileSize,
			concurrency: 3,
			syncEmptyDirs: true,
			deleteThreshold: 5,
			isIgnored: (p) => res.test(p),
			confirmDeletes: async () => {
				this.asked++;
				return this.deleteAnswer;
			},
			log: (m) => this.logs.push(m),
			saveState: async (s) => {
				this.state = JSON.parse(JSON.stringify(s));
			},
		});
		const r = await eng.run();
		if (r.errors.length) console.log(this.name, "errors:", r.errors);
		return r;
	}
}

class RegExpList {
	res: RegExp[];
	constructor(globs: string[]) {
		this.res = globs.map(globToRegExp);
	}
	test(p: string) {
		return this.res.some((r) => r.test(p));
	}
}

async function main() {
	// ---------------- merge3
	check("merge: disjoint edits", merge3("a\nb\nc\nd\ne", "A\nb\nc\nd\ne", "a\nb\nc\nd\nE") === "A\nb\nc\nd\nE");
	check("merge: same edit", merge3("a\nb", "a\nX", "a\nX") === "a\nX");
	check("merge: overlap → null", merge3("a\nb\nc", "a\nX\nc", "a\nY\nc") === null);
	check("merge: both append different → null", merge3("a", "a\nx", "a\ny") === null);
	check("merge: insert top & bottom", merge3("m\nn\no", "top\nm\nn\no", "m\nn\no\nbottom") === "top\nm\nn\no\nbottom");
	check("merge: delete vs edit elsewhere", merge3("1\n2\n3\n4\n5", "1\n3\n4\n5", "1\n2\n3\n4\nfive") === "1\n3\n4\nfive");
	const big = Array.from({ length: 3000 }, (_, i) => "line " + i).join("\n");
	const bl = big.replace("line 10\n", "line ten\n");
	const br = big.replace("line 2900\n", "line 2900\nextra\n");
	check("merge: large file", merge3(big, bl, br) === big.replace("line 10\n", "line ten\n").replace("line 2900\n", "line 2900\nextra\n"));

	// ---------------- glob
	const g = (pat: string, p: string) => globToRegExp(pat).test(p);
	check("glob name anywhere", g(".DS_Store", "a/b/.DS_Store") && g(".DS_Store", ".DS_Store"));
	check("glob dir/", g(".trash/", ".trash/x.md") && !g(".trash/", ".trash") && !g(".trash/", "a.trash/x"));
	check("glob anchored", g(".obsidian/workspace.json", ".obsidian/workspace.json") && !g(".obsidian/workspace.json", "x/.obsidian/workspace.json"));
	check("glob star", g("*.tmp", "a/b.tmp") && !g("*.tmp", "a/b.tmpx"));
	check("glob **", g("att/**/*.pdf", "att/x/y/z.pdf") && g("att/**/*.pdf", "att/z.pdf"));
	check("glob folder name matches content", g(".git", ".git/config"));

	// ---------------- API: login, libraries
	const server = new MockSeafile();
	check("login ok", (await SeafileApi.login(server.http, "https://seaf.test", "u", "pw")) === "T");
	let loginErr = "";
	try {
		await SeafileApi.login(server.http, "https://seaf.test", "u", "nope");
	} catch (e) {
		loginErr = (e as Error).message;
	}
	check("login bad", loginErr.includes("bad"), loginErr);
	const libs = await new SeafileApi(server.http, "https://seaf.test", "T").listLibraries();
	check("libraries", libs.length === 1 && libs[0].name === "Notes");

	// ---------------- two devices
	const A = new Device("PC", server);
	const B = new Device("Phone", server);
	A.local.set("note.md", "hello\nworld\n");
	A.local.set("dir/sub/deep.md", "deep");
	A.local.set("img/pic.png", "\u0000binary\u0001");
	A.local.set("Заметки/Привет мир.md", "юникод");
	A.local.dirs.add("empty-folder");
	let r = await A.sync();
	check("A initial upload", r.uploaded === 4, r);
	check("remote has files", server.get("/Vault/note.md") === "hello\nworld\n" && server.get("/Vault/Заметки/Привет мир.md") === "юникод");
	check("remote has empty folder", server.dirs.has("/Vault/empty-folder"));

	r = await B.sync();
	check("B initial download", r.downloaded === 4 && B.local.text("dir/sub/deep.md") === "deep", r);
	check("B got empty folder", B.local.dirs.has("empty-folder"));

	// No changes → skip by change token
	const before = server.requests.length;
	r = await A.sync();
	r = await A.sync();
	check("idle sync skipped", r.skipped, r);
	const reqs = server.requests.slice(before).filter((x) => x.includes("/dir/")).length;
	check("idle sync avoids listing", reqs <= 2, server.requests.slice(before));

	// Edit on A → B
	A.local.set("note.md", "hello\nworld\nfrom A\n");
	await A.sync();
	r = await B.sync();
	check("edit propagates", B.local.text("note.md") === "hello\nworld\nfrom A\n" && r.downloaded === 1, r);

	// Concurrent edits on different lines → merged
	A.local.set("note.md", "HELLO\nworld\nfrom A\n");
	B.local.set("note.md", "hello\nworld\nfrom A\nand B\n");
	await A.sync();
	r = await B.sync();
	check("merge on B", r.merged === 1 && B.local.text("note.md") === "HELLO\nworld\nfrom A\nand B\n", { r, t: B.local.text("note.md") });
	await A.sync();
	check("merge reaches A", A.local.text("note.md") === "HELLO\nworld\nfrom A\nand B\n", A.local.text("note.md"));

	// Same-line conflict → conflict copy, nothing lost
	A.local.set("note.md", "A wins?\n");
	B.local.set("note.md", "B wins?\n");
	await A.sync();
	r = await B.sync();
	check("conflict detected", r.conflicts === 1, r);
	const bFiles = [...B.local.files.keys()].filter((p) => p.startsWith("note"));
	const texts = bFiles.map((p) => B.local.text(p)).sort();
	check("conflict keeps both", bFiles.length === 2 && texts.join("|") === "A wins?\n|B wins?\n", bFiles);
	await A.sync();
	check("conflict copy reaches A", [...A.local.files.keys()].filter((p) => p.startsWith("note")).length === 2);
	r = await B.sync();
	r = await A.sync();
	check("stable after conflict", r.uploaded + r.downloaded === 0, r);

	// Delete on A → deleted on B
	A.local.files.delete("dir/sub/deep.md");
	await A.sync();
	check("remote delete", server.get("/Vault/dir/sub/deep.md") === undefined);
	r = await B.sync();
	check("delete propagates", !B.local.files.has("dir/sub/deep.md") && r.deletedLocal === 1, r);
	// folders dir/sub became empty: A still has them (empty), B too → they stay unless removed
	A.local.dirs.delete("dir/sub");
	A.local.dirs.delete("dir");
	await A.sync();
	await B.sync();
	check("folder delete propagates", !B.local.dirs.has("dir") && !server.dirs.has("/Vault/dir"), [...B.local.dirs]);

	// Edit vs delete → edit wins
	A.local.files.delete("img/pic.png");
	B.local.set("img/pic.png", "\u0000new binary");
	await A.sync();
	r = await B.sync();
	await A.sync();
	check("edit beats delete", A.local.text("img/pic.png") === "\u0000new binary", r);

	// New file both sides, identical → no conflict
	A.local.set("same.md", "identical");
	B.local.set("same.md", "identical");
	await A.sync();
	r = await B.sync();
	check("identical new files no conflict", r.conflicts === 0 && [...B.local.files.keys()].filter((p) => p.startsWith("same")).length === 1, r);

	// Mass deletion guard
	for (let i = 0; i < 8; i++) A.local.set(`bulk/${i}.md`, "x" + i);
	await A.sync();
	await B.sync();
	for (let i = 0; i < 8; i++) A.local.files.delete(`bulk/${i}.md`);
	A.deleteAnswer = "skip";
	await A.sync();
	check("guard asked", A.asked === 1);
	check("guard skip keeps remote", server.get("/Vault/bulk/3.md") === "x3");
	A.deleteAnswer = "restore";
	await A.sync();
	check("guard restore", A.local.text("bulk/3.md") === "x3");
	for (let i = 0; i < 8; i++) A.local.files.delete(`bulk/${i}.md`);
	A.deleteAnswer = "delete";
	await A.sync();
	await B.sync();
	check("guard delete", server.get("/Vault/bulk/3.md") === undefined && !B.local.files.has("bulk/3.md"));

	// Ignore patterns: ignored files neither uploaded nor deleted
	const C = new Device("Tablet", server, "merge", "Vault", [".trash/", "*.tmp"]);
	C.local.set(".trash/old.md", "trash");
	C.local.set("x.tmp", "tmp");
	await C.sync();
	check("ignored not uploaded", server.get("/Vault/.trash/old.md") === undefined && server.get("/Vault/x.tmp") === undefined);
	check("C got everything else", C.local.text("same.md") === "identical");

	// Remote changed by a third party (web UI) between syncs
	server.put("/Vault/web.md", "from web");
	await A.sync();
	check("web upload reaches A", A.local.text("web.md") === "from web");

	// Strategy: local / remote / newer
	const S = new MockSeafile();
	const L1 = new Device("L1", S, "local");
	const L2 = new Device("L2", S, "local");
	L1.local.set("f.md", "base");
	await L1.sync();
	await L2.sync();
	L1.local.set("f.md", "one");
	L2.local.set("f.md", "two");
	await L1.sync();
	await L2.sync();
	check("strategy local", S.get("/Vault/f.md") === "two");
	L2.conflict = "remote";
	L1.local.set("f.md", "uno");
	L2.local.set("f.md", "dos");
	await L1.sync();
	await L2.sync();
	check("strategy remote", L2.local.text("f.md") === "uno" && S.get("/Vault/f.md") === "uno");

	// Root folder (whole library) + upload to root works
	const R = new MockSeafile();
	const W = new Device("W", R, "merge", "");
	W.local.set("root.md", "r");
	W.local.set("a/b.md", "b");
	await W.sync();
	check("whole library sync", R.get("/root.md") === "r" && R.get("/a/b.md") === "b");

	// ================= Races and safety =================
	{
		const S2 = new MockSeafile();
		const P = new Device("P", S2);
		const Q = new Device("Q", S2);
		P.local.set("n.md", "1\n2\n3\n4\n5\n");
		await P.sync();
		await Q.sync();

		// (a) Another device uploads between our listing and our upload → no blind overwrite.
		P.local.set("n.md", "ONE\n2\n3\n4\n5\n");
		let fired = false;
		S2.onRequest = (m, path, p) => {
			if (!fired && path.endsWith("/file/detail/") && p === "/Vault/n.md") {
				fired = true;
				S2.put("/Vault/n.md", "1\n2\n3\n4\nFIVE\n"); // Q's edit lands right now
			}
		};
		await P.sync();
		S2.onRequest = null;
		check("race upload: merged, nothing lost", S2.get("/Vault/n.md") === "ONE\n2\n3\n4\nFIVE\n" && P.local.text("n.md") === "ONE\n2\n3\n4\nFIVE\n", { srv: S2.get("/Vault/n.md"), loc: P.local.text("n.md") });
		await Q.sync();

		// (b) User types while a download is about to overwrite the file.
		Q.local.set("n.md", Q.local.text("n.md")!); // no-op
		P.local.set("n.md", "ONE\n2\nthree\n4\nFIVE\n");
		await P.sync();
		Q.local.beforeWrite = (path) => {
			if (path === "n.md" && Q.local.text("n.md") === "ONE\n2\n3\n4\nFIVE\n") Q.local.set("n.md", "ONE\ntwo\n3\n4\nFIVE\n");
		};
		await Q.sync();
		Q.local.beforeWrite = null;
		check("race download: typing kept", Q.local.text("n.md") === "ONE\ntwo\n3\n4\nFIVE\n", Q.local.text("n.md"));
		await Q.sync();
		check("race download: merged next run", Q.local.text("n.md") === "ONE\ntwo\nthree\n4\nFIVE\n", Q.local.text("n.md"));
		await P.sync();
		check("race download: other side converges", P.local.text("n.md") === Q.local.text("n.md"));

		// (c) Remote edit lands right before we delete it on the server → not deleted.
		P.local.set("d.md", "keep me");
		await P.sync();
		await Q.sync();
		Q.local.files.delete("d.md");
		S2.onRequest = (m, path, p) => {
			if (path.endsWith("/file/detail/") && p === "/Vault/d.md") {
				S2.onRequest = null;
				S2.put("/Vault/d.md", "edited elsewhere");
			}
		};
		await Q.sync();
		check("race delete: server edit survives", S2.get("/Vault/d.md") === "edited elsewhere");
		await Q.sync();
		check("race delete: edit comes back", Q.local.text("d.md") === "edited elsewhere");

		// (d) Local edit right before a server-side deletion is applied locally → not deleted.
		await P.sync();
		P.local.files.delete("d.md");
		await P.sync();
		Q.local.beforeWrite = (path) => {
			if (path === "d.md") Q.local.set("d.md", "typed just now");
		};
		await Q.sync();
		Q.local.beforeWrite = null;
		check("race local delete: typing kept", Q.local.text("d.md") === "typed just now");
		await Q.sync();
		check("race local delete: re-uploaded", S2.get("/Vault/d.md") === "typed just now");

		// (e) File grows beyond the size limit → must not be deleted on the server.
		P.local.set("big.bin", "small");
		await P.sync();
		P.maxFileSize = 10;
		P.local.set("big.bin", "now it is much bigger than ten bytes");
		await P.sync();
		check("oversized not deleted on server", S2.get("/Vault/big.bin") === "small");
		await Q.sync();
		Q.maxFileSize = 10;
		S2.put("/Vault/big.bin", "server side grew too, way past the limit");
		await Q.sync();
		check("oversized not deleted locally", Q.local.text("big.bin") === "small");

		// (f) Case clash on the server → neither file deleted locally.
		S2.put("/Vault/Case.md", "upper");
		await Q.sync();
		S2.put("/Vault/case.md", "lower");
		const r2 = await Q.sync();
		check("case clash: local kept", Q.local.text("Case.md") === "upper" && r2.deletedLocal === 0, r2);
		S2.files.delete("/Vault/case.md");

		// (g) Type switched off, file removed locally, switched back on → re-downloaded, not deleted.
		P.local.set("pic.png", "PNG");
		await P.sync();
		await Q.sync();
		Q.ignore = ["*.png"];
		await Q.sync();
		Q.local.files.delete("pic.png");
		await Q.sync();
		Q.ignore = [];
		await Q.sync();
		check("re-enabled type downloads, server intact", S2.get("/Vault/pic.png") === "PNG" && Q.local.text("pic.png") === "PNG", { srv: S2.get("/Vault/pic.png"), loc: Q.local.text("pic.png"), log: Q.logs.slice(-6) });
	}

	// ---------------- conflict names
	{
		const n = formatConflictName("dir/My note.md", "Pixel 10", new Date(2026, 10, 25, 9, 5, 7));
		const p = parseConflictName(n);
		check("conflict name roundtrip", p?.original === "dir/My note.md" && p.device === "Pixel 10", { n, p });
		const n2 = formatConflictName("README", "server", new Date());
		check("conflict name no ext", parseConflictName(n2)?.original === "README", n2);
		check("not a conflict name", parseConflictName("dir/note.md") === null);
	}

	// ---------------- extra library: a vault folder synced to another place
	{
		const S3 = new MockSeafile();
		const W = new Device("PC", S3, "merge", "Other");
		W.local.set("main.md", "main vault note");
		W.local.set("Work/plan.md", "plan");
		W.local.set("Work/sub/x.md", "x");
		W.view = new PrefixLocal(W.local, "Work");
		const r = await W.sync();
		check("prefix: only folder uploaded", r.uploaded === 2 && S3.get("/Other/plan.md") === "plan" && S3.get("/Other/sub/x.md") === "x" && !S3.get("/Other/main.md"), r);
		const W2 = new Device("Phone", S3, "merge", "Other");
		W2.local.set("unrelated.md", "u");
		W2.view = new PrefixLocal(W2.local, "Team");
		await W2.sync();
		check("prefix: downloaded into folder", W2.local.text("Team/plan.md") === "plan" && W2.local.text("Team/sub/x.md") === "x" && W2.local.text("unrelated.md") === "u");
		W2.local.files.delete("Team/plan.md");
		await W2.sync();
		await W.sync();
		check("prefix: delete propagates, outside untouched", !W.local.text("Work/plan.md") && W.local.text("main.md") === "main vault note");
	}

	console.log(`\n${passes} passed, ${failures} failed`);
	if (failures) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
