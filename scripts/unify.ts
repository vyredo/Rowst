#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function printUsage(): void {
	console.log(`Usage:
    node dist/scripts/unify.js -s=SOURCE_DIR -o=OUTPUT_FILE

  Flags:
    -s=src         Source directory to traverse (recursively)
    -o=unified.md  Output markdown file path

  Example:
    node dist/scripts/unify.js -s=src -o=unified.md
  `);
}

type Args = { src: string; out: string };

function parseArgs(argv: string[]): Args {
	let src: string | undefined;
	let out: string | undefined;
	for (const arg of argv) {
		if (arg.startsWith("-s=")) src = arg.slice(3);
		else if (arg.startsWith("--src=")) src = arg.slice(6);
		else if (arg.startsWith("-o=")) out = arg.slice(3);
		else if (arg.startsWith("--out=")) out = arg.slice(6);
		else if (arg === "-h" || arg === "--help") {
			printUsage();
			process.exit(0);
		}
	}
	if (!src || !out) {
		printUsage();
		process.exit(1);
	}
	return { src, out };
}

async function gatherFiles(
	dir: string,
	ignoreAbsolutePath?: string,
): Promise<string[]> {
	const results: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (ignoreAbsolutePath && path.resolve(fullPath) === ignoreAbsolutePath) {
			continue;
		}
		if (entry.isDirectory()) {
			const sub = await gatherFiles(fullPath, ignoreAbsolutePath);
			results.push(...sub);
		} else if (entry.isFile()) {
			results.push(fullPath);
		}
	}
	return results;
}

function toPosixRelative(fp: string): string {
	const rel = path.relative(process.cwd(), fp);
	return rel.split(path.sep).join("/");
}

async function main(): Promise<void> {
	const { src, out } = parseArgs(process.argv.slice(2));
	const srcPath = path.resolve(src);
	const outPath = path.resolve(out);

	await mkdir(path.dirname(outPath), { recursive: true });

	const files = await gatherFiles(srcPath, outPath);
	files.sort((a, b) => a.localeCompare(b));

	const sections: string[] = [];
	for (const file of files) {
		const rel = toPosixRelative(file);
		let content = "";
		try {
			content = await readFile(file, "utf8");
		} catch (err: unknown) {
			const e = err as Error;
			console.warn(
				`Skipping file due to read error: ${rel} (${e?.message ?? String(err)})`,
			);
			continue;
		}
		sections.push(`\`\`\`${rel}
${content}
\`\`\``);
	}

	const finalText = sections.join("\n\n");
	await writeFile(outPath, finalText, "utf8");
	console.log(`Unified ${files.length} files from "${src}" into "${out}"`);
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
