/**
 * Prune CLI command — finds and optionally deletes low-value observations.
 * Opens DB directly, no worker needed. Dry-run by default.
 */

import { DEFAULT_DB_PATH } from "../constants";
import {
  createDatabase,
  deleteObservations,
  findAllObservations,
  runMigrations,
} from "../db/index";
import {
  getLowValueReasons,
  isLowValueObservation,
} from "../utils/observation-quality";

const DB_PATH = process.env.GOLDFISH_DB || DEFAULT_DB_PATH;

const log = (msg: string) => console.log(`[prune] ${msg}`);

export const main = async (): Promise<void> => {
  const args = process.argv.slice(3);
  const execute = args.includes("--execute");
  const projectIdx = args.indexOf("--project");
  const project =
    projectIdx !== -1 && args[projectIdx + 1]
      ? args[projectIdx + 1]
      : undefined;

  log(`Opening database: ${DB_PATH}`);
  const db = createDatabase(DB_PATH);
  runMigrations(db);

  const fetchResult = findAllObservations(db, { project });
  if (!fetchResult.ok) {
    log(`Failed to fetch observations: ${fetchResult.error.message}`);
    db.close();
    return process.exit(1);
  }

  const allObs = fetchResult.value;
  const candidates = allObs.filter(isLowValueObservation);

  log(
    `Scanned ${allObs.length} observations${project ? ` in project "${project}"` : ""}, found ${candidates.length} low-value`,
  );

  if (candidates.length === 0) {
    log("Nothing to prune.");
    db.close();
    return;
  }

  for (const obs of candidates) {
    const reasons = getLowValueReasons(obs);
    console.log(
      `  #${obs.id} [${obs.type}] "${obs.title ?? "(no title)"}" — ${reasons.join(", ")}`,
    );
  }

  if (!execute) {
    log("Dry run complete. Re-run with --execute to delete.");
    db.close();
    return;
  }

  const ids = candidates.map((o) => o.id);
  const deleteResult = deleteObservations(db, ids);
  if (!deleteResult.ok) {
    log(`Failed to delete observations: ${deleteResult.error.message}`);
    db.close();
    return process.exit(1);
  }

  log(`Deleted ${deleteResult.value} low-value observations.`);
  db.close();
};
