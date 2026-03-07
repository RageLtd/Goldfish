/**
 * CLI map commands — thin wrappers that hit the running worker.
 * All commands require the worker to be running (goldfish worker).
 */

import { DEFAULT_WORKER_PORT } from "../constants";

const PORT = process.env.GOLDFISH_PORT || String(DEFAULT_WORKER_PORT);
const BASE = `http://127.0.0.1:${PORT}`;

const log = (msg: string) => console.log(msg);

const fetchJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url);
  return res.json();
};

const postJson = async (url: string, body: unknown): Promise<unknown> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
};

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const projectFromCwd = (): string => {
  const cwd = process.cwd();
  const parts = cwd.split("/");
  return parts[parts.length - 1] || "unknown";
};

const parseArgs = (
  offset = 3,
): { flags: Map<string, string>; positional: string[] } => {
  const args = process.argv.slice(offset);
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      arg.startsWith("--") &&
      i + 1 < args.length &&
      !args[i + 1].startsWith("--")
    ) {
      flags.set(arg.slice(2), args[i + 1]);
      i++;
    } else if (arg.startsWith("--")) {
      flags.set(arg.slice(2), "true");
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
};

// ============================================================================
// goldfish map:scan [--project ...]
// ============================================================================

export const mapScanMain = async (): Promise<void> => {
  const { flags } = parseArgs();
  const project = flags.get("project") || projectFromCwd();
  const projectRoot = process.cwd();

  log(`Scanning ${projectRoot} for project "${project}"...`);

  const data = (await postJson(`${BASE}/map/scan`, {
    project,
    projectRoot,
  })) as {
    totalFiles?: number;
    directories?: number;
    directoriesProcessed?: number;
    filesIndexed?: number;
    errors?: number;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);

  log(
    `Scan complete: ${data.totalFiles} files in ${data.directories} directories`,
  );
  log(`  Directories summarized: ${data.directoriesProcessed}`);
  log(`  Files indexed: ${data.filesIndexed}`);
  if (data.errors && data.errors > 0) {
    log(`  Errors: ${data.errors}`);
  }
};

// ============================================================================
// goldfish map:show [--project ...]
// ============================================================================

export const mapShowMain = async (): Promise<void> => {
  const { flags } = parseArgs();
  const project = flags.get("project") || projectFromCwd();

  const params = new URLSearchParams({ project });
  const data = (await fetchJson(`${BASE}/map?${params}`)) as {
    formatted?: string;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(data.formatted || "No codebase map found.");
};

// ============================================================================
// goldfish map:detail <directory> [--project ...]
// ============================================================================

export const mapDetailMain = async (): Promise<void> => {
  const { flags, positional } = parseArgs();
  const directory = positional.join(" ");
  const project = flags.get("project") || projectFromCwd();

  if (!directory) die("Usage: goldfish map:detail <directory> [--project ...]");

  const params = new URLSearchParams({ project, directory });
  const data = (await fetchJson(`${BASE}/map?${params}`)) as {
    formatted?: string;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(data.formatted || `No files found in ${directory}.`);
};

// ============================================================================
// goldfish map:search <query> [--project ...]
// ============================================================================

export const mapSearchMain = async (): Promise<void> => {
  const { flags, positional } = parseArgs();
  const query = positional.join(" ");
  const project = flags.get("project") || projectFromCwd();

  if (!query) die("Usage: goldfish map:search <query> [--project ...]");

  const params = new URLSearchParams({ project, query });
  const data = (await fetchJson(`${BASE}/map/search?${params}`)) as {
    entries?: Array<{ path: string; type: string; summary: string | null }>;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);

  if (!data.entries || data.entries.length === 0) {
    log("No matches found.");
    return;
  }

  for (const entry of data.entries) {
    const path = entry.type === "directory" ? `${entry.path}/` : entry.path;
    log(entry.summary ? `${path} — ${entry.summary}` : path);
  }
};

// ============================================================================
// goldfish map:stats [--project ...]
// ============================================================================

export const mapStatsMain = async (): Promise<void> => {
  const { flags } = parseArgs();
  const project = flags.get("project") || projectFromCwd();

  const params = new URLSearchParams({ project });
  const data = (await fetchJson(`${BASE}/map/stats?${params}`)) as {
    directories?: number;
    files?: number;
    withSummary?: number;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(JSON.stringify(data, null, 2));
};
