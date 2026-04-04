/**
 * Shared loki.process stage builder for all log recipes.
 * Stage order: json → regex → timestamp → labels → structured_metadata → static_labels → tenant → match → output.
 */

import { componentLabel, escapeString } from "../../config-builder.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * A match route for conditional processing by label selector.
 * Logs matching `selector` pass through the nested stages; others pass through unchanged.
 */
export type MatchRoute = {
  /** LogQL selector, e.g., '{hostname=~"prod.*"}' or '{level="error"}'. */
  selector: string;
  /** Optional pipeline name for Alloy debugging UI. */
  pipelineName?: string;
  /** Static tenant value — sets X-Scope-OrgID for multi-tenant Loki. */
  tenantValue?: string;
  /** Dynamic tenant — reads tenant ID from an extracted field. */
  tenantSource?: string;
};

/**
 * Declarative log processing parameters.
 * All fields are optional — return null when none are set.
 */
export type LogProcessingParams = {
  /**
   * stage.json — Extract fields from JSON log lines.
   * Keys are output field names, values are JSON paths.
   * Empty string "" extracts the top-level key matching the name.
   * Example: { "timestamp": "", "level": "", "request_id": "context.rid" }
   */
  jsonExpressions?: Record<string, string>;

  /**
   * stage.regex — Extract fields via regex with named capture groups.
   * Example: "^(?P<timestamp>\\S+) (?P<level>\\w+) (?P<message>.*)$"
   */
  regexExpression?: string;

  /**
   * stage.timestamp — Parse timestamps from an extracted field.
   * source: field name containing the timestamp.
   * format: "RFC3339", "RFC3339Nano", "Unix", "UnixMs", or Go time layout.
   */
  timestampSource?: string;
  timestampFormat?: string;

  /**
   * stage.labels — Promote extracted fields to Loki index labels.
   * Keys are label names, values are source fields (empty string = same name).
   * Use sparingly — high-cardinality labels hurt Loki performance.
   */
  labelFields?: Record<string, string>;

  /**
   * stage.structured_metadata — Store high-cardinality fields as metadata.
   * Queryable via `| field="value"` but not indexed as labels.
   * Preferred over labels for request IDs, user IDs, trace IDs, etc.
   */
  structuredMetadata?: Record<string, string>;

  /**
   * stage.static_labels — Add fixed labels to all log entries.
   * Example: { "environment": "production", "service_name": "my-app" }
   */
  staticLabels?: Record<string, string>;

  /**
   * stage.tenant — Set Loki tenant ID (X-Scope-OrgID header).
   * Use `tenantValue` for a static tenant, `tenantSource` for dynamic (from extracted field).
   * Only one of `tenantValue` or `tenantSource` should be set at top level.
   */
  tenantValue?: string;
  tenantSource?: string;

  /**
   * stage.match — Conditional processing branches by label selector.
   * Each route applies nested stages only to logs matching its selector.
   * Commonly used with stage.tenant inside for multi-tenant routing.
   *
   * Example: Route logs to different Loki tenants by environment label:
   * ```
   * matchRoutes: [
   *   { selector: '{env="prod"}', tenantValue: "prod-tenant" },
   *   { selector: '{env="staging"}', tenantValue: "staging-tenant" }
   * ]
   * ```
   */
  matchRoutes?: MatchRoute[];

  /**
   * stage.output — Replace log line with an extracted field's value.
   * Useful when the original line is raw JSON but you want a human-readable message.
   */
  outputSource?: string;
};

// ── Public API ─────────────────────────────────────────────────────

export type ProcessBlockResult = {
  /** The complete loki.process block as Alloy config string. */
  block: string;
  /** Component ID for health checking: "loki.process.lens_{id}_process" */
  componentId: string;
  /** Receiver reference for source forward_to: "loki.process.lens_{id}_process.receiver" */
  receiverRef: string;
};

/**
 * Build a loki.process config block from declarative parameters.
 * Returns null if no processing params are set (backwards compatible).
 *
 * @param forwardTo — The Alloy receiver to forward processed logs to,
 *   e.g., "loki.write.lens_abc_write.receiver"
 */
export function buildProcessBlock(
  pipelineId: string,
  params: LogProcessingParams,
  forwardTo: string,
): ProcessBlockResult | null {
  const stages: string[] = [];

  // Stage ordering: json → regex → timestamp → labels → structured_metadata → static_labels → tenant → match → output
  if (params.jsonExpressions && Object.keys(params.jsonExpressions).length > 0) {
    stages.push(buildJsonStage(params.jsonExpressions));
  }

  if (params.regexExpression) {
    stages.push(buildRegexStage(params.regexExpression));
  }

  if (params.timestampSource) {
    stages.push(buildTimestampStage(params.timestampSource, params.timestampFormat || "RFC3339"));
  }

  if (params.labelFields && Object.keys(params.labelFields).length > 0) {
    stages.push(buildValuesStage("labels", params.labelFields));
  }

  if (params.structuredMetadata && Object.keys(params.structuredMetadata).length > 0) {
    stages.push(buildValuesStage("structured_metadata", params.structuredMetadata));
  }

  if (params.staticLabels && Object.keys(params.staticLabels).length > 0) {
    stages.push(buildValuesStage("static_labels", params.staticLabels));
  }

  if (params.tenantValue) {
    stages.push(buildTenantStage({ value: params.tenantValue }));
  } else if (params.tenantSource) {
    stages.push(buildTenantStage({ source: params.tenantSource }));
  }

  if (params.matchRoutes && params.matchRoutes.length > 0) {
    for (const route of params.matchRoutes) {
      stages.push(buildMatchStage(route));
    }
  }

  if (params.outputSource) {
    stages.push(buildOutputStage(params.outputSource));
  }

  // No stages → no processing needed
  if (stages.length === 0) return null;

  const label = componentLabel(pipelineId, "process");

  const block = `loki.process "${label}" {
${stages.join("\n\n")}

  forward_to = [${forwardTo}]
}`;

  return {
    block,
    componentId: `loki.process.${label}`,
    receiverRef: `loki.process.${label}.receiver`,
  };
}

/**
 * Check if any processing params are set.
 * Useful for recipes that need to conditionally add processing params to optionalParams.
 */
export function hasProcessingParams(params: Record<string, unknown>): boolean {
  return !!(
    params.jsonExpressions ||
    params.regexExpression ||
    params.timestampSource ||
    params.labelFields ||
    params.structuredMetadata ||
    params.staticLabels ||
    params.tenantValue ||
    params.tenantSource ||
    params.matchRoutes ||
    params.outputSource
  );
}

/**
 * Extract LogProcessingParams from a raw params object.
 * Picks only the processing-related fields.
 */
export function extractProcessingParams(params: Record<string, unknown>): LogProcessingParams {
  return {
    jsonExpressions: params.jsonExpressions as Record<string, string> | undefined,
    regexExpression: params.regexExpression as string | undefined,
    timestampSource: params.timestampSource as string | undefined,
    timestampFormat: params.timestampFormat as string | undefined,
    labelFields: params.labelFields as Record<string, string> | undefined,
    structuredMetadata: params.structuredMetadata as Record<string, string> | undefined,
    staticLabels: params.staticLabels as Record<string, string> | undefined,
    tenantValue: params.tenantValue as string | undefined,
    tenantSource: params.tenantSource as string | undefined,
    matchRoutes: params.matchRoutes as MatchRoute[] | undefined,
    outputSource: params.outputSource as string | undefined,
  };
}

/**
 * Common optional param definitions for log processing.
 * Import and spread into any log recipe's optionalParams array.
 */
export const PROCESSING_OPTIONAL_PARAMS = [
  {
    name: "jsonExpressions" as const,
    type: "object" as const,
    description: "JSON field extraction. Keys=output names, values=JSON paths (empty string=same name). E.g., { level: '', request_id: 'ctx.rid' }",
  },
  {
    name: "regexExpression" as const,
    type: "string" as const,
    description: "Regex with named capture groups for field extraction. E.g., '^(?P<ts>\\\\S+) (?P<level>\\\\w+)'",
  },
  {
    name: "timestampSource" as const,
    type: "string" as const,
    description: "Extract timestamps from this field name (use with timestampFormat)",
  },
  {
    name: "timestampFormat" as const,
    type: "string" as const,
    description: "Timestamp format: RFC3339, RFC3339Nano, Unix, UnixMs, or Go layout",
    default: "RFC3339",
  },
  {
    name: "labelFields" as const,
    type: "object" as const,
    description: "Promote fields to Loki labels. Keys=label names, values=source fields (empty=same). Use sparingly for low-cardinality fields",
  },
  {
    name: "structuredMetadata" as const,
    type: "object" as const,
    description: "Store high-cardinality fields as structured metadata (queryable, not indexed). Preferred for request_id, user_id, etc.",
  },
  {
    name: "staticLabels" as const,
    type: "object" as const,
    description: "Add fixed labels to all entries. E.g., { environment: 'production' }",
  },
  {
    name: "tenantValue" as const,
    type: "string" as const,
    description: "Static Loki tenant ID (X-Scope-OrgID). Routes all logs to this tenant",
  },
  {
    name: "tenantSource" as const,
    type: "string" as const,
    description: "Dynamic Loki tenant ID — reads tenant from this extracted field name",
  },
  {
    name: "matchRoutes" as const,
    type: "object" as const,
    description:
      "Multi-tenant routing: array of {selector, tenantValue?, tenantSource?, pipelineName?}. " +
      "Each route matches logs by LogQL selector and applies nested tenant/stages. " +
      'E.g., [{selector: \'{env="prod"}\', tenantValue: "prod-tenant"}]',
  },
  {
    name: "outputSource" as const,
    type: "string" as const,
    description: "Replace log line with this extracted field's value (e.g., 'message')",
  },
];

// ── Stage Builders ─────────────────────────────────────────────────

function buildJsonStage(expressions: Record<string, string>): string {
  const entries = Object.entries(expressions)
    .map(([key, val]) => `      "${escapeString(key)}" = "${escapeString(val)}"`)
    .join(",\n");
  return `  stage.json {
    expressions = {
${entries},
    }
  }`;
}

function buildRegexStage(expression: string): string {
  return `  stage.regex {
    expression = "${escapeString(expression)}"
  }`;
}

function buildTimestampStage(source: string, format: string): string {
  return `  stage.timestamp {
    source = "${escapeString(source)}"
    format = "${escapeString(format)}"
  }`;
}

/** Shared builder for stage.labels, stage.structured_metadata, and stage.static_labels. */
function buildValuesStage(stageName: string, values: Record<string, string>): string {
  const entries = Object.entries(values)
    .map(([key, val]) => `      "${escapeString(key)}" = "${escapeString(val)}"`)
    .join(",\n");
  return `  stage.${stageName} {
    values = {
${entries},
    }
  }`;
}

function buildOutputStage(source: string): string {
  return `  stage.output {
    source = "${escapeString(source)}"
  }`;
}

function buildTenantStage(opts: { value?: string; source?: string }, indent = "  "): string {
  if (opts.value) {
    return `${indent}stage.tenant {\n${indent}  value = "${escapeString(opts.value)}"\n${indent}}`;
  }
  return `${indent}stage.tenant {\n${indent}  source = "${escapeString(opts.source!)}"\n${indent}}`;
}

function buildMatchStage(route: MatchRoute): string {
  const lines: string[] = [];
  lines.push(`  stage.match {`);
  lines.push(`    selector = "${escapeString(route.selector)}"`);
  if (route.pipelineName) {
    lines.push(`    pipeline_name = "${escapeString(route.pipelineName)}"`);
  }
  if (route.tenantValue) {
    lines.push(buildTenantStage({ value: route.tenantValue }, "    "));
  } else if (route.tenantSource) {
    lines.push(buildTenantStage({ source: route.tenantSource }, "    "));
  }
  lines.push(`  }`);
  return lines.join("\n");
}
