import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { buildProcessBlock, extractProcessingParams, PROCESSING_OPTIONAL_PARAMS } from "./_process-builder.js";

const recipe: PipelineRecipe = {
  name: "journal-logs",
  category: "logs",
  signal: "logs",
  summary: "Read systemd journal logs and forward to Loki, with optional JSON/label processing",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "units", type: "string[]", description: "Systemd units to collect from (empty = all)", default: [] },
    { name: "priority", type: "string", description: "Minimum journal priority (0-7, lower = more critical)", default: "6" },
    ...PROCESSING_OPTIONAL_PARAMS,
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const srcLabel = componentLabel(pipelineId, "journal");
    const writeLabel = componentLabel(pipelineId, "write");

    const builder = new AlloyConfigBuilder();

    const processing = buildProcessBlock(
      pipelineId,
      extractProcessingParams(params),
      `loki.write.${writeLabel}.receiver`,
    );

    const forwardTo = processing
      ? processing.receiverRef
      : `loki.write.${writeLabel}.receiver`;

    builder.addBlock(`loki.source.journal "${srcLabel}" {
  forward_to = [${forwardTo}]
  labels     = { source = "journal" }
}`);

    if (processing) {
      builder.addBlock(processing.block);
    }

    builder.addBlock(`loki.write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.lokiWriteUrl)}"
  }
}`);

    return builder.build(pipelineId, "journal-logs", "journal-logs");
  },

  sampleQueries() {
    return { recentLogs: '{source="journal"}', errorLogs: '{source="journal"} |= "error"' };
  },

  componentIds(pipelineId: string) {
    return [`loki.source.journal.${componentLabel(pipelineId, "journal")}`, `loki.write.${componentLabel(pipelineId, "write")}`];
  },
};

export default recipe;
