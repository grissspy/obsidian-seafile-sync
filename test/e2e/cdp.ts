// Minimal Chrome DevTools Protocol client (Node 22+ has a global WebSocket).

export interface Target {
	id: string;
	title: string;
	url: string;
	type: string;
	webSocketDebuggerUrl: string;
}

export async function targets(port: number): Promise<Target[]> {
	const r = await fetch(`http://127.0.0.1:${port}/json`);
	return ((await r.json()) as Target[]).filter((t) => t.type === "page");
}

export async function waitTarget(port: number, pred: (t: Target) => boolean, timeoutMs = 60_000): Promise<Target> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			const t = (await targets(port)).find(pred);
			if (t) return t;
		} catch {
			/* not up yet */
		}
		if (Date.now() > end) throw new Error("timed out waiting for an Obsidian window");
		await new Promise((r) => setTimeout(r, 500));
	}
}

export class Cdp {
	private ws!: WebSocket;
	private seq = 0;
	private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();

	static async connect(t: Target): Promise<Cdp> {
		const c = new Cdp();
		c.ws = new WebSocket(t.webSocketDebuggerUrl);
		await new Promise((ok, fail) => {
			c.ws.onopen = ok;
			c.ws.onerror = () => fail(new Error("CDP connect failed"));
		});
		c.ws.onmessage = (m) => {
			const d = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
			const w = d.id !== undefined ? c.waiting.get(d.id) : undefined;
			if (!w) return;
			c.waiting.delete(d.id!);
			if (d.error) w.fail(new Error(d.error.message));
			else w.ok(d.result);
		};
		return c;
	}

	send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = ++this.seq;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise<T>((ok, fail) => this.waiting.set(id, { ok: ok as (v: unknown) => void, fail }));
	}

	/** Run an async function body in the page and return its (JSON) result. */
	async eval<T = unknown>(body: string, timeoutMs = 240_000): Promise<T> {
		type R = { result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const r = await Promise.race([
			this.send<R>("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
			new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error(`page script timed out after ${timeoutMs / 1000}s`)), timeoutMs))),
		]).finally(() => clearTimeout(timer));
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "page error");
		return r.result.value as T;
	}

	close() {
		this.ws.close();
	}
}
