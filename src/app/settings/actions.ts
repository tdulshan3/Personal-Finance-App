"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import type { EndpointRole } from "../../core/services/model-settings-service.ts";
import { createModelSettingsService } from "../../core/services/model-settings-service.ts";
import type { ProviderKind } from "../../extraction/provider.ts";
import { requireDb } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * Settings actions for the two inference endpoints.
 *
 * buildspec.md §14.2: "Change credentials, source access, endpoints, permissions, retention or
 * export | Never through agent | Owner-only settings flow." These actions are reachable only from
 * the settings screen behind an authenticated session, and no agent tool maps onto them.
 */

export type ModelOption = {
  readonly id: string;
  readonly digest: string | null;
  readonly quantization: string | null;
  readonly parameterCount: number | null;
  readonly contextTokens: number | null;
};

export type EndpointFormState = {
  readonly error?: string | undefined;
  readonly ok?: string | undefined;
  readonly providerKind?: ProviderKind | undefined;
  readonly resolvedBaseUrl?: string | undefined;
  readonly serverHeader?: string | undefined;
  readonly models?: readonly ModelOption[] | undefined;
  readonly latencyMs?: number | undefined;
};

async function settingsService() {
  const access = await accessState();
  if (access.kind !== "ready") {
    redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  }
  // One connection per process; settings share the handle the vault opened.
  return createModelSettingsService(requireDb());
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** buildspec.md §14.1 "Test Connection" + "Refresh Models" in one round trip. */
export async function testEndpointAction(
  _prev: EndpointFormState,
  formData: FormData,
): Promise<EndpointFormState> {
  const role = String(formData.get("role") ?? "extraction") as EndpointRole;
  const baseUrl = String(formData.get("baseUrl") ?? "");
  try {
    const settings = await settingsService();
    const result = await settings.testConnection(role, baseUrl);
    if (!result.ok) return { error: result.detail };
    return {
      ok: `Connected in ${result.latencyMs} ms`,
      providerKind: result.providerKind,
      resolvedBaseUrl: result.resolvedBaseUrl,
      serverHeader: result.serverHeader,
      latencyMs: result.latencyMs,
      models: result.models.map((m) => ({
        id: m.id,
        digest: m.digest,
        quantization: m.quantization,
        parameterCount: m.parameterCount,
        contextTokens: m.contextTokens,
      })),
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function saveEndpointAction(
  _prev: EndpointFormState,
  formData: FormData,
): Promise<EndpointFormState> {
  const role = String(formData.get("role") ?? "extraction") as EndpointRole;
  try {
    const settings = await settingsService();
    const baseUrl = String(formData.get("baseUrl") ?? "");
    const modelName = String(formData.get("modelName") ?? "");

    /*
     * Re-probe before saving rather than trusting hidden form fields. The digest and provider kind
     * that get stored then come from the host itself, which is what buildspec.md §14.1 means by
     * "Persist the exact selected name and digest; do not invent tags from earlier conversations."
     */
    const probe = await settings.testConnection(role, baseUrl);
    if (!probe.ok) return { error: `Cannot save: ${probe.detail}` };

    const chosen = probe.models.find((m) => m.id === modelName);
    if (!chosen) {
      return {
        error: `'${modelName}' is not installed on that host. Test the connection and pick from the list.`,
      };
    }

    settings.save({
      role,
      baseUrl: probe.resolvedBaseUrl ?? baseUrl,
      modelName,
      providerKind: probe.providerKind!,
      model: chosen,
    });

    revalidatePath("/settings");
    return { ok: `Saved ${modelName}` };
  } catch (error) {
    return { error: describe(error) };
  }
}
