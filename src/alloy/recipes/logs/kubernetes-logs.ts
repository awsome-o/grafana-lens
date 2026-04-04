import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { buildProcessBlock, extractProcessingParams, PROCESSING_OPTIONAL_PARAMS } from "./_process-builder.js";

const recipe: PipelineRecipe = {
  name: "kubernetes-logs",
  category: "logs",
  signal: "logs",
  summary: "Collect Kubernetes pod logs and forward to Loki, with optional JSON/label processing",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "namespaces", type: "string[]", description: "Namespaces to collect from (empty = all)", default: [] },
    { name: "labelSelector", type: "string", description: "Label selector for filtering pods" },
    ...PROCESSING_OPTIONAL_PARAMS,
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const srcLabel = componentLabel(pipelineId, "k8s_logs");
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

    builder.addBlock(`loki.source.kubernetes "${srcLabel}" {
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

    return builder.build(pipelineId, "kubernetes-logs", "kubernetes-logs");
  },

  sampleQueries() {
    return { recentLogs: '{namespace=~".+"}', errorLogs: '{namespace=~".+"} |= "error"', logsByNamespace: 'sum by(namespace) (rate({namespace=~".+"}[5m]))' };
  },

  componentIds(pipelineId: string) {
    return [`loki.source.kubernetes.${componentLabel(pipelineId, "k8s_logs")}`, `loki.write.${componentLabel(pipelineId, "write")}`];
  },
};

export default recipe;
