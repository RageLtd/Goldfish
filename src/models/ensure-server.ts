/**
 * Auto-downloads llama-server binary from ggml-org/llama.cpp releases.
 * Skips download if binary exists and version matches latest release.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../constants";
import { err, ok, type Result } from "../types/result";

// ============================================================================
// Constants
// ============================================================================

const LLAMA_REPO = "ggml-org/llama.cpp";
const GITHUB_API_URL = `https://api.github.com/repos/${LLAMA_REPO}/releases/latest`;
const VERSION_FILE_NAME = ".llama-server-version";

// ============================================================================
// Platform Mapping
// ============================================================================

interface PlatformKey {
  readonly platform: string;
  readonly arch: string;
}

const PLATFORM_SUFFIX_MAP: Record<string, string> = {
  "darwin-arm64": "macos-arm64",
  "darwin-x64": "macos-x64",
  "linux-x64": "ubuntu-x64",
};

export const getPlatformSuffix = (key: PlatformKey): Result<string> => {
  const lookup = `${key.platform}-${key.arch}`;
  const suffix = PLATFORM_SUFFIX_MAP[lookup];
  if (!suffix) {
    return err(new Error(`Unsupported platform: ${lookup}`));
  }
  return ok(suffix);
};

// ============================================================================
// Version Tracking
// ============================================================================

const versionFilePath = (dataDir: string): string =>
  join(dataDir, VERSION_FILE_NAME);

const readStoredVersion = (dataDir: string): string | undefined => {
  const path = versionFilePath(dataDir);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf-8").trim();
};

const writeVersion = (dataDir: string, version: string): void => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(versionFilePath(dataDir), version, "utf-8");
};

// ============================================================================
// GitHub API
// ============================================================================

const fetchLatestTag = async (): Promise<Result<string>> => {
  let response: Response;
  try {
    response = await fetch(GITHUB_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (!response.ok) {
    return err(
      new Error(
        `GitHub API returned ${response.status}: ${response.statusText}`,
      ),
    );
  }

  const body = (await response.json()) as { tag_name?: string };
  if (!body.tag_name) {
    return err(new Error("GitHub API response missing tag_name"));
  }

  return ok(body.tag_name);
};

// ============================================================================
// Download & Extract
// ============================================================================

const downloadAndExtract = async (
  tag: string,
  platformSuffix: string,
  binaryDir: string,
): Promise<Result<string>> => {
  const tarballUrl = `https://github.com/${LLAMA_REPO}/releases/download/${tag}/llama-${tag}-bin-${platformSuffix}.tar.gz`;
  const tmpDir = join(
    process.env.TMPDIR || "/tmp",
    `llama-server-${Date.now()}`,
  );
  const tmpTar = `${tmpDir}.tar.gz`;

  // Download tarball
  const downloadResponse = await fetch(tarballUrl, {
    signal: AbortSignal.timeout(120000),
  });

  if (!downloadResponse.ok) {
    return err(
      new Error(
        `Failed to download tarball (${downloadResponse.status}): ${tarballUrl}`,
      ),
    );
  }

  mkdirSync(binaryDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  await Bun.write(tmpTar, await downloadResponse.arrayBuffer());

  // Extract tarball
  const extractProc = Bun.spawn(["tar", "xzf", tmpTar, "-C", tmpDir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  await extractProc.exited;

  if (extractProc.exitCode !== 0) {
    const stderr = await new Response(extractProc.stderr).text();
    return err(new Error(`tar extraction failed: ${stderr}`));
  }

  // Find llama-server in extracted tree
  const findProc = Bun.spawn(
    ["find", tmpDir, "-name", "llama-server", "-type", "f"],
    { stdout: "pipe", stderr: "inherit" },
  );
  const findOutput = await new Response(findProc.stdout).text();
  await findProc.exited;

  const serverBin = findOutput.trim().split("\n")[0];
  if (!serverBin) {
    return err(new Error("llama-server binary not found in release tarball"));
  }

  // Copy llama-server + all shared libraries from the same directory
  const sourceDir = join(serverBin, "..");
  const copyProc = Bun.spawn(
    [
      "sh",
      "-c",
      `cp "${serverBin}" "${sourceDir}"/*.dylib "${sourceDir}"/*.so "${binaryDir}/" 2>/dev/null; chmod +x "${binaryDir}/llama-server"`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await copyProc.exited;

  // Cleanup temp files
  Bun.spawn(["rm", "-rf", tmpTar, tmpDir], {
    stdout: "ignore",
    stderr: "ignore",
  });

  return ok(join(binaryDir, "llama-server"));
};

// ============================================================================
// Public API
// ============================================================================

export const ensureLlamaServer = async (
  binaryDir: string,
  dataDir: string = DATA_DIR,
): Promise<Result<string>> => {
  const binaryPath = join(binaryDir, "llama-server");
  const log = (msg: string) => console.log(`[ensure-server] ${msg}`);

  // Fetch latest tag from GitHub
  const tagResult = await fetchLatestTag();
  if (!tagResult.ok) {
    // If we can't reach GitHub but binary exists, use what we have
    if (existsSync(binaryPath)) {
      log("GitHub unreachable but binary exists — using cached binary");
      return ok(binaryPath);
    }
    return tagResult;
  }

  const latestTag = tagResult.value;
  const storedVersion = readStoredVersion(dataDir);

  // Skip if binary exists and version matches
  if (existsSync(binaryPath) && storedVersion === latestTag) {
    log(`llama-server ${latestTag} already present`);
    return ok(binaryPath);
  }

  // Determine platform suffix
  const suffixResult = getPlatformSuffix({
    platform: process.platform,
    arch: process.arch,
  });
  if (!suffixResult.ok) return suffixResult;

  log(`Downloading llama-server ${latestTag} (${suffixResult.value})...`);

  // Download and extract
  const downloadResult = await downloadAndExtract(
    latestTag,
    suffixResult.value,
    binaryDir,
  );
  if (!downloadResult.ok) return downloadResult;

  // Record version
  writeVersion(dataDir, latestTag);
  log(`llama-server ${latestTag} installed to ${binaryPath}`);

  return ok(binaryPath);
};
