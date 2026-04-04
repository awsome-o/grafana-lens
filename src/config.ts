/**
 * Grafana Lens plugin configuration types.
 *
 * These mirror the JSON Schema in openclaw.plugin.json but provide
 * TypeScript types for use within the extension code.
 *
 * Config precedence: explicit plugin config > environment variables > defaults.
 * Env vars follow Grafana community conventions (GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN)
 * and OpenTelemetry conventions (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS).
 *
 * Supports two grafana config formats:
 *   1. Legacy single instance:  { url, apiKey, orgId }
 *   2. Named instances:         { instances: [{ name, url, apiKey, orgId }], default? }
 * Both normalize to the same internal shape: { instances: Record<name, config>, defaultInstance }.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

// ── Grafana instance types ────────────────────────────────────────────

/** A single Grafana instance (parsed — fields may still be missing). */
export type GrafanaInstanceConfig = {
  url?: string;
  apiKey?: string;
  orgId?: number;
};

/** A validated instance — url and apiKey confirmed present. */
export type ValidatedGrafanaInstanceConfig = {
  url: string;
  apiKey: string;
  orgId?: number;
};

// ── Main config types ─────────────────────────────────────────────────

export type GrafanaLensConfig = {
  grafana: {
    instances: Record<string, GrafanaInstanceConfig>;
    defaultInstance: string;
  };
  metrics?: {
    enabled?: boolean;
  };
  otlp?: {
    endpoint?: string;
    headers?: Record<string, string>;
    exportIntervalMs?: number;
    instanceId?: string;
    logs?: boolean;
    traces?: boolean;
    captureContent?: boolean;
    contentMaxLength?: number;
    forwardAppLogs?: boolean;
    appLogMinSeverity?: string;
    redactSecrets?: boolean;
  };
  proactive?: {
    enabled?: boolean;
    webhookPath?: string;
    costAlertThreshold?: number;
  };
  customMetrics?: {
    enabled?: boolean;
    maxMetrics?: number;
    maxLabelsPerMetric?: number;
    maxLabelValues?: number;
    defaultTtlDays?: number;
  };
  alloy?: {
    enabled?: boolean;
    url?: string;
    configDir?: string;
    filePrefix?: string;
    maxPipelines?: number;
    lgtm?: {
      prometheusRemoteWriteUrl?: string;
      lokiUrl?: string;
      otlpEndpoint?: string;
      pyroscopeUrl?: string;
    };
  };
};

/**
 * Validated config — at least the default instance has url + apiKey.
 * Only instances with valid credentials are included.
 */
export type ValidatedGrafanaLensConfig = Omit<GrafanaLensConfig, "grafana"> & {
  grafana: {
    instances: Record<string, ValidatedGrafanaInstanceConfig>;
    defaultInstance: string;
  };
};

/**
 * Validate that the default instance has credentials and filter out incomplete instances.
 */
export function validateConfig(
  config: GrafanaLensConfig,
): { valid: true; config: ValidatedGrafanaLensConfig } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  const { instances, defaultInstance } = config.grafana;
  const defaultInst = instances[defaultInstance];

  if (!defaultInst) {
    errors.push(
      `Default Grafana instance "${defaultInstance}" not found in configured instances.`,
    );
    return { valid: false, errors };
  }

  if (!defaultInst.url) {
    errors.push(
      "grafana.url is required. Set it in plugin config or via GRAFANA_URL environment variable.",
    );
  }
  if (!defaultInst.apiKey) {
    errors.push(
      "grafana.apiKey is required. Set it in plugin config or via GRAFANA_SERVICE_ACCOUNT_TOKEN environment variable.",
    );
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Keep only instances that have both url + apiKey. Default is guaranteed valid above.
  const validInstances: Record<string, ValidatedGrafanaInstanceConfig> = {};
  for (const [name, inst] of Object.entries(instances)) {
    if (inst.url && inst.apiKey) {
      validInstances[name] = { url: inst.url, apiKey: inst.apiKey, orgId: inst.orgId };
    }
  }

  return {
    valid: true,
    config: {
      ...config,
      grafana: { instances: validInstances, defaultInstance },
    },
  };
}

/**
 * Derive per-signal OTLP endpoints from a base URL or metrics endpoint.
 *
 * Accepts either a base URL (http://localhost:4318) or a full metrics
 * endpoint (http://localhost:4318/v1/metrics) and returns all three signal paths.
 */
export function deriveOtlpEndpoints(endpoint?: string): {
  metrics: string;
  logs: string;
  traces: string;
} {
  const raw = endpoint ?? "http://localhost:4318/v1/metrics";
  // Strip any /v1/* suffix to get the base collector URL
  const base = raw.replace(/\/v1\/(metrics|logs|traces)\/?$/, "").replace(/\/+$/, "");
  return {
    metrics: `${base}/v1/metrics`,
    logs: `${base}/v1/logs`,
    traces: `${base}/v1/traces`,
  };
}

/**
 * Parse OTEL_EXPORTER_OTLP_HEADERS env var format: "key=value,key2=value2"
 * Returns parsed headers and count of skipped (malformed) pairs.
 */
export function parseOtlpHeadersEnv(raw: string): { headers: Record<string, string>; skipped: number } {
  const headers: Record<string, string> = {};
  let skipped = 0;
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      headers[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    } else {
      skipped++;
    }
  }
  return { headers, skipped };
}

// ── Format detection + normalization ──────────────────────────────────

/**
 * Detect whether the raw grafana config is legacy single-instance or multi-instance.
 *
 * Legacy:  { url: "...", apiKey: "...", orgId: 1 }
 * Multi:   { instances: [{ name, url, apiKey, orgId }], default?: "name" }
 */
function isMultiInstanceFormat(grafana: Record<string, unknown>): boolean {
  return Array.isArray(grafana.instances);
}

/** Parse a single Grafana instance from raw config, applying env var fallback for the default. */
function parseSingleInstance(
  raw: Record<string, unknown>,
  applyEnvFallback: boolean,
): GrafanaInstanceConfig {
  let url = raw.url as string | undefined;
  let apiKey = raw.apiKey as string | undefined;

  if (applyEnvFallback) {
    url = url ?? process.env.GRAFANA_URL;
    apiKey = apiKey ?? process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  }

  return {
    url: url?.replace(/\/+$/, ""),
    apiKey,
    orgId: (raw.orgId as number) ?? 1,
  };
}

/** Normalize multi-instance array format to internal record. */
function parseMultiInstances(
  grafana: Record<string, unknown>,
): { instances: Record<string, GrafanaInstanceConfig>; defaultInstance: string } {
  const rawInstances = grafana.instances as Array<Record<string, unknown>>;
  const instances: Record<string, GrafanaInstanceConfig> = {};
  let firstName: string | undefined;

  for (const entry of rawInstances) {
    const name = entry.name as string;
    if (!name) continue;
    if (!firstName) firstName = name;

    // Env var fallback applies only to the explicit default or the first entry
    const isDefault =
      grafana.default === name || (!grafana.default && name === firstName);
    instances[name] = parseSingleInstance(entry, isDefault);
  }

  const defaultInstance = (grafana.default as string) ?? firstName ?? "default";
  return { instances, defaultInstance };
}

export function parseConfig(raw?: Record<string, unknown>): GrafanaLensConfig & { _warnings?: string[] } {
  const grafana = (raw?.grafana as Record<string, unknown>) ?? {};

  // ── Normalize grafana config to { instances, defaultInstance } ───────
  let grafanaNormalized: { instances: Record<string, GrafanaInstanceConfig>; defaultInstance: string };

  if (isMultiInstanceFormat(grafana)) {
    grafanaNormalized = parseMultiInstances(grafana);
  } else {
    // Legacy single-instance format: normalize to a single "default" entry
    const inst = parseSingleInstance(grafana, true);
    grafanaNormalized = {
      instances: { default: inst },
      defaultInstance: "default",
    };
  }

  // ── Resolve OTLP config: explicit config > OTEL_EXPORTER_OTLP_* env vars > defaults ──
  const otlpRaw = (raw?.otlp as Record<string, unknown>) ?? {};
  const otlpEndpointEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const otlpHeadersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS;

  let otlpEndpoint = otlpRaw.endpoint as string | undefined;
  if (!otlpEndpoint && otlpEndpointEnv) {
    // OTEL_EXPORTER_OTLP_ENDPOINT is the base URL; append /v1/metrics for HTTP
    otlpEndpoint = otlpEndpointEnv.replace(/\/+$/, "") + "/v1/metrics";
  }

  let otlpHeaders = otlpRaw.headers as Record<string, string> | undefined;
  let otlpHeadersSkipped = 0;
  if (!otlpHeaders && otlpHeadersEnv) {
    const parsed = parseOtlpHeadersEnv(otlpHeadersEnv);
    otlpHeaders = parsed.headers;
    otlpHeadersSkipped = parsed.skipped;
  }

  const warnings: string[] = [];
  if (otlpHeadersSkipped > 0) {
    warnings.push(
      `OTEL_EXPORTER_OTLP_HEADERS contained ${otlpHeadersSkipped} malformed pair(s) without '=' separator — these were skipped`,
    );
  }

  return {
    grafana: grafanaNormalized,
    metrics: {
      enabled: (raw?.metrics as Record<string, unknown>)?.enabled !== false,
    },
    otlp: {
      endpoint: otlpEndpoint,
      headers: otlpHeaders,
      exportIntervalMs: otlpRaw.exportIntervalMs as number | undefined,
      instanceId:
        (otlpRaw.instanceId as string | undefined)
        ?? process.env.OTEL_SERVICE_INSTANCE_ID
        ?? (hostname() || randomUUID()),
      logs: otlpRaw.logs !== false,
      traces: otlpRaw.traces !== false,
      captureContent: otlpRaw.captureContent !== false,
      contentMaxLength: (otlpRaw.contentMaxLength as number | undefined) ?? 2000,
      forwardAppLogs: otlpRaw.forwardAppLogs !== false,
      appLogMinSeverity: (otlpRaw.appLogMinSeverity as string | undefined) ?? "debug",
      redactSecrets: otlpRaw.redactSecrets !== false,
    },
    proactive: {
      enabled: (raw?.proactive as Record<string, unknown>)?.enabled === true,
      webhookPath:
        ((raw?.proactive as Record<string, unknown>)?.webhookPath as string) ??
        "/grafana-lens/alerts",
      costAlertThreshold:
        ((raw?.proactive as Record<string, unknown>)?.costAlertThreshold as number) ?? 5.0,
    },
    customMetrics: {
      enabled: (raw?.customMetrics as Record<string, unknown>)?.enabled !== false,
      maxMetrics:
        ((raw?.customMetrics as Record<string, unknown>)?.maxMetrics as number) ?? 100,
      maxLabelsPerMetric:
        ((raw?.customMetrics as Record<string, unknown>)?.maxLabelsPerMetric as number) ?? 5,
      maxLabelValues:
        ((raw?.customMetrics as Record<string, unknown>)?.maxLabelValues as number) ?? 50,
      defaultTtlDays:
        (raw?.customMetrics as Record<string, unknown>)?.defaultTtlDays as number | undefined,
    },
    alloy: parseAlloyConfig(raw?.alloy as Record<string, unknown> | undefined),
    ...(warnings.length > 0 ? { _warnings: warnings } : {}),
  };
}

// ── Alloy config parsing ────────────────────────────────────────────

function parseAlloyConfig(raw: Record<string, unknown> | undefined): GrafanaLensConfig["alloy"] {
  if (!raw) return undefined;

  const enabled = raw.enabled === true;
  if (!enabled) return { enabled: false };

  const url = (raw.url as string | undefined) ?? process.env.ALLOY_URL ?? "http://localhost:12345";
  const configDir = (raw.configDir as string | undefined) ?? process.env.ALLOY_CONFIG_DIR;

  const lgtmRaw = raw.lgtm as Record<string, unknown> | undefined;

  return {
    enabled: true,
    url: url.replace(/\/+$/, ""),
    configDir,
    filePrefix: (raw.filePrefix as string | undefined) ?? "lens-",
    maxPipelines: (raw.maxPipelines as number | undefined) ?? 20,
    lgtm: lgtmRaw ? {
      prometheusRemoteWriteUrl: lgtmRaw.prometheusRemoteWriteUrl as string | undefined,
      lokiUrl: lgtmRaw.lokiUrl as string | undefined,
      otlpEndpoint: lgtmRaw.otlpEndpoint as string | undefined,
      pyroscopeUrl: lgtmRaw.pyroscopeUrl as string | undefined,
    } : undefined,
  };
}
