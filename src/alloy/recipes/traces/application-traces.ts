import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString, renderValue } from "../../config-builder.js";

// ── Sampling Policy Types ──────────────────────────────────────────

/**
 * Tail sampling policy definition.
 * Each policy type maps to an otelcol.processor.tail_sampling policy block.
 *
 * Policy evaluation: Alloy evaluates policies in order. A trace is kept if
 * ANY policy matches (OR logic). Place specific policies (errors, latency)
 * before catch-all (probabilistic) so important traces are always retained.
 */
type SamplingPolicy =
  | { name: string; type: "status_code"; statusCodes: string[] }
  | { name: string; type: "latency"; thresholdMs: number }
  | { name: string; type: "probabilistic"; samplingPercentage: number }
  | { name: string; type: "string_attribute"; key: string; values: string[]; invertMatch?: boolean }
  | { name: string; type: "numeric_attribute"; key: string; minValue: number; maxValue: number };

/**
 * Generate Alloy config for a single sampling policy block.
 */
function renderPolicy(policy: SamplingPolicy): string {
  const lines: string[] = [];
  lines.push(`  policy {`);
  lines.push(`    name = "${escapeString(policy.name)}"`);
  lines.push(`    type = "${escapeString(policy.type)}"`);

  switch (policy.type) {
    case "status_code":
      lines.push(`    status_code {`);
      lines.push(`      status_codes = ${renderValue(policy.statusCodes)}`);
      lines.push(`    }`);
      break;
    case "latency":
      lines.push(`    latency {`);
      lines.push(`      threshold_ms = ${policy.thresholdMs}`);
      lines.push(`    }`);
      break;
    case "probabilistic":
      lines.push(`    probabilistic {`);
      lines.push(`      sampling_percentage = ${policy.samplingPercentage}`);
      lines.push(`    }`);
      break;
    case "string_attribute":
      lines.push(`    string_attribute {`);
      lines.push(`      key    = "${escapeString(policy.key)}"`);
      lines.push(`      values = ${renderValue(policy.values)}`);
      if (policy.invertMatch) {
        lines.push(`      invert_match = true`);
      }
      lines.push(`    }`);
      break;
    case "numeric_attribute":
      lines.push(`    numeric_attribute {`);
      lines.push(`      key       = "${escapeString(policy.key)}"`);
      lines.push(`      min_value = ${policy.minValue}`);
      lines.push(`      max_value = ${policy.maxValue}`);
      lines.push(`    }`);
      break;
  }

  lines.push(`  }`);
  return lines.join("\n");
}

/**
 * Validate a raw samplingPolicies array from params.
 * Throws descriptive errors for the agent to relay.
 */
function validatePolicies(raw: unknown): SamplingPolicy[] {
  if (!Array.isArray(raw)) {
    throw new Error("samplingPolicies must be an array of policy objects");
  }
  if (raw.length === 0) {
    throw new Error("samplingPolicies must contain at least one policy");
  }

  const validTypes = ["status_code", "latency", "probabilistic", "string_attribute", "numeric_attribute"];

  return raw.map((p, i) => {
    if (!p || typeof p !== "object") {
      throw new Error(`samplingPolicies[${i}]: each policy must be an object`);
    }
    const policy = p as Record<string, unknown>;
    if (!policy.name || typeof policy.name !== "string") {
      throw new Error(`samplingPolicies[${i}]: 'name' is required (string)`);
    }
    if (!policy.type || typeof policy.type !== "string" || !validTypes.includes(policy.type)) {
      throw new Error(
        `samplingPolicies[${i}]: 'type' must be one of: ${validTypes.join(", ")}`,
      );
    }

    const name = policy.name as string;
    switch (policy.type) {
      case "status_code":
        if (!Array.isArray(policy.statusCodes) || policy.statusCodes.length === 0) {
          throw new Error(`samplingPolicies[${i}] (status_code): 'statusCodes' required (e.g., ["ERROR"])`);
        }
        return { name, type: "status_code" as const, statusCodes: policy.statusCodes as string[] };
      case "latency":
        if (typeof policy.thresholdMs !== "number" || policy.thresholdMs <= 0) {
          throw new Error(`samplingPolicies[${i}] (latency): 'thresholdMs' required (positive number, e.g., 5000)`);
        }
        return { name, type: "latency" as const, thresholdMs: policy.thresholdMs };
      case "probabilistic":
        if (typeof policy.samplingPercentage !== "number" || policy.samplingPercentage < 0 || policy.samplingPercentage > 100) {
          throw new Error(`samplingPolicies[${i}] (probabilistic): 'samplingPercentage' required (0-100)`);
        }
        return { name, type: "probabilistic" as const, samplingPercentage: policy.samplingPercentage };
      case "string_attribute":
        if (!policy.key || typeof policy.key !== "string") {
          throw new Error(`samplingPolicies[${i}] (string_attribute): 'key' required (string)`);
        }
        if (!Array.isArray(policy.values) || policy.values.length === 0) {
          throw new Error(`samplingPolicies[${i}] (string_attribute): 'values' required (string[])`);
        }
        return { name, type: "string_attribute" as const, key: policy.key, values: policy.values as string[], invertMatch: !!policy.invertMatch };
      case "numeric_attribute":
        if (!policy.key || typeof policy.key !== "string") {
          throw new Error(`samplingPolicies[${i}] (numeric_attribute): 'key' required (string)`);
        }
        if (typeof policy.minValue !== "number" || typeof policy.maxValue !== "number") {
          throw new Error(`samplingPolicies[${i}] (numeric_attribute): 'minValue' and 'maxValue' required (numbers)`);
        }
        return { name, type: "numeric_attribute" as const, key: policy.key, minValue: policy.minValue, maxValue: policy.maxValue };
      default:
        throw new Error(`samplingPolicies[${i}]: unknown type '${policy.type}'`);
    }
  });
}

// ── Recipe ─────────────────────────────────────────────────────────

const recipe: PipelineRecipe = {
  name: "application-traces",
  category: "traces",
  signal: "traces",
  summary:
    "Receive application traces with service name enrichment, batching, and sampling. " +
    "Simple mode: sampleRate (0-1) for probabilistic sampling. " +
    "Advanced mode: samplingPolicies array for multi-policy tail sampling (keep errors, keep slow traces, filter health checks, rate-limit the rest)",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "serviceName", type: "string", description: "Service name to set on all spans" },
    { name: "environment", type: "string", description: "Environment label (e.g., production, staging)", default: "production" },
    { name: "sampleRate", type: "number", description: "Simple sampling: rate 0.0-1.0 (1.0 = keep all). Ignored when samplingPolicies is set", default: 1.0 },
    {
      name: "samplingPolicies",
      type: "object",
      description:
        "Advanced multi-policy tail sampling. Array of policy objects. " +
        "Types: status_code ({statusCodes}), latency ({thresholdMs}), probabilistic ({samplingPercentage}), " +
        "string_attribute ({key, values, invertMatch?}), numeric_attribute ({key, minValue, maxValue}). " +
        "Policies are OR-ed: trace is kept if ANY policy matches. Place specific policies before catch-all.",
      example: '[{"name":"keep-errors","type":"status_code","statusCodes":["ERROR"]},{"name":"sample-rest","type":"probabilistic","samplingPercentage":10}]',
    },
    { name: "decisionWait", type: "string", description: "How long to wait for spans before sampling decision (only with samplingPolicies)", default: "10s" },
    { name: "numTraces", type: "number", description: "Max traces held in memory for sampling decision (only with samplingPolicies)", default: 100 },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const environment = (params.environment as string) || "production";
    const sampleRate = (params.sampleRate as number) ?? 1.0;
    const rawPolicies = params.samplingPolicies as unknown[] | undefined;
    const decisionWait = (params.decisionWait as string) || "10s";
    const numTraces = (params.numTraces as number) ?? 100;

    // Determine sampling mode: multi-policy takes precedence over sampleRate
    const policies = rawPolicies ? validatePolicies(rawPolicies) : null;
    const useSimpleSampling = !policies && sampleRate > 0 && sampleRate < 1.0;
    const useSampling = !!policies || useSimpleSampling;

    const recvLabel = componentLabel(pipelineId, "otlp");
    const attrLabel = componentLabel(pipelineId, "attrs");
    const samplerLabel = componentLabel(pipelineId, "sampler");
    const batchLabel = componentLabel(pipelineId, "batch");
    const expLabel = componentLabel(pipelineId, "export");

    const builder = new AlloyConfigBuilder();

    // Receiver → attributes enrichment
    builder.addBlock(`otelcol.receiver.otlp "${recvLabel}" {
  grpc {
    endpoint = "0.0.0.0:4317"
  }
  http {
    endpoint = "0.0.0.0:4318"
  }
  output {
    traces = [otelcol.processor.attributes.${attrLabel}.input]
  }
}`);

    // Attributes → sampling (if enabled) or batch
    const attrNext = useSampling
      ? `otelcol.processor.tail_sampling.${samplerLabel}.input`
      : `otelcol.processor.batch.${batchLabel}.input`;

    builder.addBlock(`otelcol.processor.attributes "${attrLabel}" {
  action {
    key    = "deployment.environment"
    value  = "${escapeString(environment)}"
    action = "upsert"
  }
  output {
    traces = [${attrNext}]
  }
}`);

    // Tail sampling — multi-policy or simple probabilistic
    if (policies) {
      const policyBlocks = policies.map(renderPolicy).join("\n\n");
      builder.addBlock(`otelcol.processor.tail_sampling "${samplerLabel}" {
  decision_wait = "${escapeString(decisionWait)}"
  num_traces    = ${numTraces}

${policyBlocks}

  output {
    traces = [otelcol.processor.batch.${batchLabel}.input]
  }
}`);
    } else if (useSimpleSampling) {
      const pct = Math.round(sampleRate * 100);
      builder.addBlock(`otelcol.processor.tail_sampling "${samplerLabel}" {
  decision_wait = "10s"
  policy {
    name = "probabilistic"
    type = "probabilistic"
    probabilistic {
      sampling_percentage = ${pct}
    }
  }
  output {
    traces = [otelcol.processor.batch.${batchLabel}.input]
  }
}`);
    }

    builder.addBlock(`otelcol.processor.batch "${batchLabel}" {
  output {
    traces = [otelcol.exporter.otlphttp.${expLabel}.input]
  }
}`);

    builder.addBlock(`otelcol.exporter.otlphttp "${expLabel}" {
  client {
    endpoint = "${escapeString(targets.otlpEndpoint)}"
  }
}`);

    return builder.build(pipelineId, "application-traces", "application-traces");
  },

  sampleQueries(params: ResolvedParams) {
    const env = (params.environment as string) || "production";
    const queries: Record<string, string> = {
      traces: `{ resource.deployment.environment = "${env}" }`,
      errorTraces: `{ resource.deployment.environment = "${env}" && status = error }`,
    };

    // Add policy-specific queries when using multi-policy sampling
    const rawPolicies = params.samplingPolicies as unknown[] | undefined;
    if (rawPolicies && Array.isArray(rawPolicies)) {
      for (const p of rawPolicies) {
        const policy = p as Record<string, unknown>;
        if (policy.type === "latency" && typeof policy.thresholdMs === "number") {
          queries.slowTraces = `{ resource.deployment.environment = "${env}" && duration > ${policy.thresholdMs}ms }`;
        }
      }
    }

    return queries;
  },

  componentIds(pipelineId: string) {
    return [
      `otelcol.receiver.otlp.${componentLabel(pipelineId, "otlp")}`,
      `otelcol.processor.attributes.${componentLabel(pipelineId, "attrs")}`,
      // Sampler is conditionally present — included here always for health checking.
      // If not in config, Alloy simply won't report it (missing != unhealthy).
      `otelcol.processor.batch.${componentLabel(pipelineId, "batch")}`,
      `otelcol.exporter.otlphttp.${componentLabel(pipelineId, "export")}`,
    ];
  },

  boundPorts() {
    return [4317, 4318];
  },
};

export default recipe;
