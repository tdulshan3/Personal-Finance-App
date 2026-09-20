"use client";

import { useActionState, useState } from "react";

import { Badge, Card, ErrorNote } from "../../ui/primitives.tsx";
import { Button, Field, FormRow, Select, SubmitButton, TextInput } from "../../ui/form.tsx";
import type { EndpointFormState } from "./actions.ts";
import { saveEndpointAction, testEndpointAction } from "./actions.ts";

type CurrentEndpoint = {
  baseUrl: string;
  providerKind: string;
  modelName: string | null;
  modelDigest: string | null;
  quantization: string | null;
  parameterSize: string | null;
  contextLimit: number | null;
  modelLocked: boolean;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
};

type RecentTest = {
  baseUrl: string;
  ok: boolean;
  detail: string;
  latencyMs: number | null;
  testedAt: number;
};

/**
 * One endpoint configuration card.
 *
 * buildspec.md §14.1: "Refresh Models calls `GET {agent_base_url}/api/tags`. Parse the returned
 * `models` array and show exact installed names, size, quantization details if available, and
 * digest." The model dropdown is populated only from a live probe — there is no free-text model
 * field, because a name that is not installed is a runtime failure disguised as a setting.
 */
export function EndpointCard({
  role,
  title,
  blurb,
  current,
  recentTests,
  suggestions,
}: {
  role: string;
  title: string;
  blurb: string;
  current: CurrentEndpoint | undefined;
  recentTests: readonly RecentTest[];
  suggestions: readonly { label: string; url: string }[];
}) {
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [selectedModel, setSelectedModel] = useState(current?.modelName ?? "");
  const [testState, runTest] = useActionState<EndpointFormState, FormData>(testEndpointAction, {});
  const [saveState, runSave] = useActionState<EndpointFormState, FormData>(saveEndpointAction, {});

  const models = testState.models ?? [];
  const hasProbed = models.length > 0;

  return (
    <Card title={title}>
      <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-4)" }}>
        {blurb}
      </p>

      {current ? (
        <div
          style={{
            display: "grid",
            gap: "var(--space-2)",
            padding: "var(--space-4)",
            marginBottom: "var(--space-4)",
            background: "var(--surface-sunken)",
            borderRadius: "var(--radius-input)",
          }}
        >
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
            <strong>{current.modelName ?? "No model chosen"}</strong>
            <Badge tone="primary">{current.providerKind}</Badge>
            {current.modelLocked ? <Badge tone="warning">Locked</Badge> : null}
            {current.lastTestOk === true ? <Badge tone="success">Reachable</Badge> : null}
            {current.lastTestOk === false ? <Badge tone="danger">Unreachable</Badge> : null}
          </div>
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
            {current.baseUrl}
          </span>
          <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
            {/* §7.2 requires the digest to be stored with every extraction; say so when it is absent. */}
            {current.modelDigest
              ? `digest ${current.modelDigest.slice(0, 12)}…`
              : "this host reports no digest, so extractions cannot record one"}
            {current.quantization ? ` · ${current.quantization}` : ""}
            {current.contextLimit ? ` · ctx ${current.contextLimit.toLocaleString()}` : ""}
          </span>
        </div>
      ) : (
        <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-4)" }}>
          Not configured yet.
        </p>
      )}

      <FormRow>
        <Field
          label="Base URL"
          hint="The address of the machine running the model. A trailing /v1 is added or removed automatically."
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://192.168.1.84:11434"
              inputMode="url"
              autoComplete="off"
              describedBy={describedBy}
            />
          )}
        </Field>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion.url}
              type="button"
              variant="secondary"
              onClick={() => setBaseUrl(suggestion.url)}
              style={{ minHeight: "38px", padding: "0 var(--space-3)", fontSize: "var(--font-sm)" }}
            >
              {suggestion.label}
            </Button>
          ))}
        </div>

        {/* Probing is its own form so it can run without touching what is saved. */}
        <form action={runTest}>
          <input type="hidden" name="role" value={role} />
          <input type="hidden" name="baseUrl" value={baseUrl} />
          <SubmitButton variant="secondary" pendingLabel="Checking…">
            Test connection and list models
          </SubmitButton>
        </form>

        {testState.error ? <ErrorNote>{testState.error}</ErrorNote> : null}

        {testState.ok ? (
          <p role="status" style={{ fontSize: "var(--font-sm)", color: "var(--success)" }}>
            {testState.ok}
            {testState.providerKind ? ` · speaks ${testState.providerKind}` : ""}
            {testState.serverHeader ? ` · ${testState.serverHeader}` : ""}
            {testState.resolvedBaseUrl && testState.resolvedBaseUrl !== baseUrl
              ? ` · using ${testState.resolvedBaseUrl}`
              : ""}
          </p>
        ) : null}

        {hasProbed ? (
          <form action={runSave}>
            <input type="hidden" name="role" value={role} />
            <input type="hidden" name="baseUrl" value={baseUrl} />
            <FormRow>
              <Field label="Model" hint="Only models actually installed on that host are listed.">
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    name="modelName"
                    value={selectedModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                    describedBy={describedBy}
                    required
                  >
                    <option value="">Choose a model…</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                        {model.parameterCount
                          ? ` — ${(model.parameterCount / 1e9).toFixed(1)}B`
                          : ""}
                        {model.quantization ? ` ${model.quantization}` : ""}
                        {model.digest ? "" : " (no digest)"}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <SubmitButton pendingLabel="Saving…">Save {title.toLowerCase()}</SubmitButton>
            </FormRow>
          </form>
        ) : null}

        {saveState.error ? <ErrorNote>{saveState.error}</ErrorNote> : null}
        {saveState.ok ? (
          <p role="status" style={{ fontSize: "var(--font-sm)", color: "var(--success)" }}>
            {saveState.ok}. Reload to see it above.
          </p>
        ) : null}

        {recentTests.length > 0 ? (
          <details>
            <summary style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", cursor: "pointer" }}>
              Recent connection checks
            </summary>
            <ul style={{ listStyle: "none", margin: "var(--space-3) 0 0", padding: 0, display: "grid", gap: "var(--space-2)" }}>
              {recentTests.map((test) => (
                <li key={test.testedAt} style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                  {test.ok ? "OK" : "Failed"} · {new Date(test.testedAt).toLocaleString()} ·{" "}
                  {test.detail.slice(0, 90)}
                  {test.latencyMs !== null ? ` · ${test.latencyMs} ms` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </FormRow>
    </Card>
  );
}
