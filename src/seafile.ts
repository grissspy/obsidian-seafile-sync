import { RemoteEntry, RemoteFS } from "./types";
import { normalizeRel } from "./util";

export interface HttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}

export interface HttpResponse {
	status: number;
	text: string;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export class SeafileError extends Error {
	constructor(message: string, public status: number) {
		super(message);
	}
}

/** Parse JSON from the server into a declared shape (callers validate fields they rely on). */
function parse<T>(text: string): T {
	return JSON.parse(text) as T;
}

interface ApiError {
	error_msg?: string;
	detail?: string;
	non_field_errors?: string[];
}

interface RepoJson {
	id: string;
	name: string;
	encrypted?: boolean | number;
	permission: string;
	root?: string;
	head_commit_id?: string;
}

export interface DirEntry {
	type: "file" | "dir";
	name: string;
	id: string;
	size?: number;
	mtime?: number;
	parent_dir?: string;
}

export interface Library {
	id: string;
	name: string;
	encrypted: boolean;
	permission: string;
}

function form(fields: Record<string, string>): string {
	return Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

/** Low-level Seafile Web API (api2) client. */
export class SeafileApi {
	readonly server: string;

	constructor(private http: Http, server: string, private token: string, private rewriteFileServer = false) {
		this.server = server.trim().replace(/\/+$/, "");
	}

	static async login(http: Http, server: string, username: string, password: string, otp?: string): Promise<string> {
		const headers: Record<string, string> = {};
		if (otp) headers["X-SEAFILE-OTP"] = otp;
		const res = await http({
			url: server.trim().replace(/\/+$/, "") + "/api2/auth-token/",
			method: "POST",
			headers,
			contentType: "application/x-www-form-urlencoded",
			body: form({ username, password }),
		});
		if (res.status !== 200) {
			let msg = res.text;
			try {
				const j = parse<ApiError>(res.text);
				msg = (j.non_field_errors && j.non_field_errors.join(" ")) || j.detail || res.text;
			} catch {
				/* keep raw */
			}
			if (res.headers["x-seafile-otp"] === "required") msg = "Two-factor code required";
			throw new SeafileError(`Login failed (${res.status}): ${msg}`, res.status);
		}
		return parse<{ token: string }>(res.text).token;
	}

	private async call(path: string, init: Omit<HttpRequest, "url"> = {}, okStatuses = [200, 201]): Promise<HttpResponse> {
		const res = await this.http({
			url: this.server + path,
			...init,
			headers: { Authorization: `Token ${this.token}`, Accept: "application/json", ...(init.headers || {}) },
		});
		if (!okStatuses.includes(res.status)) {
			let detail = res.text?.slice(0, 300) ?? "";
			try {
				const j = parse<ApiError>(res.text);
				detail = j.error_msg || j.detail || detail;
			} catch {
				/* not json */
			}
			throw new SeafileError(`${init.method || "GET"} ${path.split("?")[0]} → ${res.status} ${detail}`, res.status);
		}
		return res;
	}

	private fixUrl(url: string): string {
		if (!this.rewriteFileServer) return url;
		try {
			const u = new URL(url);
			const s = new URL(this.server);
			u.protocol = s.protocol;
			u.host = s.host;
			return u.toString();
		} catch {
			return url;
		}
	}

	/** Seafile server version, e.g. "11.0.13" (no auth needed). */
	async serverVersion(): Promise<string> {
		const res = await this.http({ url: this.server + "/api2/server-info/", method: "GET" });
		if (res.status !== 200) throw new SeafileError(`server-info → ${res.status}`, res.status);
		return String(parse<{ version?: string }>(res.text).version ?? "?");
	}

	async ping(): Promise<void> {
		await this.call("/api2/auth/ping/");
	}

	async listLibraries(): Promise<Library[]> {
		const res = await this.call("/api2/repos/");
		return parse<RepoJson[]>(res.text).map((r) => ({ id: r.id, name: r.name, encrypted: !!r.encrypted, permission: r.permission }));
	}

	async repoInfo(repo: string): Promise<{ root: string | null; encrypted: boolean; name: string; permission: string }> {
		const res = await this.call(`/api2/repos/${repo}/`);
		const j = parse<RepoJson>(res.text);
		return { root: j.root || j.head_commit_id || null, encrypted: !!j.encrypted, name: j.name, permission: j.permission };
	}

	async setRepoPassword(repo: string, password: string): Promise<void> {
		await this.call(`/api2/repos/${repo}/?op=setpassword`, {
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: form({ password }),
		});
	}

	/** Raw entries of one folder (non-recursive). */
	async listDir(repo: string, absPath: string, recursive = false): Promise<DirEntry[]> {
		const q = `p=${encodeURIComponent(absPath)}${recursive ? "&recursive=1" : ""}`;
		const res = await this.call(`/api2/repos/${repo}/dir/?${q}`, {}, [200]);
		return parse<DirEntry[]>(res.text);
	}

	async dirExists(repo: string, absPath: string): Promise<boolean> {
		try {
			await this.listDir(repo, absPath);
			return true;
		} catch (e) {
			if (e instanceof SeafileError && e.status === 404) return false;
			throw e;
		}
	}

	async mkdirs(repo: string, absPath: string): Promise<void> {
		await this.call(`/api2/repos/${repo}/dir/?p=${encodeURIComponent(absPath)}`, {
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: form({ operation: "mkdir", create_parents: "true" }),
		});
	}

	/** Object id of a file, or null if missing. */
	async fileId(repo: string, absPath: string): Promise<string | null> {
		const res = await this.call(`/api2/repos/${repo}/file/detail/?p=${encodeURIComponent(absPath)}`, {}, [200, 404]);
		if (res.status === 404) return null;
		return parse<{ id?: string }>(res.text).id ?? null;
	}

	async downloadLink(repo: string, absPath: string): Promise<string> {
		const res = await this.call(`/api2/repos/${repo}/file/?p=${encodeURIComponent(absPath)}&reuse=1`);
		return this.fixUrl(parse<string>(res.text));
	}

	async fetchUrl(url: string): Promise<ArrayBuffer> {
		const res = await this.http({ url, method: "GET" });
		if (res.status !== 200) throw new SeafileError(`Download failed → ${res.status}`, res.status);
		return res.arrayBuffer;
	}

	async uploadLink(repo: string, absDir: string): Promise<string> {
		const res = await this.call(`/api2/repos/${repo}/upload-link/?p=${encodeURIComponent(absDir)}`);
		return this.fixUrl(parse<string>(res.text));
	}

	/** Multipart upload (replace=1). Returns the uploaded file's object id. */
	async uploadTo(link: string, parentDir: string, relativeDir: string, fileName: string, data: ArrayBuffer): Promise<{ id: string; name: string }> {
		const boundary = "----SeafileVaultSync" + Math.random().toString(16).slice(2);
		const enc = new TextEncoder();
		const parts: Uint8Array[] = [];
		const field = (name: string, value: string) =>
			parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
		field("parent_dir", parentDir);
		if (relativeDir) field("relative_path", relativeDir);
		field("replace", "1");
		const safeName = fileName.replace(/"/g, "%22").replace(/\r|\n/g, "");
		parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
		parts.push(new Uint8Array(data));
		parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
		const total = parts.reduce((n, p) => n + p.byteLength, 0);
		const body = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			body.set(p, off);
			off += p.byteLength;
		}
		const url = link + (link.includes("?") ? "&" : "?") + "ret-json=1";
		const res = await this.http({
			url,
			method: "POST",
			contentType: `multipart/form-data; boundary=${boundary}`,
			body: body.buffer,
			headers: { Authorization: `Token ${this.token}` },
		});
		if (res.status !== 200) throw new SeafileError(`Upload failed → ${res.status} ${res.text?.slice(0, 200)}`, res.status);
		const j = parse<{ id: string; name: string } | { id: string; name: string }[]>(res.text);
		const item = Array.isArray(j) ? j[0] : j;
		return { id: item.id, name: item.name };
	}

	async deleteFile(repo: string, absPath: string): Promise<void> {
		await this.call(`/api2/repos/${repo}/file/?p=${encodeURIComponent(absPath)}`, { method: "DELETE" }, [200, 404]);
	}

	async deleteDir(repo: string, absPath: string): Promise<void> {
		await this.call(`/api2/repos/${repo}/dir/?p=${encodeURIComponent(absPath)}`, { method: "DELETE" }, [200, 404]);
	}
}

/** RemoteFS view of one folder inside a Seafile library. */
export class SeafileRemote implements RemoteFS {
	private base: string; // absolute, "/" or "/a/b"
	private uploadLinkCache: { url: string; at: number } | null = null;

	constructor(private api: SeafileApi, private repo: string, baseFolder: string, private repoPassword?: string) {
		const b = normalizeRel(baseFolder);
		this.base = b ? "/" + b : "/";
	}

	private abs(rel: string): string {
		return this.base === "/" ? "/" + rel : this.base + "/" + rel;
	}

	private rel(abs: string): string {
		const a = abs.replace(/\/+$/, "");
		if (this.base === "/") return a.replace(/^\//, "");
		if (a === this.base) return "";
		return a.startsWith(this.base + "/") ? a.slice(this.base.length + 1) : a.replace(/^\//, "");
	}

	private token: string | null = null;

	/** One request: checks encryption and remembers the library's change token. */
	async prepare(): Promise<void> {
		const info = await this.api.repoInfo(this.repo);
		if (info.encrypted) {
			if (!this.repoPassword) throw new Error("The library is encrypted: enter its password in the plugin settings.");
			await this.api.setRepoPassword(this.repo, this.repoPassword);
		}
		this.token = info.root;
	}

	async changeToken(): Promise<string | null> {
		return this.token;
	}

	async list(): Promise<{ files: RemoteEntry[]; dirs: string[] }> {
		const files: RemoteEntry[] = [];
		const dirs: string[] = [];
		const add = (e: DirEntry, parentAbs: string) => {
			// Never trust names from the server blindly: a hostile or broken server must not
			// make us write outside the vault ("..", absolute paths, path separators).
			const name = String(e.name ?? "");
			if (typeof e.id !== "string") return;
			if (!name || name === "." || name === ".." || /[\\/\u0000]/.test(name)) return;
			const parentRel = this.rel(parentAbs);
			if (parentRel.split("/").some((seg) => seg === ".." || seg === ".")) return;
			const p = parentRel ? parentRel + "/" + e.name : e.name;
			if (e.type === "dir") dirs.push(p);
			else files.push({ path: p, size: e.size ?? 0, mtime: (e.mtime ?? 0) * 1000, id: e.id });
		};

		let entries: DirEntry[] | null = null;
		try {
			entries = await this.api.listDir(this.repo, this.base, true);
		} catch (e) {
			if (e instanceof SeafileError && e.status === 404) {
				// Base folder does not exist yet: create it so uploads have a parent.
				if (this.base !== "/") await this.api.mkdirs(this.repo, this.base);
				return { files, dirs };
			}
			entries = null; // fall back to walking
		}
		if (entries && entries.every((e) => typeof e.parent_dir === "string")) {
			for (const e of entries) add(e, e.parent_dir ?? this.base);
			return { files, dirs };
		}
		// Fallback for servers without recursive listing: breadth-first walk.
		const queue = [this.base];
		while (queue.length) {
			const d = queue.shift()!;
			const list = await this.api.listDir(this.repo, d, false);
			for (const e of list) {
				add(e, d);
				if (e.type === "dir") queue.push(d === "/" ? "/" + e.name : d + "/" + e.name);
			}
		}
		return { files, dirs };
	}

	stat(path: string): Promise<string | null> {
		return this.api.fileId(this.repo, this.abs(path));
	}

	async download(path: string): Promise<ArrayBuffer> {
		const link = await this.api.downloadLink(this.repo, this.abs(path));
		return this.api.fetchUrl(link);
	}

	private async getUploadLink(force = false): Promise<string> {
		// Upload tokens are reusable but expire; refresh every 20 minutes.
		if (!force && this.uploadLinkCache && Date.now() - this.uploadLinkCache.at < 20 * 60 * 1000) return this.uploadLinkCache.url;
		const url = await this.api.uploadLink(this.repo, this.base);
		this.uploadLinkCache = { url, at: Date.now() };
		return url;
	}

	async upload(path: string, data: ArrayBuffer): Promise<string> {
		const slash = path.lastIndexOf("/");
		const relDir = slash >= 0 ? path.slice(0, slash) : "";
		const name = path.slice(slash + 1);
		let attempt = 0;
		while (true) {
			try {
				const link = await this.getUploadLink(attempt > 0);
				const r = await this.api.uploadTo(link, this.base, relDir, name, data);
				if (r.name && r.name !== name) {
					throw new Error(`Server stored "${path}" as "${r.name}" (server too old for replace=1?)`);
				}
				return r.id;
			} catch (e) {
				if (attempt++ >= 1 || !(e instanceof SeafileError)) throw e;
			}
		}
	}

	async deleteFile(path: string): Promise<void> {
		await this.api.deleteFile(this.repo, this.abs(path));
	}

	async deleteDir(path: string): Promise<void> {
		await this.api.deleteDir(this.repo, this.abs(path));
	}

	async mkdir(path: string): Promise<void> {
		await this.api.mkdirs(this.repo, this.abs(path));
	}
}
