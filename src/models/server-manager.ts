/**
 * Manages llama-server subprocess lifecycle.
 * Spawns persistent llama-server instances for generation and embedding,
 * polls /health until ready, and provides clean shutdown.
 *
 * Use getOrStartServer() to reuse an existing server on the port
 * (e.g., worker already running) or start a new one.
 */

import { join } from "node:path";
import type { Subprocess } from "bun";
import { serverUrl } from "../constants";
import { err, ok, type Result } from "../types/result";

// ============================================================================
// Types
// ============================================================================

export interface ServerConfig {
  readonly binaryDir: string;
  readonly modelPath: string;
  readonly port: number;
  readonly nGpuLayers?: number;
  readonly contextSize?: number;
  readonly embeddings?: boolean;
}

export interface ManagedServer {
  readonly process: Subprocess | null;
  readonly url: string;
  readonly port: number;
  readonly owned: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const HEALTH_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 10000;

// ============================================================================
// Server Lifecycle
// ============================================================================

/**
 * Returns an existing healthy server on the port, or starts a new one.
 * If a server is already listening (e.g., from the worker process), returns
 * a handle with owned=false so stopServer() is a no-op.
 */
export const getOrStartServer = async (
  config: ServerConfig,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Result<ManagedServer>> => {
  const url = serverUrl(config.port);

  // Check if a server is already healthy on this port
  const alreadyHealthy = await checkHealth(url);
  if (alreadyHealthy) {
    return ok({
      process: null,
      url,
      port: config.port,
      owned: false,
    });
  }

  // No existing server — spawn a new one
  const startResult = startServer(config);
  if (!startResult.ok) return startResult;

  const server = startResult.value;
  const readyResult = await waitForReady(server.url, timeoutMs);
  if (!readyResult.ok) {
    // Clean up the process we just spawned
    await stopServer(server);
    return err(readyResult.error);
  }

  return ok(server);
};

/**
 * Spawns a llama-server process with the given config.
 * Does NOT wait for readiness — call waitForReady separately.
 */
export const startServer = (config: ServerConfig): Result<ManagedServer> => {
  const binary = join(config.binaryDir, "llama-server");
  const args = [
    binary,
    "-m",
    config.modelPath,
    "--port",
    String(config.port),
    "-ngl",
    String(config.nGpuLayers ?? 99),
    "-c",
    String(config.contextSize ?? 2048),
    ...(config.embeddings ? ["--embeddings"] : []),
  ];

  const env = {
    ...process.env,
    DYLD_LIBRARY_PATH: config.binaryDir,
    LD_LIBRARY_PATH: config.binaryDir,
  };

  try {
    const proc = Bun.spawn(args, {
      stdout: "ignore",
      stderr: "ignore",
      env,
    });

    return ok({
      process: proc,
      url: serverUrl(config.port),
      port: config.port,
      owned: true,
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

/**
 * Polls GET /health until {"status":"ok"} or timeout.
 */
export const waitForReady = async (
  url: string,
  timeoutMs: number,
): Promise<Result<void>> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const healthy = await checkHealth(url);
    if (healthy) return ok(undefined);
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  return err(
    new Error(`llama-server at ${url} not ready after ${timeoutMs}ms`),
  );
};

/**
 * Stops a llama-server process if we own it.
 * No-op for borrowed (non-owned) servers.
 */
export const stopServer = async (server: ManagedServer): Promise<void> => {
  if (!server.owned || !server.process) return;
  server.process.kill("SIGTERM");
  await server.process.exited;
};

// ============================================================================
// Internal Helpers
// ============================================================================

export const checkHealth = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
