/**
 * Build script for claude-mem unified CLI.
 * Compiles TypeScript to a single standalone executable using `bun build --compile`.
 * This reduces plugin size from ~400MB (7 binaries) to ~58MB (1 binary).
 */

const ROOT_DIR = import.meta.dir.replace("/scripts", "");
const SRC_DIR = `${ROOT_DIR}/src`;
const OUT_DIR = `${ROOT_DIR}/plugin/bin`;

const log = (msg: string) => console.log(`[build] ${msg}`);
const error = (msg: string) => console.error(`[build] ERROR: ${msg}`);

const build = async (): Promise<void> => {
  log("Starting build...");

  // Ensure output directory exists
  await Bun.write(`${OUT_DIR}/.keep`, "");

  const entrypoint = `${SRC_DIR}/cli.ts`;
  const outfile = `${OUT_DIR}/claude-mem`;

  log("Compiling unified CLI binary...");

  const proc = Bun.spawn(
    ["bun", "build", "--compile", "--minify", entrypoint, "--outfile", outfile],
    { stdout: "pipe", stderr: "pipe" },
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    error(`Failed to compile: ${stderr}`);
    process.exit(1);
  }

  // Get file size
  const stat = await Bun.file(outfile).stat();
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

  log(`Compiled claude-mem (${sizeMB}MB)`);
  log(`Build completed! Binary at ${outfile}`);
  log("");
  log("Usage:");
  log("  ./plugin/bin/claude-mem hook:context   # SessionStart hook");
  log("  ./plugin/bin/claude-mem hook:new       # UserPromptSubmit hook");
  log("  ./plugin/bin/claude-mem hook:save      # PostToolUse hook");
  log("  ./plugin/bin/claude-mem hook:summary   # Stop hook");
  log("  ./plugin/bin/claude-mem hook:cleanup   # SessionEnd hook");
  log("  ./plugin/bin/claude-mem worker         # Start worker service");
};

build();
