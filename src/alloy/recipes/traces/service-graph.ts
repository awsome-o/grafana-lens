/**
 * Recipe: service-graph
 *
 * Generates service dependency graph metrics from traces using the OTel
 * servicegraph connector. Dual-output: metrics to Prometheus, traces to Tempo.
 *
 * Generated Alloy pipeline:
 *   otelcol.receiver.otlp → otelcol.processor.batch → {
 *     otelcol.connector.servicegraph → otelcol.exporter.otlphttp (metrics)
 *     otelcol.exporter.otlp (traces)
 *   }
 */

import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString, renderValue } from "../../config-builder.js";
import { deriveOtlpMetricsUrl } from "./_shared.js";

const recipe: PipelineRecipe = {
  name: "service-graph",
  category: "traces",
  signal: "traces",
  summary: "Generate service dependency graph metrics from traces via servicegraph connector",
  dashboardTemplate: "metric-explorer",
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "dimensions", type: "string[]", description: "Span attributes to include as metric dimensions", default: ["service.name", "http.method"] },
    { name: "storeMaxItems", type: "number", description: "Max items in the span pairing store", default: 5000 },
    { name: "storeTtl", type: "string", description: "TTL for span pairing entries", default: "30s" },
    { name: "metricsFlushInterval", type: "string", description: "How often to flush generated metrics", default: "10s" },
    { name: "grpcPort", type: "number", description: "OTLP gRPC listen port", default: 4317 },
    { name: "httpPort", type: "number", description: "OTLP HTTP listen port", default: 4318 },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const dimensions = (params.dimensions as string[]) ?? ["service.name", "http.method"];
    const storeMaxItems = (params.storeMaxItems as number) ?? 5000;
    const storeTtl = (params.storeTtl as string) || "30s";
    const flushInterval = (params.metricsFlushInterval as string) || "10s";
    const grpcPort = (params.grpcPort as number) ?? 4317;
    const httpPort = (params.httpPort as number) ?? 4318;

    const recvLabel = componentLabel(pipelineId, "otlp");
    const batchLabel = componentLabel(pipelineId, "batch");
    const connLabel = componentLabel(pipelineId, "servicegraph");
    const metricsExpLabel = componentLabel(pipelineId, "metrics_export");
    const tracesExpLabel = componentLabel(pipelineId, "traces_export");

    const builder = new AlloyConfigBuilder();

    builder.addBlock(`otelcol.receiver.otlp "${recvLabel}" {
  grpc {
    endpoint = "0.0.0.0:${grpcPort}"
  }
  http {
    endpoint = "0.0.0.0:${httpPort}"
  }
  output {
    traces = [otelcol.processor.batch.${batchLabel}.input]
  }
}`);

    builder.addBlock(`otelcol.processor.batch "${batchLabel}" {
  output {
    traces = [
      otelcol.connector.servicegraph.${connLabel}.input,
      otelcol.exporter.otlp.${tracesExpLabel}.input,
    ]
  }
}`);

    const dimensionList = renderValue(dimensions);

    builder.addBlock(`otelcol.connector.servicegraph "${connLabel}" {
  metrics_flush_interval = "${escapeString(flushInterval)}"
  dimensions             = [${dimensionList}]

  store {
    max_items = ${storeMaxItems}
    ttl       = "${escapeString(storeTtl)}"
  }

  output {
    metrics = [otelcol.exporter.otlphttp.${metricsExpLabel}.input]
  }
}`);

    // Derive OTLP metrics URL from remote_write URL
    const metricsOtlpUrl = deriveOtlpMetricsUrl(targets.prometheusRemoteWriteUrl);
    builder.addBlock(`otelcol.exporter.otlphttp "${metricsExpLabel}" {
  client {
    endpoint = "${escapeString(metricsOtlpUrl)}"
    tls {
      insecure = true
    }
  }
}`);

    builder.addBlock(`otelcol.exporter.otlp "${tracesExpLabel}" {
  client {
    endpoint = "${escapeString(targets.otlpEndpoint)}"
    tls {
      insecure = true
    }
  }
}`);

    return builder.build(pipelineId, "service-graph", "service-graph");
  },

  sampleQueries(_params: ResolvedParams, _jobName: string) {
    return {
      requestTotal: 'traces_service_graph_request_total',
      requestDuration: 'histogram_quantile(0.95, sum(rate(traces_service_graph_request_server_seconds_bucket[5m])) by (le))',
      traces: '{ resource.service.name =~ ".+" }',
    };
  },

  componentIds(pipelineId: string) {
    return [
      `otelcol.receiver.otlp.${componentLabel(pipelineId, "otlp")}`,
      `otelcol.processor.batch.${componentLabel(pipelineId, "batch")}`,
      `otelcol.connector.servicegraph.${componentLabel(pipelineId, "servicegraph")}`,
      `otelcol.exporter.otlphttp.${componentLabel(pipelineId, "metrics_export")}`,
      `otelcol.exporter.otlp.${componentLabel(pipelineId, "traces_export")}`,
    ];
  },

  boundPorts(params: ResolvedParams) {
    return [Number(params.grpcPort), Number(params.httpPort)];
  },
};

export default recipe;
