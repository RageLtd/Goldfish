/**
 * LLM-based summarization for codebase map entries.
 * Generates directory-level summaries by batching file previews
 * into a single llama.cpp call per directory.
 */

import type { Database } from "bun:sqlite";
import { sep } from "node:path";
import { upsertMapEntry } from "../db/codebase-map";
import type { ModelManager, ToolDefinition } from "../models/manager";
import { parseGenericToolCall } from "../models/tool-call-parser";
import type { ScannedDirectory } from "./scanner";
import { readFileHead } from "./scanner";

// ============================================================================
// Types
// ============================================================================

export interface SummarizeResult {
  readonly directoriesProcessed: number;
  readonly filesIndexed: number;
  readonly errors: number;
}

export interface SummarizeDeps {
  readonly db: Database;
  readonly modelManager: ModelManager;
  readonly projectRoot: string;
  readonly project: string;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const DIRECTORY_SUMMARY_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "summarize_directory",
    description: "Provide a concise summary of what a directory contains.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "One-line summary of the directory's purpose and contents (max 100 chars)",
        },
      },
      required: ["summary"],
    },
  },
};

// ============================================================================
// Prompts
// ============================================================================

const buildDirectorySummaryPrompt = (
  dirPath: string,
  filePreviews: readonly { name: string; head: string | null }[],
): { system: string; user: string } => {
  const system = `You summarize code directories in one concise line.
Focus on PURPOSE — what does this directory do, not what files it contains.
Call summarize_directory with a summary under 100 characters.
Your summary must be SPECIFIC to this directory. Do NOT reuse generic phrases.

Examples of GOOD summaries:
- "Unit tests for database query and migration modules"
- "React components for the user settings dashboard"
- "CLI entry point and subcommand routing"

Examples of BAD summaries:
- "Contains handler files for various operations"
- "Directory with source code files"`;

  const fileList = filePreviews
    .map((f) => {
      const preview = f.head ? `\n${f.head}` : "";
      return `--- ${f.name}${preview}`;
    })
    .join("\n\n");

  const user = `Directory: ${dirPath}/\n\nFiles:\n${fileList}`;

  return { system, user };
};

// ============================================================================
// Summarization
// ============================================================================

const log = (msg: string) => console.log(`[summarizer] ${msg}`);

/**
 * Summarizes a batch of directories, storing results in the DB.
 * Each directory gets one LLM call with file previews as context.
 * Files are indexed (path + hash) without individual summaries.
 */
export const summarizeDirectories = async (
  deps: SummarizeDeps,
  directories: readonly ScannedDirectory[],
): Promise<SummarizeResult> => {
  const { db, modelManager, projectRoot, project } = deps;
  let directoriesProcessed = 0;
  let filesIndexed = 0;
  let errors = 0;

  // Track summaries to detect hallucinated duplicates
  const summaryCounts = new Map<string, number>();

  for (const dir of directories) {
    // Index individual files (no LLM needed — just path + hash)
    for (const file of dir.files) {
      const result = upsertMapEntry(db, {
        project,
        path: file.relativePath,
        type: "file",
        summary: null,
        fileHash: file.hash,
      });
      if (result.ok) {
        filesIndexed++;
      } else {
        errors++;
      }
    }

    // Build file previews for the directory summary
    const filePreviews = await Promise.all(
      dir.files.map(async (f) => ({
        name: f.relativePath.split("/").pop() || f.relativePath,
        head: await readFileHead(`${projectRoot}${sep}${f.relativePath}`, 10),
      })),
    );

    // Generate directory summary via LLM
    const { system, user } = buildDirectorySummaryPrompt(
      dir.relativePath,
      filePreviews,
    );

    try {
      const response = await modelManager.generateText(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        [DIRECTORY_SUMMARY_TOOL],
      );

      const toolCall = parseGenericToolCall(response);
      let summary =
        typeof toolCall?.arguments?.summary === "string"
          ? toolCall.arguments.summary
          : undefined;

      // Discard hallucinated duplicates — if 3+ dirs get the same summary, it's bogus
      if (summary) {
        const normalized = summary.toLowerCase().trim();
        const count = (summaryCounts.get(normalized) ?? 0) + 1;
        summaryCounts.set(normalized, count);
        if (count >= 3) {
          log(
            `Discarding repeated summary for ${dir.relativePath}/: "${summary}"`,
          );
          summary = undefined;
        }
      }

      upsertMapEntry(db, {
        project,
        path: dir.relativePath,
        type: "directory",
        summary: summary || null,
        fileHash: null,
      });

      directoriesProcessed++;

      if (summary) {
        log(`${dir.relativePath}/ — ${summary}`);
      } else {
        log(`${dir.relativePath}/ — (no summary generated)`);
      }
    } catch (e) {
      log(
        `Error summarizing ${dir.relativePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
      // Still index the directory entry without a summary
      upsertMapEntry(db, {
        project,
        path: dir.relativePath,
        type: "directory",
        summary: null,
        fileHash: null,
      });
      errors++;
    }
  }

  return { directoriesProcessed, filesIndexed, errors };
};
