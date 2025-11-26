import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"transports/index": "src/transports/index.ts",
		"mcp/index": "src/mcp/index.ts",
		"workers/index": "src/workers/index.ts",
		// Build the worker script as its own artifact so Worker() can load it at runtime
		"workers/message-worker": "src/workers/message-worker.ts",
		"http/index": "src/http/index.ts",
		"express/index": "src/express/index.ts",
	},
	format: ["cjs", "esm"],
	dts: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	minify: false,
	target: "es2020",
	outDir: "dist",
});
