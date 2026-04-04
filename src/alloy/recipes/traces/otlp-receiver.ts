import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "otlp-receiver",
  category: "traces",
  signal: "traces",
  summary: "Receive OTLP traces, metrics, and logs via gRPC/HTTP and forward to the LGTM stack",
  dashboardTemplate: null,
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "grpcPort", type: "number", description: "gRPC listen port", default: 4317 },
    { name: "httpPort", type: "number", description: "HTTP listen port", default: 4318 },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const grpcPort = (params.grpcPort as number) || 4317;
    const httpPort = (params.httpPort as number) || 4318;
    const recvLabel = componentLabel(pipelineId, "otlp");
    const batchLabel = componentLabel(pipelineId, "batch");
    const expLabel = componentLabel(pipelineId, "export");

    return new AlloyConfigBuilder()
      .addBlock(`otelcol.receiver.otlp "${recvLabel}" {
  grpc {
    endpoint = "0.0.0.0:${grpcPort}"
  }
  http {
    endpoint = "0.0.0.0:${httpPort}"
  }
  output {
    metrics = [otelcol.processor.batch.${batchLabel}.input]
    logs    = [otelcol.processor.batch.${batchLabel}.input]
    traces  = [otelcol.processor.batch.${batchLabel}.input]
  }
}`)
      .addBlock(`otelcol.processor.batch "${batchLabel}" {
  output {
    metrics = [otelcol.exporter.otlphttp.${expLabel}.input]
    logs    = [otelcol.exporter.otlphttp.${expLabel}.input]
    traces  = [otelcol.exporter.otlphttp.${expLabel}.input]
  }
}`)
      .addBlock(`otelcol.exporter.otlphttp "${expLabel}" {
  client {
    endpoint = "${escapeString(targets.otlpEndpoint)}"
  }
}`)
      .build(pipelineId, "otlp-receiver", "otlp-receiver");
  },

  sampleQueries() {
    return {
      traces: '{ resource.service.name =~ ".+" }',
      spanCount: 'sum(rate(traces_spanmetrics_calls_total[5m]))',
    };
  },

  componentIds(pipelineId: string) {
    return [
      `otelcol.receiver.otlp.${componentLabel(pipelineId, "otlp")}`,
      `otelcol.processor.batch.${componentLabel(pipelineId, "batch")}`,
      `otelcol.exporter.otlphttp.${componentLabel(pipelineId, "export")}`,
    ];
  },

  boundPorts(params: ResolvedParams) {
    return [Number(params.grpcPort), Number(params.httpPort)];
  },
};

export default recipe;
