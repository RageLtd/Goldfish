import { afterAll, describe, expect, it } from "bun:test";
import { serverUrl } from "../../src/constants";
import {
  checkHealth,
  getOrStartServer,
  waitForReady,
} from "../../src/models/server-manager";

// ============================================================================
// Mock Health Server — single server, handler swapped per test
// ============================================================================

const MOCK_PORT = 18902;
const MOCK_URL = serverUrl(MOCK_PORT);

/** Ports used for "nothing listening" tests */
const UNUSED_PORT_1 = 19997;
const UNUSED_PORT_2 = 19998;
const UNUSED_PORT_3 = 19996;

type MockHandler = (request: Request) => Response | Promise<Response>;

let currentHandler: MockHandler = () =>
  new Response("no handler set", { status: 500 });

const server = Bun.serve({
  port: MOCK_PORT,
  fetch: (req) => currentHandler(req),
});

afterAll(() => server.stop(true));

const setHandler = (handler: MockHandler) => {
  currentHandler = handler;
};

// ============================================================================
// Tests
// ============================================================================

describe("checkHealth", () => {
  it("returns true when server responds with status ok", async () => {
    setHandler(() => Response.json({ status: "ok" }));

    const result = await checkHealth(MOCK_URL);
    expect(result).toBe(true);
  });

  it("returns false when server responds with non-ok status", async () => {
    setHandler(() => Response.json({ status: "loading model" }));

    const result = await checkHealth(MOCK_URL);
    expect(result).toBe(false);
  });

  it("returns false when server returns 500", async () => {
    setHandler(() => new Response("error", { status: 500 }));

    const result = await checkHealth(MOCK_URL);
    expect(result).toBe(false);
  });

  it("returns false when no server is listening", async () => {
    const result = await checkHealth(serverUrl(UNUSED_PORT_2));
    expect(result).toBe(false);
  });
});

describe("waitForReady", () => {
  it("succeeds when server is already healthy", async () => {
    setHandler(() => Response.json({ status: "ok" }));

    const result = await waitForReady(MOCK_URL, 2000);
    expect(result.ok).toBe(true);
  });

  it("succeeds when server becomes healthy within timeout", async () => {
    let requestCount = 0;

    setHandler(() => {
      requestCount++;
      if (requestCount < 3) {
        return Response.json({ status: "loading model" });
      }
      return Response.json({ status: "ok" });
    });

    const result = await waitForReady(MOCK_URL, 5000);
    expect(result.ok).toBe(true);
    expect(requestCount).toBeGreaterThanOrEqual(3);
  });

  it("returns error when timeout is exceeded", async () => {
    const result = await waitForReady(serverUrl(UNUSED_PORT_1), 300);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not ready after 300ms");
    }
  });
});

describe("getOrStartServer", () => {
  it("returns non-owned handle when server is already running", async () => {
    setHandler(() => Response.json({ status: "ok" }));

    const result = await getOrStartServer(
      {
        binaryDir: "/nonexistent",
        modelPath: "/nonexistent",
        port: MOCK_PORT,
      },
      2000,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.owned).toBe(false);
      expect(result.value.process).toBeNull();
      expect(result.value.url).toBe(MOCK_URL);
    }
  });

  it("returns error when binary does not exist and no server running", async () => {
    const result = await getOrStartServer(
      {
        binaryDir: "/nonexistent-binary-dir",
        modelPath: "/nonexistent-model",
        port: UNUSED_PORT_3,
      },
      500,
    );

    expect(result.ok).toBe(false);
  });
});
