import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { FinanceError, FinanceErrorCode, validationError } from "../../core/domain/errors.ts";

/**
 * Reading SMS through Termux:API.
 *
 * ADR 0004: `buildspec.md` §5.4/§5.5 describe `READ_SMS` in an app process and
 * `SMS_RECEIVED_ACTION` broadcasts. Neither exists for a Node server, so capture is
 * `termux-sms-list` polled on a schedule. The *requirements* of §5 still hold — idempotency,
 * coverage gaps, overlap scans, watermarks — and live in `sync-service.ts`.
 *
 * The important operational fact, learned the hard way on this device: `termux-sms-list` returns an
 * **empty list rather than an error** when the permission is missing. `pm grant` alone is not
 * enough; the uid's appops mode must also be `allow`. A collector that treated `[]` as "no
 * messages" would show an empty inbox forever and never say why, so an empty result is reported as
 * an explicit capability state instead.
 */

const execFileAsync = promisify(execFile);

/** Where Termux installs its binaries. Absolute, so PATH differences cannot change what runs. */
const TERMUX_BIN = "/data/data/com.termux/files/usr/bin";
const SMS_LIST = `${TERMUX_BIN}/termux-sms-list`;

export type RawSms = {
  /** `termux-sms-list`'s `_id`, the SMS provider row id. Not globally unique across restores. */
  readonly providerId: number;
  readonly threadId: number | null;
  /** The sender for an inbox message. */
  readonly address: string;
  readonly body: string;
  /** Epoch milliseconds, as the provider recorded it. */
  readonly received: number;
  readonly type: string;
  readonly read: boolean;
};

export type CollectorCapability =
  | { readonly state: "ok"; readonly sampleCount: number }
  | { readonly state: "not_termux"; readonly detail: string }
  | { readonly state: "api_missing"; readonly detail: string }
  | { readonly state: "permission_denied"; readonly detail: string }
  | { readonly state: "empty"; readonly detail: string };

export type SmsCollector = {
  /**
   * Reads one page, newest first.
   *
   * `offset` walks backwards through history; there is no date filter in `termux-sms-list`, so the
   * sync service pages until it reaches its watermark.
   */
  list(options: { limit: number; offset: number }): Promise<readonly RawSms[]>;
  /** Distinguishes "no financial messages" from "no permission", which look identical otherwise. */
  checkCapability(): Promise<CollectorCapability>;
};

export type ExecLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

function parseRows(stdout: string): RawSms[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw validationError("termux-sms-list did not return JSON", {
      sample: trimmed.slice(0, 120),
    });
  }
  if (!Array.isArray(parsed)) {
    throw validationError("termux-sms-list did not return a list");
  }

  const rows: RawSms[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    // A message with no body or no sender cannot be matched or deduplicated; skip rather than guess.
    const address = typeof row.number === "string" ? row.number : String(row.address ?? "");
    const body = typeof row.body === "string" ? row.body : "";
    if (address.length === 0 || body.length === 0) continue;

    /*
     * `received` is a local wall-clock string on this build ("2026-09-20 18:42:11"), not an epoch.
     * Parsing it as local time is correct: it came from the same device whose clock we are reading.
     */
    const receivedRaw = row.received;
    const received =
      typeof receivedRaw === "number"
        ? receivedRaw
        : typeof receivedRaw === "string"
          ? Date.parse(receivedRaw.replace(" ", "T"))
          : Number.NaN;
    if (!Number.isFinite(received)) continue;

    const providerId = Number(row._id ?? row.id ?? Number.NaN);
    if (!Number.isFinite(providerId)) continue;

    rows.push({
      providerId,
      threadId: Number.isFinite(Number(row.threadid)) ? Number(row.threadid) : null,
      address,
      body,
      received,
      type: String(row.type ?? "inbox"),
      read: row.read === true,
    });
  }
  return rows;
}

export function createTermuxSmsCollector(options: { exec?: ExecLike } = {}): SmsCollector {
  const exec: ExecLike =
    options.exec ??
    ((file, args, opts) => execFileAsync(file, [...args], opts) as Promise<{ stdout: string; stderr: string }>);

  async function run(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await exec(SMS_LIST, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT/.test(message)) {
        throw new FinanceError(
          FinanceErrorCode.UNSUPPORTED_OPERATION,
          "termux-sms-list is not installed. Run `pkg install termux-api` in Termux, and install " +
            "the Termux:API app from F-Droid. See docs/termux-setup.md.",
          { binary: SMS_LIST },
        );
      }
      throw new FinanceError(
        FinanceErrorCode.UNSUPPORTED_OPERATION,
        `Could not read SMS: ${message.slice(0, 200)}`,
      );
    }
  }

  return {
    async list({ limit, offset }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw validationError("SMS page size must be between 1 and 500");
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw validationError("SMS page offset must not be negative");
      }
      // Inbox only. buildspec.md §5.4: "outgoing payment instructions are not proof of payment."
      return parseRows(await run(["-l", String(limit), "-o", String(offset), "-t", "inbox"]));
    },

    async checkCapability() {
      let stdout: string;
      try {
        stdout = await run(["-l", "1", "-t", "inbox"]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/not installed/.test(detail)) return { state: "api_missing", detail };
        return { state: "not_termux", detail };
      }

      const rows = parseRows(stdout);
      if (rows.length > 0) return { state: "ok", sampleCount: rows.length };

      /*
       * The silent-failure case. Both of these are required, and granting only the first leaves
       * `termux-sms-list` returning `[]` with exit code 0:
       *
       *   adb shell pm grant com.termux.api android.permission.READ_SMS
       *   adb shell appops set com.termux.api READ_SMS allow
       */
      return {
        state: "permission_denied",
        detail:
          "termux-sms-list returned no messages and no error. That usually means READ_SMS is not " +
          "fully granted: `pm grant` on its own leaves the appops mode at `ignore`, which returns " +
          "an empty list instead of an error. Run both commands in docs/termux-setup.md, then " +
          "check again. If the inbox really is empty, this will keep reporting the same thing.",
      };
    },
  };
}

/** A collector backed by fixed rows, for tests and for the file-import path. */
export function createStaticSmsCollector(rows: readonly RawSms[]): SmsCollector {
  const newestFirst = [...rows].sort((a, b) => b.received - a.received || b.providerId - a.providerId);
  return {
    async list({ limit, offset }) {
      return newestFirst.slice(offset, offset + limit);
    },
    async checkCapability() {
      return newestFirst.length > 0
        ? { state: "ok", sampleCount: Math.min(1, newestFirst.length) }
        : { state: "empty", detail: "No messages in this collector" };
    },
  };
}
