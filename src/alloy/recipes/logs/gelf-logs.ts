import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "gelf-logs",
  category: "logs",
  signal: "logs",
  summary:
    "Receive GELF (Graylog Extended Log Format) logs over UDP with automatic metadata relabeling — host, level, facility. Common with Docker GELF driver and Graylog ecosystems",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "listenAddress", type: "string", description: "UDP listen address (host:port)", default: "0.0.0.0:12201" },
    { name: "relabelHost", type: "boolean", description: "Promote __gelf_message_host to 'host' label", default: true },
    { name: "relabelLevel", type: "boolean", description: "Promote __gelf_message_level to 'level' label", default: true },
    { name: "relabelFacility", type: "boolean", description: "Promote __gelf_message_facility to 'facility' label", default: true },
  ],

  generateConfig(
    pipelineId: string,
    params: ResolvedParams,
    targets: ExportTargets,
    _pipelineName: string,
  ): string {
    const listenAddress = (params.listenAddress as string) || "0.0.0.0:12201";
    const relabelHost = params.relabelHost !== false;
    const relabelLevel = params.relabelLevel !== false;
    const relabelFacility = params.relabelFacility !== false;

    const gelfLabel = componentLabel(pipelineId, "gelf");
    const relabelLabel = componentLabel(pipelineId, "relabel");
    const writeLabel = componentLabel(pipelineId, "write");

    const needsRelabel = relabelHost || relabelLevel || relabelFacility;

    const builder = new AlloyConfigBuilder();

    const forwardTo = needsRelabel
      ? `loki.relabel.${relabelLabel}.receiver`
      : `loki.write.${writeLabel}.receiver`;

    builder.addBlock(`loki.source.gelf "${gelfLabel}" {
  listen_address = "${escapeString(listenAddress)}"
  forward_to     = [${forwardTo}]
}`);

    if (needsRelabel) {
      const rules: string[] = [];
      if (relabelHost) {
        rules.push(`  rule {
    source_labels = ["__gelf_message_host"]
    target_label  = "host"
  }`);
      }
      if (relabelLevel) {
        rules.push(`  rule {
    source_labels = ["__gelf_message_level"]
    target_label  = "level"
  }`);
      }
      if (relabelFacility) {
        rules.push(`  rule {
    source_labels = ["__gelf_message_facility"]
    target_label  = "facility"
  }`);
      }

      builder.addBlock(`loki.relabel "${relabelLabel}" {
  forward_to = [loki.write.${writeLabel}.receiver]

${rules.join("\n\n")}
}`);
    }

    builder.addBlock(`loki.write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.lokiWriteUrl)}"
  }
}`);

    return builder.build(pipelineId, "gelf-logs", "gelf-logs");
  },

  sampleQueries() {
    return {
      allGelfLogs: `{source="gelf"}`,
      byHost: `{host=~".+"}`,
      errors: `{level=~"3|4"}`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `loki.source.gelf.${componentLabel(pipelineId, "gelf")}`,
      `loki.relabel.${componentLabel(pipelineId, "relabel")}`,
      `loki.write.${componentLabel(pipelineId, "write")}`,
    ];
  },

  boundPorts(params: ResolvedParams) {
    const addr = (params.listenAddress as string) || "0.0.0.0:12201";
    const port = parseInt(addr.split(":").pop() || "12201", 10);
    return [port];
  },
};

export default recipe;
