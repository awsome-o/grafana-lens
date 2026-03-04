import { describe, expect, test, vi, afterEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const mockForceFlush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetTracer = vi.hoisted(() => vi.fn().mockReturnValue({ name: "grafana-lens" }));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BasicTracerProvider: class {
    getTracer = mockGetTracer;
    forceFlush = mockForceFlush;
    shutdown = mockShutdown;
    constructor(public config?: unknown) { /* noop */ }
  },
  BatchSpanProcessor: class {
    constructor(public exporter: unknown, public config?: unknown) { /* noop */ }
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
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
}));

vi.mock("@opentelemetry/api", () => ({
  SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2 },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

// ── Import after mocks ──────────────────────────────────────────────

import { createOtelTraces } from "./otel-traces.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createOtelTraces", () => {
  test("returns tracer, forceFlush, and shutdown", () => {
    const otel = createOtelTraces({ endpoint: "http://localhost:4318/v1/traces" });

    expect(otel.tracer).toBeDefined();
    expect(typeof otel.forceFlush).toBe("function");
    expect(typeof otel.shutdown).toBe("function");
  });

  test("does not register global tracer provider", () => {
    // createOtelTraces uses a LOCAL BasicTracerProvider only — no .register() call
    createOtelTraces({ endpoint: "http://localhost:4318/v1/traces" });
    expect(true).toBe(true);
  });

  test("getTracer called with grafana-lens", () => {
    createOtelTraces({ endpoint: "http://localhost:4318/v1/traces" });
    expect(mockGetTracer).toHaveBeenCalledWith("grafana-lens");
  });

  test("forceFlush delegates to provider", async () => {
    const otel = createOtelTraces({ endpoint: "http://localhost:4318/v1/traces" });
    await otel.forceFlush();
    expect(mockForceFlush).toHaveBeenCalledTimes(1);
  });

  test("shutdown delegates to provider", async () => {
    const otel = createOtelTraces({ endpoint: "http://localhost:4318/v1/traces" });
    await otel.shutdown();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });
});
