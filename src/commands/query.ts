/**
 * CLI query commands — thin wrappers that hit the running worker.
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

/** Set a URL param only if the flag exists. */
const setIfPresent = (
  params: URLSearchParams,
  flags: Map<string, string>,
  key: string,
): void => {
  const value = flags.get(key);
  if (value !== undefined) params.set(key, value);
};

// ============================================================================
// goldfish search <query> [--type observations|summaries] [--concept ...] [--project ...] [--limit N]
// ============================================================================

export const searchMain = async (): Promise<void> => {
  const { flags, positional } = parseArgs();
  const query = positional.join(" ");

  if (!query)
    die(
      "Usage: goldfish search <query> [--type observations|summaries] [--concept ...] [--project ...] [--limit N]",
    );

  const params = new URLSearchParams({
    query,
    type: flags.get("type") || "observations",
  });
  setIfPresent(params, flags, "concept");
  setIfPresent(params, flags, "project");
  setIfPresent(params, flags, "limit");

  const data = (await fetchJson(`${BASE}/search?${params}`)) as {
    results?: unknown[];
    count?: number;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(JSON.stringify(data, null, 2));
};

// ============================================================================
// goldfish timeline [--project ...] [--limit N] [--since ...]
// ============================================================================

export const timelineMain = async (): Promise<void> => {
  const { flags } = parseArgs();
  const project = flags.get("project") || projectFromCwd();

  const params = new URLSearchParams({ project });
  setIfPresent(params, flags, "limit");
  setIfPresent(params, flags, "since");

  const data = (await fetchJson(`${BASE}/timeline?${params}`)) as {
    results?: unknown[];
    count?: number;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(JSON.stringify(data, null, 2));
};

// ============================================================================
// goldfish decisions [--project ...] [--limit N] [--since ...]
// ============================================================================

export const decisionsMain = async (): Promise<void> => {
  const { flags } = parseArgs();
  const project = flags.get("project") || projectFromCwd();

  const params = new URLSearchParams({ project });
  setIfPresent(params, flags, "limit");
  setIfPresent(params, flags, "since");

  const data = (await fetchJson(`${BASE}/decisions?${params}`)) as {
    results?: unknown[];
    count?: number;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(JSON.stringify(data, null, 2));
};

// ============================================================================
// goldfish find <file> [--limit N]
// ============================================================================

export const findMain = async (): Promise<void> => {
  const { flags, positional } = parseArgs();
  const file = positional.join(" ");

  if (!file) die("Usage: goldfish find <file> [--limit N]");

  const params = new URLSearchParams({ file });
  setIfPresent(params, flags, "limit");

  const data = (await fetchJson(`${BASE}/find_by_file?${params}`)) as {
    results?: unknown[];
    count?: number;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(JSON.stringify(data, null, 2));
};

// ============================================================================
// goldfish observation <id>
// ============================================================================

export const observationMain = async (): Promise<void> => {
  const { positional } = parseArgs();
  const id = positional[0];

  if (!id) die("Usage: goldfish observation <id>");

  const data = (await fetchJson(`${BASE}/observation_by_id?id=${id}`)) as {
    observation?: unknown;
    formatted?: string;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);

  if (data.formatted) {
    log(data.formatted);
  } else {
    log(JSON.stringify(data, null, 2));
  }
};

// ============================================================================
// goldfish graph:stats
// ============================================================================

export const graphStatsMain = async (): Promise<void> => {
  const data = (await fetchJson(`${BASE}/graph/stats`)) as {
    nodes?: number;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(JSON.stringify(data, null, 2));
};

// ============================================================================
// goldfish graph:show <id>
// ============================================================================

export const graphShowMain = async (): Promise<void> => {
  const { positional } = parseArgs();
  const id = positional[0];

  if (!id) die("Usage: goldfish graph:show <id>");

  const data = (await fetchJson(`${BASE}/graph/neighbors?id=${id}`)) as {
    neighbors?: unknown[];
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(JSON.stringify(data, null, 2));
};

// ============================================================================
// goldfish health
// ============================================================================

export const healthMain = async (): Promise<void> => {
  const data = (await fetchJson(`${BASE}/health`)) as {
    status?: string;
    error?: string;
  };

  if (data.error) die(`Error: ${data.error}`);
  log(JSON.stringify(data, null, 2));
};
