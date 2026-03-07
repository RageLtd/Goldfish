/**
 * Codebase map module — scans projects and generates directory summaries.
 */

export type { ScannedDirectory, ScannedFile, ScanResult } from "./scanner";
export { readFileHead, scanProject } from "./scanner";
export type { SummarizeDeps, SummarizeResult } from "./summarizer";
export { DIRECTORY_SUMMARY_TOOL, summarizeDirectories } from "./summarizer";
