import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { validationError } from "../core/domain/errors.ts";
import type { KdfParams } from "../core/security/passphrase.ts";
import { newKdfParams, parseKdfParams } from "../core/security/passphrase.ts";

/**
 * Vault metadata: the small unencrypted file that sits beside the encrypted database.
 *
 * It holds only what is needed to *attempt* an unlock — the KDF salt and parameters, a verifier,
 * and the schema version. buildspec.md §18 forbids secrets in ordinary storage, so there is no key
 * material here: the verifier is an HMAC derived from the key, which confirms a passphrase without
 * revealing anything that could decrypt the database.
 */

export type VaultMetadata = {
  readonly version: 1;
  readonly createdAt: number;
  readonly kdf: KdfParams;
  /** Base64url HMAC used only to tell a wrong passphrase from a corrupt file. */
  readonly verifier: string;
  readonly databaseFile: string;
  /** The owner's reporting timezone, chosen at onboarding (buildspec.md §2). */
  readonly zone: string;
  readonly currency: string;
};

/**
 * Everything the app writes lives under one directory so the deploy script never touches it.
 *
 * The `turbopackIgnore` comment stops the bundler treating this as a reason to trace the entire
 * project into the server output — the path is resolved at runtime on the phone, not at build time.
 */
export function dataDirectory(): string {
  const configured = process.env.PFA_DATA_DIR;
  if (configured) return resolve(/* turbopackIgnore: true */ configured);
  return join(process.cwd(), "data");
}

export function vaultFile(): string {
  return join(dataDirectory(), "vault.json");
}

export function databaseFile(): string {
  return join(dataDirectory(), "ledger.db");
}

export function vaultExists(): boolean {
  return existsSync(vaultFile());
}

export async function readVault(): Promise<VaultMetadata> {
  const raw = await readFile(vaultFile(), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw validationError("The vault file is not valid JSON. Restore it from a backup.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw validationError(`Unsupported vault version '${String(candidate.version)}'`);
  }
  return {
    version: 1,
    createdAt: Number(candidate.createdAt ?? 0),
    kdf: parseKdfParams(candidate.kdf),
    verifier: String(candidate.verifier ?? ""),
    databaseFile: String(candidate.databaseFile ?? databaseFile()),
    zone: String(candidate.zone ?? "Asia/Colombo"),
    currency: String(candidate.currency ?? "LKR"),
  };
}

/** Writes atomically so an interrupted write cannot leave an unreadable vault behind. */
export async function writeVault(metadata: VaultMetadata): Promise<void> {
  const target = vaultFile();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

export function freshVault(input: {
  verifier: string;
  zone: string;
  currency: string;
}): VaultMetadata {
  return {
    version: 1,
    createdAt: Date.now(),
    kdf: newKdfParams(),
    verifier: input.verifier,
    databaseFile: databaseFile(),
    zone: input.zone,
    currency: input.currency,
  };
}
