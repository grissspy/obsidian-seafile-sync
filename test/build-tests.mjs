import esbuild from "esbuild";
const common = { bundle: true, platform: "node", format: "cjs", target: "node18", logLevel: "warning" };
await esbuild.build({ ...common, entryPoints: ["test/sync.test.ts"], outfile: "test/out/sync.test.js" });
await esbuild.build({ ...common, entryPoints: ["test/e2e/run.ts"], outfile: "test/out/e2e.js", target: "node22" });
await esbuild.build({ ...common, entryPoints: ["test/e2e/phone.ts"], outfile: "test/out/phone.js", target: "node22" });
