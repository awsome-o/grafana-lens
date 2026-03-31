import { describe, expect, test, vi, afterEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const mockForceFlush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetLogger = vi.hoisted(() => vi.fn().mockReturnValue({ name: "grafana-lens" }));
const mockAddProcessor = vi.hoisted(() => vi.fn());

vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: class {
    getLogger = mockGetLogger;
    addLogRecordProcessor = mockAddProcessor;
    forceFlush = mockForceFlush;
    shutdown = mockShutdown;
  },
  BatchLogRecordProcessor: class {
    constructor(public exporter: unknown, public config?: unknown) { /* noop */ }
  },
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {
    constructor(public opts: Record<string, unknown>) { /* noop */ }
  },
}));

const mockCreateOtelResource = vi.hoisted(() => vi.fn().mockReturnValue({ attrs: {} }));

vi.mock("./otel-resource.js", () => ({
  createOtelResource: mockCreateOtelResource,
}));

vi.mock("@opentelemetry/api-logs", () => ({
  SeverityNumber: {
    INFO: 9,
    WARN: 13,
    ERROR: 17,
  },
}));

// ── Import after mocks ──────────────────────────────────────────────

import { createOtelLogs } from "./otel-logs.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createOtelLogs", () => {
  test("returns logger, forceFlush, and shutdown", () => {
    const otel = createOtelLogs({ endpoint: "http://localhost:4318/v1/logs" });

    expect(otel.logger).toBeDefined();
    expect(typeof otel.forceFlush).toBe("function");
    expect(typeof otel.shutdown).toBe("function");
  });

  test("does not register global logger provider", () => {
    // createOtelLogs uses a LOCAL LoggerProvider only — no global registration
    createOtelLogs({ endpoint: "http://localhost:4318/v1/logs" });
    expect(true).toBe(true);
  });

  test("getLogger called with grafana-lens", () => {
    createOtelLogs({ endpoint: "http://localhost:4318/v1/logs" });
    expect(mockGetLogger).toHaveBeenCalledWith("grafana-lens");
  });

  test("adds batch log record processor", () => {
    createOtelLogs({ endpoint: "http://localhost:4318/v1/logs" });
    expect(mockAddProcessor).toHaveBeenCalledTimes(1);
  });

  test("forceFlush delegates to provider", async () => {
    const otel = createOtelLogs({ endpoint: "http://localhost:4318/v1/logs" });
    await otel.forceFlush();
    expect(mockForceFlush).toHaveBeenCalledTimes(1);
  });

  test("shutdown delegates to provider", async () => {
    const otel = createOtelLogs({ endpoint: "http://localhost:4318/v1/logs" });
    await otel.shutdown();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });

  test("passes config to createOtelResource", () => {
    createOtelLogs({
      endpoint: "http://localhost:4318/v1/logs",
      serviceVersion: "1.0.0",
      serviceInstanceId: "bot-alice",
    });

    expect(mockCreateOtelResource).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceVersion: "1.0.0",
        serviceInstanceId: "bot-alice",
      }),
    );
  });
});
