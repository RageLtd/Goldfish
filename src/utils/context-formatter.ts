/**
 * Context formatting utilities for progressive disclosure.
 * Provides index (lightweight) and full (detailed) formatters.
 */

import type { Observation, SessionSummary } from "../types/domain";
import { formatTime } from "./temporal";

// ============================================================================
// Constants
// ============================================================================

/** Type icons for observations */
export const TYPE_ICONS: Record<string, string> = {
	decision: "⚖️",
	bugfix: "🔴",
	feature: "🟣",
	refactor: "🔄",
	discovery: "🔵",
	change: "✅",
	session: "🎯",
};

/** Work type icons based on discoveryTokens source */
export const WORK_ICONS: Record<string, string> = {
	research: "🔍",
	building: "🛠️",
	deciding: "⚖️",
};

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimates tokens for a string (rough: ~4 chars = 1 token).
 */
export const estimateTokens = (text: string | null | undefined): number => {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
};

/**
 * Estimates read tokens for an observation (cost to fetch full content).
 */
export const estimateObservationTokens = (obs: Observation): number => {
	return (
		estimateTokens(obs.title) +
		estimateTokens(obs.subtitle) +
		estimateTokens(obs.narrative) +
		estimateTokens(obs.facts.join(" ")) +
		estimateTokens(obs.concepts.join(" ")) +
		estimateTokens(obs.filesRead.join(" ")) +
		estimateTokens(obs.filesModified.join(" "))
	);
};

/**
 * Estimates read tokens for a summary.
 */
export const estimateSummaryTokens = (summary: SessionSummary): number => {
	return (
		estimateTokens(summary.request) +
		estimateTokens(summary.investigated) +
		estimateTokens(summary.learned) +
		estimateTokens(summary.completed) +
		estimateTokens(summary.nextSteps) +
		estimateTokens(summary.notes)
	);
};

/**
 * Estimates total index tokens (lightweight metadata only).
 */
export const estimateIndexTokens = (
	observations: readonly Observation[],
	summaries: readonly SessionSummary[],
): number => {
	// ~20 tokens per index row + header/legend overhead
	return observations.length * 20 + summaries.length * 15 + 150;
};

// ============================================================================
// Date Grouping
// ============================================================================

export interface DateGroup {
	readonly label: string;
	readonly items: readonly Observation[];
}

/**
 * Groups observations by date: Today, Yesterday, This Week, Older.
 */
export const groupByDate = (
	observations: readonly Observation[],
): readonly DateGroup[] => {
	const today = new Date().setHours(0, 0, 0, 0);
	const yesterday = today - 86400000;
	const weekAgo = today - 604800000;

	const groups = new Map<string, Observation[]>();
	groups.set("Today", []);
	groups.set("Yesterday", []);
	groups.set("This Week", []);
	groups.set("Older", []);

	for (const obs of observations) {
		const epoch = obs.createdAtEpoch;
		const key =
			epoch >= today
				? "Today"
				: epoch >= yesterday
					? "Yesterday"
					: epoch >= weekAgo
						? "This Week"
						: "Older";

		groups.get(key)?.push(obs);
	}

	// Return only non-empty groups
	return Array.from(groups.entries())
		.filter(([_, items]) => items.length > 0)
		.map(([label, items]) => ({ label, items }));
};

// ============================================================================
// File Grouping
// ============================================================================

export interface FileGroup {
	readonly filePath: string;
	readonly items: readonly Observation[];
}

/**
 * Groups observations by primary file (first in filesRead or filesModified).
 */
export const groupByFile = (
	observations: readonly Observation[],
): readonly FileGroup[] => {
	const groups = new Map<string, Observation[]>();

	for (const obs of observations) {
		// Get primary file: first modified, or first read, or "General"
		const primaryFile = obs.filesModified[0] || obs.filesRead[0] || "General";

		if (!groups.has(primaryFile)) {
			groups.set(primaryFile, []);
		}
		groups.get(primaryFile)?.push(obs);
	}

	// Sort by number of items (most active files first)
	return Array.from(groups.entries())
		.sort((a, b) => b[1].length - a[1].length)
		.map(([filePath, items]) => ({ filePath, items }));
};

// ============================================================================
// Index Formatting
// ============================================================================

/**
 * Gets work icon based on observation type.
 */
const getWorkIcon = (type: string): string => {
	switch (type) {
		case "discovery":
			return WORK_ICONS.research;
		case "decision":
			return WORK_ICONS.deciding;
		default:
			return WORK_ICONS.building;
	}
};

/**
 * Formats a single observation as an index table row.
 */
export const formatObservationIndexRow = (obs: Observation): string => {
	const icon = TYPE_ICONS[obs.type] || "📝";
	const time = formatTime(obs.createdAtEpoch);
	const title = obs.title || "Untitled";
	const readTokens = estimateObservationTokens(obs);
	const workIcon = getWorkIcon(obs.type);
	const workTokens = obs.discoveryTokens || 0;

	return `| #${obs.id} | ${time} | ${icon} | ${title} | ~${readTokens} | ${workIcon} ${workTokens.toLocaleString()} |`;
};

/**
 * Formats a summary as an index table row.
 */
export const formatSummaryIndexRow = (summary: SessionSummary): string => {
	const icon = TYPE_ICONS.session;
	const time = formatTime(summary.createdAtEpoch);
	const title = summary.request || "Session summary";
	const readTokens = estimateSummaryTokens(summary);
	const workTokens = summary.discoveryTokens || 0;

	return `| #S${summary.id} | ${time} | ${icon} | ${title} | ~${readTokens} | 🔍 ${workTokens.toLocaleString()} |`;
};

/**
 * Formats the legend section.
 */
const formatLegend = (): string => {
	return "**Legend:** 🎯 session | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | ⚖️ decision";
};

/**
 * Formats the table header.
 */
const formatTableHeader = (): string => {
	return `| ID | Time | T | Title | Read | Work |
|----|------|---|-------|------|------|`;
};

/**
 * Formats budget/economics summary.
 */
export const formatBudgetSummary = (
	observations: readonly Observation[],
	summaries: readonly SessionSummary[],
): string => {
	const indexTokens = estimateIndexTokens(observations, summaries);
	const workTokens = observations.reduce(
		(sum, o) => sum + (o.discoveryTokens || 0),
		0,
	);
	const summaryWorkTokens = summaries.reduce(
		(sum, s) => sum + (s.discoveryTokens || 0),
		0,
	);
	const totalWork = workTokens + summaryWorkTokens;

	return `📊 **Context Economics**:
- Loading: ${observations.length} observations (${indexTokens.toLocaleString()} tokens to read)
- Work investment: ${totalWork.toLocaleString()} tokens spent on research, building, and decisions
- Your savings: ${(totalWork - indexTokens).toLocaleString()} tokens (${Math.round(((totalWork - indexTokens) / totalWork) * 100)}% reduction from reuse)`;
};

/**
 * Formats context as lightweight index (progressive disclosure tier 1).
 */
export const formatContextIndex = (
	project: string,
	observations: readonly Observation[],
	summaries: readonly SessionSummary[],
): string => {
	const parts: string[] = [];

	parts.push(`# [${project}] recent context\n`);
	parts.push(formatLegend());
	parts.push("");
	parts.push(
		"💡 **Column Key**:",
		"- **Read**: Tokens to read this observation (cost to learn it now)",
		"- **Work**: Tokens spent on work that produced this record (🔍 research, 🛠️ building, ⚖️ deciding)",
	);
	parts.push("");
	parts.push(
		"💡 **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.",
	);
	parts.push("");
	parts.push(
		"When you need implementation details, rationale, or debugging context:",
		"- Use the mem-search skill to fetch full observations on-demand",
		"- Critical types (🔴 bugfix, ⚖️ decision) often need detailed fetching",
		"- Trust this index over re-reading code for past decisions and learnings",
	);
	parts.push("");
	parts.push(formatBudgetSummary(observations, summaries));
	parts.push("");

	// Group summaries first (session context)
	if (summaries.length > 0) {
		const dateGroups = groupSummariesByDate(summaries);
		for (const group of dateGroups) {
			parts.push(`### ${group.label}\n`);
			for (const summary of group.items) {
				parts.push(formatSummaryIndexRow(summary));
			}
			parts.push("");
		}
	}

	// Group observations by date, then by file within each date
	const dateGroups = groupByDate(observations);
	for (const dateGroup of dateGroups) {
		parts.push(`### ${dateGroup.label}\n`);

		const fileGroups = groupByFile(dateGroup.items);
		for (const fileGroup of fileGroups) {
			parts.push(`**${fileGroup.filePath}**`);
			parts.push(formatTableHeader());
			for (const obs of fileGroup.items) {
				parts.push(formatObservationIndexRow(obs));
			}
			parts.push("");
		}
	}

	parts.push(
		"💰 Access " +
			formatWorkTotal(observations, summaries) +
			" of past research & decisions for just " +
			estimateIndexTokens(observations, summaries).toLocaleString() +
			"t. Use the mem-search skill to access memories by ID instead of re-reading files.",
	);

	return parts.join("\n");
};

/**
 * Groups summaries by date.
 */
const groupSummariesByDate = (
	summaries: readonly SessionSummary[],
): readonly { label: string; items: SessionSummary[] }[] => {
	const today = new Date().setHours(0, 0, 0, 0);
	const yesterday = today - 86400000;

	const groups = new Map<string, SessionSummary[]>();

	for (const summary of summaries) {
		const epoch = summary.createdAtEpoch;
		const date = new Date(epoch);
		const label =
			epoch >= today
				? `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
				: epoch >= yesterday
					? "Yesterday"
					: date.toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
							year: "numeric",
						});

		if (!groups.has(label)) {
			groups.set(label, []);
		}
		groups.get(label)?.push(summary);
	}

	return Array.from(groups.entries()).map(([label, items]) => ({
		label,
		items,
	}));
};

/**
 * Formats total work tokens.
 */
const formatWorkTotal = (
	observations: readonly Observation[],
	summaries: readonly SessionSummary[],
): string => {
	const total =
		observations.reduce((sum, o) => sum + (o.discoveryTokens || 0), 0) +
		summaries.reduce((sum, s) => sum + (s.discoveryTokens || 0), 0);

	if (total >= 1000000) {
		return `${(total / 1000000).toFixed(1)}m tokens`;
	}
	if (total >= 1000) {
		return `${Math.round(total / 1000)}k tokens`;
	}
	return `${total} tokens`;
};

// ============================================================================
// Full Format (existing behavior)
// ============================================================================

/**
 * Formats context with full details (progressive disclosure tier 2).
 */
export const formatContextFull = (
	project: string,
	observations: readonly Observation[],
	summaries: readonly SessionSummary[],
): string => {
	const parts: string[] = [`# ${project} recent context\n`];

	if (summaries.length > 0) {
		parts.push("## Recent Session Summaries\n");
		for (const s of summaries) {
			if (s.request) parts.push(`- Request: ${s.request}`);
			if (s.completed) parts.push(`  Completed: ${s.completed}`);
			if (s.learned) parts.push(`  Learned: ${s.learned}`);
		}
	}

	if (observations.length > 0) {
		parts.push("\n## Recent Observations\n");
		for (const o of observations) {
			if (o.title) parts.push(`- [${o.type}] ${o.title}`);
			if (o.narrative) parts.push(`  ${o.narrative}`);
		}
	}

	return parts.join("\n");
};

// ============================================================================
// Single Observation Formatting
// ============================================================================

/**
 * Formats a single observation with full details.
 */
export const formatObservationFull = (obs: Observation): string => {
	const parts: string[] = [];
	const icon = TYPE_ICONS[obs.type] || "📝";

	parts.push(`## ${icon} ${obs.title || "Untitled"}`);
	parts.push(`**Type:** ${obs.type} | **ID:** #${obs.id}`);
	parts.push(`**Created:** ${new Date(obs.createdAtEpoch).toLocaleString()}`);
	parts.push("");

	if (obs.subtitle) {
		parts.push(`*${obs.subtitle}*\n`);
	}

	if (obs.narrative) {
		parts.push(obs.narrative);
		parts.push("");
	}

	if (obs.facts.length > 0) {
		parts.push("**Facts:**");
		for (const fact of obs.facts) {
			parts.push(`- ${fact}`);
		}
		parts.push("");
	}

	if (obs.concepts.length > 0) {
		parts.push(`**Concepts:** ${obs.concepts.join(", ")}`);
		parts.push("");
	}

	if (obs.filesRead.length > 0) {
		parts.push(`**Files Read:** ${obs.filesRead.join(", ")}`);
	}

	if (obs.filesModified.length > 0) {
		parts.push(`**Files Modified:** ${obs.filesModified.join(", ")}`);
	}

	return parts.join("\n");
};
