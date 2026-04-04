import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { buildProcessBlock, extractProcessingParams, PROCESSING_OPTIONAL_PARAMS } from "./_process-builder.js";

const recipe: PipelineRecipe = {
  name: "syslog",
  category: "logs",
  signal: "logs",
  summary: "Receive syslog messages and forward to Loki, with optional JSON/label processing",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "listenAddress", type: "string", description: "Address to listen on", default: "0.0.0.0:1514" },
    { name: "protocol", type: "string", description: "Transport protocol (tcp or udp)", default: "tcp" },
    ...PROCESSING_OPTIONAL_PARAMS,
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const listenAddress = (params.listenAddress as string) || "0.0.0.0:1514";
    const protocol = (params.protocol as string) || "tcp";
    const srcLabel = componentLabel(pipelineId, "syslog");
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

    builder.addBlock(`loki.source.syslog "${srcLabel}" {
  listener {
    address  = "${escapeString(listenAddress)}"
    protocol = "${escapeString(protocol)}"
    labels   = { source = "syslog" }
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

    return builder.build(pipelineId, "syslog", "syslog");
  },

  sampleQueries() {
    return { recentLogs: '{source="syslog"}', errorLogs: '{source="syslog"} |= "error"' };
  },

  componentIds(pipelineId: string) {
    return [`loki.source.syslog.${componentLabel(pipelineId, "syslog")}`, `loki.write.${componentLabel(pipelineId, "write")}`];
  },

  boundPorts(params: ResolvedParams) {
    const addr = String(params.listenAddress);
    const match = addr.match(/:(\d+)$/);
    return match ? [Number(match[1])] : [];
  },
};

export default recipe;
