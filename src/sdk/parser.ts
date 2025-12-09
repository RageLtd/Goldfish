/**
 * Pure functions for parsing XML output from the SDK agent.
 * These extract structured data from Claude's observation and summary responses.
 */

import type {
	ObservationType,
	ParsedObservation,
	ParsedSummary,
} from "../types/domain";
import { isObservationType } from "../types/domain";

/**
 * Extracts text content from a single XML tag.
 * Returns null if tag not found or content is empty/whitespace.
 */
export const extractTagContent = (
	xml: string,
	tagName: string,
): string | null => {
	const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`);
	const match = xml.match(regex);

	if (!match) {
		return null;
	}

	const content = match[1].trim();
	return content.length > 0 ? content : null;
};

/**
 * Extracts a list of items from nested XML tags.
 * Example: <facts><fact>a</fact><fact>b</fact></facts> -> ['a', 'b']
 */
export const extractTagList = (
	xml: string,
	containerTag: string,
	itemTag: string,
): readonly string[] => {
	const containerRegex = new RegExp(
		`<${containerTag}>([\\s\\S]*?)<\\/${containerTag}>`,
	);
	const containerMatch = xml.match(containerRegex);

	if (!containerMatch) {
		return [];
	}

	const containerContent = containerMatch[1];
	const itemRegex = new RegExp(`<${itemTag}>([\\s\\S]*?)<\\/${itemTag}>`, "g");
	const items: string[] = [];

	for (const match of containerContent.matchAll(itemRegex)) {
		const item = match[1].trim();
		if (item.length > 0) {
			items.push(item);
		}
	}

	return items;
};

/**
 * Parses a single observation XML block into a ParsedObservation.
 */
const parseObservationBlock = (block: string): ParsedObservation => {
	const rawType = extractTagContent(block, "type");
	const type: ObservationType =
		rawType && isObservationType(rawType) ? rawType : "change";

	const concepts = extractTagList(block, "concepts", "concept")
		// Filter out the observation type from concepts (they're separate dimensions)
		.filter((c) => c !== type);

	return {
		type,
		title: extractTagContent(block, "title"),
		subtitle: extractTagContent(block, "subtitle"),
		narrative: extractTagContent(block, "narrative"),
		facts: extractTagList(block, "facts", "fact"),
		concepts,
		filesRead: extractTagList(block, "files_read", "file"),
		filesModified: extractTagList(block, "files_modified", "file"),
	};
};

/**
 * Parses all observation blocks from SDK agent output.
 * Returns empty array if no observations found.
 */
export const parseObservations = (
	text: string,
): readonly ParsedObservation[] => {
	const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;
	const observations: ParsedObservation[] = [];

	for (const match of text.matchAll(observationRegex)) {
		observations.push(parseObservationBlock(match[1]));
	}

	return observations;
};

/**
 * Parses a summary block from SDK agent output.
 * Returns null if no summary found.
 */
export const parseSummary = (text: string): ParsedSummary | null => {
	const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
	const match = text.match(summaryRegex);

	if (!match) {
		return null;
	}

	const block = match[1];

	return {
		request: extractTagContent(block, "request"),
		investigated: extractTagContent(block, "investigated"),
		learned: extractTagContent(block, "learned"),
		completed: extractTagContent(block, "completed"),
		nextSteps: extractTagContent(block, "next_steps"),
		notes: extractTagContent(block, "notes"),
	};
};
