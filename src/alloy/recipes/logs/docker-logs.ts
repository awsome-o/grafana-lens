import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { buildProcessBlock, extractProcessingParams, PROCESSING_OPTIONAL_PARAMS } from "./_process-builder.js";

const recipe: PipelineRecipe = {
  name: "docker-logs",
  category: "logs",
  signal: "logs",
  summary: "Collect Docker container logs and forward to Loki, with optional JSON/label processing",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "containerNames", type: "string[]", description: "Only collect from these containers (empty = all)", default: [] },
    { name: "excludeContainers", type: "string[]", description: "Exclude these containers", default: [] },
    { name: "labels", type: "string", description: "Extra labels as key=value pairs" },
    ...PROCESSING_OPTIONAL_PARAMS,
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const containerNames = (params.containerNames as string[] | undefined) ?? [];
    const excludeContainers = (params.excludeContainers as string[] | undefined) ?? [];
    const discLabel = componentLabel(pipelineId, "discover");
    const relabelLabel = componentLabel(pipelineId, "relabel");
    const srcLabel = componentLabel(pipelineId, "docker");
    const writeLabel = componentLabel(pipelineId, "write");
    const needsRelabel = containerNames.length > 0 || excludeContainers.length > 0;

    const builder = new AlloyConfigBuilder();

    builder.addBlock(`discovery.docker "${discLabel}" {
  host             = "unix:///var/run/docker.sock"
  refresh_interval = "5s"
}`);

    if (needsRelabel) {
      const rules: string[] = [];
      if (containerNames.length > 0) {
        const regex = containerNames.map((n) => escapeString(n)).join("|");
        rules.push(`  rule {\n    source_labels = ["__meta_docker_container_name"]\n    regex         = "/?(${regex})"\n    action        = "keep"\n  }`);
      }
      if (excludeContainers.length > 0) {
        const regex = excludeContainers.map((n) => escapeString(n)).join("|");
        rules.push(`  rule {\n    source_labels = ["__meta_docker_container_name"]\n    regex         = "/?(${regex})"\n    action        = "drop"\n  }`);
      }
      builder.addBlock(`discovery.relabel "${relabelLabel}" {\n  targets = discovery.docker.${discLabel}.targets\n${rules.join("\n")}\n}`);
    }

    const targetsRef = needsRelabel
      ? `discovery.relabel.${relabelLabel}.output`
      : `discovery.docker.${discLabel}.targets`;

    // Wire: source → [process →] write
    const processing = buildProcessBlock(
      pipelineId,
      extractProcessingParams(params),
      `loki.write.${writeLabel}.receiver`,
    );

    const forwardTo = processing
      ? processing.receiverRef
      : `loki.write.${writeLabel}.receiver`;

    builder.addBlock(`loki.source.docker "${srcLabel}" {
  host       = "unix:///var/run/docker.sock"
  targets    = ${targetsRef}
  forward_to = [${forwardTo}]
  labels     = { source = "docker" }
}`);

    if (processing) {
      builder.addBlock(processing.block);
    }

    builder.addBlock(`loki.write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.lokiWriteUrl)}"
  }
}`);

    return builder.build(pipelineId, "docker-logs", "docker-logs");
  },

  sampleQueries(_params: ResolvedParams, _jobName: string) {
    return {
      recentLogs: '{source="docker"}',
      errorLogs: '{source="docker"} |= "error"',
      logVolume: 'rate({source="docker"}[5m])',
    };
  },

  componentIds(pipelineId: string) {
    return [
      `discovery.docker.${componentLabel(pipelineId, "discover")}`,
      `loki.source.docker.${componentLabel(pipelineId, "docker")}`,
      `loki.write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
