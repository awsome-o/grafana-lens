import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { buildProcessBlock, extractProcessingParams, PROCESSING_OPTIONAL_PARAMS } from "./_process-builder.js";

const recipe: PipelineRecipe = {
  name: "file-logs",
  category: "logs",
  signal: "logs",
  summary: "Tail and ship local log files to Loki, with optional JSON/label processing",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [
    { name: "paths", type: "string[]", description: "Glob patterns for log files to tail", example: "/var/log/app/*.log" },
  ],

  optionalParams: [
    { name: "labels", type: "string", description: "Extra labels as key=value pairs" },
    { name: "encoding", type: "string", description: "File encoding", default: "utf-8" },
    ...PROCESSING_OPTIONAL_PARAMS,
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const paths = params.paths as string[];
    const matchLabel = componentLabel(pipelineId, "match");
    const srcLabel = componentLabel(pipelineId, "file");
    const writeLabel = componentLabel(pipelineId, "write");

    const builder = new AlloyConfigBuilder();

    builder.addBlock(`local.file_match "${matchLabel}" {
  path_targets = [${paths.map((p) => `{ __path__ = "${escapeString(p)}" }`).join(", ")}]
}`);

    // Check for processing params — wire source → process → write or source → write
    const processing = buildProcessBlock(
      pipelineId,
      extractProcessingParams(params),
      `loki.write.${writeLabel}.receiver`,
    );

    const forwardTo = processing
      ? processing.receiverRef
      : `loki.write.${writeLabel}.receiver`;

    builder.addBlock(`loki.source.file "${srcLabel}" {
  targets    = local.file_match.${matchLabel}.targets
  forward_to = [${forwardTo}]
}`);

    if (processing) {
      builder.addBlock(processing.block);
    }

    builder.addBlock(`loki.write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.lokiWriteUrl)}"
  }
}`);

    return builder.build(pipelineId, "file-logs", "file-logs");
  },

  sampleQueries(_params: ResolvedParams, _jobName: string) {
    return {
      recentLogs: '{source="file"}',
      errorLogs: '{source="file"} |= "error"',
      logVolume: 'rate({source="file"}[5m])',
    };
  },

  componentIds(pipelineId: string) {
    return [
      `local.file_match.${componentLabel(pipelineId, "match")}`,
      `loki.source.file.${componentLabel(pipelineId, "file")}`,
      `loki.write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
