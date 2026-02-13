/**
 * Hook runner utilities.
 * Provides stdin/stdout handling for hook scripts.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HookOutput } from "../types/hooks";
import { fromPromise, fromTry } from "../types/result";

const WORKER_PORT = process.env.CLAUDE_MEM_PORT || "3456";
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const HEALTH_TIMEOUT_MS = 1000;
const WORKER_STARTUP_WAIT_MS = 5000;
const WORKER_STARTUP_POLL_MS = 200;

// File-based logging (stdout is reserved for hook output)
// Use CLAUDE_PLUGIN_ROOT if available, otherwise cwd
const LOG_DIR = process.env.CLAUDE_PLUGIN_ROOT
  ? join(process.env.CLAUDE_PLUGIN_ROOT, "..", "logs")
  : join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "hooks.log");

const log = (level: string, message: string, data?: unknown): void => {
  const result = fromTry(() => {
    mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = data
      ? `[${timestamp}] [${level}] ${message} ${JSON.stringify(data)}\n`
      : `[${timestamp}] [${level}] ${message}\n`;
    appendFileSync(LOG_FILE, entry);
  });
  // Logging errors are intentionally discarded — logging must never break hooks
  void result;
};

/**
 * Reads JSON from stdin.
 */
export const readStdin = async <T>(): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return JSON.parse(text) as T;
};

/**
 * Writes JSON to stdout.
 */
export const writeStdout = (output: HookOutput): void => {
  console.log(JSON.stringify(output));
};

/**
 * Checks if worker is healthy.
 */
const isWorkerHealthy = async (): Promise<boolean> => {
  const result = await fromPromise(
    fetch(`${WORKER_URL}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    }),
  );
  return result.ok ? result.value.ok : false;
};

/**
 * Gets the path to the claude-mem binary.
 * Handles both development (bun run) and compiled binary cases.
 */
const getWorkerBinPath = (): string => {
  // Check if CLAUDE_PLUGIN_ROOT is set (running as plugin)
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    return join(pluginRoot, "bin", "claude-mem");
  }

  // Fallback: use Bun.main which gives us the actual script path
  // For compiled binaries, this is the path to the executable
  const mainPath = Bun.main;
  if (mainPath && !mainPath.startsWith("/$bunfs")) {
    return mainPath;
  }

  // Last resort: check common locations
  const homeDir = process.env.HOME || "";
  const possiblePaths = [
    join(homeDir, ".claude-mem", "bin", "claude-mem"),
    join(process.cwd(), "plugin", "bin", "claude-mem"),
  ];

  for (const p of possiblePaths) {
    const check = fromTry(() => Bun.file(p).size > 0);
    if (check.ok && check.value) {
      return p;
    }
  }

  // Give up - worker won't auto-start but hooks will still work gracefully
  return "";
};

/**
 * Starts the worker as a background process.
 */
const startWorker = (): void => {
  const workerBin = getWorkerBinPath();
  if (!workerBin) {
    return; // Can't find binary, fail gracefully
  }

  // Spawn worker in background, detached from parent
  const result = fromTry(() => {
    const child = spawn(workerBin, ["worker"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CLAUDE_MEM_PORT: WORKER_PORT,
      },
    });

    // Unref so parent can exit without waiting
    child.unref();
  });
  // Spawn errors are intentionally discarded — hooks degrade gracefully
  void result;
};

/**
 * Ensures worker is running, starting it if needed.
 */
const ensureWorker = async (): Promise<void> => {
  if (await isWorkerHealthy()) {
    return;
  }

  // Start worker
  startWorker();

  // Wait for worker to become healthy
  const startTime = Date.now();
  while (Date.now() - startTime < WORKER_STARTUP_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, WORKER_STARTUP_POLL_MS));
    if (await isWorkerHealthy()) {
      return;
    }
  }
  // Worker didn't start in time, but continue anyway - hooks fail gracefully
};

/**
 * Gets the default hook dependencies.
 */
export const getDefaultDeps = () => ({
  fetch: globalThis.fetch,
  workerUrl: WORKER_URL,
});

/**
 * Runs a hook processor with stdin/stdout handling.
 * Automatically starts worker if not running.
 */
export const runHook = async <T>(
  processor: (
    deps: { fetch: typeof fetch; workerUrl: string },
    input: T,
  ) => Promise<HookOutput>,
  hookName = "unknown",
): Promise<void> => {
  log("INFO", `[${hookName}] Hook started`);

  const result = await fromPromise(
    (async () => {
      const input = await readStdin<T>();
      log("DEBUG", `[${hookName}] Input received`, input);

      log("DEBUG", `[${hookName}] Ensuring worker is running`);
      await ensureWorker();
      const healthy = await isWorkerHealthy();
      log("INFO", `[${hookName}] Worker healthy: ${healthy}`);

      const deps = getDefaultDeps();
      log("DEBUG", `[${hookName}] Calling processor`);
      const output = await processor(deps, input);
      log("INFO", `[${hookName}] Processor output`, output);

      writeStdout(output);
      log("INFO", `[${hookName}] Hook completed successfully`);
    })(),
  );

  if (!result.ok) {
    log("ERROR", `[${hookName}] Hook failed`, {
      error: result.error.message,
      stack: result.error.stack,
    });
    // Always return valid output so Claude Code continues
    writeStdout({
      continue: true,
      suppressOutput: true,
    });
  }
};
