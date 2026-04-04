/**
 * Pipeline Recipe Types
 *
 * A recipe is a parameterized pipeline template that the agent matches
 * to user intent. Each recipe knows how to:
 *   1. Validate its required parameters
 *   2. Generate a complete, self-contained .alloy config
 *   3. Provide sample queries for the data it produces
 *   4. Map to an appropriate Grafana dashboard template
 *
 * The recipe system is the abstraction layer between the LLM (which
 * understands "monitor my Postgres") and Alloy (which needs specific
 * component configuration). The agent never needs to know 188+ Alloy
 * component types — it matches intent to ~18 recipe names.
 */

import type { ExportTargets } from "../types.js";

// ── Parameter Definition ────────────────────────────────────────────

export type ParamType = "string" | "number" | "boolean" | "string[]" | "object";

export type ParamDef = {
  /** Parameter name (e.g., "url", "connectionString"). */
  name: string;
  /** Parameter type. */
  type: ParamType;
  /** Human-readable description for the agent + user. */
  description: string;
  /** Default value — if present, parameter is optional. */
  default?: unknown;
  /** Whether this param contains a secret (password, token, connection string). */
  sensitive?: boolean;
  /** Example value for the agent to show the user. */
  example?: string;
};

// ── Resolved Parameters ─────────────────────────────────────────────

/**
 * Parameters after validation — required params guaranteed present,
 * optional params filled with defaults.
 */
export type ResolvedParams = Record<string, unknown>;

/**
 * Enriched result from resolveParams() — includes the resolved params
 * plus any warnings about unknown/mismatched parameter names.
 * Warnings are advisory (params still resolve correctly) and flow
 * through tool responses so the agent can relay them.
 */
export type ResolveResult = {
  params: ResolvedParams;
  warnings: string[];
};

// ── Credential Reference ────────────────────────────────────────────

/**
 * Describes an environment variable the user must set for this pipeline.
 * Generated when a recipe has sensitive parameters.
 */
export type CredentialRef = {
  /** Env var name (e.g., "ALLOY_POSTGRES_ANALYTICS_DB_DSN"). */
  envVar: string;
  /** Description of what this credential is for. */
  description: string;
  /** Example value. */
  example?: string;
};

// ── Pipeline Recipe Interface ───────────────────────────────────────

export interface PipelineRecipe {
  /** Recipe identifier (e.g., "scrape-endpoint", "postgres-exporter"). */
  name: string;

  /** Category for filtering. */
  category: "metrics" | "logs" | "traces" | "infrastructure" | "profiling";

  /** Signal type this pipeline produces. */
  signal: "metrics" | "logs" | "traces" | "profiles";

  /** One-line summary for the agent to match user intent. */
  summary: string;

  /** Required parameters — must be provided by the user. */
  requiredParams: ParamDef[];

  /** Optional parameters — have defaults, can be overridden. */
  optionalParams: ParamDef[];

  /** Parameter names that contain secrets (routed to sys.env()). */
  credentialParams: string[];

  /**
   * Generate a complete .alloy config from resolved parameters.
   * The config must be self-contained — no cross-file references.
   */
  generateConfig(
    pipelineId: string,
    params: ResolvedParams,
    targets: ExportTargets,
    pipelineName: string,
  ): string;

  /**
   * Generate sample queries for the data this pipeline produces.
   * Keys are descriptive names, values are PromQL/LogQL/TraceQL.
   */
  sampleQueries(
    params: ResolvedParams,
    jobName: string,
  ): Record<string, string>;

  /**
   * Return Alloy component IDs that will be created by this pipeline.
   * Used for health checking after deployment.
   */
  componentIds(pipelineId: string): string[];

  /** Suggested grafana_create_dashboard template, or null. */
  dashboardTemplate: string | null;

  /**
   * Return ports this pipeline will bind to (for conflict detection).
   * Only implement on recipes that create listener components
   * (OTLP receivers, push APIs, syslog listeners, etc.).
   * Returns empty array by default — override in listener recipes.
   */
  boundPorts?(params: ResolvedParams): number[];
}

// ── Recipe Validation ───────────────────────────────────────────────

/**
 * Common synonyms the LLM might use instead of the actual param name.
 * Maps the synonym → candidate real param names (checked against recipe).
 */
const PARAM_SYNONYMS: Record<string, string[]> = {
  port: ["listenPort", "grpcPort", "httpPort", "listenAddress"],
  host: ["listenAddress", "url"],
  address: ["listenAddress", "url"],
  interval: ["scrapeInterval"],
  timeout: ["scrapeInterval"],
  user: ["basicAuth"],
  username: ["basicAuth"],
  token: ["bearerToken", "basicAuth"],
  auth: ["basicAuth", "bearerToken", "kafkaAuth"],
};

/**
 * Validate and resolve recipe parameters.
 * Returns resolved params with defaults applied and warnings about
 * unrecognized parameter names. Throws on missing required params.
 */
export function resolveParams(
  recipe: PipelineRecipe,
  rawParams: Record<string, unknown> | undefined,
): ResolveResult {
  const params = rawParams ?? {};
  const resolved: ResolvedParams = {};
  const warnings: string[] = [];

  // Check required params
  for (const p of recipe.requiredParams) {
    if (params[p.name] === undefined || params[p.name] === null || params[p.name] === "") {
      const example = p.example ? ` Example: ${p.example}` : "";
      throw new Error(
        `Recipe '${recipe.name}' requires '${p.name}' parameter (${p.description}).${example}`,
      );
    }
    resolved[p.name] = params[p.name];
  }

  // Apply optional params with defaults
  for (const p of recipe.optionalParams) {
    resolved[p.name] = params[p.name] ?? p.default;
  }

  // Detect unknown params and generate suggestions
  const knownNames = new Set([
    ...recipe.requiredParams.map((p) => p.name),
    ...recipe.optionalParams.map((p) => p.name),
    "jobName", // implicit param used by many recipes
  ]);

  for (const key of Object.keys(params)) {
    if (knownNames.has(key)) continue;

    // Check synonym map for suggestions
    const candidates = PARAM_SYNONYMS[key.toLowerCase()];
    if (candidates) {
      const match = candidates.find((c) => knownNames.has(c));
      if (match) {
        const def = [...recipe.requiredParams, ...recipe.optionalParams].find(
          (p) => p.name === match,
        );
        const defaultHint = def?.default !== undefined ? ` (default: '${def.default}')` : "";
        warnings.push(
          `Unknown param '${key}'. Did you mean '${match}'${defaultHint}?`,
        );
        continue;
      }
    }

    // No synonym match — list available optional params
    const available = recipe.optionalParams.map((p) => p.name);
    warnings.push(
      `Unknown param '${key}' for recipe '${recipe.name}'. Available optional params: ${available.join(", ") || "none"}.`,
    );
  }

  return { params: resolved, warnings };
}

/**
 * Generate env var name for a credential parameter.
 * Convention: ALLOY_{RECIPE_TYPE}_{PIPELINE_NAME}_{PARAM}
 */
export function credentialEnvVar(
  recipeName: string,
  pipelineName: string,
  paramName: string,
): string {
  const prefix = recipeName.replace(/-/g, "_").toUpperCase();
  const name = pipelineName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  const param = paramName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `ALLOY_${prefix}_${name}_${param}`;
}

/**
 * Generate credential references for a recipe's sensitive parameters.
 */
export function generateCredentialRefs(
  recipe: PipelineRecipe,
  pipelineName: string,
  params: ResolvedParams,
): CredentialRef[] {
  return recipe.credentialParams
    .filter((name) => params[name] !== undefined)
    .map((name) => {
      const def = [...recipe.requiredParams, ...recipe.optionalParams].find(
        (p) => p.name === name,
      );
      return {
        envVar: credentialEnvVar(recipe.name, pipelineName, name),
        description: def?.description ?? name,
        example: def?.example,
      };
    });
}
