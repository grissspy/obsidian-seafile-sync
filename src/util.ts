export async function sha256(data: ArrayBuffer): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(buf);
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
	return s;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

export function toText(data: ArrayBuffer): string {
	return dec.decode(data);
}

export function fromText(s: string): ArrayBuffer {
	const u = enc.encode(s);
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

/** Heuristic: valid UTF-8 without NUL bytes. */
export function looksLikeText(data: ArrayBuffer): boolean {
	const u = new Uint8Array(data);
	for (let i = 0; i < Math.min(u.length, 8000); i++) if (u[i] === 0) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(u);
		return true;
	} catch {
		return false;
	}
}

export function extOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const i = name.lastIndexOf(".");
	return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function parentDirs(path: string): string[] {
	const out: string[] = [];
	let d = dirname(path);
	while (d) {
		out.push(d);
		d = dirname(d);
	}
	return out;
}

export function normalizeRel(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Run `fn` over items with bounded concurrency. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
	let next = 0;
	const workers: Promise<void>[] = [];
	const n = Math.max(1, Math.min(limit, items.length));
	for (let w = 0; w < n; w++) {
		workers.push(
			(async () => {
				while (true) {
					const i = next++;
					if (i >= items.length) return;
					await fn(items[i], i);
				}
			})()
		);
	}
	await Promise.all(workers);
}

/**
 * Minimal glob → RegExp. Supports `**` (any depth), `*` (within a segment), `?`.
 * A pattern without "/" matches the name at any depth (like .gitignore).
 * A pattern ending in "/" matches a folder and everything inside it.
 */
export function globToRegExp(glob: string): RegExp {
	let g = glob.trim().replace(/\\/g, "/");
	let dirOnly = false;
	if (g.endsWith("/")) {
		dirOnly = true;
		g = g.slice(0, -1);
	}
	const anchored = g.includes("/");
	g = g.replace(/^\//, "");
	let re = "";
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*") {
			if (g[i + 1] === "*") {
				i++;
				if (g[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else re += ".*";
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	const prefix = anchored ? "^" : "^(?:.*/)?";
	const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
	return new RegExp(prefix + re + suffix);
}

export function formatConflictName(path: string, device: string, when: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
	const safeDevice = device.replace(/[\\/:*?"<>|]/g, "-").trim() || "device";
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	return `${dir}${base} (conflict ${safeDevice} ${stamp})${ext}`;
}

/** Inverse of formatConflictName: the original path and device, or null if not a conflict copy. */
export function parseConflictName(path: string): { original: string; device: string } | null {
	const m = /^(.*) \(conflict (.+) \d{4}-\d{2}-\d{2} \d{6}\)(\.[^./]*)?$/.exec(path);
	if (!m) return null;
	return { original: m[1] + (m[3] ?? ""), device: m[2] };
}
