/**
 * OTLP Metrics Provider
 *
 * Central MeterProvider lifecycle module. Creates an OpenTelemetry
 * MeterProvider that pushes metrics via OTLP HTTP/JSON to the
 * configured collector (LGTM stack, Grafana Cloud, Mimir, etc.).
 *
 * Replaces the previous prom-client pull model (/metrics endpoint).
 * Data flow:
 *   OpenClaw diagnostic events → OTel instruments → OTLP exporter → Collector → Mimir → Grafana
 */

import type { Meter } from "@opentelemetry/api";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { createOtelResource } from "./otel-resource.js";

export type OtelMetricsConfig = {
  endpoint: string;
  headers?: Record<string, string>;
  exportIntervalMs?: number;
  serviceVersion?: string;
  serviceInstanceId?: string;
};

export type OtelMetrics = {
  meter: Meter;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

const DEFAULT_ENDPOINT = "http://localhost:4318/v1/metrics";
const DEFAULT_EXPORT_INTERVAL_MS = 15_000;

export function createOtelMetrics(config: OtelMetricsConfig): OtelMetrics {
  const exporter = new OTLPMetricExporter({
    url: config.endpoint || DEFAULT_ENDPOINT,
    headers: config.headers,
    temporalityPreference: AggregationTemporality.CUMULATIVE,
  });

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS,
  });

  const resource = createOtelResource(config);

  const provider = new MeterProvider({
    resource,
    readers: [reader],
  });

  const meter = provider.getMeter("grafana-lens");

  return {
    meter,
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}
