import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const queryLokiMock = vi.hoisted(() => vi.fn());
const queryLokiRangeMock = vi.hoisted(() => vi.fn());
const getDashboardMock = vi.hoisted(() => vi.fn());
const listDatasourcesMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    queryLoki = queryLokiMock;
    queryLokiRange = queryLokiRangeMock;
    getDashboard = getDashboardMock;
    listDatasources = listDatasourcesMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createQueryLogsToolFactory, MAX_MATRIX_SERIES, MAX_VECTOR_RESULTS } from "./query-logs.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { GrafanaClientRegistry } from "../grafana-client-registry.js";

function makeConfig(): ValidatedGrafanaLensConfig {
  return {
    grafana: {
      instances: { default: { url: "http://localhost:3000", apiKey: "test-key" } },
      defaultInstance: "default",
    },
  } as ValidatedGrafanaLensConfig;
}

function makeRegistry(): GrafanaClientRegistry {
  return new GrafanaClientRegistry(makeConfig());
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first.type === "text" && first.text) return first.text;
  throw new Error("Expected text content");
}

describe("grafana_query_logs tool", () => {
  beforeEach(() => {
    queryLokiMock.mockReset();
    queryLokiRangeMock.mockReset();
    getDashboardMock.mockReset();
    listDatasourcesMock.mockReset();
  });

  test("stream query returns formatted log entries", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { job: "api", level: "error" },
            values: [
              ["1700000000000000000", "connection refused to database"],
              ["1700000001000000000", "retrying connection attempt 2"],
            ],
          },
          {
            stream: { job: "api", level: "warn" },
            values: [["1700000002000000000", "slow query detected"]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "loki1",
      expr: '{job="api"} |= "error"',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.resultType).toBe("streams");
    expect(parsed.datasourceUid).toBe("loki1");
    expect(parsed.totalStreams).toBe(2);
    expect(parsed.totalEntries).toBe(3);
    expect(parsed.entries).toHaveLength(3);
    // Should be sorted newest first
    expect(parsed.entries[0].labels.level).toBe("warn");
    expect(parsed.entries[0].line).toBe("slow query detected");
    expect(parsed.entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("stream query truncates to 100 entries", async () => {
    const values = Array.from({ length: 200 }, (_, i) => [
      String(1700000000000000000n + BigInt(i) * 1000000000n),
      `log line ${i}`,
    ]);
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [{ stream: { job: "api" }, values }],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-2", {
      datasourceUid: "loki1",
      expr: '{job="api"}',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.entries).toHaveLength(100);
    expect(parsed.truncated).toBe(true);
    expect(parsed.totalEntries).toBe(200);
  });

  test("long log lines are truncated", async () => {
    const longLine = "x".repeat(1000);
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { job: "api" },
            values: [["1700000000000000000", longLine]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-3", {
      datasourceUid: "loki1",
      expr: '{job="api"}',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.entries[0].line.length).toBeLessThan(1000);
    expect(parsed.entries[0].line).toContain("... (truncated)");
  });

  test("default 'now-1h'/'now' values are passed to queryLokiRange", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "streams", result: [] },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-time", {
      datasourceUid: "loki1",
      expr: '{job="api"}',
      // No start/end — should use defaults "now-1h" / "now"
    });

    expect(queryLokiRangeMock).toHaveBeenCalledTimes(1);
    const [, , start, end] = queryLokiRangeMock.mock.calls[0];
    // The tool passes "now-1h"/"now" to the client, which converts them internally
    expect(start).toBe("now-1h");
    expect(end).toBe("now");
  });

  test("lineLimit increases per-line truncation threshold", async () => {
    const longLine = "x".repeat(1500);
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { job: "api" },
            values: [["1700000000000000000", longLine]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-lineLimit", {
      datasourceUid: "loki1",
      expr: '{job="api"}',
      lineLimit: 2000,
    });

    const parsed = JSON.parse(getTextContent(result));
    // 1500 chars < 2000 limit — should NOT be truncated
    expect(parsed.entries[0].line).toBe(longLine);
    expect(parsed.entries[0].line).not.toContain("... (truncated)");
  });

  test("lineLimit defaults to 500 when not specified", async () => {
    const longLine = "y".repeat(800);
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { job: "api" },
            values: [["1700000000000000000", longLine]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-default-lineLimit", {
      datasourceUid: "loki1",
      expr: '{job="api"}',
    });

    const parsed = JSON.parse(getTextContent(result));
    // 800 chars > 500 default — should be truncated
    expect(parsed.entries[0].line).toContain("... (truncated)");
    expect(parsed.entries[0].line.length).toBeLessThan(800);
  });

  test("lineLimit is clamped to max 2000", async () => {
    const longLine = "z".repeat(2500);
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { job: "api" },
            values: [["1700000000000000000", longLine]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-clamped-lineLimit", {
      datasourceUid: "loki1",
      expr: '{job="api"}',
      lineLimit: 5000, // exceeds max — should be clamped to 2000
    });

    const parsed = JSON.parse(getTextContent(result));
    // Clamped to 2000 — 2500 char line should be truncated at 2000
    expect(parsed.entries[0].line).toContain("... (truncated)");
    // 2000 chars + "... (truncated)" = 2015 chars
    expect(parsed.entries[0].line.length).toBe(2000 + "... (truncated)".length);
  });

  // ══════════════════════════════════════════════════════════════════
  // extractFields — structured field extraction
  // ══════════════════════════════════════════════════════════════════

  test("extractFields promotes OTel attributes from labels to fields", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: {
              component: "lifecycle",
              event_name: "tool.call",
              severity_text: "INFO",
              trace_id: "abc123",
              span_id: "def456",
              openclaw_session_id: "session-1",
              openclaw_model: "claude-opus",
              openclaw_duration_s: "7.5",
              // Infrastructure noise — should be stripped
              telemetry_sdk_language: "nodejs",
              telemetry_sdk_name: "opentelemetry",
              telemetry_sdk_version: "1.30.1",
              service_name: "openclaw",
              service_namespace: "grafana-lens",
              service_version: "0.1.0",
              scope_name: "grafana-lens",
              flags: "1",
              observed_timestamp: "1700000000000000000",
              event_domain: "openclaw",
              severity_number: "9",
              detected_level: "INFO",
            },
            values: [["1700000000000000000", "Tool grafana_query 53ms | datasourceUid,expr"]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-extract", {
      datasourceUid: "loki1",
      expr: '{service_name="openclaw"}',
      extractFields: true,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    const entry = parsed.entries[0];

    // fields should have clean keys
    expect(entry.fields).toBeDefined();
    expect(entry.fields.component).toBe("lifecycle");
    expect(entry.fields.event_name).toBe("tool.call");
    expect(entry.fields.trace_id).toBe("abc123");
    expect(entry.fields.session_id).toBe("session-1"); // openclaw_ prefix stripped
    expect(entry.fields.model).toBe("claude-opus");     // openclaw_ prefix stripped
    expect(entry.fields.duration_s).toBe(7.5);          // numeric conversion

    // labels should only have non-noise, non-openclaw keys
    expect(entry.labels.telemetry_sdk_language).toBeUndefined();
    expect(entry.labels.service_name).toBeUndefined();
    expect(entry.labels.flags).toBeUndefined();
    expect(entry.labels.observed_timestamp).toBeUndefined();
    expect(entry.labels.component).toBe("lifecycle"); // kept in labels
    expect(entry.labels.severity_text).toBe("INFO");  // kept in labels

    // line should be unchanged
    expect(entry.line).toBe("Tool grafana_query 53ms | datasourceUid,expr");
  });

  test("extractFields parses JSON log line bodies", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { component: "app" },
            values: [
              ["1700000000000000000", '{"level":"error","message":"connection failed","host":"db-1","retries":3}'],
            ],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-json-body", {
      datasourceUid: "loki1",
      expr: '{component="app"}',
      extractFields: true,
    });

    const parsed = JSON.parse(getTextContent(result));
    const entry = parsed.entries[0];
    expect(entry.fields.level).toBe("error");
    expect(entry.fields.message).toBe("connection failed");
    expect(entry.fields.host).toBe("db-1");
    expect(entry.fields.retries).toBe(3);
  });

  test("extractFields handles non-JSON bodies gracefully", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { component: "lifecycle", event_name: "session.start" },
            values: [["1700000000000000000", "Session started abc-123"]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-non-json", {
      datasourceUid: "loki1",
      expr: '{component="lifecycle"}',
      extractFields: true,
    });

    const parsed = JSON.parse(getTextContent(result));
    const entry = parsed.entries[0];
    // fields still populated from labels
    expect(entry.fields.component).toBe("lifecycle");
    expect(entry.fields.event_name).toBe("session.start");
    // line unchanged
    expect(entry.line).toBe("Session started abc-123");
  });

  test("extractFields=false (default) returns entries without fields", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: {
              component: "lifecycle",
              telemetry_sdk_language: "nodejs",
              openclaw_session_id: "s1",
            },
            values: [["1700000000000000000", "test log"]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-extract", {
      datasourceUid: "loki1",
      expr: '{component="lifecycle"}',
      // extractFields not set — default false
    });

    const parsed = JSON.parse(getTextContent(result));
    const entry = parsed.entries[0];
    // No fields property
    expect(entry.fields).toBeUndefined();
    // All original labels preserved (including noise)
    expect(entry.labels.telemetry_sdk_language).toBe("nodejs");
    expect(entry.labels.openclaw_session_id).toBe("s1");
  });

  test("extractFields handles nested JSON objects by stringifying", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { component: "app" },
            values: [
              ["1700000000000000000", '{"event":"deploy","metadata":{"version":"2.1","env":"prod"},"count":5}'],
            ],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-nested-json", {
      datasourceUid: "loki1",
      expr: '{component="app"}',
      extractFields: true,
    });

    const parsed = JSON.parse(getTextContent(result));
    const entry = parsed.entries[0];
    expect(entry.fields.event).toBe("deploy");
    expect(entry.fields.count).toBe(5);
    // Nested object stringified
    expect(entry.fields.metadata).toBe('{"version":"2.1","env":"prod"}');
  });

  test("extractFields skips null/undefined values from JSON body", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { component: "app" },
            values: [
              ["1700000000000000000", '{"message":"ok","extra":null,"missing":null}'],
            ],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-null-json", {
      datasourceUid: "loki1",
      expr: '{component="app"}',
      extractFields: true,
    });

    const parsed = JSON.parse(getTextContent(result));
    const entry = parsed.entries[0];
    expect(entry.fields.message).toBe("ok");
    expect(entry.fields.extra).toBeUndefined();
    expect(entry.fields.missing).toBeUndefined();
  });

  test("extractFields strips noise labels from JSON body too", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { component: "app" },
            values: [
              ["1700000000000000000", '{"message":"hello","service_name":"internal","telemetry_sdk_language":"nodejs"}'],
            ],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-noise-json", {
      datasourceUid: "loki1",
      expr: '{component="app"}',
      extractFields: true,
    });

    const parsed = JSON.parse(getTextContent(result));
    const entry = parsed.entries[0];
    expect(entry.fields.message).toBe("hello");
    // Noise labels from JSON body also filtered
    expect(entry.fields.service_name).toBeUndefined();
    expect(entry.fields.telemetry_sdk_language).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // traceCorrelation — log-to-trace hints
  // ══════════════════════════════════════════════════════════════════

  test("stream results with extractFields includes traceCorrelation when trace_id present", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: {
              component: "lifecycle",
              openclaw_trace_id: "trace-aaa111",
              openclaw_session_id: "s1",
            },
            values: [["1700000000000000000", "LLM call started"]],
          },
          {
            stream: {
              component: "lifecycle",
              openclaw_trace_id: "trace-bbb222",
              openclaw_session_id: "s2",
            },
            values: [["1700000001000000000", "LLM call ended"]],
          },
          {
            stream: {
              component: "lifecycle",
              openclaw_trace_id: "trace-aaa111",
              openclaw_session_id: "s1",
            },
            values: [["1700000002000000000", "Tool call started"]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-trace-corr", {
      datasourceUid: "loki1",
      expr: '{service_name="openclaw"}',
      extractFields: true,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.traceCorrelation).toBeDefined();
    expect(parsed.traceCorrelation.tool).toBe("grafana_query_traces");
    // Should contain unique trace IDs (deduplicated)
    expect(parsed.traceCorrelation.traceIds).toContain("trace-aaa111");
    expect(parsed.traceCorrelation.traceIds).toContain("trace-bbb222");
    expect(parsed.traceCorrelation.traceIds).toHaveLength(2);
    expect(parsed.traceCorrelation.tip).toContain("2 trace ID(s)");
  });

  test("stream results without extractFields omits traceCorrelation", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: {
              component: "lifecycle",
              openclaw_trace_id: "trace-aaa111",
            },
            values: [["1700000000000000000", "test log"]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-trace-corr", {
      datasourceUid: "loki1",
      expr: '{service_name="openclaw"}',
      // extractFields NOT set — default false
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.traceCorrelation).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // Top-level series/result truncation for matrix and vector
  // ══════════════════════════════════════════════════════════════════

  test("matrix query truncates series to MAX_MATRIX_SERIES when exceeded", async () => {
    const series = Array.from({ length: 70 }, (_, i) => ({
      metric: { job: "api", instance: `inst-${i}` },
      values: [[1700000000, String(i)]],
    }));
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "matrix", result: series },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-trunc-matrix", {
      datasourceUid: "loki1",
      expr: 'rate({job="api"}[5m])',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.resultType).toBe("matrix");
    expect(parsed.series).toHaveLength(MAX_MATRIX_SERIES);
    expect(parsed.resultCount).toBe(MAX_MATRIX_SERIES);
    expect(parsed.truncated).toBe(true);
    expect(parsed.totalSeries).toBe(70);
    expect(parsed.truncationHint).toContain("Narrow your LogQL query");
  });

  test("matrix query omits truncation fields when under limit", async () => {
    const series = Array.from({ length: 3 }, (_, i) => ({
      metric: { job: "api", instance: `inst-${i}` },
      values: [[1700000000, String(i)]],
    }));
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "matrix", result: series },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-trunc-matrix", {
      datasourceUid: "loki1",
      expr: 'rate({job="api"}[5m])',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.series).toHaveLength(3);
    expect(parsed.resultCount).toBe(3);
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.totalSeries).toBeUndefined();
  });

  test("vector query truncates results to MAX_VECTOR_RESULTS when exceeded", async () => {
    const results = Array.from({ length: 65 }, (_, i) => ({
      metric: { job: "api", instance: `inst-${i}` },
      value: [1700000000, String(i)],
    }));
    queryLokiMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "vector", result: results },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-trunc-vector", {
      datasourceUid: "loki1",
      expr: 'count_over_time({job="api"}[1h])',
      queryType: "instant",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.resultType).toBe("vector");
    expect(parsed.metrics).toHaveLength(MAX_VECTOR_RESULTS);
    expect(parsed.resultCount).toBe(MAX_VECTOR_RESULTS);
    expect(parsed.truncated).toBe(true);
    expect(parsed.totalResults).toBe(65);
    expect(parsed.truncationHint).toContain("Narrow your LogQL query");
  });

  test("vector query omits truncation fields when under limit", async () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      metric: { job: "api", instance: `inst-${i}` },
      value: [1700000000, String(i)],
    }));
    queryLokiMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "vector", result: results },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-trunc-vector", {
      datasourceUid: "loki1",
      expr: 'count_over_time({job="api"}[1h])',
      queryType: "instant",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metrics).toHaveLength(5);
    expect(parsed.resultCount).toBe(5);
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.totalResults).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // datasourceUid echo for chaining
  // ══════════════════════════════════════════════════════════════════

  test("log query echoes datasourceUid for chaining", async () => {
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { job: "api" },
            values: [["1700000000000000000", "test entry"]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-chain", {
      datasourceUid: "loki-abc",
      expr: '{job="api"}',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.datasourceUid).toBe("loki-abc");
  });

  test("API error caught and returned gracefully", async () => {
    queryLokiRangeMock.mockRejectedValueOnce(new Error("query loki range: 502"));

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-4", {
      datasourceUid: "loki1",
      expr: '{job="api"}',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Log query failed");
  });

  // ══════════════════════════════════════════════════════════════════
  // Panel resolution (dashboardUid + panelId)
  // ══════════════════════════════════════════════════════════════════

  test("panel resolution resolves LogQL expr from dashboard panel", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "log-dash",
        panels: [
          {
            id: 5,
            title: "Error Logs",
            type: "logs",
            datasource: { type: "loki", uid: "loki1" },
            targets: [{ refId: "A", expr: '{job="api"} |= "error"' }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce([
      { id: 1, uid: "prom1", name: "Prometheus", type: "prometheus", isDefault: true },
      { id: 2, uid: "loki1", name: "Loki", type: "loki", isDefault: false },
    ]);
    queryLokiRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { job: "api", level: "error" },
            values: [["1700000000000000000", "connection refused"]],
          },
        ],
      },
    });

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-panel", {
      dashboardUid: "log-dash",
      panelId: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.expr).toBe('{job="api"} |= "error"');
    expect(parsed.resolvedFrom).toBe("panel");
    expect(parsed.panelTitle).toBe("Error Logs");
  });

  test("panel resolution redirects Prometheus panels to grafana_query", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "cost-dash",
        panels: [
          {
            id: 2,
            title: "Cost",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom1" },
            targets: [{ refId: "A", expr: "sum(cost_total)" }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce([
      { id: 1, uid: "prom1", name: "Prometheus", type: "prometheus", isDefault: true },
    ]);

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-panel-prom", {
      dashboardUid: "cost-dash",
      panelId: 2,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("grafana_query");
    expect(parsed.error).toContain("prometheus");
  });

  test("missing both expr and dashboardUid returns helpful error", async () => {
    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-params", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Missing 'datasourceUid'");
  });

  // ══════════════════════════════════════════════════════════════════
  // Query guidance (error hints)
  // ══════════════════════════════════════════════════════════════════

  test("LogQL parse error includes structured guidance", async () => {
    queryLokiRangeMock.mockRejectedValueOnce(
      new Error("parse error at line 1, col 1: syntax error: unexpected IDENTIFIER"),
    );

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-guidance-logql", {
      datasourceUid: "loki1",
      expr: "error",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Log query failed");
    expect(parsed.guidance).toBeDefined();
    expect(parsed.guidance.cause).toContain("stream selector");
    expect(parsed.guidance.suggestion).toContain("{job=");
  });

  test("empty stream selector error includes guidance", async () => {
    queryLokiRangeMock.mockRejectedValueOnce(
      new Error("queries require at least one regexp or equality matcher"),
    );

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-guidance-empty-selector", {
      datasourceUid: "loki1",
      expr: '{}|="error"',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.guidance).toBeDefined();
    expect(parsed.guidance.suggestion).toContain("label filter");
  });

  test("no guidance field when error is unknown", async () => {
    queryLokiRangeMock.mockRejectedValueOnce(new Error("some completely unknown error"));

    const tool = createQueryLogsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-unknown-err", {
      datasourceUid: "loki1",
      expr: '{job="api"}',
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Log query failed");
    expect(parsed.guidance).toBeUndefined();
  });
});
