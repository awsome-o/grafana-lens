/**
 * Recipe: span-metrics
 *
 * Generates RED (Request rate, Error rate, Duration) metrics from traces
 * using the OTel spanmetrics connector. Produces both metrics (to Prometheus)
 * and forwards traces (to Tempo) via dual-output fan-out.
 *
 * Generated Alloy pipeline:
 *   otelcol.receiver.otlp → otelcol.processor.batch → {
 *     otelcol.connector.spanmetrics → otelcol.exporter.otlphttp (metrics)
 *     otelcol.exporter.otlp (traces)
 *   }
 */

import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { deriveOtlpMetricsUrl } from "./_shared.js";

const recipe: PipelineRecipe = {
  name: "span-metrics",
  category: "traces",
  signal: "traces",
  summary: "Generate RED metrics (Request, Error, Duration) from traces via spanmetrics connector",
  dashboardTemplate: "metric-explorer",
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "dimensions", type: "string[]", description: "Span attributes to include as metric dimensions", default: ["http.method", "http.status_code"] },
    { name: "metricsFlushInterval", type: "string", description: "How often to flush generated metrics", default: "5s" },
    { name: "grpcPort", type: "number", description: "OTLP gRPC listen port", default: 4317 },
    { name: "httpPort", type: "number", description: "OTLP HTTP listen port", default: 4318 },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const dimensions = (params.dimensions as string[]) ?? ["http.method", "http.status_code"];
    const flushInterval = (params.metricsFlushInterval as string) || "5s";
    const grpcPort = (params.grpcPort as number) ?? 4317;
    const httpPort = (params.httpPort as number) ?? 4318;

    const recvLabel = componentLabel(pipelineId, "otlp");
    const batchLabel = componentLabel(pipelineId, "batch");
    const connLabel = componentLabel(pipelineId, "spanmetrics");
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
      otelcol.connector.spanmetrics.${connLabel}.input,
      otelcol.exporter.otlp.${tracesExpLabel}.input,
    ]
  }
}`);

    const dimensionBlocks = dimensions
      .map((d) => `  dimension {\n    name = "${escapeString(d)}"\n  }`)
      .join("\n\n");

    builder.addBlock(`otelcol.connector.spanmetrics "${connLabel}" {
  histogram {
    explicit {}
  }

${dimensionBlocks}

  metrics_flush_interval = "${escapeString(flushInterval)}"

  output {
    metrics = [otelcol.exporter.otlphttp.${metricsExpLabel}.input]
  }
}`);

    // Derive OTLP metrics URL from the configured remote_write URL
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

    return builder.build(pipelineId, "span-metrics", "span-metrics");
  },

  sampleQueries(_params: ResolvedParams, _jobName: string) {
    return {
      requestRate: 'sum(rate(traces_spanmetrics_calls_total[5m]))',
      errorRate: 'sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))',
      p95Duration: 'histogram_quantile(0.95, sum(rate(traces_spanmetrics_duration_milliseconds_bucket[5m])) by (le))',
      traces: '{ resource.service.name =~ ".+" }',
    };
  },

  componentIds(pipelineId: string) {
    return [
      `otelcol.receiver.otlp.${componentLabel(pipelineId, "otlp")}`,
      `otelcol.processor.batch.${componentLabel(pipelineId, "batch")}`,
      `otelcol.connector.spanmetrics.${componentLabel(pipelineId, "spanmetrics")}`,
      `otelcol.exporter.otlphttp.${componentLabel(pipelineId, "metrics_export")}`,
      `otelcol.exporter.otlp.${componentLabel(pipelineId, "traces_export")}`,
    ];
  },

  boundPorts(params: ResolvedParams) {
    return [Number(params.grpcPort), Number(params.httpPort)];
  },
};

export default recipe;
