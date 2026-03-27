import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const queryPrometheusMock = vi.hoisted(() => vi.fn());
const queryPrometheusRangeMock = vi.hoisted(() => vi.fn());
const getDashboardMock = vi.hoisted(() => vi.fn());
const listDatasourcesMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", async () => {
  const actual = await vi.importActual<typeof import("../grafana-client.js")>("../grafana-client.js");
  return {
    ...actual,
    GrafanaClient: class {
      queryPrometheus = queryPrometheusMock;
      queryPrometheusRange = queryPrometheusRangeMock;
      getDashboard = getDashboardMock;
      listDatasources = listDatasourcesMock;
      getUrl() { return "http://localhost:3000"; }
    },
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────

import { createQueryToolFactory, calculateAutoStep, MAX_INSTANT_RESULTS, MAX_RANGE_SERIES } from "./query.js";
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

describe("calculateAutoStep", () => {
  test("1-hour range → 15s step (minimum)", () => {
    // 3600 / 300 = 12 → clamped to min 15s
    const result = calculateAutoStep("1700000000", "1700003600");
    expect(result.stepSeconds).toBe(15);
    expect(result.stepDisplay).toBe("15s");
  });

  test("1-day range → ~288s step", () => {
    // 86400 / 300 = 288
    const result = calculateAutoStep("1700000000", "1700086400");
    expect(result.stepSeconds).toBe(288);
    expect(result.stepDisplay).toBe("5m");
  });

  test("7-day range → ~2016s step", () => {
    // 604800 / 300 = 2016
    const result = calculateAutoStep("1700000000", "1700604800");
    expect(result.stepSeconds).toBe(2016);
    expect(result.stepDisplay).toBe("34m");
  });

  test("30-day range → ~8640s step", () => {
    // 2592000 / 300 = 8640
    const result = calculateAutoStep("1700000000", "1702592000");
    expect(result.stepSeconds).toBe(8640);
    expect(result.stepDisplay).toBe("2h");
  });

  test("90-day range → ~25920s step", () => {
    // 7776000 / 300 = 25920
    const result = calculateAutoStep("1700000000", "1707776000");
    expect(result.stepSeconds).toBe(25920);
    expect(result.stepDisplay).toBe("7h");
  });

  test("zero-range (start == end) clamps to minimum step", () => {
    const result = calculateAutoStep("1700000000", "1700000000");
    expect(result.stepSeconds).toBe(15);
    expect(result.stepDisplay).toBe("15s");
  });
});

describe("grafana_query tool", () => {
  beforeEach(() => {
    queryPrometheusMock.mockReset();
    queryPrometheusRangeMock.mockReset();
    getDashboardMock.mockReset();
    listDatasourcesMock.mockReset();
  });

  test("instant query returns formatted metrics", async () => {
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          { metric: { __name__: "up", job: "prom" }, value: [1700000000, "1"] },
        ],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "prom1",
      expr: "up",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.queryType).toBe("instant");
    expect(parsed.datasourceUid).toBe("prom1");
    expect(parsed.metrics).toHaveLength(1);
    expect(parsed.metrics[0].value).toBe("1");
  });

  test("range query truncates to 20 values", async () => {
    const values = Array.from({ length: 50 }, (_, i) => [1700000000 + i * 60, String(i)]);
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "matrix",
        result: [{ metric: { __name__: "up" }, values }],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-2", {
      datasourceUid: "prom1",
      expr: "up",
      queryType: "range",
      start: "1700000000",
      end: "1700003000",
      step: "60",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.datasourceUid).toBe("prom1");
    expect(parsed.series[0].values).toHaveLength(20);
    expect(parsed.series[0].truncated).toBe(true);
    expect(parsed.series[0].totalValues).toBe(50);
  });

  test("range query without start returns error", async () => {
    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-3", {
      datasourceUid: "prom1",
      expr: "up",
      queryType: "range",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("require");
    expect(parsed.error).toContain("start");
  });

  test("range query auto-calculates step when omitted", async () => {
    const values = Array.from({ length: 10 }, (_, i) => [1700000000 + i * 60, String(i)]);
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "matrix",
        result: [{ metric: { __name__: "up" }, values }],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-auto-step", {
      datasourceUid: "prom1",
      expr: "up",
      queryType: "range",
      start: "1700000000",
      end: "1700086400",  // 1 day = 86400s
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    // Step metadata should be in response
    expect(parsed.step).toBeDefined();
    expect(parsed.step.auto).toBe(true);
    // 86400 / 300 = 288s → rounds to 288s, displayed as ~5m
    expect(parsed.step.value).toBe("288s");
    expect(parsed.step.display).toBe("5m");
    // The step passed to the API
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith("prom1", "up", "1700000000", "1700086400", "288");
  });

  test("range query defaults end to 'now' when omitted", async () => {
    const values = [[1700000000, "42"]];
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "matrix",
        result: [{ metric: { __name__: "up" }, values }],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-default-end", {
      datasourceUid: "prom1",
      expr: "up",
      queryType: "range",
      start: "now-1h",
    });

    // Should pass "now" as end
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1", "up", "now-1h", "now", expect.any(String),
    );
  });

  test("range query with explicit step does not include step metadata", async () => {
    const values = [[1700000000, "42"]];
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "matrix",
        result: [{ metric: { __name__: "up" }, values }],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-explicit-step", {
      datasourceUid: "prom1",
      expr: "up",
      queryType: "range",
      start: "1700000000",
      end: "1700086400",
      step: "300",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    // No auto-step metadata when step is explicit
    expect(parsed.step).toBeUndefined();
  });

  test("instant query includes healthContext for well-known metrics", async () => {
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          { metric: { __name__: "openclaw_lens_queue_depth" }, value: [1700000000, "15"] },
        ],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-health", {
      datasourceUid: "prom1",
      expr: "openclaw_lens_queue_depth",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.metrics[0].healthContext).toBeDefined();
    expect(parsed.metrics[0].healthContext.status).toBe("warning");
    expect(parsed.metrics[0].healthContext.thresholds).toEqual({ warning: 10, critical: 50 });
    expect(parsed.metrics[0].healthContext.direction).toBe("higher_is_worse");
  });

  test("instant query omits healthContext for unknown metrics", async () => {
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          { metric: { __name__: "up", job: "prom" }, value: [1700000000, "1"] },
        ],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-health", {
      datasourceUid: "prom1",
      expr: "up",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metrics[0].healthContext).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // Top-level result/series truncation
  // ══════════════════════════════════════════════════════════════════

  test("instant query truncates to MAX_INSTANT_RESULTS when exceeded", async () => {
    const results = Array.from({ length: 80 }, (_, i) => ({
      metric: { __name__: `metric_${i}`, job: "prom" },
      value: [1700000000, String(i)],
    }));
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "vector", result: results },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-trunc-instant", {
      datasourceUid: "prom1",
      expr: "{__name__=~'.+'}",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.metrics).toHaveLength(MAX_INSTANT_RESULTS);
    expect(parsed.resultCount).toBe(MAX_INSTANT_RESULTS);
    expect(parsed.truncated).toBe(true);
    expect(parsed.totalResults).toBe(80);
    expect(parsed.truncationHint).toContain("Narrow your query");
  });

  test("instant query omits truncation fields when under limit", async () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      metric: { __name__: `metric_${i}` },
      value: [1700000000, String(i)],
    }));
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "vector", result: results },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-trunc-instant", {
      datasourceUid: "prom1",
      expr: "up",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metrics).toHaveLength(5);
    expect(parsed.resultCount).toBe(5);
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.totalResults).toBeUndefined();
  });

  test("range query truncates series to MAX_RANGE_SERIES when exceeded", async () => {
    const series = Array.from({ length: 70 }, (_, i) => ({
      metric: { __name__: `metric_${i}` },
      values: [[1700000000, String(i)]],
    }));
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "matrix", result: series },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-trunc-range", {
      datasourceUid: "prom1",
      expr: "{__name__=~'.+'}",
      queryType: "range",
      start: "1700000000",
      end: "1700003600",
      step: "60",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.series).toHaveLength(MAX_RANGE_SERIES);
    expect(parsed.resultCount).toBe(MAX_RANGE_SERIES);
    expect(parsed.truncated).toBe(true);
    expect(parsed.totalSeries).toBe(70);
    expect(parsed.truncationHint).toContain("Narrow your query");
  });

  test("range query omits truncation fields when under limit", async () => {
    const series = Array.from({ length: 3 }, (_, i) => ({
      metric: { __name__: `metric_${i}` },
      values: [[1700000000, String(i)]],
    }));
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "matrix", result: series },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-trunc-range", {
      datasourceUid: "prom1",
      expr: "up",
      queryType: "range",
      start: "1700000000",
      end: "1700003600",
      step: "60",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.series).toHaveLength(3);
    expect(parsed.resultCount).toBe(3);
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.totalSeries).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // datasourceUid echo for chaining (query → alert)
  // ══════════════════════════════════════════════════════════════════

  test("instant query echoes datasourceUid for chaining to create_alert", async () => {
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [{ metric: { __name__: "error_rate" }, value: [1700000000, "0.02"] }],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-chain", {
      datasourceUid: "prom-abc",
      expr: "error_rate",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.datasourceUid).toBe("prom-abc");
    // Agent can now pass parsed.datasourceUid directly to grafana_create_alert
  });

  test("range query echoes datasourceUid for chaining", async () => {
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "matrix",
        result: [{ metric: { __name__: "error_rate" }, values: [[1700000000, "0.02"]] }],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-chain-range", {
      datasourceUid: "prom-xyz",
      expr: "error_rate",
      queryType: "range",
      start: "1700000000",
      end: "1700003600",
      step: "60",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.datasourceUid).toBe("prom-xyz");
  });

  test("panel-resolved query echoes resolved datasourceUid", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "sla-dash",
        panels: [
          {
            id: 1,
            title: "Error Rate",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom-resolved" },
            targets: [{ refId: "A", expr: "rate(errors_total[5m])" }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce([
      { id: 1, uid: "prom-resolved", name: "Prometheus", type: "prometheus", isDefault: true },
    ]);
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [{ metric: {}, value: [1700000000, "0.015"] }],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-panel-chain", {
      dashboardUid: "sla-dash",
      panelId: 1,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.datasourceUid).toBe("prom-resolved");
    expect(parsed.resolvedFrom).toBe("panel");
  });

  test("API error caught and returned gracefully", async () => {
    queryPrometheusMock.mockRejectedValueOnce(new Error("query prometheus: 502"));

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-4", {
      datasourceUid: "prom1",
      expr: "bad_expr{",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Query failed");
  });

  // ══════════════════════════════════════════════════════════════════
  // Query guidance (error hints, warnings, empty results)
  // ══════════════════════════════════════════════════════════════════

  test("parse error includes structured guidance", async () => {
    queryPrometheusMock.mockRejectedValueOnce(
      new Error('Grafana API error 400 (query prometheus): {"status":"error","errorType":"bad_data","error":"parse error: unclosed left parenthesis"}'),
    );

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-guidance-syntax", {
      datasourceUid: "prom1",
      expr: "rate(my_metric[5m]",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Query failed");
    expect(parsed.guidance).toBeDefined();
    expect(parsed.guidance.cause).toContain("parenthesis");
    expect(parsed.guidance.suggestion).toContain("closing ')'");
  });

  test("timeout error includes narrowing guidance", async () => {
    queryPrometheusMock.mockRejectedValueOnce(new Error("context deadline exceeded"));

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-guidance-timeout", {
      datasourceUid: "prom1",
      expr: "rate(http_total[5m])",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.guidance).toBeDefined();
    expect(parsed.guidance.cause).toContain("timed out");
  });

  test("Prometheus infos field surfaces as warnings on instant query", async () => {
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [{ metric: { __name__: "openclaw_lens_daily_cost_usd" }, value: [1700000000, "0"] }],
      },
      infos: [
        'PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "openclaw_lens_daily_cost_usd" (1:6)',
      ],
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-infos", {
      datasourceUid: "prom1",
      expr: "rate(openclaw_lens_daily_cost_usd[5m])",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0].cause).toContain("gauge");
    expect(parsed.warnings[0].suggestion).toContain("delta()");
  });

  test("Prometheus infos field surfaces as warnings on range query", async () => {
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "matrix",
        result: [{ metric: { __name__: "openclaw_lens_daily_cost_usd" }, values: [[1700000000, "0"]] }],
      },
      infos: [
        'PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "openclaw_lens_daily_cost_usd" (1:6)',
      ],
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-infos-range", {
      datasourceUid: "prom1",
      expr: "rate(openclaw_lens_daily_cost_usd[5m])",
      queryType: "range",
      start: "1700000000",
      end: "1700003600",
      step: "60",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings[0].cause).toContain("gauge");
  });

  test("empty instant result includes hint", async () => {
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "vector", result: [] },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-empty", {
      datasourceUid: "prom1",
      expr: "nonexistent_metric_xyz",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.resultCount).toBe(0);
    expect(parsed.hint).toBeDefined();
    expect(parsed.hint.cause).toContain("may not exist");
    expect(parsed.hint.suggestion).toContain("grafana_list_metrics");
  });

  test("empty range result includes hint", async () => {
    queryPrometheusRangeMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "matrix", result: [] },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-empty-range", {
      datasourceUid: "prom1",
      expr: 'http_requests_total{job="nonexistent"}',
      queryType: "range",
      start: "1700000000",
      end: "1700003600",
      step: "60",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.resultCount).toBe(0);
    expect(parsed.hint).toBeDefined();
    expect(parsed.hint.cause).toContain("label filters");
  });

  test("no guidance field when error is unknown", async () => {
    queryPrometheusMock.mockRejectedValueOnce(new Error("some completely unknown error"));

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-unknown-err", {
      datasourceUid: "prom1",
      expr: "up",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Query failed");
    expect(parsed.guidance).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // Panel resolution (dashboardUid + panelId)
  // ══════════════════════════════════════════════════════════════════

  test("panel resolution resolves expr and datasource from dashboard panel", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "cost-dash",
        panels: [
          {
            id: 2,
            title: "Today's Cost",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom1" },
            targets: [{ refId: "A", expr: "sum(increase(cost_total[1d]))" }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce([
      { id: 1, uid: "prom1", name: "Prometheus", type: "prometheus", isDefault: true },
    ]);
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [{ metric: {}, value: [1700000000, "42.5"] }],
      },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-panel", {
      dashboardUid: "cost-dash",
      panelId: 2,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.expr).toBe("sum(increase(cost_total[1d]))");
    expect(parsed.resolvedFrom).toBe("panel");
    expect(parsed.panelTitle).toBe("Today's Cost");
    expect(parsed.panelType).toBe("stat");
    // Should have queried with resolved datasource
    expect(queryPrometheusMock).toHaveBeenCalledWith("prom1", "sum(increase(cost_total[1d]))", undefined);
  });

  test("panel resolution allows explicit expr to override panel's expr", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "cost-dash",
        panels: [
          {
            id: 2,
            title: "Today's Cost",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom1" },
            targets: [{ refId: "A", expr: "sum(increase(cost_total[1d]))" }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce([
      { id: 1, uid: "prom1", name: "Prometheus", type: "prometheus", isDefault: true },
    ]);
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "10"] }] },
    });

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-panel-override", {
      dashboardUid: "cost-dash",
      panelId: 2,
      expr: "custom_override_expr",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.expr).toBe("custom_override_expr");
    expect(parsed.resolvedFrom).toBe("panel");
  });

  test("panel resolution redirects Loki panels to grafana_query_logs", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "log-dash",
        panels: [
          {
            id: 3,
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

    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-panel-loki", {
      dashboardUid: "log-dash",
      panelId: 3,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("grafana_query_logs");
    expect(parsed.error).toContain("loki");
  });

  test("missing both expr and dashboardUid returns helpful error", async () => {
    const tool = createQueryToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-no-params", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Missing 'datasourceUid'");
    expect(parsed.error).toContain("dashboardUid + panelId");
  });
});
