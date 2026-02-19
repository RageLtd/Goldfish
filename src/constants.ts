/**
 * Shared constants for ports, paths, and timeouts.
 * Single source of truth — used by worker, backfill, hooks, and tests.
 */

import { join } from "node:path";

// ============================================================================
// Directories
// ============================================================================

const HOME = process.env.HOME || "";

export const DATA_DIR = join(HOME, ".claude-mem");
export const DEFAULT_BINARY_DIR = join(DATA_DIR, "bin");
export const DEFAULT_MODEL_DIR = join(DATA_DIR, "models");
export const DEFAULT_DB_PATH = join(DATA_DIR, "memory.db");

// ============================================================================
// Model paths
// ============================================================================

export const DEFAULT_GEN_MODEL_PATH = join(
  DEFAULT_MODEL_DIR,
  "Qwen3-0.6B-Q8_0.gguf",
);
export const DEFAULT_EMBED_MODEL_PATH = join(
  DEFAULT_MODEL_DIR,
  "all-MiniLM-L6-v2-Q8_0.gguf",
);

// ============================================================================
// Ports
// ============================================================================

export const DEFAULT_WORKER_PORT = 3456;
export const DEFAULT_GEN_PORT = 8011;
export const DEFAULT_EMBED_PORT = 8012;

// ============================================================================
// Timeouts
// ============================================================================

export const DEFAULT_SERVER_TIMEOUT_MS = 10000;

// ============================================================================
// URL helpers
// ============================================================================

export const serverUrl = (port: number): string => `http://127.0.0.1:${port}`;
