/**
 * Worker handlers for codebase map operations.
 */

import { scanProject } from "../../codebase-map/scanner";
import { summarizeDirectories } from "../../codebase-map/summarizer";
import {
  getDirectoryMap,
  getFileMap,
  getMapStats,
  searchMap,
  upsertMapEntry,
} from "../../db/codebase-map";
import { escapeFts5QueryOr } from "../../utils/validation";
import type { HandlerResponse, WorkerDeps } from "./types";

// ============================================================================
// Input types
// ============================================================================

export interface MapScanInput {
  readonly project: string;
  readonly projectRoot: string;
}

export interface MapQueryInput {
  readonly project: string;
  readonly directory?: string;
  readonly projectRoot?: string;
}

export interface MapSearchInput {
  readonly project: string;
  readonly query: string;
}

export interface MapReindexInput {
  readonly project: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly fileHash: string;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Triggers a full scan + summarization of a project.
 * This is a long-running operation — called by the slash command.
 */
export const handleMapScan = async (
  deps: WorkerDeps,
  input: MapScanInput,
): Promise<HandlerResponse> => {
  if (!deps.modelManager) {
    return { status: 503, body: { error: "Model manager not available" } };
  }

  const scanResult = await scanProject(input.projectRoot);
  if (!scanResult.ok) {
    return { status: 500, body: { error: scanResult.error.message } };
  }

  const { directories, totalFiles } = scanResult.value;

  const summarizeResult = await summarizeDirectories(
    {
      db: deps.db,
      modelManager: deps.modelManager,
      projectRoot: input.projectRoot,
      project: input.project,
    },
    directories,
  );

  return {
    status: 200,
    body: {
      totalFiles,
      directories: directories.length,
      ...summarizeResult,
    },
  };
};

/**
 * Returns the directory-level map for context injection.
 * When projectRoot is provided and entries exist, queues a background
 * staleness check to keep the map fresh across sessions.
 */
export const handleMapGet = (
  deps: WorkerDeps,
  input: MapQueryInput,
): HandlerResponse => {
  const result = input.directory
    ? getFileMap(deps.db, input.project, input.directory)
    : getDirectoryMap(deps.db, input.project);

  if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
  }

  const entries = result.value;
  if (entries.length === 0) {
    return {
      status: 200,
      body: {
        entries: [],
        formatted: "No codebase map found. Run /map:scan to build one.",
      },
    };
  }

  // Queue background refresh when projectRoot is available and map exists
  if (input.projectRoot && deps.router) {
    deps.router.enqueue({
      type: "map-refresh",
      claudeSessionId: "",
      data: {
        project: input.project,
        projectRoot: input.projectRoot,
      },
    });
  }

  // Format for context injection
  const formatted = entries
    .map((e) => {
      const path = e.type === "directory" ? `${e.path}/` : e.path;
      return e.summary ? `${path} — ${e.summary}` : path;
    })
    .join("\n");

  return {
    status: 200,
    body: { entries, formatted },
  };
};

/**
 * Searches the codebase map by FTS5 query.
 */
export const handleMapSearch = (
  deps: WorkerDeps,
  input: MapSearchInput,
): HandlerResponse => {
  const ftsQuery = escapeFts5QueryOr(input.query);
  const result = searchMap(deps.db, input.project, ftsQuery);

  if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
  }

  return { status: 200, body: { entries: result.value } };
};

/**
 * Re-indexes a single file after a Write/Edit.
 * Updates the file hash in the DB and enqueues directory re-summarization.
 */
export const handleMapReindex = (
  deps: WorkerDeps,
  input: MapReindexInput,
): HandlerResponse => {
  // Update the file entry with the new hash
  const result = upsertMapEntry(deps.db, {
    project: input.project,
    path: input.filePath,
    type: "file",
    summary: null,
    fileHash: input.fileHash,
  });

  if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
  }

  // Enqueue directory re-summarization via the router
  const lastSlash = input.filePath.lastIndexOf("/");
  const directory = lastSlash >= 0 ? input.filePath.slice(0, lastSlash) : ".";

  if (deps.router) {
    deps.router.enqueue({
      type: "map-resummarize",
      claudeSessionId: "",
      data: {
        project: input.project,
        projectRoot: input.projectRoot,
        directory,
      },
    });
  }

  return { status: 200, body: { indexed: true, directory } };
};

/**
 * Returns map statistics for a project.
 */
export const handleMapStats = (
  deps: WorkerDeps,
  input: { project: string },
): HandlerResponse => {
  const result = getMapStats(deps.db, input.project);
  if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
  }
  return { status: 200, body: result.value };
};
