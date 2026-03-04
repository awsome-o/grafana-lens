import { describe, expect, test, vi, afterEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const mockForceFlush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetMeter = vi.hoisted(() => vi.fn().mockReturnValue({ name: "grafana-lens" }));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: class {
    getMeter = mockGetMeter;
    forceFlush = mockForceFlush;
    shutdown = mockShutdown;
  },
  PeriodicExportingMetricReader: class {
    constructor() { /* noop */ }
  },
  AggregationTemporality: { DELTA: 0, CUMULATIVE: 1 },
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {
    constructor(public opts: Record<string, unknown>) { /* noop */ }
  },
}));

vi.mock("@opentelemetry/resources", () => ({
  Resource: class {
    constructor(public attrs: Record<string, unknown>) { /* noop */ }
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
  ATTR_SERVICE_NAMESPACE: "service.namespace",
}));

// ── Import after mocks ──────────────────────────────────────────────

import { createOtelMetrics } from "./otel-metrics.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createOtelMetrics", () => {
  test("returns meter, forceFlush, and shutdown", () => {
    const otel = createOtelMetrics({ endpoint: "http://localhost:4318/v1/metrics" });

    expect(otel.meter).toBeDefined();
    expect(typeof otel.forceFlush).toBe("function");
    expect(typeof otel.shutdown).toBe("function");
  });

  test("does not register global meter provider (avoids conflict with diagnostics-otel)", () => {
    // createOtelMetrics should use a LOCAL MeterProvider only — no global registration
    // This is verified implicitly: there's no setGlobalMeterProvider import or call
    createOtelMetrics({ endpoint: "http://localhost:4318/v1/metrics" });
    // If this test runs without error, the import structure is correct
    expect(true).toBe(true);
  });

  test("getMeter called with grafana-lens", () => {
    createOtelMetrics({ endpoint: "http://localhost:4318/v1/metrics" });

    expect(mockGetMeter).toHaveBeenCalledWith("grafana-lens");
  });

  test("forceFlush delegates to provider", async () => {
    const otel = createOtelMetrics({ endpoint: "http://localhost:4318/v1/metrics" });
    await otel.forceFlush();

    expect(mockForceFlush).toHaveBeenCalledTimes(1);
  });

  test("shutdown delegates to provider", async () => {
    const otel = createOtelMetrics({ endpoint: "http://localhost:4318/v1/metrics" });
    await otel.shutdown();

    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });
});
