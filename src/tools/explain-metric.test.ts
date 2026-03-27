import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const queryPrometheusMock = vi.hoisted(() => vi.fn());
const queryPrometheusRangeMock = vi.hoisted(() => vi.fn());
const getMetricMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    queryPrometheus = queryPrometheusMock;
    queryPrometheusRange = queryPrometheusRangeMock;
    getMetricMetadata = getMetricMetadataMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createExplainMetricToolFactory, extractLabelNames, buildSuggestedQueries, resolveBreakdowns } from "./explain-metric.js";
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

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse(getTextContent(result as { content: Array<{ type: string; text?: string }> }));
}

// ── Helpers: mock Prometheus responses ────────────────────────────────

function makeInstantResult(value: string, ts = 1708243800) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: [{ metric: { __name__: "test_metric" }, value: [ts, value] }],
    },
  };
}

function makeMultiSeriesInstantResult(
  series: Array<{ labels: Record<string, string>; value: string }>,
  ts = 1708243800,
) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: series.map((s) => ({
        metric: { __name__: "test_metric", ...s.labels },
        value: [ts, s.value],
      })),
    },
  };
}

function makeRangeResult(values: Array<[number, string]>) {
  return {
    status: "success",
    data: {
      resultType: "matrix",
      result: [{ metric: { __name__: "test_metric" }, values }],
    },
  };
}

function makeEmptyResult() {
  return { status: "success", data: { resultType: "vector", result: [] } };
}

function makeEmptyRangeResult() {
  return { status: "success", data: { resultType: "matrix", result: [] } };
}

function makeMetadata(type: string, help: string, unit = "", metric = "test_metric") {
  return { [metric]: [{ type, help, unit }] };
}

describe("grafana_explain_metric tool", () => {
  beforeEach(() => {
    queryPrometheusMock.mockReset();
    queryPrometheusRangeMock.mockReset();
    getMetricMetadataMock.mockReset();
  });

  test("full success with gauge metric — all sections present", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Daily cost in USD"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("2.34"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([
        [1708157400, "2.03"],
        [1708200600, "1.80"],
        [1708243800, "2.34"],
      ]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-1", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.status).toBe("success");
    expect(result.expr).toBe("test_metric");
    expect(result.metricType).toBe("gauge");
    expect(result.trendQuery).toBeUndefined(); // no rate() wrapping for gauges
    expect(result.period).toBe("24h");
    expect(result.periodLabel).toBe("24 hours");
    expect(result.current).toEqual({ value: "2.34", timestamp: expect.any(String) });
    expect(result.trend).toEqual({
      changePercent: expect.any(Number),
      direction: "up",
      first: "2.03",
      last: "2.34",
    });
    expect(result.stats).toEqual({
      min: "1.8",
      max: "2.34",
      avg: expect.any(String),
      samples: 3,
    });
    expect(result.metadata).toEqual({ type: "gauge", help: "Daily cost in USD", unit: "" });
    // Gauge: range query uses raw expression (no rate wrapping)
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1", "test_metric", expect.any(String), expect.any(String), "300",
    );
  });

  test("complex PromQL skips metadata", async () => {
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("0.5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "0.4"], [1708243800, "0.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-2", {
      datasourceUid: "prom1",
      expr: "rate(http_requests_total[5m])",
    }));

    expect(result.status).toBe("success");
    expect(result.metadata).toBeUndefined();
    expect(getMetricMetadataMock).not.toHaveBeenCalled();
  });

  test("metadata fails gracefully — current + stats still returned", async () => {
    getMetricMetadataMock.mockRejectedValueOnce(new Error("metadata unavailable"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("10"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "8"], [1708243800, "10"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-3", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.status).toBe("success");
    expect(result.current).toBeDefined();
    expect(result.stats).toBeDefined();
    expect(result.metadata).toBeUndefined();
  });

  test("7d period uses correct step", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Active sessions"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1707639000, "3"], [1708243800, "5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-4", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "7d",
    });

    // Verify step "3600" was passed (7d config)
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1",
      "test_metric",
      expect.any(String),
      expect.any(String),
      "3600",
    );
  });

  test("30d period uses correct step", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Total items"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("100"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1705651800, "50"], [1708243800, "100"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-5", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "30d",
    }));

    expect(result.periodLabel).toBe("30 days");
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1",
      "test_metric",
      expect.any(String),
      expect.any(String),
      "21600",
    );
  });

  test("default period is 24h", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "test"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("1"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "1"], [1708243800, "1"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-6", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.period).toBe("24h");
    expect(result.periodLabel).toBe("24 hours");
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1",
      "test_metric",
      expect.any(String),
      expect.any(String),
      "300",
    );
  });

  test("no data returns informative note", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    queryPrometheusMock.mockResolvedValueOnce(makeEmptyResult());
    queryPrometheusRangeMock.mockResolvedValueOnce(makeEmptyRangeResult());

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-7", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.status).toBe("success");
    expect(result.note).toContain("No data found");
    expect(result.current).toBeUndefined();
    expect(result.trend).toBeUndefined();
    expect(result.stats).toBeUndefined();
  });

  test("upward trend detection", async () => {
    getMetricMetadataMock.mockRejectedValueOnce(new Error("skip"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("10"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "5"], [1708200600, "7"], [1708243800, "10"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-8", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    const trend = result.trend as { changePercent: number; direction: string };
    expect(trend.direction).toBe("up");
    expect(trend.changePercent).toBe(100);
  });

  test("downward trend detection", async () => {
    getMetricMetadataMock.mockRejectedValueOnce(new Error("skip"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("3"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "10"], [1708200600, "6"], [1708243800, "3"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-9", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    const trend = result.trend as { changePercent: number; direction: string };
    expect(trend.direction).toBe("down");
    expect(trend.changePercent).toBe(-70);
  });

  test("flat trend detection", async () => {
    getMetricMetadataMock.mockRejectedValueOnce(new Error("skip"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "5.00"], [1708200600, "5.01"], [1708243800, "5.00"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-10", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    const trend = result.trend as { direction: string };
    expect(trend.direction).toBe("flat");
  });

  test("zero first value sets changePercent to null", async () => {
    getMetricMetadataMock.mockRejectedValueOnce(new Error("skip"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "0"], [1708243800, "5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-11", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    const trend = result.trend as { changePercent: number | null; direction: string };
    expect(trend.changePercent).toBeNull();
    expect(trend.direction).toBe("up");
  });

  test("invalid period returns error", async () => {
    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-12", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "1y",
    }));

    expect(result.error).toContain("Invalid period");
  });

  test("all queries fail returns error from instant query", async () => {
    getMetricMetadataMock.mockRejectedValueOnce(new Error("connection refused"));
    queryPrometheusMock.mockRejectedValueOnce(new Error("connection refused"));
    queryPrometheusRangeMock.mockRejectedValueOnce(new Error("connection refused"));

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-13", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.error).toContain("Query failed");
    expect(result.error).toContain("connection refused");
  });

  test("correct min/max/avg computation", async () => {
    getMetricMetadataMock.mockRejectedValueOnce(new Error("skip"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("4"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([
        [1708157400, "2"],
        [1708175100, "6"],
        [1708192800, "4"],
        [1708210500, "8"],
        [1708243800, "4"],
      ]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-14", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    const stats = result.stats as { min: string; max: string; avg: string; samples: number };
    expect(stats.min).toBe("2");
    expect(stats.max).toBe("8");
    expect(stats.avg).toBe("4.8");
    expect(stats.samples).toBe(5);
  });

  test("range fails but instant succeeds — partial result", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Answer"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("42"));
    queryPrometheusRangeMock.mockRejectedValueOnce(new Error("timeout"));

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-15", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.status).toBe("success");
    expect(result.current).toEqual({ value: "42", timestamp: expect.any(String) });
    expect(result.trend).toBeUndefined();
    expect(result.stats).toBeUndefined();
    expect(result.metadata).toEqual({ type: "gauge", help: "Answer", unit: "" });
  });

  // ── healthContext tests ──────────────────────────────────────────────

  test("well-known metric includes healthContext", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(
      makeMetadata("gauge", "Message queue depth", "", "openclaw_lens_queue_depth"),
    );
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [{ metric: { __name__: "openclaw_lens_queue_depth" }, value: [1708243800, "15"] }],
      },
    });
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "5"], [1708243800, "15"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-health-1", {
      datasourceUid: "prom1",
      expr: "openclaw_lens_queue_depth",
    }));

    expect(result.healthContext).toBeDefined();
    const health = result.healthContext as { status: string; thresholds: { warning: number; critical: number }; direction: string };
    expect(health.status).toBe("warning");
    expect(health.thresholds).toEqual({ warning: 10, critical: 50 });
    expect(health.direction).toBe("higher_is_worse");
  });

  test("unknown metric omits healthContext", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(
      makeMetadata("gauge", "Daily cost in USD"),
    );
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("2.34"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "2.03"], [1708243800, "2.34"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-health-2", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.healthContext).toBeUndefined();
  });

  // ── compareWith="previous" tests ────────────────────────────────────

  test("compareWith='previous' returns comparison with previous period stats", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Daily cost in USD"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("3.50"));
    // Current period range: avg = (2.0 + 3.0 + 3.5) / 3 = 2.833...
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([
        [1708157400, "2.0"],
        [1708200600, "3.0"],
        [1708243800, "3.5"],
      ]),
    );
    // Previous period range: avg = (1.0 + 1.5 + 2.0) / 3 = 1.5
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([
        [1707552600, "1.0"],
        [1707595800, "1.5"],
        [1707639000, "2.0"],
      ]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-cmp-1", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "7d",
      compareWith: "previous",
    }));

    expect(result.status).toBe("success");
    expect(result.comparison).toBeDefined();
    const cmp = result.comparison as {
      previousPeriod: { from: string; to: string; avg: string; min: string; max: string; samples: number };
      change: { absolute: string; percentage: number; direction: string };
    };
    expect(cmp.previousPeriod.avg).toBe("1.5");
    expect(cmp.previousPeriod.min).toBe("1");
    expect(cmp.previousPeriod.max).toBe("2");
    expect(cmp.previousPeriod.samples).toBe(3);
    expect(cmp.previousPeriod.from).toMatch(/^\d{4}-/); // ISO date
    expect(cmp.previousPeriod.to).toMatch(/^\d{4}-/);
    // Change: (2.833 - 1.5) / 1.5 * 100 = ~88.9%
    expect(cmp.change.direction).toBe("up");
    expect(cmp.change.percentage).toBeGreaterThan(80);
    expect(parseFloat(cmp.change.absolute)).toBeGreaterThan(1);
    // Two range queries made (current + previous)
    expect(queryPrometheusRangeMock).toHaveBeenCalledTimes(2);
  });

  test("compareWith='previous' with flat change", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "test"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "5.0"], [1708243800, "5.0"]]),
    );
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708071000, "5.0"], [1708157400, "5.0"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-cmp-2", {
      datasourceUid: "prom1",
      expr: "test_metric",
      compareWith: "previous",
    }));

    const cmp = result.comparison as { change: { direction: string; percentage: number } };
    expect(cmp.change.direction).toBe("flat");
    expect(cmp.change.percentage).toBe(0);
  });

  test("compareWith='previous' with downward change", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "test"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("2"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "2.0"], [1708243800, "2.0"]]),
    );
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708071000, "4.0"], [1708157400, "4.0"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-cmp-3", {
      datasourceUid: "prom1",
      expr: "test_metric",
      compareWith: "previous",
    }));

    const cmp = result.comparison as { change: { direction: string; percentage: number } };
    expect(cmp.change.direction).toBe("down");
    expect(cmp.change.percentage).toBe(-50);
  });

  test("compareWith='previous' with zero previous avg sets percentage to null", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "test"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "5.0"], [1708243800, "5.0"]]),
    );
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708071000, "0"], [1708157400, "0"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-cmp-4", {
      datasourceUid: "prom1",
      expr: "test_metric",
      compareWith: "previous",
    }));

    const cmp = result.comparison as { change: { percentage: number | null; direction: string } };
    expect(cmp.change.percentage).toBeNull();
    expect(cmp.change.direction).toBe("up");
  });

  test("compareWith='previous' omitted when previous period has no data", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "test"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "5.0"], [1708243800, "5.0"]]),
    );
    queryPrometheusRangeMock.mockResolvedValueOnce(makeEmptyRangeResult());

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-cmp-5", {
      datasourceUid: "prom1",
      expr: "test_metric",
      compareWith: "previous",
    }));

    expect(result.status).toBe("success");
    expect(result.comparison).toBeUndefined();
  });

  test("compareWith='previous' omitted when previous range query fails", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "test"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "5.0"], [1708243800, "5.0"]]),
    );
    queryPrometheusRangeMock.mockRejectedValueOnce(new Error("timeout"));

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-cmp-6", {
      datasourceUid: "prom1",
      expr: "test_metric",
      compareWith: "previous",
    }));

    expect(result.status).toBe("success");
    expect(result.stats).toBeDefined();
    expect(result.comparison).toBeUndefined();
  });

  test("no compareWith param means no comparison query made", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "test"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "5.0"], [1708243800, "5.0"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-cmp-7", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.comparison).toBeUndefined();
    // Only one range query should have been made
    expect(queryPrometheusRangeMock).toHaveBeenCalledTimes(1);
  });

  test("compareWith='previous' works with counter metrics (rate-wrapped)", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("counter", "Total tokens"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("95000"));
    // Current period rate values
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "1.0"], [1708243800, "1.5"]]),
    );
    // Previous period rate values
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708071000, "0.5"], [1708157400, "0.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-cmp-8", {
      datasourceUid: "prom1",
      expr: "test_metric",
      compareWith: "previous",
    }));

    expect(result.metricType).toBe("counter");
    expect(result.trendQuery).toBe("rate(test_metric[5m])");
    // Both range queries use rate() expression
    expect(queryPrometheusRangeMock).toHaveBeenCalledTimes(2);
    expect(queryPrometheusRangeMock).toHaveBeenNthCalledWith(
      2,
      "prom1",
      "rate(test_metric[5m])",
      expect.any(String),
      expect.any(String),
      "300",
    );
    const cmp = result.comparison as { change: { direction: string; percentage: number } };
    expect(cmp.change.direction).toBe("up");
    expect(cmp.change.percentage).toBe(150); // (1.25 - 0.5) / 0.5 * 100
  });

  // ── Counter-aware tests ─────────────────────────────────────────────

  test("counter metric (via metadata) wraps range query in rate()", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("counter", "Total tokens processed"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("95267"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([
        [1708157400, "0.5"],
        [1708200600, "0.48"],
        [1708243800, "0.52"],
      ]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-counter-1", {
      datasourceUid: "prom1",
      expr: "test_metric",
    }));

    expect(result.metricType).toBe("counter");
    expect(result.trendQuery).toBe("rate(test_metric[5m])");
    // Current value is raw cumulative total (meaningful for counters)
    expect(result.current).toEqual({ value: "95267", timestamp: expect.any(String) });
    // Range query used rate() wrapping
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1",
      "rate(test_metric[5m])",
      expect.any(String),
      expect.any(String),
      "300",
    );
    // Trend shows rate values, not cumulative
    const trend = result.trend as { direction: string; first: string; last: string };
    expect(trend.first).toBe("0.5");
    expect(trend.last).toBe("0.52");
  });

  test("counter detected by _total suffix when metadata unavailable", async () => {
    // Metadata API returns empty (common with OTLP-pushed metrics)
    getMetricMetadataMock.mockResolvedValueOnce({});
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("12000"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "1.2"], [1708243800, "1.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-counter-2", {
      datasourceUid: "prom1",
      expr: "http_requests_total",
    }));

    expect(result.metricType).toBe("counter");
    expect(result.trendQuery).toBe("rate(http_requests_total[5m])");
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1",
      "rate(http_requests_total[5m])",
      expect.any(String),
      expect.any(String),
      "300",
    );
  });

  test("counter detected by _total suffix when metadata fails", async () => {
    getMetricMetadataMock.mockRejectedValueOnce(new Error("metadata unavailable"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5000"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "2.0"], [1708243800, "2.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-counter-3", {
      datasourceUid: "prom1",
      expr: "openclaw_lens_tokens_total",
    }));

    expect(result.metricType).toBe("counter");
    expect(result.trendQuery).toBe("rate(openclaw_lens_tokens_total[5m])");
  });

  test("histogram metric detected by _bucket suffix", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("100"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "90"], [1708243800, "100"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-histogram-1", {
      datasourceUid: "prom1",
      expr: "http_duration_bucket",
    }));

    expect(result.metricType).toBe("histogram");
    // Histograms are NOT wrapped in rate() — they need histogram_quantile()
    expect(result.trendQuery).toBeUndefined();
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1",
      "http_duration_bucket",
      expect.any(String),
      expect.any(String),
      "300",
    );
  });

  test("gauge metric has no rate wrapping or trendQuery", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Current CPU usage", "", "node_cpu_usage"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("72.5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "65"], [1708243800, "72.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-gauge-1", {
      datasourceUid: "prom1",
      expr: "node_cpu_usage",
    }));

    expect(result.metricType).toBe("gauge");
    expect(result.trendQuery).toBeUndefined();
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1",
      "node_cpu_usage",
      expect.any(String),
      expect.any(String),
      "300",
    );
  });

  test("complex PromQL expression skips counter detection entirely", async () => {
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("0.8"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "0.7"], [1708243800, "0.8"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-complex-1", {
      datasourceUid: "prom1",
      expr: "sum(rate(http_requests_total[5m]))",
    }));

    expect(result.metricType).toBeUndefined();
    expect(result.trendQuery).toBeUndefined();
    expect(getMetricMetadataMock).not.toHaveBeenCalled();
    // Uses raw expression for range query
    expect(queryPrometheusRangeMock).toHaveBeenCalledWith(
      "prom1",
      "sum(rate(http_requests_total[5m]))",
      expect.any(String),
      expect.any(String),
      "300",
    );
  });

  // ── suggestedQueries integration tests ────────────────────────────

  test("counter metric with multiple labels returns suggestedQueries with rate()", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(
      makeMetadata("counter", "Cost by token type", "", "cost_by_token_type_total"),
    );
    queryPrometheusMock.mockResolvedValueOnce(makeMultiSeriesInstantResult([
      { labels: { token_type: "input", model: "opus", provider: "anthropic" }, value: "1.5" },
      { labels: { token_type: "output", model: "opus", provider: "anthropic" }, value: "0.8" },
      { labels: { token_type: "input", model: "haiku", provider: "anthropic" }, value: "0.1" },
    ]));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "0.3"], [1708243800, "0.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sq-1", {
      datasourceUid: "prom1",
      expr: "cost_by_token_type_total",
    }));

    expect(result.metricType).toBe("counter");
    const sq = result.suggestedQueries as Array<{ query: string; description: string }>;
    expect(sq).toBeDefined();
    expect(sq.length).toBeGreaterThanOrEqual(4); // topk + 3 labels + full breakdown
    // All queries should use rate() since it's a counter
    for (const q of sq) {
      expect(q.query).toContain("rate(cost_by_token_type_total[5m])");
    }
    // Should have topk as first suggestion
    expect(sq[0].query).toContain("topk(5,");
    // Should have full breakdown as last
    expect(sq[sq.length - 1].description).toBe("Full breakdown by all labels");
    expect(sq[sq.length - 1].query).toContain("model, provider, token_type"); // sorted alphabetically
  });

  test("gauge metric with labels returns suggestedQueries without rate()", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(
      makeMetadata("gauge", "Active sessions", "", "sessions_active"),
    );
    queryPrometheusMock.mockResolvedValueOnce(makeMultiSeriesInstantResult([
      { labels: { state: "idle" }, value: "3" },
      { labels: { state: "processing" }, value: "1" },
    ]));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "4"], [1708243800, "4"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sq-2", {
      datasourceUid: "prom1",
      expr: "sessions_active",
    }));

    expect(result.metricType).toBe("gauge");
    const sq = result.suggestedQueries as Array<{ query: string; description: string }>;
    expect(sq).toBeDefined();
    // Single label → topk + breakdown (no full multi-label breakdown)
    expect(sq.length).toBe(2);
    // No rate() wrapping for gauges
    expect(sq[0].query).not.toContain("rate(");
    expect(sq[0].query).toBe("topk(5, sum by (state) (sessions_active))");
    expect(sq[1].query).toBe("sum by (state) (sessions_active)");
  });

  test("metric with no semantic labels omits suggestedQueries", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(
      makeMetadata("gauge", "Daily cost", "", "daily_cost_usd"),
    );
    // Single series with only __name__ and infrastructure labels
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [{
          metric: { __name__: "daily_cost_usd", job: "grafana-lens/openclaw", instance: "localhost:3000" },
          value: [1708243800, "2.50"],
        }],
      },
    });
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "2.00"], [1708243800, "2.50"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sq-3", {
      datasourceUid: "prom1",
      expr: "daily_cost_usd",
    }));

    expect(result.status).toBe("success");
    expect(result.suggestedQueries).toBeUndefined();
  });

  test("complex PromQL expression omits suggestedQueries", async () => {
    queryPrometheusMock.mockResolvedValueOnce(makeMultiSeriesInstantResult([
      { labels: { model: "opus" }, value: "0.5" },
      { labels: { model: "haiku" }, value: "0.2" },
    ]));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "0.4"], [1708243800, "0.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sq-4", {
      datasourceUid: "prom1",
      expr: "sum by (model) (rate(tokens_total[5m]))",
    }));

    // Complex PromQL → not a plain metric → no suggestedQueries
    expect(result.suggestedQueries).toBeUndefined();
  });

  // ── suggestedBreakdowns integration tests ─────────────────────────

  test("known metric returns static suggestedBreakdowns even with no data", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    queryPrometheusMock.mockResolvedValueOnce(makeEmptyResult());
    queryPrometheusRangeMock.mockResolvedValueOnce(makeEmptyRangeResult());

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sb-1", {
      datasourceUid: "prom1",
      expr: "openclaw_lens_cost_by_token_type",
    }));

    expect(result.status).toBe("success");
    // Static breakdowns available despite no data
    expect(result.suggestedBreakdowns).toEqual(["model", "token_type", "provider"]);
    // suggestedQueries uses static breakdowns as fallback when instant has no data
    const sq = result.suggestedQueries as Array<{ query: string; description: string }>;
    expect(sq).toBeDefined();
    expect(sq.length).toBeGreaterThan(0);
    // No _total suffix + empty metadata → metricType undefined → raw expression (no rate wrapping)
    expect(sq[0].query).toContain("openclaw_lens_cost_by_token_type");
    expect(sq[0].query).toContain("model"); // uses static breakdown labels
  });

  test("stale metric uses static breakdowns for suggestedQueries", async () => {
    // Metric is stale (empty instant) but range has data — simulates Prometheus staleness
    getMetricMetadataMock.mockResolvedValueOnce({});
    queryPrometheusMock.mockResolvedValueOnce(makeEmptyResult()); // stale: no instant data
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "100"], [1708200600, "200"], [1708243800, "300"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sb-stale", {
      datasourceUid: "prom1",
      expr: "openclaw_lens_tokens_total",
    }));

    expect(result.status).toBe("success");
    // Range data still provides trend + stats
    expect(result.trend).toBeDefined();
    expect(result.stats).toBeDefined();
    // Static breakdowns present
    expect(result.suggestedBreakdowns).toEqual(["model", "token", "provider"]);
    // suggestedQueries falls back to static breakdowns (not empty)
    const sq = result.suggestedQueries as Array<{ query: string; description: string }>;
    expect(sq).toBeDefined();
    expect(sq.length).toBeGreaterThan(0);
    // Counter → rate() wrapping, broken down by first label "model"
    expect(sq[0].query).toContain("rate(openclaw_lens_tokens_total");
    expect(sq[0].query).toContain("model");
  });

  test("known metric uses static breakdowns over dynamic labels", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(
      makeMetadata("counter", "Cost by token type", "", "openclaw_lens_cost_by_token_type"),
    );
    queryPrometheusMock.mockResolvedValueOnce(makeMultiSeriesInstantResult([
      { labels: { token_type: "input", model: "opus", provider: "anthropic" }, value: "1.5" },
    ]));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "0.3"], [1708243800, "0.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sb-2", {
      datasourceUid: "prom1",
      expr: "openclaw_lens_cost_by_token_type",
    }));

    // Static breakdowns — ordered by analytical importance
    expect(result.suggestedBreakdowns).toEqual(["model", "token_type", "provider"]);
    // suggestedQueries also present (from dynamic labels)
    expect(result.suggestedQueries).toBeDefined();
  });

  test("unknown metric with data uses dynamic labels as breakdowns", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    queryPrometheusMock.mockResolvedValueOnce(makeMultiSeriesInstantResult([
      { labels: { region: "us-east", env: "prod" }, value: "42" },
    ]));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "40"], [1708243800, "42"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sb-3", {
      datasourceUid: "prom1",
      expr: "custom_app_metric",
    }));

    // Falls back to dynamic labels (sorted alphabetically)
    expect(result.suggestedBreakdowns).toEqual(["env", "region"]);
  });

  test("complex PromQL expression omits suggestedBreakdowns", async () => {
    queryPrometheusMock.mockResolvedValueOnce(makeMultiSeriesInstantResult([
      { labels: { model: "opus" }, value: "0.5" },
    ]));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "0.4"], [1708243800, "0.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sb-4", {
      datasourceUid: "prom1",
      expr: "sum by (model) (rate(tokens_total[5m]))",
    }));

    expect(result.suggestedBreakdowns).toBeUndefined();
  });

  test("known session metric returns state breakdown", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(
      makeMetadata("gauge", "Active sessions", "", "openclaw_lens_sessions_active"),
    );
    queryPrometheusMock.mockResolvedValueOnce(makeMultiSeriesInstantResult([
      { labels: { state: "idle" }, value: "3" },
      { labels: { state: "processing" }, value: "1" },
    ]));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "4"], [1708243800, "4"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sb-5", {
      datasourceUid: "prom1",
      expr: "openclaw_lens_sessions_active",
    }));

    expect(result.suggestedBreakdowns).toEqual(["state"]);
  });

  test("infrastructure labels are excluded from suggestedQueries", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    queryPrometheusMock.mockResolvedValueOnce({
      status: "success",
      data: {
        resultType: "vector",
        result: [{
          metric: {
            __name__: "http_requests_total",
            job: "api-server",
            instance: "10.0.0.1:8080",
            service_name: "api",
            service_namespace: "production",
            service_version: "1.0.0",
            method: "GET",
            status: "200",
          },
          value: [1708243800, "50000"],
        }],
      },
    });
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "1.0"], [1708243800, "1.2"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("call-sq-5", {
      datasourceUid: "prom1",
      expr: "http_requests_total",
    }));

    const sq = result.suggestedQueries as Array<{ query: string; description: string }>;
    expect(sq).toBeDefined();
    // Only semantic labels: method, status (infra labels excluded)
    const allLabels = sq.flatMap((q) => {
      const match = q.query.match(/sum by \(([^)]+)\)/);
      return match ? match[1].split(", ") : [];
    });
    expect(allLabels).not.toContain("job");
    expect(allLabels).not.toContain("instance");
    expect(allLabels).not.toContain("service_name");
    expect(allLabels).toContain("method");
    expect(allLabels).toContain("status");
  });
});

// ── Unit tests for exported helpers ───────────────────────────────────

describe("extractLabelNames", () => {
  test("extracts semantic labels, excludes infrastructure labels", () => {
    const results = [
      { metric: { __name__: "m", job: "j", instance: "i", model: "opus", token_type: "input" } },
      { metric: { __name__: "m", job: "j", instance: "i", model: "haiku", token_type: "output" } },
    ];
    expect(extractLabelNames(results)).toEqual(["model", "token_type"]);
  });

  test("returns empty array for no results", () => {
    expect(extractLabelNames([])).toEqual([]);
  });

  test("returns empty array when only infrastructure labels present", () => {
    const results = [
      { metric: { __name__: "m", job: "j", instance: "i", service_name: "s" } },
    ];
    expect(extractLabelNames(results)).toEqual([]);
  });

  test("deduplicates labels across series", () => {
    const results: Array<{ metric: Record<string, string> }> = [
      { metric: { __name__: "m", region: "us" } },
      { metric: { __name__: "m", region: "eu", env: "prod" } },
    ];
    expect(extractLabelNames(results)).toEqual(["env", "region"]);
  });

  test("excludes le label (histogram bucket boundary)", () => {
    const results = [
      { metric: { __name__: "m", le: "0.5", handler: "/api" } },
    ];
    expect(extractLabelNames(results)).toEqual(["handler"]);
  });
});

describe("buildSuggestedQueries", () => {
  test("counter metric generates rate()-wrapped queries", () => {
    const queries = buildSuggestedQueries("tokens_total", ["model", "provider"], "counter");
    expect(queries.length).toBe(4); // topk + 2 breakdowns + full
    expect(queries[0].query).toBe("topk(5, sum by (model) (rate(tokens_total[5m])))");
    expect(queries[1].query).toBe("sum by (model) (rate(tokens_total[5m]))");
    expect(queries[2].query).toBe("sum by (provider) (rate(tokens_total[5m]))");
    expect(queries[3].query).toBe("sum by (model, provider) (rate(tokens_total[5m]))");
  });

  test("gauge metric generates raw expression queries", () => {
    const queries = buildSuggestedQueries("sessions_active", ["state"], "gauge");
    expect(queries.length).toBe(2); // topk + 1 breakdown (no full for single label)
    expect(queries[0].query).toBe("topk(5, sum by (state) (sessions_active))");
    expect(queries[1].query).toBe("sum by (state) (sessions_active)");
  });

  test("unknown metric type uses raw expression", () => {
    const queries = buildSuggestedQueries("custom_metric", ["env"], undefined);
    expect(queries[0].query).toBe("topk(5, sum by (env) (custom_metric))");
  });

  test("empty labels returns empty array", () => {
    expect(buildSuggestedQueries("any_metric", [], "counter")).toEqual([]);
  });

  test("each query has a description", () => {
    const queries = buildSuggestedQueries("m", ["a", "b"], "gauge");
    for (const q of queries) {
      expect(q.description).toBeTruthy();
    }
  });
});

describe("resolveBreakdowns", () => {
  test("known cost metric returns static breakdowns", () => {
    expect(resolveBreakdowns("openclaw_lens_cost_by_token_type", [])).toEqual([
      "model", "token_type", "provider",
    ]);
  });

  test("known tokens metric returns static breakdowns", () => {
    expect(resolveBreakdowns("openclaw_lens_tokens_total", [])).toEqual([
      "model", "token", "provider",
    ]);
  });

  test("known session metric returns state breakdown", () => {
    expect(resolveBreakdowns("openclaw_lens_sessions_active", [])).toEqual(["state"]);
  });

  test("known queue metric returns lane breakdown", () => {
    expect(resolveBreakdowns("openclaw_lens_queue_lane_depth", [])).toEqual(["lane"]);
  });

  test("known webhook metric returns channel + update_type", () => {
    expect(resolveBreakdowns("openclaw_lens_webhook_received_total", [])).toEqual([
      "channel", "update_type",
    ]);
  });

  test("unknown metric falls back to dynamic labels", () => {
    expect(resolveBreakdowns("custom_metric", ["env", "region"])).toEqual(["env", "region"]);
  });

  test("unknown metric with no labels returns empty array", () => {
    expect(resolveBreakdowns("some_metric", [])).toEqual([]);
  });

  test("known metric ignores dynamic labels (static wins)", () => {
    expect(resolveBreakdowns("openclaw_lens_cost_by_token_type", ["dynamic_label"])).toEqual([
      "model", "token_type", "provider",
    ]);
  });
});

// ── Anomaly scoring & seasonality tests ─────────────────────────────

describe("anomaly scoring and seasonality (24h period)", () => {
  beforeEach(() => {
    queryPrometheusMock.mockReset();
    queryPrometheusRangeMock.mockReset();
    getMetricMetadataMock.mockReset();
  });

  test("returns anomaly and seasonality for 24h gauge metric", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Daily cost"));
    // instant query
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("10.5"));
    // range query
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "8.0"], [1708200600, "9.0"], [1708243800, "10.5"]]),
    );
    // anomaly: avg_over_time(metric[7d])
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5.0"));
    // anomaly: stddev_over_time(metric[7d])
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("1.5"));
    // seasonality: metric offset 1d
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("7.0"));
    // seasonality: metric offset 7d
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("4.0"));

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("anomaly-1", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "24h",
    }));

    // Anomaly: (9.167 - 5.0) / (1.5) ≈ 2.78 → significant
    expect(result.anomaly).toBeDefined();
    const anomaly = result.anomaly as Record<string, unknown>;
    expect(anomaly.severity).toBe("significant");
    expect(typeof anomaly.score).toBe("number");
    expect((anomaly.score as number)).toBeGreaterThan(2);
    expect((anomaly.score as number)).toBeLessThan(3);
    expect(anomaly.interpretation).toContain("significant");

    const baseline = anomaly.baseline as Record<string, unknown>;
    expect(baseline.period).toBe("7d");

    // Seasonality
    expect(result.seasonality).toBeDefined();
    const seasonality = result.seasonality as Record<string, unknown>;
    const vs1d = seasonality.vs1dAgo as Record<string, unknown>;
    const vs7d = seasonality.vs7dAgo as Record<string, unknown>;
    expect(vs1d.value).toBe("7");
    expect(vs1d.changePercent).toBe(50); // (10.5-7)/7*100 = 50%
    expect(vs7d.value).toBe("4");
    expect(vs7d.changePercent).toBe(162.5); // (10.5-4)/4*100 = 162.5%
  });

  test("anomaly not computed for 7d period", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Daily cost"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("10.5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "8.0"], [1708243800, "10.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("anomaly-2", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "7d",
    }));

    expect(result.anomaly).toBeUndefined();
    expect(result.seasonality).toBeUndefined();
    // Should not make anomaly queries for non-24h periods
    expect(queryPrometheusMock).toHaveBeenCalledTimes(1); // only instant
  });

  test("anomaly not computed for complex PromQL expressions", async () => {
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("0.5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "0.3"], [1708243800, "0.5"]]),
    );

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("anomaly-3", {
      datasourceUid: "prom1",
      expr: "rate(http_requests_total[5m])",
      period: "24h",
    }));

    expect(result.anomaly).toBeUndefined();
    expect(result.seasonality).toBeUndefined();
  });

  test("anomaly scoring handles failed baseline queries gracefully", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Daily cost"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("10.5"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "8.0"], [1708243800, "10.5"]]),
    );
    // anomaly queries fail
    queryPrometheusMock.mockRejectedValueOnce(new Error("query timeout"));
    queryPrometheusMock.mockRejectedValueOnce(new Error("query timeout"));
    // offset queries also fail
    queryPrometheusMock.mockRejectedValueOnce(new Error("query timeout"));
    queryPrometheusMock.mockRejectedValueOnce(new Error("query timeout"));

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("anomaly-4", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "24h",
    }));

    // Should still succeed — anomaly is optional
    expect(result.status).toBe("success");
    expect(result.anomaly).toBeUndefined();
    // Seasonality still returns structure (with N/A values) when offset queries fail
    // but instant value is available — this is correct behavior
    const seasonality = result.seasonality as Record<string, unknown> | undefined;
    if (seasonality) {
      const vs1d = seasonality.vs1dAgo as Record<string, unknown>;
      const vs7d = seasonality.vs7dAgo as Record<string, unknown>;
      expect(vs1d.value).toBe("N/A");
      expect(vs7d.value).toBe("N/A");
    }
  });

  test("critical anomaly (>3σ) detected correctly", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Cost"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("100"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "90"], [1708243800, "100"]]),
    );
    // baseline avg = 20, stddev = 5 → z-score = (95-20)/5 = 15 → critical
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("20"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("5"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("25"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("22"));

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("anomaly-5", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "24h",
    }));

    const anomaly = result.anomaly as Record<string, unknown>;
    expect(anomaly.severity).toBe("critical");
    expect((anomaly.score as number)).toBeGreaterThan(3);
    expect(anomaly.interpretation).toContain("critical");
  });

  test("seasonality shows N/A when offset query returns empty", async () => {
    getMetricMetadataMock.mockResolvedValueOnce(makeMetadata("gauge", "Metric"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("50"));
    queryPrometheusRangeMock.mockResolvedValueOnce(
      makeRangeResult([[1708157400, "45"], [1708243800, "50"]]),
    );
    // anomaly queries succeed
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("48"));
    queryPrometheusMock.mockResolvedValueOnce(makeInstantResult("3"));
    // offset 1d returns empty
    queryPrometheusMock.mockResolvedValueOnce(makeEmptyResult());
    // offset 7d returns empty
    queryPrometheusMock.mockResolvedValueOnce(makeEmptyResult());

    const tool = createExplainMetricToolFactory(makeRegistry())({} as never);
    const result = parse(await tool!.execute("anomaly-6", {
      datasourceUid: "prom1",
      expr: "test_metric",
      period: "24h",
    }));

    const seasonality = result.seasonality as Record<string, unknown>;
    expect(seasonality).toBeDefined();
    const vs1d = seasonality.vs1dAgo as Record<string, unknown>;
    const vs7d = seasonality.vs7dAgo as Record<string, unknown>;
    expect(vs1d.value).toBe("N/A");
    expect(vs1d.changePercent).toBeNull();
    expect(vs7d.value).toBe("N/A");
    expect(vs7d.changePercent).toBeNull();
  });
});
