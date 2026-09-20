import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { FinanceError, FinanceErrorCode, validationError } from "../domain/errors.ts";

/**
 * Passphrase handling and database-key derivation.
 *
 * buildspec.md §18 assumes Android Keystore wraps a random database key. Termux has no Keystore, so
 * the design here is the honest substitute documented in ADR 0003: the owner types a passphrase,
 * a KDF turns it into the SQLCipher key, and the key lives in process memory only while the server
 * runs. The server therefore starts **locked** — the closest available analogue of buildspec §18's
 * "Strict lock mode: require recent owner authentication to decrypt finance data".
 *
 * scrypt comes from `node:crypto`, so there is no native Argon2 dependency to compile under Termux.
 * The parameters below are stored alongside the salt so a future increase can be applied on the
 * next successful unlock without stranding existing databases (buildspec.md §18: "include
 * algorithm/version parameters, manifest checksums, and schema version").
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const KDF_ALGORITHM = "scrypt" as const;

export type KdfParams = {
  readonly algorithm: typeof KDF_ALGORITHM;
  readonly version: number;
  /** CPU/memory cost. Must be a power of two. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLengthBytes: number;
  /** Base64url-encoded random salt. */
  readonly salt: string;
};

/**
 * Current parameters: N=2^16, r=8, p=1 needs roughly 64 MiB and about a second on the S20's
 * hardware. That is a deliberate trade — unlocking happens once per server start, not per request,
 * so the cost falls on an attacker guessing passphrases rather than on the owner.
 */
export const CURRENT_KDF_VERSION = 1;
const DEFAULT_N = 1 << 16;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const DEFAULT_KEY_BYTES = 32;
const SALT_BYTES = 16;

/** scrypt needs headroom above 128*N*r bytes or it refuses to run. */
function maxmemFor(params: Pick<KdfParams, "N" | "r" | "p">): number {
  return 256 * params.N * params.r + 64 * 1024 * 1024;
}

export function newKdfParams(): KdfParams {
  return Object.freeze({
    algorithm: KDF_ALGORITHM,
    version: CURRENT_KDF_VERSION,
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    keyLengthBytes: DEFAULT_KEY_BYTES,
    salt: randomBytes(SALT_BYTES).toString("base64url"),
  });
}

export function parseKdfParams(raw: unknown): KdfParams {
  if (typeof raw !== "object" || raw === null) {
    throw validationError("KDF parameters are missing or malformed");
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.algorithm !== KDF_ALGORITHM) {
    throw validationError(`Unsupported key derivation algorithm '${String(candidate.algorithm)}'`);
  }
  const N = Number(candidate.N);
  const r = Number(candidate.r);
  const p = Number(candidate.p);
  const keyLengthBytes = Number(candidate.keyLengthBytes);
  const version = Number(candidate.version);
  const salt = String(candidate.salt ?? "");

  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) {
    throw validationError("KDF cost N must be a power of two greater than one");
  }
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) {
    throw validationError("KDF parameters r and p must be positive integers");
  }
  if (!Number.isInteger(keyLengthBytes) || keyLengthBytes < 16 || keyLengthBytes > 64) {
    throw validationError("KDF key length must be between 16 and 64 bytes");
  }
  if (salt.length === 0) throw validationError("KDF salt is missing");

  return Object.freeze({ algorithm: KDF_ALGORITHM, version, N, r, p, keyLengthBytes, salt });
}

/**
 * Minimum passphrase strength.
 *
 * The passphrase is the only thing between a stolen phone and the ledger, and it is also the
 * backup recovery secret (buildspec.md §18: "Use an independently recoverable password/key
 * mechanism"). A short one cannot be compensated for by any KDF parameter.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

export function assertPassphraseAcceptable(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw validationError(
      `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. It protects the ` +
        `whole database and is also the backup recovery secret.`,
      { min_length: String(MIN_PASSPHRASE_LENGTH) },
    );
  }
  if (passphrase.trim().length === 0) {
    throw validationError("The passphrase must not be only whitespace");
  }
}

/** Derives the raw database key. The result is secret: never log it, never send it anywhere. */
export async function deriveKey(passphrase: string, params: KdfParams): Promise<Buffer> {
  if (passphrase.length === 0) throw validationError("Passphrase must not be empty");
  const salt = Buffer.from(params.salt, "base64url");
  return scrypt(passphrase.normalize("NFKC"), salt, params.keyLengthBytes, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
}

/**
 * A separate verifier so a wrong passphrase gives a clean "wrong passphrase" error instead of
 * SQLCipher's generic "file is not a database". Derived from the same key material via a distinct
 * info string so it cannot be used as the encryption key itself.
 */
export async function deriveVerifier(key: Buffer): Promise<Buffer> {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", key).update("pfa/passphrase-verifier/v1").digest();
}

export function verifierMatches(expected: Buffer, actual: Buffer): boolean {
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * The searchable-fingerprint secret of buildspec.md §8: "Use an HMAC with an installation secret
 * for searchable content fingerprints." Derived from the database key so it never needs separate
 * storage, and domain-separated from the verifier.
 */
export async function deriveFingerprintSecret(key: Buffer): Promise<Buffer> {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", key).update("pfa/content-fingerprint/v1").digest();
}

/** Overwrites key material in place once it is no longer needed. */
export function wipe(buffer: Buffer): void {
  buffer.fill(0);
}

export function lockedError(message = "The database is locked. Unlock it to continue."): FinanceError {
  return new FinanceError(FinanceErrorCode.LOCKED, message);
}
