import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { buildProcessBlock, extractProcessingParams, PROCESSING_OPTIONAL_PARAMS } from "./_process-builder.js";

const recipe: PipelineRecipe = {
  name: "loki-push-api",
  category: "logs",
  signal: "logs",
  summary: "Accept logs via Loki-compatible HTTP push API — centralized log gateway with optional JSON/label processing",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "listenPort", type: "number", description: "HTTP listen port", default: 3500 },
    { name: "listenAddress", type: "string", description: "Bind address", default: "0.0.0.0" },
    ...PROCESSING_OPTIONAL_PARAMS,
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const listenPort = (params.listenPort as number) ?? 3500;
    const listenAddress = (params.listenAddress as string) || "0.0.0.0";
    const srcLabel = componentLabel(pipelineId, "push_api");
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

    builder.addBlock(`loki.source.api "${srcLabel}" {
  http {
    listen_address = "${escapeString(listenAddress)}"
    listen_port    = ${listenPort}
  }
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

    return builder.build(pipelineId, "loki-push-api", "loki-push-api");
  },

  sampleQueries() {
    return {
      recentLogs: '{source="push-api"}',
      errorLogs: '{source="push-api"} |= "error"',
      logVolume: 'rate({source="push-api"}[5m])',
    };
  },

  componentIds(pipelineId: string) {
    return [
      `loki.source.api.${componentLabel(pipelineId, "push_api")}`,
      `loki.write.${componentLabel(pipelineId, "write")}`,
    ];
  },

  boundPorts(params: ResolvedParams) {
    return [Number(params.listenPort)];
  },
};

export default recipe;
