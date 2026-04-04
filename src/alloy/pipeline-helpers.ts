/**
 * Pure utility functions shared between the alloy_pipeline tool and its tests.
 *
 * Extracted here so tests import the real implementations instead of
 * duplicating them (maintenance risk if the tool's version diverges).
 */

import type { PipelineDefinition } from "./types.js";
import type { PipelineRecipe } from "./recipes/types.js";

// ── Component ID Extraction ───────────────────────────────────────

/**
 * Extract Alloy component IDs from raw River config.
 * Matches patterns like: `type.subtype "label" {` or `type.subtype.sub2 "label" {`
 * Returns component IDs in the format Alloy uses: `type.subtype.label`
 */
export function extractComponentIds(config: string): string[] {
  const ids: string[] = [];
  const re = /^([a-zA-Z_]\w+(?:\.[a-zA-Z_]\w+)+)\s+"([^"]+)"\s*\{/gm;
  let match;
  while ((match = re.exec(config)) !== null) {
    ids.push(`${match[1]}.${match[2]}`);
  }
  return ids;
}

// ── Signal Inference ──────────────────────────────────────────────

/**
 * Infer signal type from raw Alloy config component types.
 * loki/faro → logs, otelcol+traces/tempo → traces, pyroscope → profiles, else metrics.
 */
export function inferSignalFromConfig(config: string): PipelineDefinition["signal"] {
  const hasLoki = /\bloki\.\w+/.test(config);
  const hasFaro = /\bfaro\.receiver\b/.test(config);
  const hasTraces = /\botelcol\.(?:receiver|processor|exporter|connector)\.\w+[\s\S]*?traces\s*=/.test(config)
    || /\btempo\b/.test(config);
  const hasProfiles = /\bpyroscope\.\w+/.test(config);
  if (hasLoki || hasFaro) return "logs";
  if (hasTraces) return "traces";
  if (hasProfiles) return "profiles";
  return "metrics";
}

// ── Signal → Query Tool Mapping ───────────────────────────────────

/** Map signal type to the appropriate query tool name. */
export function queryToolForSignal(signal: PipelineDefinition["signal"]): string {
  if (signal === "logs") return "grafana_query_logs";
  if (signal === "traces") return "grafana_query_traces";
  if (signal === "profiles") return "grafana_explore_datasources";
  return "grafana_query";
}

/** Map signal type to the query type key used in response shapes. */
export function queryTypeForSignal(signal: PipelineDefinition["signal"]): "metrics" | "logs" | "traces" {
  if (signal === "logs") return "logs";
  if (signal === "traces") return "traces";
  return "metrics";
}

// ── Suggested Workflow ────────────────────────────────────────────

/**
 * Build a basic suggestedWorkflow for raw-config pipelines based on signal type.
 */
export function rawConfigSuggestedWorkflow(pipelineName: string, signal: PipelineDefinition["signal"], sampleQueries?: Record<string, string>) {
  const firstQuery = sampleQueries ? Object.values(sampleQueries)[0] : undefined;
  const tool = queryToolForSignal(signal);
  const isProfiles = signal === "profiles";

  return [
    {
      tool: "alloy_pipeline",
      action: "Verify data is flowing",
      example: { action: "status", name: pipelineName },
    },
    isProfiles
      ? { tool, action: "Verify Pyroscope datasource available", example: {} }
      : tool === "grafana_query_traces"
        ? { tool, action: "Search collected traces", example: firstQuery ? { query: firstQuery } : { query: '{ }' } }
        : tool === "grafana_query_logs"
          ? { tool, action: "Search collected logs", example: firstQuery ? { expr: firstQuery } : { expr: '{source="..."}' } }
          : { tool, action: "Query collected metrics", example: firstQuery ? { expr: firstQuery } : { expr: 'up{job="..."}' } },
  ];
}

// ── Credential Redaction ──────────────────────────────────────────

/** Redact sensitive params for storage (does not mutate original). */
export function redactSecrets(
  params: Record<string, unknown>,
  recipe: Pick<PipelineRecipe, "credentialParams">,
): Record<string, unknown> {
  const redacted = { ...params };
  for (const name of recipe.credentialParams) {
    if (redacted[name]) {
      redacted[name] = "***REDACTED***";
    }
  }
  return redacted;
}

// ── Raw Config Credential Scanning ──────────────────────────────

/** URI schemes with embedded credentials (user:pass@host). */
const RE_URI_CREDS = /(postgres|mysql|mongodb|redis|amqp):\/\/[^:]+:[^@]+@/g;

/** Credential keywords as bare double-quoted string values, NOT inside sys.env(). */
const RE_CRED_KEYWORDS = /\b(password|secret|token|api_key|apikey)\s*=\s*"(?!sys\.env)[^"]+"/gi;

/**
 * Scan raw Alloy config for likely plaintext credentials.
 * Returns advisory warnings (not errors) — the config is still written.
 * Only flags credentials that are NOT already wrapped in sys.env().
 */
export function scanForCredentials(config: string): string[] {
  const warnings: string[] = [];

  for (const m of config.matchAll(RE_URI_CREDS)) {
    warnings.push(
      `Config contains a ${m[1]}:// URI with embedded credentials. Use sys.env("MY_VAR") instead, or use the matching recipe which handles this automatically.`,
    );
  }

  for (const m of config.matchAll(RE_CRED_KEYWORDS)) {
    warnings.push(
      `Config contains '${m[1]}' as a plaintext string value. Wrap sensitive values in sys.env("ENV_VAR_NAME") so they aren't written to disk.`,
    );
  }

  return warnings;
}
