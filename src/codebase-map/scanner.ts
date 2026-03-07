/**
 * Filesystem scanner for building the codebase map.
 * Walks a project directory respecting .gitignore, collects file metadata,
 * and groups files by directory for batch summarization.
 *
 * Uses Bun-native APIs for performance (Bun.file, Bun.hash, Bun.spawnSync).
 */

import { sep } from "node:path";
import { err, ok, type Result } from "../types/result";

// ============================================================================
// Types
// ============================================================================

export interface ScannedFile {
  readonly relativePath: string;
  readonly hash: string;
  readonly sizeBytes: number;
}

export interface ScannedDirectory {
  readonly relativePath: string;
  readonly files: readonly ScannedFile[];
}

export interface ScanResult {
  readonly directories: readonly ScannedDirectory[];
  readonly totalFiles: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Max file size to hash/read (skip large binaries) */
const MAX_FILE_SIZE = 512 * 1024; // 512KB

/** Extensions we skip entirely (binaries, images, etc.) */
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".wasm",
  ".lock",
]);

// ============================================================================
// Helpers
// ============================================================================

const log = (msg: string) => console.log(`[scanner] ${msg}`);

const getExtension = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
};

/**
 * Hash file contents using Bun.hash (xxHash64, very fast).
 * Returns null for files that are too large or unreadable.
 */
const hashFile = async (absolutePath: string): Promise<string | null> => {
  try {
    const file = Bun.file(absolutePath);
    const size = file.size;
    if (size > MAX_FILE_SIZE || size === 0) return null;
    const content = await file.arrayBuffer();
    return Bun.hash(new Uint8Array(content)).toString(16);
  } catch {
    return null;
  }
};

/**
 * Reads the first N lines of a file for summarization context.
 */
export const readFileHead = async (
  absolutePath: string,
  maxLines = 15,
): Promise<string | null> => {
  try {
    const file = Bun.file(absolutePath);
    if (file.size > MAX_FILE_SIZE || file.size === 0) return null;
    const content = await file.text();
    const lines = content.split("\n").slice(0, maxLines);
    return lines.join("\n");
  } catch {
    return null;
  }
};

// ============================================================================
// Scanner
// ============================================================================

/**
 * Scans a project directory using `git ls-files` (respects .gitignore).
 * Groups files by directory for efficient batch summarization.
 */
export const scanProject = async (
  projectRoot: string,
): Promise<Result<ScanResult, Error>> => {
  const filesResult = getTrackedFiles(projectRoot);
  if (!filesResult.ok) return filesResult;

  const relativePaths = filesResult.value;
  const dirMap = new Map<string, ScannedFile[]>();
  let totalFiles = 0;

  for (const relPath of relativePaths) {
    const ext = getExtension(relPath);
    if (SKIP_EXTENSIONS.has(ext)) continue;

    const absolutePath = `${projectRoot}${sep}${relPath}`;
    const hash = await hashFile(absolutePath);
    if (!hash) continue;

    const lastSlash = relPath.lastIndexOf("/");
    const dir = lastSlash >= 0 ? relPath.slice(0, lastSlash) : ".";

    const file: ScannedFile = {
      relativePath: relPath,
      hash,
      sizeBytes: Bun.file(absolutePath).size,
    };

    const existing = dirMap.get(dir);
    if (existing) {
      existing.push(file);
    } else {
      dirMap.set(dir, [file]);
    }
    totalFiles++;
  }

  const directories: ScannedDirectory[] = Array.from(dirMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirPath, files]) => ({
      relativePath: dirPath,
      files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    }));

  log(`Scanned ${totalFiles} files in ${directories.length} directories`);
  return ok({ directories, totalFiles });
};

/**
 * Gets all tracked files via git ls-files (Bun.spawnSync, no shell).
 */
const getTrackedFiles = (
  projectRoot: string,
): Result<readonly string[], Error> => {
  const proc = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
  );

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    return err(new Error(`git ls-files failed: ${stderr}`));
  }

  const files = proc.stdout
    .toString()
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  return ok(files);
};
