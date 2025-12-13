#!/usr/bin/env bun
/**
 * Automatic semantic versioning based on conventional commits.
 *
 * Usage:
 *   bun scripts/release.ts [--dry-run] [--no-tag] [--no-commit]
 *
 * Commit prefixes and their version bumps:
 *   - feat!:, fix!:, BREAKING CHANGE: → major
 *   - feat: → minor
 *   - fix:, refactor:, test:, style:, perf:, ci:, build:, revert: → patch
 *   - docs:, chore: → no release (internal changes)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

type BumpType = "major" | "minor" | "patch" | "none";

interface Commit {
	readonly hash: string;
	readonly message: string;
	readonly type: string;
	readonly breaking: boolean;
}

interface ReleaseOptions {
	readonly dryRun: boolean;
	readonly noTag: boolean;
	readonly noCommit: boolean;
}

// ============================================================================
// Git Helpers
// ============================================================================

const exec = (cmd: string): string => {
	try {
		return execSync(cmd, { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
};

const getLastTag = (): string | null => {
	const tag = exec("git describe --tags --abbrev=0 2>/dev/null");
	return tag || null;
};

const getCommitsSinceTag = (tag: string | null): Commit[] => {
	const range = tag ? `${tag}..HEAD` : "HEAD";
	const format = "%H|%s"; // hash|subject
	const log = exec(`git log ${range} --format="${format}"`);

	if (!log) return [];

	return log
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, ...rest] = line.split("|");
			const message = rest.join("|");
			const { type, breaking } = parseCommitMessage(message);
			return { hash, message, type, breaking };
		});
};

// ============================================================================
// Conventional Commit Parsing
// ============================================================================

// All recognized conventional commit types
const COMMIT_TYPES = [
	"feat",
	"fix",
	"docs",
	"chore",
	"refactor",
	"test",
	"style",
	"perf",
	"ci",
	"build",
	"revert",
];

// Types that trigger a patch release (excludes docs, chore - internal changes)
const RELEASE_TRIGGER_TYPES = [
	"fix",
	"refactor",
	"test",
	"style",
	"perf",
	"ci",
	"build",
	"revert",
];

const parseCommitMessage = (
	message: string,
): { type: string; breaking: boolean } => {
	// Check for breaking change indicators
	const breaking =
		message.includes("BREAKING CHANGE") ||
		message.includes("BREAKING-CHANGE") ||
		/^[a-z]+!:/i.test(message);

	// Extract commit type
	const match = message.match(/^([a-z]+)(!)?(\(.+\))?:/i);
	const type = match?.[1]?.toLowerCase() || "other";

	return { type, breaking };
};

const determineBumpType = (commits: Commit[]): BumpType => {
	if (commits.length === 0) return "none";

	let hasBreaking = false;
	let hasFeature = false;
	let hasPatchTrigger = false;

	for (const commit of commits) {
		if (commit.breaking) {
			hasBreaking = true;
		}
		if (commit.type === "feat") {
			hasFeature = true;
		}
		// Only certain types trigger a patch release (not docs, chore)
		if (RELEASE_TRIGGER_TYPES.includes(commit.type)) {
			hasPatchTrigger = true;
		}
	}

	if (hasBreaking) return "major";
	if (hasFeature) return "minor";
	if (hasPatchTrigger) return "patch";

	return "none";
};

// ============================================================================
// Version Helpers
// ============================================================================

const parseVersion = (version: string): [number, number, number] => {
	const [major, minor, patch] = version
		.replace(/^v/, "")
		.split(".")
		.map(Number);
	return [major || 0, minor || 0, patch || 0];
};

const bumpVersion = (version: string, bumpType: BumpType): string => {
	const [major, minor, patch] = parseVersion(version);

	switch (bumpType) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
		default:
			return version;
	}
};

// ============================================================================
// Package.json Helpers
// ============================================================================

const getPackageJson = (): { version: string; [key: string]: unknown } => {
	const pkgPath = join(process.cwd(), "package.json");
	const content = readFileSync(pkgPath, "utf-8");
	return JSON.parse(content);
};

const updatePackageJson = (newVersion: string): void => {
	const pkgPath = join(process.cwd(), "package.json");
	const content = readFileSync(pkgPath, "utf-8");
	const pkg = JSON.parse(content);
	pkg.version = newVersion;
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
};

// ============================================================================
// Release Actions
// ============================================================================

const createCommit = (version: string): void => {
	exec(`git add package.json`);
	exec(`git commit -m "chore(release): v${version}"`);
};

const createTag = (version: string): void => {
	exec(`git tag -a v${version} -m "Release v${version}"`);
};

// ============================================================================
// Main
// ============================================================================

const parseArgs = (): ReleaseOptions => {
	const args = process.argv.slice(2);
	return {
		dryRun: args.includes("--dry-run"),
		noTag: args.includes("--no-tag"),
		noCommit: args.includes("--no-commit"),
	};
};

const formatCommitList = (commits: Commit[]): string => {
	const grouped: Record<string, Commit[]> = {};

	for (const commit of commits) {
		const type = commit.type || "other";
		grouped[type] = grouped[type] || [];
		grouped[type].push(commit);
	}

	const lines: string[] = [];
	for (const [type, typeCommits] of Object.entries(grouped)) {
		lines.push(`\n  ${type}:`);
		for (const c of typeCommits) {
			const breaking = c.breaking ? " [BREAKING]" : "";
			lines.push(`    - ${c.message.substring(0, 60)}${breaking}`);
		}
	}

	return lines.join("\n");
};

const main = (): void => {
	const options = parseArgs();

	console.log("[release] Analyzing commits...\n");

	// Get current version
	const pkg = getPackageJson();
	const currentVersion = pkg.version;

	// Get commits since last tag
	const lastTag = getLastTag();
	const commits = getCommitsSinceTag(lastTag);

	if (commits.length === 0) {
		console.log("[release] No commits since last release. Nothing to do.");
		return;
	}

	// Determine bump type
	const bumpType = determineBumpType(commits);

	if (bumpType === "none") {
		console.log("[release] No version-bumping commits found. Nothing to do.");
		return;
	}

	// Calculate new version
	const newVersion = bumpVersion(currentVersion, bumpType);

	// Display summary
	console.log(`[release] Last tag: ${lastTag || "(none)"}`);
	console.log(`[release] Commits analyzed: ${commits.length}`);
	console.log(formatCommitList(commits));
	console.log("");
	console.log(`[release] Bump type: ${bumpType}`);
	console.log(`[release] Version: ${currentVersion} → ${newVersion}`);
	console.log("");

	if (options.dryRun) {
		console.log("[release] Dry run - no changes made.");
		return;
	}

	// Update package.json
	console.log("[release] Updating package.json...");
	updatePackageJson(newVersion);

	// Create commit
	if (!options.noCommit) {
		console.log("[release] Creating release commit...");
		createCommit(newVersion);
	}

	// Create tag
	if (!options.noTag && !options.noCommit) {
		console.log("[release] Creating git tag...");
		createTag(newVersion);
	}

	console.log("");
	console.log(`[release] Released v${newVersion}`);

	if (!options.noTag && !options.noCommit) {
		console.log("[release] Run 'git push --follow-tags' to publish.");
	}
};

main();
