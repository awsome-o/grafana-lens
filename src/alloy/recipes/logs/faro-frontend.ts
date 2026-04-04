import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString, renderValue } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "faro-frontend",
  category: "logs",
  signal: "logs",
  summary:
    "Receive frontend telemetry from the Grafana Faro Web SDK — browser errors, performance metrics, web vitals, and user sessions",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "listenPort", type: "number", description: "HTTP listen port for Faro receiver", default: 12347 },
    { name: "listenAddress", type: "string", description: "Listen address", default: "0.0.0.0" },
    {
      name: "corsAllowedOrigins",
      type: "object",
      description: 'CORS allowed origins (string array). Default: ["*"] (all origins)',
      default: ["*"],
    },
  ],

  generateConfig(
    pipelineId: string,
    params: ResolvedParams,
    targets: ExportTargets,
    _pipelineName: string,
  ): string {
    const listenPort = (params.listenPort as number) ?? 12347;
    const listenAddress = (params.listenAddress as string) || "0.0.0.0";
    const corsOrigins = (params.corsAllowedOrigins as string[]) ?? ["*"];

    const recvLabel = componentLabel(pipelineId, "faro");
    const writeLabel = componentLabel(pipelineId, "write");

    return new AlloyConfigBuilder()
      .addBlock(`faro.receiver "${recvLabel}" {
  server {
    listen_address       = "${escapeString(listenAddress)}"
    listen_port          = ${listenPort}
    cors_allowed_origins = ${renderValue(corsOrigins)}
  }
  output {
    logs = [loki.write.${writeLabel}.receiver]
  }
}`)
      .addBlock(`loki.write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.lokiWriteUrl)}"
  }
}`)
      .build(pipelineId, "faro-frontend", "faro-frontend");
  },

  sampleQueries() {
    return {
      allFaroLogs: `{service_name="faro-web-sdk"}`,
      browserErrors: `{service_name="faro-web-sdk"} |= "error"`,
      webVitals: `{service_name="faro-web-sdk"} | json | kind="measurement"`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `faro.receiver.${componentLabel(pipelineId, "faro")}`,
      `loki.write.${componentLabel(pipelineId, "write")}`,
    ];
  },

  boundPorts(params: ResolvedParams) {
    return [(params.listenPort as number) ?? 12347];
  },
};

export default recipe;
