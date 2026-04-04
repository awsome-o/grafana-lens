import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString, renderTargets } from "../../config-builder.js";

/**
 * Valid pprof profile types for Go applications.
 * Maps to pyroscope.scrape profiling_config blocks.
 */
const VALID_PROFILE_TYPES = ["cpu", "memory", "goroutine", "mutex", "block"] as const;

/**
 * Map our short names to Alloy's profiling_config block names.
 * "cpu" → profile.process_cpu, rest → profile.{name}
 */
function profileBlockName(type: string): string {
  return type === "cpu" ? "profile.process_cpu" : `profile.${type}`;
}

type Target = { address: string; serviceName: string };

function validateTargets(raw: unknown): Target[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      "continuous-profiling requires 'targets' — array of { address, serviceName }. " +
        'Example: [{ "address": "myapp:6060", "serviceName": "my-app" }]',
    );
  }
  return raw.map((t, i) => {
    const obj = t as Record<string, unknown>;
    if (!obj.address || typeof obj.address !== "string") {
      throw new Error(`targets[${i}]: 'address' is required (e.g., "myapp:6060")`);
    }
    if (!obj.serviceName || typeof obj.serviceName !== "string") {
      throw new Error(`targets[${i}]: 'serviceName' is required (e.g., "my-app")`);
    }
    return { address: obj.address, serviceName: obj.serviceName };
  });
}

const recipe: PipelineRecipe = {
  name: "continuous-profiling",
  category: "profiling",
  signal: "profiles",
  summary:
    "Continuous profiling via Pyroscope — scrape pprof profiles (CPU, memory, goroutine, mutex, block) from Go applications and send to Pyroscope",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [
    {
      name: "targets",
      type: "object",
      description:
        'Array of targets: [{ address: "host:port", serviceName: "my-app" }]. ' +
        "Go apps expose pprof at :6060/debug/pprof by default",
      example: '[{"address": "myapp:6060", "serviceName": "my-app"}]',
    },
  ],

  optionalParams: [
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
    {
      name: "profileTypes",
      type: "object",
      description:
        "Profile types to enable. Valid: cpu, memory, goroutine, mutex, block. " +
        "Default: all five enabled",
      default: ["cpu", "memory", "goroutine", "mutex", "block"],
    },
    {
      name: "pyroscopeUrl",
      type: "string",
      description: "Override Pyroscope write URL (default from config or http://localhost:4040)",
    },
  ],

  generateConfig(
    pipelineId: string,
    params: ResolvedParams,
    targets: ExportTargets,
    _pipelineName: string,
  ): string {
    const validatedTargets = validateTargets(params.targets);
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const profileTypes = (params.profileTypes as string[]) ?? VALID_PROFILE_TYPES.slice();
    const pyroscopeUrl =
      (params.pyroscopeUrl as string) || targets.pyroscopeWriteUrl || "http://localhost:4040";

    // Validate profile types
    for (const pt of profileTypes) {
      if (!VALID_PROFILE_TYPES.includes(pt as (typeof VALID_PROFILE_TYPES)[number])) {
        throw new Error(
          `Invalid profile type '${pt}'. Valid types: ${VALID_PROFILE_TYPES.join(", ")}`,
        );
      }
    }

    const scrapeLabel = componentLabel(pipelineId, "profiles");
    const writeLabel = componentLabel(pipelineId, "write");

    // Build targets using shared utility
    const targetsStr = renderTargets(
      validatedTargets.map((t) => ({ address: t.address, labels: { service_name: t.serviceName } })),
    );

    // Build profiling_config — iterate ALL valid types, mark selected ones as enabled
    const profileBlocks = VALID_PROFILE_TYPES
      .map((pt) => {
        const enabled = profileTypes.includes(pt);
        return `    ${profileBlockName(pt)} {\n      enabled = ${enabled}\n    }`;
      })
      .join("\n\n");

    const builder = new AlloyConfigBuilder();

    builder.addBlock(`pyroscope.scrape "${scrapeLabel}" {
  targets = ${targetsStr}

  scrape_interval = "${escapeString(scrapeInterval)}"

  profiling_config {
${profileBlocks}
  }

  forward_to = [pyroscope.write.${writeLabel}.receiver]
}`);

    builder.addBlock(`pyroscope.write "${writeLabel}" {
  endpoint {
    url = "${escapeString(pyroscopeUrl)}"
  }
}`);

    return builder.build(pipelineId, "continuous-profiling", "continuous-profiling");
  },

  sampleQueries(params: ResolvedParams) {
    const targets = params.targets as Target[];
    const svc = targets?.[0]?.serviceName ?? "my-app";
    return {
      cpuProfile: `process_cpu:cpu:nanoseconds:cpu:nanoseconds{service_name="${svc}"}`,
      memoryProfile: `memory:alloc_objects:count:space:bytes{service_name="${svc}"}`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `pyroscope.scrape.${componentLabel(pipelineId, "profiles")}`,
      `pyroscope.write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
