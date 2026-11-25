// In-memory fakes: a Seafile server speaking the api2 HTTP protocol, and a local vault.
import { Http, HttpResponse } from "../src/seafile";
import { BaseStore, LocalEntry, LocalFS } from "../src/types";
import { dirname, sha256 } from "../src/util";

const enc = new TextEncoder();
const dec = new TextDecoder();

function resp(status: number, body: string | ArrayBuffer, headers: Record<string, string> = {}): HttpResponse {
	const ab = typeof body === "string" ? enc.encode(body).buffer : body;
	return { status, headers, text: typeof body === "string" ? body : dec.decode(body), arrayBuffer: ab as ArrayBuffer };
}

export class MockSeafile {
	files = new Map<string, { data: Uint8Array; id: string; mtime: number }>(); // abs path
	dirs = new Set<string>(["/"]);
	version = 1;
	private idSeq = 0;
	requests: string[] = [];
	readonly repo = "repo-1";

	private touch() {
		this.version++;
	}

	private mkdirs(p: string) {
		while (p && p !== "/") {
			this.dirs.add(p);
			p = p.slice(0, p.lastIndexOf("/")) || "/";
		}
	}

	put(abs: string, text: string) {
		this.mkdirs(abs.slice(0, abs.lastIndexOf("/")) || "/");
		this.files.set(abs, { data: enc.encode(text), id: "f" + ++this.idSeq, mtime: Math.floor(Date.now() / 1000) });
		this.touch();
	}

	get(abs: string): string | undefined {
		const f = this.files.get(abs);
		return f ? dec.decode(f.data) : undefined;
	}

	/** Test hook: called for every request before it is handled (simulate another device). */
	onRequest: ((method: string, path: string, p: string | null) => void) | null = null;

	http: Http = async (req) => {
		const u = new URL(req.url);
		const m = req.method || "GET";
		this.onRequest?.(m, u.pathname, u.searchParams.get("p"));
		this.requests.push(`${m} ${u.pathname}`);
		const p = u.searchParams.get("p");
		const auth = req.headers?.Authorization;
		if (u.host === "seaf.test" && u.pathname !== "/api2/auth-token/" && auth !== "Token T") return resp(401, '{"detail":"bad token"}');

		if (u.pathname === "/api2/auth-token/") {
			const f = new URLSearchParams(req.body as string);
			return f.get("password") === "pw" ? resp(200, '{"token":"T"}') : resp(400, '{"non_field_errors":["bad"]}');
		}
		if (u.pathname === "/api2/repos/") return resp(200, JSON.stringify([{ id: this.repo, name: "Notes", encrypted: false, permission: "rw" }]));
		if (u.pathname === `/api2/repos/${this.repo}/`) return resp(200, JSON.stringify({ id: this.repo, root: "root" + this.version, encrypted: false }));

		if (u.pathname === `/api2/repos/${this.repo}/dir/`) {
			if (m === "GET") {
				if (!p || !this.dirs.has(p)) return resp(404, '{"error_msg":"Folder not found"}');
				const rec = u.searchParams.get("recursive") === "1";
				const out: any[] = [];
				const pre = p === "/" ? "/" : p + "/";
				for (const d of this.dirs) {
					if (d === "/" || !d.startsWith(pre)) continue;
					const rest = d.slice(pre.length);
					if (!rec && rest.includes("/")) continue;
					out.push({ type: "dir", name: rest.slice(rest.lastIndexOf("/") + 1), id: "d", mtime: 0, parent_dir: rec ? dirname(d) || "/" : undefined });
				}
				for (const [fp, f] of this.files) {
					if (!fp.startsWith(pre)) continue;
					const rest = fp.slice(pre.length);
					if (!rec && rest.includes("/")) continue;
					out.push({ type: "file", name: rest.slice(rest.lastIndexOf("/") + 1), id: f.id, size: f.data.length, mtime: f.mtime, parent_dir: rec ? dirname(fp) || "/" : undefined });
				}
				for (const o of out) if (o.parent_dir === undefined) delete o.parent_dir;
				return resp(200, JSON.stringify(out));
			}
			if (m === "POST") {
				const f = new URLSearchParams(req.body as string);
				if (f.get("operation") !== "mkdir" || f.get("create_parents") !== "true") return resp(400, "bad");
				this.mkdirs(p!);
				this.touch();
				return resp(201, '"success"');
			}
			if (m === "DELETE") {
				const pre = p + "/";
				for (const k of [...this.files.keys()]) if (k.startsWith(pre)) this.files.delete(k);
				for (const k of [...this.dirs]) if (k === p || k.startsWith(pre)) this.dirs.delete(k);
				this.touch();
				return resp(200, '"success"');
			}
		}
		if (u.pathname === `/api2/repos/${this.repo}/file/`) {
			if (m === "GET") {
				if (!this.files.has(p!)) return resp(404, '{"error_msg":"File not found"}');
				return resp(200, JSON.stringify(`http://fs.test/seafhttp/files/x${encodeURIComponent(p!)}`));
			}
			if (m === "DELETE") {
				this.files.delete(p!);
				this.touch();
				return resp(200, '"success"');
			}
		}
		if (u.pathname === `/api2/repos/${this.repo}/file/detail/`) {
			const f = this.files.get(p!);
			return f ? resp(200, JSON.stringify({ id: f.id, size: f.data.length, mtime: f.mtime })) : resp(404, '{"error_msg":"File not found"}');
		}
		if (u.pathname === `/api2/repos/${this.repo}/upload-link/`) return resp(200, JSON.stringify("http://fs.test/seafhttp/upload-api/tok"));

		if (u.host === "fs.test" && u.pathname.startsWith("/seafhttp/files/x")) {
			const abs = decodeURIComponent(u.pathname.slice("/seafhttp/files/x".length));
			const f = this.files.get(abs);
			if (!f) return resp(404, "nf");
			return resp(200, f.data.slice().buffer as ArrayBuffer);
		}
		if (u.host === "fs.test" && u.pathname === "/seafhttp/upload-api/tok" && m === "POST") {
			if (u.searchParams.get("ret-json") !== "1") return resp(400, "need ret-json");
			const fields = parseMultipart(req.contentType!, new Uint8Array(req.body as ArrayBuffer));
			if (fields.replace?.text !== "1") return resp(400, "need replace");
			const parent = fields.parent_dir.text!;
			const rel = fields.relative_path?.text || "";
			const name = fields.file.filename!;
			let dir = parent.replace(/\/$/, "");
			if (rel) dir += "/" + rel;
			if (!dir) dir = "/";
			const abs = (dir === "/" ? "" : dir) + "/" + name;
			this.mkdirs(dir);
			this.files.set(abs, { data: fields.file.data, id: "f" + ++this.idSeq, mtime: Math.floor(Date.now() / 1000) });
			this.touch();
			return resp(200, JSON.stringify([{ name, id: this.files.get(abs)!.id, size: fields.file.data.length }]));
		}
		return resp(500, `mock: unhandled ${m} ${req.url}`);
	};
}

function parseMultipart(ct: string, body: Uint8Array): Record<string, { text?: string; filename?: string; data: Uint8Array }> {
	const boundary = "--" + /boundary=(.+)$/.exec(ct)![1];
	const b = enc.encode(boundary);
	const out: Record<string, { text?: string; filename?: string; data: Uint8Array }> = {};
	const idx: number[] = [];
	outer: for (let i = 0; i <= body.length - b.length; i++) {
		for (let j = 0; j < b.length; j++) if (body[i + j] !== b[j]) continue outer;
		idx.push(i);
	}
	for (let k = 0; k < idx.length - 1; k++) {
		const part = body.slice(idx[k] + b.length + 2, idx[k + 1] - 2);
		let h = 0;
		while (!(part[h] === 13 && part[h + 1] === 10 && part[h + 2] === 13 && part[h + 3] === 10)) h++;
		const head = dec.decode(part.slice(0, h));
		const data = part.slice(h + 4);
		const name = /name="([^"]+)"/.exec(head)![1];
		const fn = /filename="([^"]*)"/.exec(head);
		out[name] = { data, filename: fn ? fn[1] : undefined, text: fn ? undefined : dec.decode(data) };
	}
	return out;
}

export class MemLocal implements LocalFS {
	files = new Map<string, { data: Uint8Array; mtime: number }>();
	dirs = new Set<string>();
	clock = 1_000_000;

	private mk(dir: string) {
		while (dir) {
			this.dirs.add(dir);
			dir = dirname(dir);
		}
	}
	set(path: string, text: string) {
		this.mk(dirname(path));
		this.files.set(path, { data: enc.encode(text), mtime: (this.clock += 1000) });
	}
	text(path: string): string | undefined {
		const f = this.files.get(path);
		return f ? dec.decode(f.data) : undefined;
	}
	async list() {
		return {
			files: [...this.files].map(([path, f]) => ({ path, size: f.data.length, mtime: f.mtime })),
			dirs: [...this.dirs],
		};
	}
	async stat(path: string): Promise<LocalEntry | null> {
		const f = this.files.get(path);
		return f ? { path, size: f.data.length, mtime: f.mtime } : null;
	}
	async read(path: string) {
		const f = this.files.get(path);
		if (!f) throw new Error("ENOENT " + path);
		return f.data.slice().buffer as ArrayBuffer;
	}
	/** Test hook: runs right before replace/deleteIf checks (simulates the user typing). */
	beforeWrite: ((path: string) => void) | null = null;
	private async hashOf(path: string) {
		const f = this.files.get(path);
		return f ? sha256(f.data.slice().buffer as ArrayBuffer) : null;
	}
	async replace(path: string, data: ArrayBuffer, expect: string | null) {
		this.beforeWrite?.(path);
		if ((await this.hashOf(path)) !== expect) return false;
		this.mk(dirname(path));
		this.files.set(path, { data: new Uint8Array(data.slice(0)), mtime: (this.clock += 1000) });
		return true;
	}
	async deleteIf(path: string, expect: string) {
		this.beforeWrite?.(path);
		const h = await this.hashOf(path);
		if (h === null) return true;
		if (h !== expect) return false;
		this.files.delete(path);
		return true;
	}
	async mkdir(path: string) {
		this.mk(path);
	}
	async rmdirIfEmpty(path: string) {
		const pre = path + "/";
		if ([...this.files.keys()].some((k) => k.startsWith(pre)) || [...this.dirs].some((d) => d.startsWith(pre))) return false;
		this.dirs.delete(path);
		return true;
	}
}

export class MemBases implements BaseStore {
	m = new Map<string, string>();
	async get(h: string) {
		return this.m.get(h) ?? null;
	}
	async put(h: string, t: string) {
		this.m.set(h, t);
	}
	async gc(keep: Set<string>) {
		for (const k of [...this.m.keys()]) if (!keep.has(k)) this.m.delete(k);
	}
}
