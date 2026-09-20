import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Db } from "../core/data/driver.ts";
import { openEncryptedDatabase } from "../core/data/driver.ts";
import { migrate } from "../core/data/migrations.ts";
import { FinanceError, FinanceErrorCode, validationError } from "../core/domain/errors.ts";
import { requireCurrency } from "../core/domain/money.ts";
import { requireZone } from "../core/domain/time.ts";
import {
  assertPassphraseAcceptable,
  deriveKey,
  deriveVerifier,
  lockedError,
  verifierMatches,
  wipe,
} from "../core/security/passphrase.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import { createFinanceService } from "../core/services/finance-service.ts";
import type { VaultMetadata } from "./vault.ts";
import { databaseFile, freshVault, readVault, vaultExists, writeVault } from "./vault.ts";

/**
 * The process-wide lock state.
 *
 * buildspec.md §18 describes two options and forbids pretending to have both mandatory
 * authentication and fully unattended processing. This deployment takes the strict one: the server
 * starts **locked**, the key exists only in memory after the owner unlocks, and a restart locks it
 * again. ADR 0003 records the trade — background SMS polling cannot run while locked.
 */

type LockedState = { readonly status: "locked"; readonly reason?: string | undefined };
type UnlockedState = {
  readonly status: "unlocked";
  readonly db: Db;
  readonly service: FinanceService;
  readonly vault: VaultMetadata;
  readonly unlockedAt: number;
  readonly sessionToken: Buffer;
};

type RuntimeState = LockedState | UnlockedState;

/*
 * Next.js can reload modules in development, which would otherwise drop the unlocked handle and
 * force a re-unlock on every edit. Parking it on globalThis keeps one instance per process.
 */
const GLOBAL_KEY = Symbol.for("pfa.runtime.state");
type GlobalWithRuntime = typeof globalThis & { [GLOBAL_KEY]?: RuntimeState };
const globalRef = globalThis as GlobalWithRuntime;

function current(): RuntimeState {
  return globalRef[GLOBAL_KEY] ?? { status: "locked" };
}

function set(state: RuntimeState): void {
  globalRef[GLOBAL_KEY] = state;
}

export function isUnlocked(): boolean {
  return current().status === "unlocked";
}

export function isInitialised(): boolean {
  return vaultExists();
}

/** Returns the service, or throws LOCKED. Every server action starts here. */
export function requireService(): FinanceService {
  const state = current();
  if (state.status !== "unlocked") throw lockedError();
  return state.service;
}

export function currentVault(): VaultMetadata | undefined {
  const state = current();
  return state.status === "unlocked" ? state.vault : undefined;
}

/** The opaque token handed to the browser cookie; compared in constant time. */
export function sessionTokenHex(): string {
  const state = current();
  if (state.status !== "unlocked") throw lockedError();
  return state.sessionToken.toString("hex");
}

export function sessionMatches(tokenHex: string | undefined): boolean {
  const state = current();
  if (state.status !== "unlocked" || !tokenHex) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(tokenHex, "hex");
  } catch {
    return false;
  }
  if (provided.length !== state.sessionToken.length) return false;
  return timingSafeEqual(provided, state.sessionToken);
}

/**
 * First-run setup: creates the vault and the encrypted database.
 *
 * buildspec.md §19.A: the owner chooses currency and timezone before anything else, and §18
 * requires the passphrase to be independently recoverable — it is also the backup secret, which is
 * why the caller must have shown that warning before getting here.
 */
export async function initialise(input: {
  passphrase: string;
  zone: string;
  currency: string;
}): Promise<void> {
  if (vaultExists()) {
    throw validationError("This device already has a vault. Unlock it instead.");
  }
  assertPassphraseAcceptable(input.passphrase);
  const zone = requireZone(input.zone);
  const currency = requireCurrency(input.currency);

  const vault = freshVault({ verifier: "", zone, currency: currency.code });
  const key = await deriveKey(input.passphrase, vault.kdf);
  const verifier = (await deriveVerifier(key)).toString("base64url");
  const stored: VaultMetadata = { ...vault, verifier };

  const db = await openEncryptedDatabase({ file: databaseFile(), key });
  wipe(key);
  migrate(db);

  const service = createFinanceService({ db, zone });
  service.seedDefaultCategories();

  await writeVault(stored);
  set({
    status: "unlocked",
    db,
    service,
    vault: stored,
    unlockedAt: Date.now(),
    sessionToken: randomBytes(32),
  });
}

/**
 * Unlocks an existing vault.
 *
 * The verifier is checked before SQLCipher is handed the key so a wrong passphrase produces "that
 * passphrase is wrong" rather than a driver-level error about a corrupt file.
 */
export async function unlock(passphrase: string): Promise<void> {
  if (current().status === "unlocked") return;
  if (!vaultExists()) {
    throw validationError("No vault on this device yet. Run setup first.");
  }

  const vault = await readVault();
  const key = await deriveKey(passphrase, vault.kdf);
  const verifier = await deriveVerifier(key);

  if (!verifierMatches(Buffer.from(vault.verifier, "base64url"), verifier)) {
    wipe(key);
    throw new FinanceError(FinanceErrorCode.LOCKED, "That passphrase is not correct.");
  }

  const db = await openEncryptedDatabase({ file: vault.databaseFile, key });
  wipe(key);
  migrate(db);

  set({
    status: "unlocked",
    db,
    service: createFinanceService({ db, zone: vault.zone }),
    vault,
    unlockedAt: Date.now(),
    sessionToken: randomBytes(32),
  });
}

/** buildspec.md §18: "a manual 'Lock now'". Drops the key and closes the database. */
export function lock(reason?: string): void {
  const state = current();
  if (state.status === "unlocked") {
    try {
      state.db.close();
    } catch {
      // Closing is best-effort; the key is dropped either way.
    }
    wipe(state.sessionToken);
  }
  set({ status: "locked", reason });
}

export function unlockedSince(): number | undefined {
  const state = current();
  return state.status === "unlocked" ? state.unlockedAt : undefined;
}
