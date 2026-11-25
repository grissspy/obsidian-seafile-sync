// Line-based three-way merge (diff3-style).
// Returns merged text, or null when both sides changed the same region differently.

interface Hunk {
	s: number; // start in base (inclusive)
	e: number; // end in base (exclusive)
	lines: string[]; // replacement
}

const MAX_EDIT_DISTANCE = 20000;

/** Myers O(ND) diff, returns hunks describing how to turn `a` into `b`. Null if too large. */
export function diffHunks(a: string[], b: string[]): Hunk[] | null {
	// Trim common prefix / suffix (cheap and makes the typical edit tiny).
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const A = a.slice(pre, a.length - suf);
	const B = b.slice(pre, b.length - suf);
	const N = A.length;
	const M = B.length;
	if (N === 0 && M === 0) return [];
	if (N === 0 || M === 0) return [{ s: pre, e: pre + N, lines: B }];

	const max = N + M;
	const offset = max;
	let v = new Int32Array(2 * max + 2);
	const trace: Int32Array[] = [];
	let found = false;
	for (let d = 0; d <= max; d++) {
		if (d > MAX_EDIT_DISTANCE) return null;
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
			else x = v[offset + k - 1] + 1;
			let y = x - k;
			while (x < N && y < M && A[x] === B[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= N && y >= M) {
				found = true;
				break;
			}
		}
		if (found) break;
	}

	// Backtrack into a list of ops.
	type Op = { t: "=" | "-" | "+"; ai: number; bi: number };
	const ops: Op[] = [];
	let x = N;
	let y = M;
	for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
		const vv = trace[d];
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) prevK = k + 1;
		else prevK = k - 1;
		const prevX = vv[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			ops.push({ t: "=", ai: x, bi: y });
		}
		if (d === 0) break;
		if (x === prevX) {
			y--;
			ops.push({ t: "+", ai: x, bi: y });
		} else {
			x--;
			ops.push({ t: "-", ai: x, bi: y });
		}
	}
	while (x > 0 && y > 0) {
		x--;
		y--;
		ops.push({ t: "=", ai: x, bi: y });
	}
	ops.reverse();

	// Group consecutive non-equal ops into hunks.
	const hunks: Hunk[] = [];
	let cur: Hunk | null = null;
	let ai = 0;
	for (const op of ops) {
		if (op.t === "=") {
			if (cur) {
				hunks.push(cur);
				cur = null;
			}
			ai = op.ai + 1;
		} else {
			if (!cur) cur = { s: pre + ai, e: pre + ai, lines: [] };
			if (op.t === "-") {
				cur.e++;
				ai = op.ai + 1;
			} else cur.lines.push(B[op.bi]);
		}
	}
	if (cur) hunks.push(cur);
	return hunks;
}

function sameLines(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function merge3(base: string, local: string, remote: string): string | null {
	if (local === remote) return local;
	if (base === local) return remote;
	if (base === remote) return local;

	const O = base.split("\n");
	const hl = diffHunks(O, local.split("\n"));
	const hr = diffHunks(O, remote.split("\n"));
	if (!hl || !hr) return null;

	type Tagged = Hunk & { side: 0 | 1 };
	const all: Tagged[] = [
		...hl.map((h) => ({ ...h, side: 0 as const })),
		...hr.map((h) => ({ ...h, side: 1 as const })),
	].sort((p, q) => p.s - q.s || p.e - q.e);

	const out: string[] = [];
	let pos = 0;
	let i = 0;
	while (i < all.length) {
		// Collect a group of mutually overlapping hunks.
		const group: Tagged[] = [all[i]];
		let gs = all[i].s;
		let ge = all[i].e;
		i++;
		while (i < all.length) {
			const h = all[i];
			// Overlapping ranges, or two edits anchored at the same base line
			// (e.g. both sides inserted at the same spot) belong together.
			if (!(h.s < ge || h.s === gs)) break;
			group.push(h);
			ge = Math.max(ge, h.e);
			i++;
		}

		for (let k = pos; k < gs; k++) out.push(O[k]);

		const sides = new Set(group.map((g) => g.side));
		if (sides.size === 1) {
			// Only one side touched this region: apply its hunks in order.
			let p = gs;
			for (const g of group) {
				for (let k = p; k < g.s; k++) out.push(O[k]);
				out.push(...g.lines);
				p = g.e;
			}
			for (let k = p; k < ge; k++) out.push(O[k]);
		} else {
			// Both sides touched it: fine only if they produce identical results.
			const render = (side: 0 | 1) => {
				const r: string[] = [];
				let p = gs;
				for (const g of group.filter((x) => x.side === side)) {
					for (let k = p; k < g.s; k++) r.push(O[k]);
					r.push(...g.lines);
					p = g.e;
				}
				for (let k = p; k < ge; k++) r.push(O[k]);
				return r;
			};
			const a = render(0);
			const b = render(1);
			if (!sameLines(a, b)) return null;
			out.push(...a);
		}
		pos = ge;
	}
	for (let k = pos; k < O.length; k++) out.push(O[k]);
	return out.join("\n");
}
