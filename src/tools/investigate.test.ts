import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const mockListDatasources = vi.hoisted(() => vi.fn());
const mockQueryPrometheus = vi.hoisted(() => vi.fn());
const mockQueryPrometheusRange = vi.hoisted(() => vi.fn());
const mockQueryLokiRange = vi.hoisted(() => vi.fn());
const mockSearchTraces = vi.hoisted(() => vi.fn());
const mockGetAnnotations = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: vi.fn().mockImplementation(() => ({
    listDatasources: mockListDatasources,
    queryPrometheus: mockQueryPrometheus,
    queryPrometheusRange: mockQueryPrometheusRange,
    queryLokiRange: mockQueryLokiRange,
    searchTraces: mockSearchTraces,
    getAnnotations: mockGetAnnotations,
    getUrl: () => "http://localhost:3000",
  })),
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createInvestigateToolFactory } from "./investigate.js";
import { createAlertStore, type GrafanaAlertNotification } from "../services/alert-webhook.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { GrafanaClientRegistry } from "../grafana-client-registry.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeConfig(): ValidatedGrafanaLensConfig {
  return {
    grafana: {
      instances: { default: { url: "http://localhost:3000", apiKey: "test-key" } },
      defaultInstance: "default",
    },
    proactive: { enabled: true },
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

const ALL_DATASOURCES = [
  { id: 1, uid: "prom-1", name: "Mimir", type: "prometheus", url: "", isDefault: true, access: "proxy" },
  { id: 2, uid: "loki-1", name: "Loki", type: "loki", url: "", isDefault: false, access: "proxy" },
  { id: 3, uid: "tempo-1", name: "Tempo", type: "tempo", url: "", isDefault: false, access: "proxy" },
];

/** Prometheus instant query result with a scalar value. */
function promInstant(value: string) {
  return { status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1708243800, value] }] } };
}

/** Prometheus range query result with a series. */
function promRange(values: Array<[number, string]>) {
  return { status: "success", data: { resultType: "matrix", result: [{ metric: {}, values }] } };
}

/** Loki range result with stream values. */
function lokiResult(values: Array<[string, string]>, metric?: Record<string, string>) {
  return {
    data: {
      result: [{ metric: metric ?? {}, values }],
    },
  };
}

/** Loki empty result. */
function lokiEmpty() {
  return { data: { result: [] } };
}

/** Tempo search traces result. */
function tempoTraces(traces: Array<{ traceID: string; rootServiceName: string; rootTraceName: string; durationMs: number }>) {
  return {
    traces: traces.map((t) => ({
      traceID: t.traceID,
      rootServiceName: t.rootServiceName,
      rootTraceName: t.rootTraceName,
      startTimeUnixNano: String(Date.now() * 1_000_000),
      durationMs: t.durationMs,
    })),
  };
}

function makeNotification(overrides?: Partial<GrafanaAlertNotification>): GrafanaAlertNotification {
  return {
    receiver: "openclaw-webhook",
    status: "firing",
    orgId: 1,
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighCost", managed_by: "openclaw" },
        annotations: { summary: "Daily cost > $5" },
        startsAt: "2026-02-18T10:00:00Z",
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "http://localhost:3000/alerting/alert-1/edit",
        fingerprint: "abc123",
        values: { B: 7.5 },
      },
    ],
    groupLabels: { alertname: "HighCost" },
    commonLabels: { managed_by: "openclaw" },
    externalURL: "http://localhost:3000",
    title: "[FIRING:1] HighCost",
    state: "alerting",
    message: "Daily cost exceeded $5",
    ...overrides,
  };
}

// ── Defaults for a typical "healthy" investigation ───────────────────

function setupDefaultMocks() {
  mockListDatasources.mockResolvedValue(ALL_DATASOURCES);

  // Metric focus queries: instant + range + avg_over_time + stddev_over_time
  mockQueryPrometheus.mockResolvedValue(promInstant("2.34"));
  mockQueryPrometheusRange.mockResolvedValue(
    promRange([
      [1708157400, "2.03"],
      [1708200600, "1.80"],
      [1708243800, "2.34"],
    ]),
  );

  // Log queries: volume, severity breakdown, sample errors
  mockQueryLokiRange.mockResolvedValue(lokiEmpty());

  // Trace queries: error + slow traces
  mockSearchTraces.mockResolvedValue(tempoTraces([]));

  // Context: annotations
  mockGetAnnotations.mockResolvedValue([
    {
      id: 1,
      dashboardUID: "d1",
      panelId: 1,
      time: 1708243800000,
      timeEnd: 0,
      tags: ["deploy"],
      text: "Deployed v2",
      created: 1708243800,
      updated: 1708243800,
    },
  ]);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("grafana_investigate tool", () => {
  let store: ReturnType<typeof createAlertStore>;

  beforeEach(() => {
    mockListDatasources.mockReset();
    mockQueryPrometheus.mockReset();
    mockQueryPrometheusRange.mockReset();
    mockQueryLokiRange.mockReset();
    mockSearchTraces.mockReset();
    mockGetAnnotations.mockReset();

    store = createAlertStore();
    setupDefaultMocks();
  });

  // ── 1. Metric focus ──────────────────────────────────────────────

  test("metric focus gathers focused metric + RED signals", async () => {
    // Focus metric instant result
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("2.34"))             // focus instant
      .mockResolvedValueOnce(promInstant("2.10"))             // avg_over_time (7d baseline)
      .mockResolvedValueOnce(promInstant("0.15"))             // stddev_over_time (7d baseline)
      .mockResolvedValueOnce(promInstant("0.5"))              // RED: rate
      .mockResolvedValueOnce(promInstant("0.005"))            // RED: error rate
      .mockResolvedValueOnce(promInstant("3.2"));             // RED: p95 latency

    mockQueryPrometheusRange.mockResolvedValueOnce(
      promRange([
        [1708157400, "2.03"],
        [1708200600, "1.80"],
        [1708243800, "2.34"],
      ]),
    );

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-1", { focus: "openclaw_lens_daily_cost_usd" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.focus).toBe("openclaw_lens_daily_cost_usd");
    expect(parsed.timeWindow).toBeDefined();
    expect(parsed.timeWindow.duration).toBe("1h");

    // Metric signals should include focus data
    expect(parsed.metricSignals).toBeDefined();
    expect(parsed.metricSignals.focus).toBeDefined();
    expect(parsed.metricSignals.focus.current).toBe("2.34");
    expect(parsed.metricSignals.focus.trend).toBeDefined();
    expect(parsed.metricSignals.focus.trend.length).toBeGreaterThan(0);

    // RED signals should be present
    expect(parsed.metricSignals.red).toBeDefined();
    expect(parsed.metricSignals.red.rate).toBe("0.5");
    expect(parsed.metricSignals.red.errorRate).toBe("0.005");
    expect(parsed.metricSignals.red.p95Latency).toBe("3.2");

    // Hypotheses should always exist
    expect(parsed.suggestedHypotheses).toBeDefined();
    expect(Array.isArray(parsed.suggestedHypotheses)).toBe(true);
  });

  // ── 2. Free-text focus ───────────────────────────────────────────

  test("free-text focus uses input as log search term instead of metric name", async () => {
    // With free-text focus, no metric-specific queries (instant/range/avg/stddev)
    // — only RED signals
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("0.3"))              // RED: rate
      .mockResolvedValueOnce(promInstant("0.02"))             // RED: error rate
      .mockResolvedValueOnce(promInstant("5.1"));             // RED: p95

    // Loki should be queried with the search term
    mockQueryLokiRange
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", "100"]])) // volume
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", "15"]], { level: "ERROR" })) // severity
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", "Error: high error rate detected"]])); // samples

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-2", { focus: "high error rate" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.focus).toBe("high error rate");

    // With free-text, no focus metric queries should be made
    // Only RED signals — no instant/range for the focus
    expect(parsed.metricSignals?.focus).toBeUndefined();
    expect(parsed.metricSignals?.red).toBeDefined();

    // Log signals should be populated
    expect(parsed.logSignals).toBeDefined();

    // queryLokiRange should have been called with the search term embedded
    const lokiCalls = mockQueryLokiRange.mock.calls;
    // The error sample query should include the search term
    const sampleQuery = lokiCalls.find((c: string[]) => c[1]?.includes("high error rate"));
    expect(sampleQuery).toBeDefined();
  });

  // ── 3. Graceful degradation — missing Loki/Tempo ─────────────────

  test("gracefully degrades when Loki and Tempo datasources are missing", async () => {
    mockListDatasources.mockResolvedValue([
      { id: 1, uid: "prom-1", name: "Mimir", type: "prometheus", url: "", isDefault: true, access: "proxy" },
      // No Loki, no Tempo
    ]);

    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("2.34"))   // focus instant
      .mockResolvedValueOnce(promInstant("2.10"))   // avg_over_time
      .mockResolvedValueOnce(promInstant("0.15"))   // stddev_over_time
      .mockResolvedValueOnce(promInstant("0.5"))    // RED: rate
      .mockResolvedValueOnce(promInstant("0.005"))  // RED: error rate
      .mockResolvedValueOnce(promInstant("3.2"));   // RED: p95
    mockQueryPrometheusRange.mockResolvedValueOnce(
      promRange([[1708243800, "2.34"]]),
    );

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-3", { focus: "openclaw_lens_daily_cost_usd" });
    const parsed = JSON.parse(getTextContent(result));

    // Should NOT have log or trace signals
    expect(parsed.logSignals).toBeUndefined();
    expect(parsed.traceSignals).toBeUndefined();

    // But metric signals should still be present
    expect(parsed.metricSignals).toBeDefined();

    // Limitations should mention missing datasources
    expect(parsed.limitations).toBeDefined();
    expect(parsed.limitations.some((l: string) => l.includes("Loki"))).toBe(true);
    expect(parsed.limitations.some((l: string) => l.includes("Tempo"))).toBe(true);
  });

  // ── 4. No Prometheus datasource → error ──────────────────────────

  test("returns error when no Prometheus datasource found", async () => {
    mockListDatasources.mockResolvedValue([
      { id: 2, uid: "loki-1", name: "Loki", type: "loki", url: "", isDefault: false, access: "proxy" },
    ]);

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-4", { focus: "openclaw_lens_daily_cost_usd" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("No Prometheus datasource found");
  });

  // ── 5. Error resilience — individual queries fail ─────────────────

  test("when individual queries fail, other signals still populate", async () => {
    // Metric queries fail — but gatherMetricSignals uses internal Promise.allSettled
    // so it resolves with empty/partial data rather than rejecting.
    mockQueryPrometheus.mockRejectedValue(new Error("Prometheus timeout"));
    mockQueryPrometheusRange.mockRejectedValue(new Error("Prometheus timeout"));

    // Log queries succeed
    mockQueryLokiRange
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", "50"]])) // volume
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", "3"]], { level: "ERROR" })) // severity
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", "Error: something broke"]])); // samples

    // Trace queries succeed
    mockSearchTraces
      .mockResolvedValueOnce(tempoTraces([
        { traceID: "trace-err-1", rootServiceName: "openclaw", rootTraceName: "chat claude", durationMs: 5000 },
      ]))
      .mockResolvedValueOnce(tempoTraces([]));

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-5", { focus: "high error rate" });
    const parsed = JSON.parse(getTextContent(result));

    // Should NOT have an error at top-level — graceful degradation
    expect(parsed.error).toBeUndefined();

    // Log signals should be populated despite metric failures
    expect(parsed.logSignals).toBeDefined();

    // Trace signals should be populated despite metric failures
    expect(parsed.traceSignals).toBeDefined();
    expect(parsed.traceSignals.errorTraces).toHaveLength(1);

    // Context signals should also be present (annotations)
    expect(parsed.contextSignals).toBeDefined();

    // Metric signals still present (gatherMetricSignals uses internal allSettled,
    // so it resolves with empty RED signals rather than rejecting)
    // The RED values will be undefined since individual PromQL queries failed
    expect(parsed.metricSignals?.red?.rate).toBeUndefined();
    expect(parsed.metricSignals?.red?.errorRate).toBeUndefined();
  });

  // ── 6. Hypothesis — error rate elevated ──────────────────────────

  test("generates error-related hypothesis when error rate is high", async () => {
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("0.5"))    // RED: rate
      .mockResolvedValueOnce(promInstant("0.15"))   // RED: error rate (15% — above 1% threshold)
      .mockResolvedValueOnce(promInstant("3.2"));   // RED: p95

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-6", { focus: "high error rate" });
    const parsed = JSON.parse(getTextContent(result));

    // Should generate an error-rate hypothesis
    const errorHypothesis = parsed.suggestedHypotheses.find(
      (h: { hypothesis: string }) => h.hypothesis.includes("Error rate is elevated"),
    );
    expect(errorHypothesis).toBeDefined();
    expect(errorHypothesis.confidence).toBe("high");
    expect(errorHypothesis.testWith.tool).toBe("grafana_query_logs");
    expect(errorHypothesis.testWith.params.datasourceUid).toBe("loki-1");
  });

  // ── 7. Hypothesis — anomaly score high ───────────────────────────

  test("generates anomaly hypothesis when z-score is high", async () => {
    // Focus metric: current=10.0, avg=2.0, stddev=1.0 → z-score = 8.0 (critical)
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("10.0"))    // focus instant
      .mockResolvedValueOnce(promInstant("2.0"))     // avg_over_time
      .mockResolvedValueOnce(promInstant("1.0"))     // stddev_over_time
      .mockResolvedValueOnce(promInstant("0.5"))     // RED: rate
      .mockResolvedValueOnce(promInstant("0.001"))   // RED: error rate (low)
      .mockResolvedValueOnce(promInstant("2.0"));    // RED: p95

    mockQueryPrometheusRange.mockResolvedValueOnce(
      promRange([
        [1708157400, "2.03"],
        [1708200600, "2.10"],
        [1708243800, "10.0"],
      ]),
    );

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-7", { focus: "openclaw_lens_daily_cost_usd" });
    const parsed = JSON.parse(getTextContent(result));

    // Should have anomaly data on focus metric
    expect(parsed.metricSignals.focus.anomalyScore).toBeGreaterThanOrEqual(2);
    expect(parsed.metricSignals.focus.anomalySeverity).toBe("critical");

    // Should generate anomaly hypothesis
    const anomalyHypothesis = parsed.suggestedHypotheses.find(
      (h: { hypothesis: string }) => h.hypothesis.includes("anomaly"),
    );
    expect(anomalyHypothesis).toBeDefined();
    expect(anomalyHypothesis.confidence).toBe("high");
    expect(anomalyHypothesis.testWith.tool).toBe("grafana_explain_metric");
  });

  // ── 8. Hypothesis — error traces found ───────────────────────────

  test("generates trace hypothesis when error traces are found", async () => {
    // Set up minimal metric mocks (no focus metric queries for free-text)
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("0.5"))     // RED: rate
      .mockResolvedValueOnce(promInstant("0.001"))   // RED: error rate
      .mockResolvedValueOnce(promInstant("2.0"));    // RED: p95

    // Error traces exist
    mockSearchTraces
      .mockResolvedValueOnce(
        tempoTraces([
          { traceID: "trace-abc", rootServiceName: "openclaw", rootTraceName: "chat claude", durationMs: 15000 },
        ]),
      )
      .mockResolvedValueOnce(tempoTraces([])); // slow traces

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-8", { focus: "request failures" });
    const parsed = JSON.parse(getTextContent(result));

    // Trace signals should include error traces
    expect(parsed.traceSignals).toBeDefined();
    expect(parsed.traceSignals.errorTraces).toHaveLength(1);
    expect(parsed.traceSignals.errorTraces[0].traceId).toBe("trace-abc");
    expect(parsed.traceSignals.errorTraces[0].durationMs).toBe(15000);

    // Should generate trace hypothesis
    const traceHypothesis = parsed.suggestedHypotheses.find(
      (h: { hypothesis: string }) => h.hypothesis.includes("request paths are failing"),
    );
    expect(traceHypothesis).toBeDefined();
    expect(traceHypothesis.confidence).toBe("high");
    expect(traceHypothesis.testWith.tool).toBe("grafana_query_traces");
    expect(traceHypothesis.testWith.params.traceId).toBe("trace-abc");
    expect(traceHypothesis.testWith.params.datasourceUid).toBe("tempo-1");
  });

  // ── 9. Context signals — annotations + active alerts ─────────────

  test("includes annotations and active alerts in context signals", async () => {
    // Add an active alert to the store
    store.addAlert(makeNotification());

    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("0.5"))     // RED: rate
      .mockResolvedValueOnce(promInstant("0.001"))   // RED: error rate
      .mockResolvedValueOnce(promInstant("2.0"));    // RED: p95

    mockGetAnnotations.mockResolvedValue([
      {
        id: 1,
        dashboardUID: "d1",
        panelId: 1,
        time: 1708243800000,
        timeEnd: 0,
        tags: ["deploy"],
        text: "Deployed v2",
        created: 1708243800,
        updated: 1708243800,
      },
    ]);

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-9", { focus: "why are errors increasing" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.contextSignals).toBeDefined();

    // Annotations
    expect(parsed.contextSignals.recentAnnotations).toBeDefined();
    expect(parsed.contextSignals.recentAnnotations.length).toBeGreaterThan(0);
    expect(parsed.contextSignals.recentAnnotations[0].text).toBe("Deployed v2");
    expect(parsed.contextSignals.recentAnnotations[0].tags).toEqual(["deploy"]);

    // Active alerts
    expect(parsed.contextSignals.alertsActive).toBeDefined();
    expect(parsed.contextSignals.alertsActive.length).toBeGreaterThan(0);
    expect(parsed.contextSignals.alertsActive[0].status).toBe("firing");
  });

  // ── 10. Time window validation ───────────────────────────────────

  test("invalid time window returns error", async () => {
    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-10", {
      focus: "openclaw_lens_daily_cost_usd",
      timeWindow: "30m",
    });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("Invalid timeWindow");
    expect(parsed.error).toContain("30m");

    // No queries should have been executed
    expect(mockQueryPrometheus).not.toHaveBeenCalled();
    expect(mockQueryLokiRange).not.toHaveBeenCalled();
    expect(mockSearchTraces).not.toHaveBeenCalled();
  });

  // ── Additional coverage ──────────────────────────────────────────

  test("valid time windows are accepted (6h, 24h)", async () => {
    mockQueryPrometheus.mockResolvedValue(promInstant("1.0"));
    mockQueryPrometheusRange.mockResolvedValue(promRange([[1708243800, "1.0"]]));

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);

    for (const tw of ["1h", "6h", "24h"]) {
      mockQueryPrometheus.mockClear();
      mockQueryPrometheusRange.mockClear();
      mockQueryLokiRange.mockClear();
      mockSearchTraces.mockClear();
      mockGetAnnotations.mockClear();

      mockQueryPrometheus.mockResolvedValue(promInstant("1.0"));
      mockQueryPrometheusRange.mockResolvedValue(promRange([[1708243800, "1.0"]]));
      mockQueryLokiRange.mockResolvedValue(lokiEmpty());
      mockSearchTraces.mockResolvedValue(tempoTraces([]));
      mockGetAnnotations.mockResolvedValue([]);

      const res = await tool!.execute(`call-tw-${tw}`, {
        focus: "openclaw_lens_daily_cost_usd",
        timeWindow: tw,
      });
      const parsed = JSON.parse(getTextContent(res));
      expect(parsed.error).toBeUndefined();
      expect(parsed.timeWindow.duration).toBe(tw);
    }
  });

  test("default time window is 1h when not provided", async () => {
    mockQueryPrometheus.mockResolvedValue(promInstant("1.0"));
    mockQueryPrometheusRange.mockResolvedValue(promRange([[1708243800, "1.0"]]));

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-default-tw", { focus: "openclaw_lens_daily_cost_usd" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.timeWindow.duration).toBe("1h");
  });

  test("generates fallback hypothesis when no anomalies detected", async () => {
    // All values normal — no anomalies
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("2.0"))     // focus instant
      .mockResolvedValueOnce(promInstant("2.0"))     // avg (same as current — no anomaly)
      .mockResolvedValueOnce(promInstant("0.1"))     // stddev
      .mockResolvedValueOnce(promInstant("0.5"))     // RED: rate
      .mockResolvedValueOnce(promInstant("0.001"))   // RED: error rate (very low)
      .mockResolvedValueOnce(promInstant("2.0"));    // RED: p95 (< 10s)

    mockQueryPrometheusRange.mockResolvedValueOnce(
      promRange([[1708243800, "2.0"]]),
    );

    // No traces, no annotations, no alerts
    mockSearchTraces.mockResolvedValue(tempoTraces([]));
    mockGetAnnotations.mockResolvedValue([]);

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-fallback", { focus: "openclaw_lens_daily_cost_usd" });
    const parsed = JSON.parse(getTextContent(result));

    // Should have a fallback hypothesis
    expect(parsed.suggestedHypotheses.length).toBeGreaterThan(0);
    const fallback = parsed.suggestedHypotheses.find(
      (h: { hypothesis: string }) => h.hypothesis.includes("No clear anomaly"),
    );
    expect(fallback).toBeDefined();
    expect(fallback.confidence).toBe("low");
    expect(fallback.testWith.tool).toBe("grafana_explain_metric");
  });

  test("response includes proper timeWindow from/to fields", async () => {
    mockQueryPrometheus.mockResolvedValue(promInstant("1.0"));
    mockQueryPrometheusRange.mockResolvedValue(promRange([[1708243800, "1.0"]]));

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-tw-fields", { focus: "openclaw_lens_daily_cost_usd" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.timeWindow.from).toBeDefined();
    expect(parsed.timeWindow.to).toBeDefined();
    // ISO date strings
    expect(new Date(parsed.timeWindow.from).toISOString()).toBe(parsed.timeWindow.from);
    expect(new Date(parsed.timeWindow.to).toISOString()).toBe(parsed.timeWindow.to);
  });

  test("each hypothesis has required shape: hypothesis, evidence, confidence, testWith", async () => {
    // Trigger multiple hypotheses: high error rate + error traces
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("0.5"))     // RED: rate
      .mockResolvedValueOnce(promInstant("0.10"))    // RED: error rate (high)
      .mockResolvedValueOnce(promInstant("2.0"));    // RED: p95

    mockSearchTraces
      .mockResolvedValueOnce(
        tempoTraces([
          { traceID: "trace-1", rootServiceName: "openclaw", rootTraceName: "chat", durationMs: 5000 },
        ]),
      )
      .mockResolvedValueOnce(tempoTraces([]));

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-shape", { focus: "error investigation" });
    const parsed = JSON.parse(getTextContent(result));

    for (const h of parsed.suggestedHypotheses) {
      expect(h.hypothesis).toEqual(expect.any(String));
      expect(h.evidence).toEqual(expect.any(String));
      expect(["low", "medium", "high"]).toContain(h.confidence);
      expect(h.testWith).toBeDefined();
      expect(h.testWith.tool).toEqual(expect.any(String));
      expect(h.testWith.params).toBeDefined();
    }
  });

  test("log signals include error samples with truncated lines", async () => {
    const longLine = "E".repeat(300); // Longer than 200 char limit
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("0.5"))
      .mockResolvedValueOnce(promInstant("0.001"))
      .mockResolvedValueOnce(promInstant("2.0"));

    mockQueryLokiRange
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", "100"]])) // volume
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", "5"]], { level: "ERROR" })) // severity
      .mockResolvedValueOnce(lokiResult([["1708243800000000000", longLine]])); // samples

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-truncate", { focus: "some error" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.logSignals).toBeDefined();
    expect(parsed.logSignals.sampleErrors.length).toBeGreaterThan(0);
    // Line should be truncated to ~200 chars
    expect(parsed.logSignals.sampleErrors[0].line.length).toBeLessThanOrEqual(210);
  });

  test("service parameter filters log and trace queries", async () => {
    mockQueryPrometheus
      .mockResolvedValueOnce(promInstant("0.5"))
      .mockResolvedValueOnce(promInstant("0.001"))
      .mockResolvedValueOnce(promInstant("2.0"));

    mockQueryLokiRange.mockResolvedValue(lokiEmpty());
    mockSearchTraces.mockResolvedValue(tempoTraces([]));

    const tool = createInvestigateToolFactory(makeRegistry(), store)({} as never);
    await tool!.execute("call-service", {
      focus: "some issue",
      service: "my-api",
    });

    // Loki queries should use the custom service name
    const lokiCalls = mockQueryLokiRange.mock.calls;
    const hasServiceFilter = lokiCalls.some((c: string[]) => c[1]?.includes('service_name="my-api"'));
    expect(hasServiceFilter).toBe(true);

    // Trace queries should use the custom service name
    const traceCalls = mockSearchTraces.mock.calls;
    const hasTraceServiceFilter = traceCalls.some((c: string[]) => c[1]?.includes('resource.service.name = "my-api"'));
    expect(hasTraceServiceFilter).toBe(true);
  });
});
