import { describe, expect, test, vi, beforeEach } from "vitest";
import { OtlpJsonWriter, msToNanoString, labelsToAttributes, type TimestampedSample } from "./otlp-json-writer.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSample(overrides?: Partial<TimestampedSample>): TimestampedSample {
  return {
    metricName: "openclaw_ext_fitness_steps",
    description: "Daily step count",
    labels: {},
    value: 8000,
    timestampMs: 1705276800000, // 2024-01-15T00:00:00Z
    ...overrides,
  };
}

// ── Unit tests ───────────────────────────────────────────────────────

describe("msToNanoString", () => {
  test("converts milliseconds to nanosecond string", () => {
    expect(msToNanoString(1705276800000)).toBe("1705276800000000000");
  });

  test("handles zero", () => {
    expect(msToNanoString(0)).toBe("0000000");
  });

  test("handles small values", () => {
    expect(msToNanoString(1)).toBe("1000000");
  });
});

describe("labelsToAttributes", () => {
  test("converts labels to OTLP attribute format", () => {
    const result = labelsToAttributes({ region: "us", env: "prod" });
    expect(result).toEqual([
      { key: "region", value: { stringValue: "us" } },
      { key: "env", value: { stringValue: "prod" } },
    ]);
  });

  test("handles empty labels", () => {
    expect(labelsToAttributes({})).toEqual([]);
  });
});

describe("OtlpJsonWriter.buildPayload", () => {
  const writer = new OtlpJsonWriter({ endpoint: "http://localhost:4318/v1/metrics" });

  test("builds correct OTLP JSON structure", () => {
    const payload = writer.buildPayload([makeSample()]);

    expect(payload.resourceMetrics).toHaveLength(1);
    const rm = payload.resourceMetrics[0];

    // Resource attributes
    expect(rm.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "openclaw" } },
      { key: "service.namespace", value: { stringValue: "grafana-lens" } },
    ]);

    // Scope
    expect(rm.scopeMetrics).toHaveLength(1);
    expect(rm.scopeMetrics[0].scope.name).toBe("grafana-lens-custom");

    // Metric
    const metric = rm.scopeMetrics[0].metrics[0];
    expect(metric.name).toBe("openclaw_ext_fitness_steps");
    expect(metric.description).toBe("Daily step count");
    expect(metric.gauge.dataPoints).toHaveLength(1);

    // Data point
    const dp = metric.gauge.dataPoints[0];
    expect(dp.timeUnixNano).toBe("1705276800000000000");
    expect(dp.asDouble).toBe(8000);
    expect(dp.attributes).toEqual([]);
  });

  test("groups samples by metric name", () => {
    const payload = writer.buildPayload([
      makeSample({ metricName: "openclaw_ext_steps", value: 8000, timestampMs: 1705276800000 }),
      makeSample({ metricName: "openclaw_ext_steps", value: 10500, timestampMs: 1705363200000 }),
      makeSample({ metricName: "openclaw_ext_weight", value: 72.5, timestampMs: 1705276800000 }),
    ]);

    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(2);

    const steps = metrics.find((m) => m.name === "openclaw_ext_steps");
    expect(steps?.gauge.dataPoints).toHaveLength(2);

    const weight = metrics.find((m) => m.name === "openclaw_ext_weight");
    expect(weight?.gauge.dataPoints).toHaveLength(1);
  });

  test("encodes labels as OTLP attributes on data points", () => {
    const payload = writer.buildPayload([
      makeSample({ labels: { type: "walking", source: "fitbit" } }),
    ]);

    const attrs = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].attributes;
    expect(attrs).toEqual([
      { key: "type", value: { stringValue: "walking" } },
      { key: "source", value: { stringValue: "fitbit" } },
    ]);
  });

  test("uses default description when not provided", () => {
    const payload = writer.buildPayload([
      makeSample({ description: undefined }),
    ]);

    const metric = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.description).toBe("Custom metric");
  });

  test("returns empty resourceMetrics for empty input", () => {
    // write() short-circuits on empty, but buildPayload handles it gracefully
    const payload = writer.buildPayload([]);
    expect(payload.resourceMetrics[0].scopeMetrics[0].metrics).toHaveLength(0);
  });
});

describe("OtlpJsonWriter.write", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  test("POSTs JSON with correct content type and headers", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const writer = new OtlpJsonWriter({
      endpoint: "http://localhost:4318/v1/metrics",
      headers: { Authorization: "Bearer token123" },
    });

    await writer.write([makeSample()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4318/v1/metrics");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual(expect.objectContaining({
      "Content-Type": "application/json",
      Authorization: "Bearer token123",
    }));

    // Verify body is valid JSON with correct structure
    const body = JSON.parse(opts.body as string);
    expect(body.resourceMetrics).toBeDefined();
  });

  test("skips fetch for empty samples", async () => {
    const writer = new OtlpJsonWriter({ endpoint: "http://localhost:4318/v1/metrics" });
    await writer.write([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws on HTTP 400", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("invalid payload"),
    });

    const writer = new OtlpJsonWriter({ endpoint: "http://localhost:4318/v1/metrics" });

    await expect(writer.write([makeSample()])).rejects.toThrow(
      "OTLP push failed (HTTP 400): invalid payload",
    );
  });

  test("throws on HTTP 429", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: () => Promise.resolve("rate limited"),
    });

    const writer = new OtlpJsonWriter({ endpoint: "http://localhost:4318/v1/metrics" });

    await expect(writer.write([makeSample()])).rejects.toThrow(
      "OTLP push failed (HTTP 429): rate limited",
    );
  });

  test("handles network failure gracefully", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const writer = new OtlpJsonWriter({ endpoint: "http://localhost:4318/v1/metrics" });

    await expect(writer.write([makeSample()])).rejects.toThrow("ECONNREFUSED");
  });

  test("handles body read failure on error response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.reject(new Error("stream error")),
    });

    const writer = new OtlpJsonWriter({ endpoint: "http://localhost:4318/v1/metrics" });

    await expect(writer.write([makeSample()])).rejects.toThrow(
      "OTLP push failed (HTTP 500)",
    );
  });
});
