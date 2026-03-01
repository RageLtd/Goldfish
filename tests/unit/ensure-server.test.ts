import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLlamaServer,
  getPlatformSuffix,
} from "../../src/models/ensure-server";

// ============================================================================
// getPlatformSuffix — pure function, no I/O
// ============================================================================

describe("getPlatformSuffix", () => {
  it("maps darwin-arm64 to macos-arm64", () => {
    const result = getPlatformSuffix({ platform: "darwin", arch: "arm64" });
    expect(result).toEqual({ ok: true, value: "macos-arm64" });
  });

  it("maps darwin-x64 to macos-x64", () => {
    const result = getPlatformSuffix({ platform: "darwin", arch: "x64" });
    expect(result).toEqual({ ok: true, value: "macos-x64" });
  });

  it("maps linux-x64 to ubuntu-x64", () => {
    const result = getPlatformSuffix({ platform: "linux", arch: "x64" });
    expect(result).toEqual({ ok: true, value: "ubuntu-x64" });
  });

  it("returns error for linux-arm64 (unsupported)", () => {
    const result = getPlatformSuffix({ platform: "linux", arch: "arm64" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unsupported platform");
    }
  });

  it("returns error for unsupported platform", () => {
    const result = getPlatformSuffix({ platform: "win32", arch: "x64" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unsupported platform");
    }
  });
});

// ============================================================================
// ensureLlamaServer — mock fetch to avoid real network calls
// ============================================================================

describe("ensureLlamaServer", () => {
  let testDir: string;
  let binaryDir: string;
  let dataDir: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    testDir = join(tmpdir(), `ensure-server-test-${Date.now()}`);
    binaryDir = join(testDir, "bin");
    dataDir = join(testDir, "data");
    mkdirSync(binaryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("skips download when binary exists and version matches", async () => {
    const TAG = "b9999";
    writeFileSync(join(binaryDir, "llama-server"), "existing-binary", {
      mode: 0o755,
    });
    writeFileSync(join(dataDir, ".llama-server-version"), TAG);

    fetchSpy.mockResolvedValueOnce(Response.json({ tag_name: TAG }));

    const result = await ensureLlamaServer(binaryDir, dataDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(join(binaryDir, "llama-server"));
    }
    // Only the GitHub API call, no tarball download
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to cached binary when GitHub API fails", async () => {
    writeFileSync(join(binaryDir, "llama-server"), "cached-binary", {
      mode: 0o755,
    });

    fetchSpy.mockRejectedValueOnce(new Error("network error"));

    const result = await ensureLlamaServer(binaryDir, dataDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(join(binaryDir, "llama-server"));
    }
  });

  it("returns error when no binary and GitHub API fails", async () => {
    const emptyBinDir = join(testDir, "empty-bin");
    mkdirSync(emptyBinDir, { recursive: true });

    fetchSpy.mockRejectedValueOnce(new Error("network error"));

    const result = await ensureLlamaServer(emptyBinDir, dataDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("network error");
    }
  });

  it("downloads and extracts when binary is missing", async () => {
    const TAG = "b9999";

    // Create a test tarball with a fake llama-server inside
    const tarContentDir = join(testDir, "tar-content", "build", "bin");
    mkdirSync(tarContentDir, { recursive: true });
    writeFileSync(join(tarContentDir, "llama-server"), "#!/bin/sh\necho ok\n", {
      mode: 0o755,
    });
    const tarPath = join(testDir, "test.tar.gz");
    const tarProc = Bun.spawn(
      ["tar", "czf", tarPath, "-C", join(testDir, "tar-content"), "."],
      { stdout: "ignore", stderr: "ignore" },
    );
    await tarProc.exited;
    const tarBytes = await Bun.file(tarPath).arrayBuffer();

    // Mock GitHub API → tag
    fetchSpy.mockResolvedValueOnce(Response.json({ tag_name: TAG }));
    // Mock tarball download
    fetchSpy.mockResolvedValueOnce(
      new Response(tarBytes, {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      }),
    );

    const freshBinDir = join(testDir, "fresh-bin");
    mkdirSync(freshBinDir, { recursive: true });

    const result = await ensureLlamaServer(freshBinDir, dataDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(join(freshBinDir, "llama-server"));
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns error when tarball download fails", async () => {
    const TAG = "b9999";

    fetchSpy.mockResolvedValueOnce(Response.json({ tag_name: TAG }));
    fetchSpy.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const freshBinDir = join(testDir, "fresh-bin-404");
    mkdirSync(freshBinDir, { recursive: true });

    const result = await ensureLlamaServer(freshBinDir, dataDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Failed to download tarball");
    }
  });
});
