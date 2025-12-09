/**
 * Hook runner utilities.
 * Provides stdin/stdout handling for hook scripts.
 */

import type { HookOutput } from "../types/hooks";

const WORKER_PORT = process.env.CLAUDE_MEM_PORT || "3456";
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;

/**
 * Reads JSON from stdin.
 */
export const readStdin = async <T>(): Promise<T> => {
	const chunks: Buffer[] = [];
	for await (const chunk of Bun.stdin.stream()) {
		chunks.push(Buffer.from(chunk));
	}
	const text = Buffer.concat(chunks).toString("utf-8");
	return JSON.parse(text) as T;
};

/**
 * Writes JSON to stdout.
 */
export const writeStdout = (output: HookOutput): void => {
	console.log(JSON.stringify(output));
};

/**
 * Gets the default hook dependencies.
 */
export const getDefaultDeps = () => ({
	fetch: globalThis.fetch,
	workerUrl: WORKER_URL,
});

/**
 * Runs a hook processor with stdin/stdout handling.
 */
export const runHook = async <T>(
	processor: (
		deps: { fetch: typeof fetch; workerUrl: string },
		input: T,
	) => Promise<HookOutput>,
): Promise<void> => {
	try {
		const input = await readStdin<T>();
		const deps = getDefaultDeps();
		const output = await processor(deps, input);
		writeStdout(output);
	} catch {
		// Always return valid output so Claude Code continues
		writeStdout({
			continue: true,
			suppressOutput: true,
		});
	}
};
