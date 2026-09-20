import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { dataDirectory } from "../../server/vault.ts";

/**
 * Where backups live, and the only shape a backup file name may take.
 *
 * The pattern is shared by the action that writes the files, the list that shows them and the
 * route that serves them, so there is exactly one definition of "a backup file name". It is the
 * whole of the download route's path-traversal defence: a name that matches it contains no slash,
 * no dot-dot and no separator of any kind, so joining it to the backups directory cannot leave it.
 */
export const BACKUP_NAME_PATTERN = /^ledger-\d{8}-\d{6}\.pfa$/;

/** Under the data directory, which `.gitignore` excludes and the deploy script never touches. */
export function backupsDirectory(): string {
  return join(dataDirectory(), "backups");
}

export type BackupFile = {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAt: number;
};

/** The newest backups on this device. Anything that is not a plain, correctly named file is skipped. */
export function listBackups(limit: number): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(backupsDirectory());
  } catch {
    // No directory yet simply means no backup has been made.
    return [];
  }

  const files: BackupFile[] = [];
  for (const name of names) {
    if (!BACKUP_NAME_PATTERN.test(name)) continue;
    try {
      const stat = lstatSync(join(backupsDirectory(), name));
      if (!stat.isFile()) continue;
      files.push({ name, bytes: stat.size, modifiedAt: stat.mtimeMs });
    } catch {
      // Removed between the listing and the stat; nothing to show.
    }
  }
  /*
   * Sorted by name rather than mtime: the name is the capture time, and an mtime changes the
   * moment a file is copied back onto the device.
   */
  return files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)).slice(0, limit);
}
