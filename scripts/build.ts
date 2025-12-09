/**
 * Build script for claude-mem hooks and worker service.
 * Compiles TypeScript to standalone executables using `bun build --compile`.
 */

const ROOT_DIR = import.meta.dir.replace("/scripts", "");
const SRC_DIR = `${ROOT_DIR}/src`;
const OUT_DIR = `${ROOT_DIR}/bin`;

const ENTRIES = [
	{ name: "context-hook", source: "hooks/context-hook.ts" },
	{ name: "save-hook", source: "hooks/save-hook.ts" },
	{ name: "new-hook", source: "hooks/new-hook.ts" },
	{ name: "summary-hook", source: "hooks/summary-hook.ts" },
	{ name: "cleanup-hook", source: "hooks/cleanup-hook.ts" },
	{ name: "worker", source: "worker/main.ts" },
];

const log = (msg: string) => console.log(`[build] ${msg}`);
const error = (msg: string) => console.error(`[build] ERROR: ${msg}`);

const compileEntry = async (name: string, source: string): Promise<boolean> => {
	const entrypoint = `${SRC_DIR}/${source}`;
	const outfile = `${OUT_DIR}/${name}`;

	const proc = Bun.spawn(
		["bun", "build", "--compile", "--minify", entrypoint, "--outfile", outfile],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		error(`Failed to compile ${name}: ${stderr}`);
		return false;
	}

	log(`Compiled ${name}`);
	return true;
};

const build = async (): Promise<void> => {
	log("Starting build...");

	// Ensure output directory exists
	await Bun.write(`${OUT_DIR}/.keep`, "");

	let success = true;
	for (const entry of ENTRIES) {
		if (!(await compileEntry(entry.name, entry.source))) {
			success = false;
		}
	}

	if (success) {
		log(`Build completed! Binaries in ${OUT_DIR}/`);
	} else {
		error("Build completed with errors");
		process.exit(1);
	}
};

build();
