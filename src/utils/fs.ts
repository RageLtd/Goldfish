/**
 * Filesystem utilities for cross-platform directory and path operations.
 */

import { dirname, join } from "node:path";

/**
 * Ensures the parent directory of a file exists by creating a .keep file.
 * Uses Bun.write which automatically creates parent directories.
 * Cross-platform: works on Unix and Windows without shell dependencies.
 *
 * @param filePath - Path to a file whose parent directory should exist
 */
export const ensureDbDir = async (filePath: string): Promise<void> => {
	const dir = dirname(filePath);
	await Bun.write(join(dir, ".keep"), "");
};
