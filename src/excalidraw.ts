// Merging Excalidraw drawings edited on two devices.
//
// A drawing (`.excalidraw.md`, or plain `.excalidraw` JSON) holds a list of elements. Every element
// has an id and a version that grows with each change; deleted elements stay as tombstones
// (isDeleted). Excalidraw's own collaboration merges scenes the same way: per element, the higher
// version wins (ties: the lower versionNonce). That merge needs no common ancestor and never mixes
// the inside of one element, so it is safe to run on both sides' latest files.
import { compressToBase64, decompressFromBase64 } from "lz-string";

interface El {
	id: string;
	type?: string;
	version?: number;
	versionNonce?: number;
	isDeleted?: boolean;
	text?: string;
	originalText?: string;
	rawText?: string;
}

interface Scene {
	elements: El[];
	files?: Record<string, unknown>;
	[k: string]: unknown;
}

const DRAWING_RE = /(##\s*Drawing\s*\n```(compressed-json|json)\n)([\s\S]*?)(\n```)/;

export function isExcalidraw(path: string): boolean {
	return /\.excalidraw(\.md)?$/i.test(path);
}

function compress(json: string): string {
	// Same layout as the Excalidraw plugin: base64 in 256-character chunks separated by blank lines.
	const c = compressToBase64(json);
	const parts: string[] = [];
	for (let i = 0; i < c.length; i += 256) parts.push(c.slice(i, i + 256));
	return parts.join("\n\n");
}

function decompress(data: string): string | null {
	return decompressFromBase64(data.replace(/[\r\n]/g, "")) || null;
}

interface Parsed {
	scene: Scene;
	/** Rebuild the file with a new scene (markdown) or the scene itself (plain JSON). */
	write(scene: Scene, textSection: string | null, filesSection: string | null): string;
	text: string;
}

function parse(text: string, md: boolean): Parsed | null {
	try {
		if (!md) {
			const scene = JSON.parse(text) as Scene;
			if (!Array.isArray(scene.elements)) return null;
			return { scene, text, write: (s) => JSON.stringify(s, null, "\t") };
		}
		const m = DRAWING_RE.exec(text);
		if (!m) return null;
		const json = m[2] === "json" ? m[3] : decompress(m[3]);
		if (!json) return null;
		const scene = JSON.parse(json) as Scene;
		if (!Array.isArray(scene.elements)) return null;
		return {
			scene,
			text,
			write: (s, textSection, filesSection) => {
				const body = m[2] === "json" ? JSON.stringify(s, null, "\t") : compress(JSON.stringify(s));
				let out = text.replace(DRAWING_RE, (_all, head: string, _kind: string, _old: string, tail: string) => head + body + tail);
				if (textSection !== null) out = replaceSection(out, "Text Elements", textSection);
				if (filesSection !== null) out = replaceSection(out, "Embedded Files", filesSection);
				return out;
			},
		};
	} catch {
		return null;
	}
}

/** Lines of a "## Name" section (up to the next heading or %% marker). */
function sectionLines(text: string, name: string): string[] | null {
	const re = new RegExp(`(^|\\n)## ${name}\\n([\\s\\S]*?)(?=\\n#{1,2} |\\n%%|$)`);
	const m = re.exec(text);
	return m ? m[2].split("\n") : null;
}

function replaceSection(text: string, name: string, body: string): string {
	const re = new RegExp(`((?:^|\\n)## ${name}\\n)([\\s\\S]*?)(?=\\n#{1,2} |\\n%%|$)`);
	return re.test(text) ? text.replace(re, (_a, head: string) => head + body) : text;
}

function newer(a: El, b: El): El {
	const va = a.version ?? 0;
	const vb = b.version ?? 0;
	if (va !== vb) return va > vb ? a : b;
	return (a.versionNonce ?? 0) <= (b.versionNonce ?? 0) ? a : b;
}

/**
 * Merge two versions of a drawing. Returns the merged file, or null when either side
 * can't be read as an Excalidraw drawing (the caller then keeps both versions).
 */
export function mergeExcalidraw(path: string, local: string, remote: string): string | null {
	const md = /\.md$/i.test(path);
	const L = parse(local, md);
	const R = parse(remote, md);
	if (!L || !R) return null;

	// Elements: union by id, newest version of each; keep the local order, then new remote ones.
	const fromRemote = new Set<string>();
	const rById = new Map(R.scene.elements.map((e) => [e.id, e]));
	const lIds = new Set(L.scene.elements.map((e) => e.id));
	const elements: El[] = [];
	for (const le of L.scene.elements) {
		const re = rById.get(le.id);
		const pick = re ? newer(le, re) : le;
		if (pick !== le) fromRemote.add(pick.id);
		elements.push(pick);
	}
	for (const re of R.scene.elements) {
		if (lIds.has(re.id)) continue;
		elements.push(re);
		fromRemote.add(re.id);
	}
	const files = { ...(R.scene.files ?? {}), ...(L.scene.files ?? {}) };
	const scene: Scene = { ...L.scene, elements, files };

	if (!md) return L.write(scene, null, null);

	// "## Text Elements": one line per live text element, "text ^id", taken from the side whose
	// version of the element won. This section is what the plugin reads text from, so it must match.
	let textSection: string | null = null;
	const lt = sectionLines(local, "Text Elements");
	const rt = sectionLines(remote, "Text Elements");
	if (lt && rt) {
		const lineFor = (lines: string[], id: string) => {
			const out: string[] = [];
			let cur: string[] = [];
			for (const line of lines) {
				cur.push(line);
				if (line.endsWith(` ^${id}`)) {
					out.push(...cur);
					break;
				}
				if (/ \^[\w-]+$/.test(line)) cur = [];
			}
			return out.length ? out.join("\n") : null;
		};
		const parts: string[] = [];
		for (const e of elements) {
			if (e.type !== "text" || e.isDeleted) continue;
			const own = lineFor(fromRemote.has(e.id) ? rt : lt, e.id) ?? lineFor(fromRemote.has(e.id) ? lt : rt, e.id);
			parts.push(own ?? `${e.rawText ?? e.originalText ?? e.text ?? ""} ^${e.id}`);
		}
		textSection = parts.length ? parts.join("\n\n") + "\n" : "";
	}

	// "## Embedded Files": "fileId: [[link]]" lines, union of both sides.
	let filesSection: string | null = null;
	const lf = sectionLines(local, "Embedded Files");
	const rf = sectionLines(remote, "Embedded Files");
	if (lf || rf) {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const line of [...(lf ?? []), ...(rf ?? [])]) {
			const key = line.split(":")[0].trim();
			if (!line.trim() || seen.has(key)) continue;
			seen.add(key);
			out.push(line);
		}
		filesSection = out.join("\n") + "\n";
		if (!lf) filesSection = null; // section missing locally: leave the file layout alone
	}
	return L.write(scene, textSection, filesSection);
}
