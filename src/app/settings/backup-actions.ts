"use server";

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createBackup } from "../../core/data/backup.ts";
import { isFinanceError } from "../../core/domain/errors.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { BACKUP_NAME_PATTERN, backupsDirectory } from "./backup-files.ts";

/**
 * Creating an encrypted backup.
 *
 * buildspec.md §18: "Create versioned encrypted backups ... Use an independently recoverable
 * password/key mechanism." The backup password is therefore its own secret, not the unlock
 * passphrase, and it is handled here exactly once: read from the form, handed to `createBackup`,
 * and never logged, stored or returned.
 *
 * buildspec.md §14.2 keeps backup out of the assistant's reach — this is an owner-only settings
 * flow behind the authenticated session, and no agent tool maps onto it.
 */

export type BackupState = {
  readonly error?: string | undefined;
  readonly ok?: string | undefined;
  readonly fileName?: string | undefined;
  /** Row counts captured in the backup's manifest, so the owner can see what it holds. */
  readonly counts?: Readonly<Record<string, number>> | undefined;
};

/** `YYYYMMDD-HHmmss` in the owner's own timezone, so the file name reads as the time they made it. */
function timestamp(instant: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}${read("month")}${read("day")}-${read("hour")}${read("minute")}${read("second")}`;
}

/*
 * Deliberately narrower than the `describe` helpers elsewhere. A FinanceError message is written
 * for the owner and is safe to show. Anything else may come from the SQLite driver while the
 * backup key is part of the statement being run, so its text is never echoed — only the
 * operating-system error code, which says "disk full" or "permission denied" and nothing more.
 */
function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const suffix = /^E[A-Z]+$/.test(code) ? ` (${code})` : "";
  return `The backup could not be written${suffix}. Nothing was changed; check free space and try again.`;
}

export async function createBackupAction(
  _prev: BackupState,
  formData: FormData,
): Promise<BackupState> {
  // Outside the try on purpose: `redirect` works by throwing, and a catch would swallow it.
  const access = await accessState();
  if (access.kind !== "ready") {
    redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  }
  const db = requireDb();
  const zone = requireService().zone;

  const backupPassphrase = String(formData.get("backupPassphrase") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (backupPassphrase !== confirm) return { error: "The two backup passwords do not match." };
  if (backupPassphrase.length < 12) {
    return { error: "The backup password must be at least 12 characters." };
  }

  let result: BackupState;
  try {
    const directory = backupsDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    const fileName = `ledger-${timestamp(Date.now(), zone)}.pfa`;
    // The download route accepts only this shape, so a name that fails it could never be fetched.
    if (!BACKUP_NAME_PATTERN.test(fileName)) {
      return { error: "Could not build a file name for the backup." };
    }
    const targetPath = join(directory, fileName);
    if (existsSync(targetPath)) {
      return { error: "A backup was already made this second. Wait a moment and try again." };
    }

    const manifest = await createBackup({ db, backupPassphrase, targetPath });
    result = { ok: "Backup created.", fileName, counts: manifest.counts };
  } catch (error) {
    return { error: describe(error) };
  }

  revalidatePath("/settings");
  return result;
}
