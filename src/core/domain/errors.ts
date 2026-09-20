/**
 * Structured domain errors.
 *
 * buildspec.md §16: "Make domain errors structured and safe". These codes are the only error
 * identities that cross a service boundary. Messages attached to them are shown to the owner and
 * written to logs, so they must never carry secrets, OTPs or full raw message bodies
 * (buildspec.md §15, §18).
 */
export const FinanceErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  STALE_PROPOSAL: "STALE_PROPOSAL",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  DUPLICATE_SOURCE: "DUPLICATE_SOURCE",
  UNBALANCED_JOURNAL: "UNBALANCED_JOURNAL",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  SOURCE_REAUTH_REQUIRED: "SOURCE_REAUTH_REQUIRED",
  UNDO_CONFLICT: "UNDO_CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  UNSUPPORTED_OPERATION: "UNSUPPORTED_OPERATION",
  LOCKED: "LOCKED",
} as const;

export type FinanceErrorCode = (typeof FinanceErrorCode)[keyof typeof FinanceErrorCode];

export type ErrorDetails = Readonly<Record<string, string>>;

export class FinanceError extends Error {
  readonly code: FinanceErrorCode;
  readonly details: ErrorDetails;

  constructor(code: FinanceErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "FinanceError";
    this.code = code;
    this.details = details;
  }

  /** Safe to return over the API: no stack, no cause chain. */
  toJSON(): { code: FinanceErrorCode; message: string; details: ErrorDetails } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function validationError(message: string, details: ErrorDetails = {}): FinanceError {
  return new FinanceError(FinanceErrorCode.VALIDATION_ERROR, message, details);
}

export function unbalancedJournal(message: string, details: ErrorDetails = {}): FinanceError {
  return new FinanceError(FinanceErrorCode.UNBALANCED_JOURNAL, message, details);
}

export function notFound(what: string, id: string): FinanceError {
  return new FinanceError(FinanceErrorCode.NOT_FOUND, `${what} '${id}' was not found`, { id });
}

export function unsupported(message: string, details: ErrorDetails = {}): FinanceError {
  return new FinanceError(FinanceErrorCode.UNSUPPORTED_OPERATION, message, details);
}

export function revisionConflict(message: string, details: ErrorDetails = {}): FinanceError {
  return new FinanceError(FinanceErrorCode.REVISION_CONFLICT, message, details);
}

export function isFinanceError(value: unknown): value is FinanceError {
  return value instanceof FinanceError;
}
