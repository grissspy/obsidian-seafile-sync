import esbuild from "esbuild";
await esbuild.build({ entryPoints: ["test/sync.test.ts"], bundle: true, platform: "node", format: "cjs", target: "node18", outfile: "test/out/sync.test.js", logLevel: "warning" });
