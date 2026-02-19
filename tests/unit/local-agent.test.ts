/**
 * Tests for the local agent that uses llama.cpp CLI for observation extraction.
 * Mocks ModelManager to avoid invoking actual llama.cpp binaries.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  DEFAULT_EMBED_PORT,
  DEFAULT_GEN_PORT,
  serverUrl,
} from "../../src/constants";
import {
  createDatabase,
  createSession,
  getObservationById,
  runMigrations,
} from "../../src/db/index";
import type {
  ModelManager,
  ModelManagerConfig,
} from "../../src/models/manager";
import {
  processObservation,
  processSummary,
  type SessionContext,
} from "../../src/worker/local-agent";

// ============================================================================
// Mock ModelManager factory
// ============================================================================

const VALID_TOOL_CALL = `<tool_call>
{"name": "create_observation", "arguments": {"type": "feature", "title": "Added user authentication", "subtitle": "OAuth2 flow implemented", "narrative": "Implemented OAuth2 PKCE flow for user authentication", "facts": ["Uses PKCE flow", "Supports refresh tokens"], "concepts": ["what-changed"]}}
</tool_call>`;

const createMockModelManager = (
  overrides: { generateTextResponse?: string } = {},
): ModelManager => {
  const generateText = mock(
    async () => overrides.generateTextResponse ?? VALID_TOOL_CALL,
  );
  const computeEmbedding = mock(async () => new Float32Array([0.1, 0.2, 0.3]));
  const dispose = mock(async () => {});
  const getConfig = mock(
    (): ModelManagerConfig => ({
      generativeModelId: "test-model",
      embeddingModelId: "test-embed-model",
      generationUrl: serverUrl(DEFAULT_GEN_PORT),
      embeddingUrl: serverUrl(DEFAULT_EMBED_PORT),
      cacheDir: "/tmp/test-models",
    }),
  );

  return { generateText, computeEmbedding, dispose, getConfig };
};

describe("standalone processing functions", () => {
  let db: Database;

  const testContext: SessionContext = {
    claudeSessionId: "test-session-standalone",
    project: "test-project",
    promptNumber: 1,
  };

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    createSession(db, {
      claudeSessionId: "test-session-standalone",
      project: "test-project",
      userPrompt: "Help me build something",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("processObservation stores observation from model output", async () => {
    const modelManager = createMockModelManager();

    const result = await processObservation({ db, modelManager }, testContext, {
      toolName: "Edit",
      toolInput: { file_path: "/src/auth.ts", new_string: "..." },
      toolResponse: "File edited",
      cwd: "/project",
      occurredAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      const dbResult = getObservationById(db, result.value);
      expect(dbResult.ok).toBe(true);
      if (dbResult.ok && dbResult.value) {
        expect(dbResult.value.title).toBe("Added user authentication");
      }
    }
  });

  it("processObservation returns ok(null) when model skips", async () => {
    const modelManager = createMockModelManager({
      generateTextResponse: "Trivial operation, skipping.",
    });

    const result = await processObservation({ db, modelManager }, testContext, {
      toolName: "LS",
      toolInput: { path: "/tmp" },
      toolResponse: "file1.ts",
      cwd: "/project",
      occurredAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it("processObservation deduplicates similar observations", async () => {
    const modelManager = createMockModelManager();

    const first = await processObservation({ db, modelManager }, testContext, {
      toolName: "Edit",
      toolInput: { file_path: "/src/auth.ts" },
      toolResponse: "Edited",
      cwd: "/project",
      occurredAt: new Date().toISOString(),
    });
    expect(first.ok).toBe(true);

    const second = await processObservation({ db, modelManager }, testContext, {
      toolName: "Edit",
      toolInput: { file_path: "/src/auth.ts" },
      toolResponse: "Edited again",
      cwd: "/project",
      occurredAt: new Date().toISOString(),
    });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value).toBeNull();
    }
  });

  it("processSummary stores summary from tool call", async () => {
    const summaryToolCall = `<tool_call>
{"name": "create_summary", "arguments": {"request": "Add auth", "completed": "Implemented OAuth2"}}
</tool_call>`;
    const modelManager = createMockModelManager({
      generateTextResponse: summaryToolCall,
    });

    const result = await processSummary({ db, modelManager }, testContext, {
      lastUserMessage: "Add auth",
      lastAssistantMessage: "Done",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeGreaterThan(0);
    }
  });

  it("processSummary falls back when model skips tool call", async () => {
    const modelManager = createMockModelManager({
      generateTextResponse: "Implemented OAuth2 authentication.",
    });

    const result = await processSummary({ db, modelManager }, testContext, {
      lastUserMessage: "Add auth",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeGreaterThan(0);
    }
  });
});
