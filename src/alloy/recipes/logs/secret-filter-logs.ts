import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "secret-filter-logs",
  category: "logs",
  signal: "logs",
  summary: "Tail log files with automatic secret redaction using Gitleaks patterns — compliance-ready",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [
    { name: "paths", type: "string[]", description: "Glob patterns for log files to tail", example: "/var/log/app/*.log" },
  ],

  optionalParams: [
    { name: "redactWith", type: "string", description: "Replacement text for redacted secrets", default: "<REDACTED:$SECRET_NAME>" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const paths = params.paths as string[];
    const redactWith = (params.redactWith as string) || "<REDACTED:$SECRET_NAME>";
    const matchLabel = componentLabel(pipelineId, "match");
    const srcLabel = componentLabel(pipelineId, "file");
    const filterLabel = componentLabel(pipelineId, "filter");
    const writeLabel = componentLabel(pipelineId, "write");

    const builder = new AlloyConfigBuilder();

    builder.addBlock(`local.file_match "${matchLabel}" {
  path_targets = [${paths.map((p) => `{ __path__ = "${escapeString(p)}" }`).join(", ")}]
}`);

    builder.addBlock(`loki.source.file "${srcLabel}" {
  targets    = local.file_match.${matchLabel}.targets
  forward_to = [loki.secretfilter.${filterLabel}.receiver]
}`);

    builder.addBlock(`loki.secretfilter "${filterLabel}" {
  redact_with = "${escapeString(redactWith)}"
  forward_to  = [loki.write.${writeLabel}.receiver]
}`);

    builder.addBlock(`loki.write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.lokiWriteUrl)}"
  }
}`);

    return builder.build(pipelineId, "secret-filter-logs", "secret-filter-logs");
  },

  sampleQueries() {
    return {
      recentLogs: '{source="file"}',
      redactedEntries: '{source="file"} |= "REDACTED"',
      logVolume: 'rate({source="file"}[5m])',
    };
  },

  componentIds(pipelineId: string) {
    return [
      `local.file_match.${componentLabel(pipelineId, "match")}`,
      `loki.source.file.${componentLabel(pipelineId, "file")}`,
      `loki.secretfilter.${componentLabel(pipelineId, "filter")}`,
      `loki.write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
