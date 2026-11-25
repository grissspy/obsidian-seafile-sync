// A fake Seafile server on a real HTTP port, for end-to-end tests with the Obsidian app.
import http from "node:http";
import { MockSeafile } from "../mock";

export async function startServer(port = 0, host = "127.0.0.1"): Promise<{ mock: MockSeafile; url: string; close: () => void }> {
	const mock = new MockSeafile();
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			void (async () => {
				const raw = Buffer.concat(chunks);
				const ct = req.headers["content-type"] ?? "";
				const body = !raw.length ? undefined : ct.startsWith("multipart/") ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) : raw.toString("utf8");
				const auth = req.headers["authorization"];
				try {
					const r = await mock.http({
						url: `http://${req.headers.host}${req.url}`,
						method: req.method,
						headers: auth ? { Authorization: auth } : {},
						body,
						contentType: ct || undefined,
					});
					res.writeHead(r.status, { "Content-Type": r.text.startsWith("{") || r.text.startsWith("[") || r.text.startsWith('"') ? "application/json" : "application/octet-stream" });
					res.end(Buffer.from(r.arrayBuffer));
				} catch (e) {
					res.writeHead(500);
					res.end(String(e));
				}
			})();
		});
	});
	await new Promise<void>((r) => server.listen(port, host, r));
	const addr = server.address() as { port: number };
	const url = `http://127.0.0.1:${addr.port}`;
	mock.fsBase = url;
	return { mock, url, close: () => server.close() };
}
