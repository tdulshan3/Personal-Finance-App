import { randomUUID } from "node:crypto";

import type { Db } from "../data/driver.ts";
import { asBoolean, asNumber, asOptionalNumber, asOptionalText, asText } from "../data/driver.ts";
import { validationError } from "../domain/errors.ts";
import type { ModelInfo, ProviderKind } from "../../extraction/provider.ts";
import { createProvider, detectProvider } from "../../extraction/provider.ts";

/**
 * Owner-configured inference endpoints.
 *
 * buildspec.md §7.2 requires "Two separate model configurations: one extraction URL and one agent
 * URL, with independent clients, timeouts, queues, and connection tests", and §14.1 requires the
 * agent card to have "its own Base URL, authentication credential reference if using a proxy, Test
 * Connection, Refresh Models, model dropdown, context limit, generation limit, and permission
 * profile. It must never overwrite the extraction settings card."
 *
 * The two roles are separate rows with separate writes, so saving one cannot touch the other.
 */

export const EndpointRole = {
  EXTRACTION: "extraction",
  AGENT: "agent",
} as const;
export type EndpointRole = (typeof EndpointRole)[keyof typeof EndpointRole];

export type EndpointRecord = {
  readonly role: EndpointRole;
  readonly providerKind: ProviderKind;
  readonly baseUrl: string;
  readonly modelName?: string | undefined;
  readonly modelDigest?: string | undefined;
  readonly quantization?: string | undefined;
  readonly parameterSize?: string | undefined;
  readonly contextLimit?: number | undefined;
  readonly modelLocked: boolean;
  readonly lastTestAt?: number | undefined;
  readonly lastTestOk?: boolean | undefined;
  readonly lastTestDetail?: string | undefined;
  readonly revision: number;
};

export type ConnectionTestResult = {
  readonly ok: boolean;
  readonly detail: string;
  readonly providerKind?: ProviderKind | undefined;
  /** The base URL that actually answered, which may differ from what was typed by a `/v1`. */
  readonly resolvedBaseUrl?: string | undefined;
  readonly serverHeader?: string | undefined;
  readonly models: readonly ModelInfo[];
  readonly latencyMs: number;
};

/**
 * Private network addresses are legitimate only because the owner typed them.
 *
 * buildspec.md §18: "Private LAN addresses are legitimate only when the owner explicitly configured
 * them. The agent cannot change this allowlist or pass a new URL through tool arguments." These
 * flags are set here — in the owner-only settings path — and nowhere else.
 */
const OWNER_CONFIGURED = {
  allowPlaintextHttp: true,
  allowPrivateNetwork: true,
} as const;

export function createModelSettingsService(db: Db) {
  function read(role: EndpointRole): EndpointRecord | undefined {
    const row = db.prepare("SELECT * FROM ai_endpoints WHERE role = ?").get(role) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      role,
      providerKind: asText(row.provider_kind, "provider_kind") as ProviderKind,
      baseUrl: asText(row.base_url, "base_url"),
      modelName: asOptionalText(row.model_name, "model_name"),
      modelDigest: asOptionalText(row.model_digest, "model_digest"),
      quantization: asOptionalText(row.quantization, "quantization"),
      parameterSize: asOptionalText(row.parameter_size, "parameter_size"),
      contextLimit: asOptionalNumber(row.context_limit, "context_limit"),
      modelLocked: asBoolean(row.model_locked, "model_locked"),
      lastTestAt: asOptionalNumber(row.last_test_at, "last_test_at"),
      lastTestOk: row.last_test_ok === null ? undefined : asBoolean(row.last_test_ok, "last_test_ok"),
      lastTestDetail: asOptionalText(row.last_test_detail, "last_test_detail"),
      revision: asNumber(row.revision, "revision"),
    };
  }

  function list(): EndpointRecord[] {
    return [EndpointRole.EXTRACTION, EndpointRole.AGENT]
      .map(read)
      .filter((r): r is EndpointRecord => r !== undefined);
  }

  /**
   * Probes a host and reports which dialect it speaks, plus the models it has.
   *
   * buildspec.md §16 maps this to `SettingsService.testEndpoint`: "Owner-approved endpoint only; no
   * arbitrary fetch." The URL comes from the settings form, never from a model or a tool argument.
   */
  async function testConnection(
    role: EndpointRole,
    baseUrl: string,
  ): Promise<ConnectionTestResult> {
    const trimmed = baseUrl.trim();
    if (trimmed.length === 0) throw validationError("Enter the endpoint's base URL");

    const started = Date.now();
    let result: ConnectionTestResult;
    try {
      const detected = await detectProvider(trimmed, {
        ...OWNER_CONFIGURED,
        configLabel: `${role} endpoint`,
        timeoutMs: 6_000,
      });
      const provider = createProvider({
        kind: detected.kind,
        baseUrl: detected.baseUrl,
        ...OWNER_CONFIGURED,
        configLabel: `${role} endpoint`,
      });
      const models = await provider.listModels();
      result = {
        ok: true,
        detail: `${detected.kind} · ${models.length} model${models.length === 1 ? "" : "s"}`,
        providerKind: detected.kind,
        resolvedBaseUrl: detected.baseUrl,
        serverHeader: detected.serverHeader ?? undefined,
        models,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      result = {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        models: [],
        latencyMs: Date.now() - started,
      };
    }

    db.prepare(
      `INSERT INTO ai_endpoint_tests (id, role, base_url, provider_kind, ok, detail, model_count, latency_ms, tested_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      `test_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      role,
      trimmed,
      result.providerKind ?? null,
      result.ok ? 1 : 0,
      result.detail.slice(0, 500),
      result.models.length,
      result.latencyMs,
      Date.now(),
    );

    // Only touch the stored row if this role already exists; a test must never create one.
    if (read(role)) {
      db.prepare(
        `UPDATE ai_endpoints SET last_test_at = ?, last_test_ok = ?, last_test_detail = ?,
                                 updated_at = ?
          WHERE role = ?`,
      ).run(Date.now(), result.ok ? 1 : 0, result.detail.slice(0, 500), Date.now(), role);
    }

    return result;
  }

  /**
   * Saves one role. The other role is never read or written here (buildspec.md §14.1).
   *
   * buildspec.md §14.1: "Persist the exact selected name and digest; do not invent tags from earlier
   * conversations." The digest comes from the live model list, not from the form.
   */
  function save(input: {
    role: EndpointRole;
    baseUrl: string;
    modelName: string;
    providerKind: ProviderKind;
    model?: ModelInfo | undefined;
    modelLocked?: boolean;
  }): EndpointRecord {
    const baseUrl = input.baseUrl.trim();
    if (baseUrl.length === 0) throw validationError("Enter the endpoint's base URL");
    if (input.modelName.trim().length === 0) throw validationError("Choose a model");

    /*
     * buildspec.md §7.2: "Do not use `latest`". A floating tag means a stored extraction can no
     * longer say which weights produced it, which breaks the provenance §7.2 requires.
     */
    if (input.role === EndpointRole.EXTRACTION && /(^|:)latest$/.test(input.modelName.trim())) {
      throw validationError(
        `'${input.modelName}' is a floating tag. Pin an exact model version for extraction so ` +
          `stored records can say which weights produced them.`,
        { model: input.modelName },
      );
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO ai_endpoints
         (role, provider_kind, base_url, model_name, model_digest, quantization, parameter_size,
          context_limit, model_locked, created_at, updated_at, revision)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
       ON CONFLICT(role) DO UPDATE SET
         provider_kind  = excluded.provider_kind,
         base_url       = excluded.base_url,
         model_name     = excluded.model_name,
         model_digest   = excluded.model_digest,
         quantization   = excluded.quantization,
         parameter_size = excluded.parameter_size,
         context_limit  = excluded.context_limit,
         model_locked   = excluded.model_locked,
         updated_at     = excluded.updated_at,
         revision       = ai_endpoints.revision + 1`,
    ).run(
      input.role,
      input.providerKind,
      baseUrl,
      input.modelName.trim(),
      input.model?.digest ?? null,
      input.model?.quantization ?? null,
      input.model?.parameterCount === null || input.model?.parameterCount === undefined ? null : String(input.model.parameterCount),
      input.model?.contextTokens ?? null,
      (input.modelLocked ?? input.role === EndpointRole.EXTRACTION) ? 1 : 0,
      now,
      now,
    );
    return read(input.role)!;
  }

  function recentTests(role: EndpointRole, limit = 5) {
    return (
      db
        .prepare(
          `SELECT base_url, provider_kind, ok, detail, model_count, latency_ms, tested_at
             FROM ai_endpoint_tests WHERE role = ? ORDER BY tested_at DESC LIMIT ?`,
        )
        .all(role, limit) as Record<string, unknown>[]
    ).map((row) => ({
      baseUrl: asText(row.base_url, "base_url"),
      providerKind: asOptionalText(row.provider_kind, "provider_kind"),
      ok: asBoolean(row.ok, "ok"),
      detail: asText(row.detail, "detail"),
      modelCount: asOptionalNumber(row.model_count, "model_count"),
      latencyMs: asOptionalNumber(row.latency_ms, "latency_ms"),
      testedAt: asNumber(row.tested_at, "tested_at"),
    }));
  }

  return { read, list, save, testConnection, recentTests };
}

export type ModelSettingsService = ReturnType<typeof createModelSettingsService>;
