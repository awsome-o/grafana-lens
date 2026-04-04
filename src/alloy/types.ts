/**
 * Shared types for the Alloy pipeline management system.
 *
 * These types define the contract between AlloyClient (HTTP API),
 * PipelineStore (state persistence), ConfigBuilder (config generation),
 * and the alloy_pipeline tool.
 */

// ── Pipeline State Types ────────────────────────────────────────────

export type PipelineStatus =
  | "pending"   // Config written, reload not yet attempted
  | "active"    // Reload succeeded, components running
  | "failed"    // Reload failed, file removed, rolled back
  | "stopped"   // Intentionally disabled (file removed via delete)
  | "drift";    // State says active but file missing or components unhealthy

export type PipelineDefinition = {
  /** Short UUID (8 chars) — used in file names + component labels. */
  id: string;
  /** Human-readable name (e.g., "analytics-db"). */
  name: string;
  /** Recipe that generated this pipeline, or null for raw config. */
  recipe: string | null;
  /** Parameters passed to the recipe (secrets redacted in storage). */
  params: Record<string, unknown>;
  /** Absolute path to the .alloy config file. */
  filePath: string;
  /** Current pipeline status. */
  status: PipelineStatus;
  /** Alloy component IDs for health checking (e.g., "prometheus.scrape.lens_a1b2_nginx"). */
  componentIds: string[];
  /** Signal type this pipeline produces. */
  signal: "metrics" | "logs" | "traces" | "profiles";
  /** Unix ms when created. */
  createdAt: number;
  /** Unix ms when last updated. */
  updatedAt: number;
  /** SHA-256 hash of the generated config content — for drift detection. */
  configHash: string;
  /** Most recent error message, if any. */
  lastError?: string;
  /** Ports this pipeline binds to (for conflict detection). */
  boundPorts?: number[];
  /** Sample queries for this pipeline (PromQL/LogQL/TraceQL). */
  sampleQueries?: Record<string, string>;
};

// ── Persisted State ─────────────────────────────────────────────────

export type AlloyPipelineState = {
  version: 1;
  pipelines: PipelineDefinition[];
};

// ── Alloy HTTP API Types ────────────────────────────────────────────

export type AlloyClientOptions = {
  /** Alloy HTTP API base URL (e.g., "http://localhost:12345"). */
  url: string;
  /** Request timeout in milliseconds (default: 5000). */
  timeout?: number;
};

export type AlloyComponentHealth = {
  /** Alloy serializes this as "state" in JSON (not "health"). */
  state: "healthy" | "unhealthy" | "unknown" | "exited";
  message: string;
  updatedTime: string;
};

export type AlloyComponentInfo = {
  /** Component ID (e.g., "prometheus.scrape.lens_a1b2_nginx"). */
  localID: string;
  /** Component name. */
  name: string;
  /** Component health status. */
  health: AlloyComponentHealth;
  /** Component arguments (config). */
  arguments?: Record<string, unknown>;
  /** Component exports (outputs). */
  exports?: Record<string, unknown>;
};

export type PipelineHealthResult = {
  healthy: string[];
  unhealthy: Array<{ id: string; message: string }>;
  missing: string[];
};

// ── Config Builder Types ────────────────────────────────────────────

/** Values that can be rendered into Alloy syntax. */
export type AlloyValue =
  | string
  | number
  | boolean
  | AlloyValue[]
  | { [key: string]: AlloyValue };

// ── Export Targets ──────────────────────────────────────────────────

/** Where pipelines send collected data — auto-resolved from LGTM config. */
export type ExportTargets = {
  /** Prometheus remote_write URL (e.g., "http://localhost:9009/api/prom/push"). */
  prometheusRemoteWriteUrl: string;
  /** Loki write URL (e.g., "http://localhost:3100/loki/api/v1/push"). */
  lokiWriteUrl: string;
  /** OTLP endpoint (e.g., "http://localhost:4318"). */
  otlpEndpoint: string;
  /** Pyroscope write URL (e.g., "http://localhost:4040"). Optional — only needed for profiling recipes. */
  pyroscopeWriteUrl?: string;
};

// ── Pipeline Limits ─────────────────────────────────────────────────

export type AlloyPipelineLimits = {
  /** Max managed pipelines (default: 20). */
  maxPipelines: number;
};

// ── Drift Detection ─────────────────────────────────────────────────

export type DriftReport = {
  /** Pipelines whose config file is missing or hash doesn't match. */
  fileDrift: Array<{ name: string; issue: string }>;
  /** lens-*.alloy files not tracked in state. */
  orphanFiles: string[];
};
