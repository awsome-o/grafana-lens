import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const getDashboardMock = vi.hoisted(() => vi.fn());
const dashboardUrlMock = vi.hoisted(() => vi.fn((uid: string) => `http://localhost:3000/d/${uid}`));
const listDatasourcesMock = vi.hoisted(() => vi.fn());
const queryPrometheusMock = vi.hoisted(() => vi.fn());
const queryLokiMock = vi.hoisted(() => vi.fn());
const queryLokiRangeMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    getDashboard = getDashboardMock;
    dashboardUrl = dashboardUrlMock;
    listDatasources = listDatasourcesMock;
    queryPrometheus = queryPrometheusMock;
    queryLoki = queryLokiMock;
    queryLokiRange = queryLokiRangeMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createGetDashboardToolFactory } from "./get-dashboard.js";
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

const MOCK_DATASOURCES = [
  { id: 1, uid: "prom-1", name: "Prometheus", type: "prometheus", url: "", isDefault: true, access: "proxy" },
  { id: 2, uid: "loki-1", name: "Loki", type: "loki", url: "", isDefault: false, access: "proxy" },
];

describe("grafana_get_dashboard tool", () => {
  beforeEach(() => {
    getDashboardMock.mockReset();
    dashboardUrlMock.mockClear();
    listDatasourcesMock.mockReset();
    queryPrometheusMock.mockReset();
    queryLokiMock.mockReset();
    queryLokiRangeMock.mockReset();
  });

  test("returns compact dashboard summary", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-1",
        title: "Agent Overview",
        tags: ["agent"],
        panels: [
          {
            id: 1,
            title: "Token Usage",
            type: "timeseries",
            targets: [{ refId: "A", expr: "rate(openclaw_lens_tokens_total[5m])" }],
          },
          {
            id: 2,
            title: "Cost",
            type: "stat",
            targets: [{ refId: "A", expr: "openclaw_lens_daily_cost_usd" }],
          },
        ],
      },
      meta: {
        folderUid: "folder-1",
        created: "2026-01-01",
        updated: "2026-01-15",
      },
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", { uid: "dash-1" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.title).toBe("Agent Overview");
    expect(parsed.panelCount).toBe(2);
    expect(parsed.panels[0].id).toBe(1);
    expect(parsed.panels[0].type).toBe("timeseries");
    expect(parsed.panels[0].queries[0].expr).toContain("tokens_total");
    expect(parsed.url).toContain("/d/dash-1");
  });

  test("handles dashboard with no targets", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-2",
        title: "Empty",
        tags: [],
        panels: [{ id: 1, title: "Text", type: "text" }],
      },
      meta: {},
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-2", { uid: "dash-2" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.panels[0].queries).toEqual([]);
  });

  test("compact mode returns titles and types only — no queries or metadata", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-c",
        title: "Session Explorer",
        description: "Deep dive into sessions",
        tags: ["agent", "sessions"],
        time: { from: "now-6h", to: "now" },
        refresh: "30s",
        panels: [
          {
            id: 1,
            title: "Active Sessions",
            type: "stat",
            targets: [{ refId: "A", expr: "openclaw_lens_sessions_active" }],
          },
          {
            id: 2,
            title: "Session Duration",
            type: "timeseries",
            targets: [{ refId: "A", expr: "histogram_quantile(0.95, rate(openclaw_run_duration_ms_milliseconds_bucket[5m]))" }],
          },
          {
            id: 3,
            title: "Cost Over Time",
            type: "timeseries",
            targets: [
              { refId: "A", expr: "sum(rate(openclaw_lens_cost_by_token_type[5m])) by (model)" },
              { refId: "B", expr: "openclaw_lens_daily_cost_usd" },
            ],
          },
        ],
      },
      meta: {
        folderUid: "folder-1",
        created: "2026-01-01",
        updated: "2026-01-15",
      },
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-c1", { uid: "dash-c", compact: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.uid).toBe("dash-c");
    expect(parsed.title).toBe("Session Explorer");
    expect(parsed.panelCount).toBe(3);
    expect(parsed.tags).toEqual(["agent", "sessions"]);
    expect(parsed.url).toContain("/d/dash-c");

    // Compact panels: id, title, type only
    expect(parsed.panels).toEqual([
      { id: 1, title: "Active Sessions", type: "stat" },
      { id: 2, title: "Session Duration", type: "timeseries" },
      { id: 3, title: "Cost Over Time", type: "timeseries" },
    ]);

    // No queries, description, time, refresh, folder, or timestamps
    expect(parsed.panels[0]).not.toHaveProperty("queries");
    expect(parsed).not.toHaveProperty("description");
    expect(parsed).not.toHaveProperty("time");
    expect(parsed).not.toHaveProperty("refresh");
    expect(parsed).not.toHaveProperty("folderUid");
    expect(parsed).not.toHaveProperty("created");
    expect(parsed).not.toHaveProperty("updated");
  });

  test("compact mode response is significantly smaller than full response", async () => {
    const dashboardData = {
      dashboard: {
        uid: "dash-size",
        title: "Size Test",
        description: "Dashboard for measuring response sizes",
        tags: ["test"],
        time: { from: "now-24h", to: "now" },
        refresh: "1m",
        panels: Array.from({ length: 20 }, (_, i) => ({
          id: i + 1,
          title: `Panel ${i + 1}`,
          type: "timeseries",
          targets: [{ refId: "A", expr: `rate(some_long_metric_name_${i}[5m]) / on(instance) group_left(job) up{job="test"}` }],
        })),
      },
      meta: { folderUid: "f1", created: "2026-01-01", updated: "2026-02-01" },
    };

    // Full response
    getDashboardMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(dashboardData)));
    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const fullResult = await tool!.execute("call-full", { uid: "dash-size" });
    const fullText = getTextContent(fullResult);

    // Compact response
    getDashboardMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(dashboardData)));
    const compactResult = await tool!.execute("call-compact", { uid: "dash-size", compact: true });
    const compactText = getTextContent(compactResult);

    // Compact should be at least 50% smaller
    const savings = 1 - compactText.length / fullText.length;
    expect(savings).toBeGreaterThan(0.5);
  });

  test("compact=false returns full response (backward compatible)", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-compat",
        title: "Compat Test",
        description: "Test backward compatibility",
        tags: [],
        time: { from: "now-6h", to: "now" },
        refresh: "30s",
        panels: [
          {
            id: 1,
            title: "Panel 1",
            type: "stat",
            targets: [{ refId: "A", expr: "up" }],
          },
        ],
      },
      meta: { folderUid: "f1", created: "2026-01-01", updated: "2026-02-01" },
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-compat", { uid: "dash-compat", compact: false });

    const parsed = JSON.parse(getTextContent(result));
    // Full response includes queries and metadata
    expect(parsed.panels[0].queries).toEqual([{ refId: "A", expr: "up" }]);
    expect(parsed.description).toBe("Test backward compatibility");
    expect(parsed.time).toEqual({ from: "now-6h", to: "now" });
    expect(parsed.refresh).toBe("30s");
    expect(parsed.folderUid).toBe("f1");
    expect(parsed.created).toBe("2026-01-01");
    expect(parsed.updated).toBe("2026-02-01");
  });

  test("default (no compact param) returns full response", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-def",
        title: "Default Test",
        tags: [],
        panels: [
          {
            id: 1,
            title: "P1",
            type: "timeseries",
            targets: [{ refId: "A", expr: "rate(http_requests_total[5m])" }],
          },
        ],
      },
      meta: {},
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-def", { uid: "dash-def" });

    const parsed = JSON.parse(getTextContent(result));
    // Should include queries (full mode is default)
    expect(parsed.panels[0].queries).toEqual([{ refId: "A", expr: "rate(http_requests_total[5m])" }]);
  });

  test("API error caught gracefully", async () => {
    getDashboardMock.mockRejectedValueOnce(new Error("Not found: get dashboard by uid bad-uid"));

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-3", { uid: "bad-uid" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to get dashboard");
  });

  // ── Audit mode tests ────────────────────────────────────────────────

  test("audit mode — panels with data return ok + sampleValue", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-audit",
        title: "Audit Test",
        tags: [],
        panels: [
          {
            id: 1,
            title: "Active Sessions",
            type: "stat",
            datasource: { type: "prometheus", uid: "$prometheus" },
            targets: [{ refId: "A", expr: "openclaw_lens_sessions_active" }],
          },
          {
            id: 2,
            title: "Daily Cost",
            type: "stat",
            datasource: { type: "prometheus", uid: "$prometheus" },
            targets: [{ refId: "A", expr: "openclaw_lens_daily_cost_usd" }],
          },
        ],
      },
      meta: {},
    });

    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);
    queryPrometheusMock
      .mockResolvedValueOnce({ data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "42"] }] } })
      .mockResolvedValueOnce({ data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "3.14"] }] } });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-audit", { uid: "dash-audit", audit: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.panels[0].health).toEqual({ status: "ok", sampleValue: 42 });
    expect(parsed.panels[1].health).toEqual({ status: "ok", sampleValue: 3.14 });
    expect(parsed.auditSummary).toEqual({ ok: 2, nodata: 0, error: 0, skipped: 0 });
  });

  test("audit mode — empty result returns nodata", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-nodata",
        title: "Nodata Test",
        tags: [],
        panels: [
          {
            id: 1,
            title: "Missing Metric",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom-1" },
            targets: [{ refId: "A", expr: "nonexistent_metric" }],
          },
        ],
      },
      meta: {},
    });

    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);
    queryPrometheusMock.mockResolvedValueOnce({ data: { resultType: "vector", result: [] } });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-nodata", { uid: "dash-nodata", audit: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.panels[0].health).toEqual({ status: "nodata" });
    expect(parsed.auditSummary).toEqual({ ok: 0, nodata: 1, error: 0, skipped: 0 });
  });

  test("audit mode — query error returns error with message", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-err",
        title: "Error Test",
        tags: [],
        panels: [
          {
            id: 1,
            title: "Bad Query",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "prom-1" },
            targets: [{ refId: "A", expr: "rate(bad_syntax[" }],
          },
        ],
      },
      meta: {},
    });

    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);
    queryPrometheusMock.mockRejectedValueOnce(new Error("parse error: unexpected end of input"));

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-err", { uid: "dash-err", audit: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.panels[0].health.status).toBe("error");
    expect(parsed.panels[0].health.error).toContain("parse error");
    expect(parsed.auditSummary).toEqual({ ok: 0, nodata: 0, error: 1, skipped: 0 });
  });

  test("audit mode — row panels (no queries) are skipped", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-row",
        title: "Row Test",
        tags: [],
        panels: [
          { id: 1, title: "Section Header", type: "row" },
          {
            id: 2,
            title: "Active Metric",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom-1" },
            targets: [{ refId: "A", expr: "up" }],
          },
        ],
      },
      meta: {},
    });

    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);
    queryPrometheusMock.mockResolvedValueOnce({
      data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "1"] }] },
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-row", { uid: "dash-row", audit: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.panels[0].health).toEqual({ status: "skipped" });
    expect(parsed.panels[1].health).toEqual({ status: "ok", sampleValue: 1 });
    expect(parsed.auditSummary).toEqual({ ok: 1, nodata: 0, error: 0, skipped: 1 });
  });

  test("audit mode — resolves template variable datasources", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-tpl",
        title: "Template Var Test",
        tags: [],
        panels: [
          {
            id: 1,
            title: "Prometheus Panel",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "$prometheus" },
            targets: [{ refId: "A", expr: "sum(rate(openclaw_lens_tokens_total{provider=~\"$provider\"}[5m]))" }],
          },
          {
            id: 2,
            title: "Loki Panel",
            type: "logs",
            datasource: { type: "loki", uid: "$loki" },
            targets: [{ refId: "A", expr: "{service_name=\"openclaw\"} |= \"error\"" }],
          },
        ],
      },
      meta: {},
    });

    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);
    // Prometheus query should use resolved UID "prom-1"
    queryPrometheusMock.mockResolvedValueOnce({
      data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "100"] }] },
    });
    // Loki query should use resolved UID "loki-1" via queryLokiRange (not instant)
    queryLokiRangeMock.mockResolvedValueOnce({
      data: { resultType: "streams", result: [{ stream: {}, values: [["1700000000000000000", "error line"]] }] },
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-tpl", { uid: "dash-tpl", audit: true });

    const parsed = JSON.parse(getTextContent(result));
    // Verify prometheus was called with resolved UID and sanitized expr
    expect(queryPrometheusMock).toHaveBeenCalledWith("prom-1", expect.stringContaining(".*"));
    expect(queryLokiRangeMock).toHaveBeenCalledWith("loki-1", expect.any(String), "now-1h", "now", { limit: 1 });

    expect(parsed.panels[0].health.status).toBe("ok");
    expect(parsed.panels[1].health.status).toBe("ok");
    expect(parsed.auditSummary).toEqual({ ok: 2, nodata: 0, error: 0, skipped: 0 });
  });

  test("audit mode — mixed health statuses in summary", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-mix",
        title: "Mixed Health",
        tags: [],
        panels: [
          { id: 1, title: "Row", type: "row" },
          {
            id: 2,
            title: "Working",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom-1" },
            targets: [{ refId: "A", expr: "up" }],
          },
          {
            id: 3,
            title: "Empty",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom-1" },
            targets: [{ refId: "A", expr: "nonexistent" }],
          },
          {
            id: 4,
            title: "Broken",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "prom-1" },
            targets: [{ refId: "A", expr: "bad(" }],
          },
        ],
      },
      meta: {},
    });

    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);
    queryPrometheusMock
      .mockResolvedValueOnce({ data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "1"] }] } })
      .mockResolvedValueOnce({ data: { resultType: "vector", result: [] } })
      .mockRejectedValueOnce(new Error("parse error"));

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-mix", { uid: "dash-mix", audit: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.auditSummary).toEqual({ ok: 1, nodata: 1, error: 1, skipped: 1 });
  });

  test("audit=false does not add health fields", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-noaudit",
        title: "No Audit",
        tags: [],
        panels: [
          {
            id: 1,
            title: "P1",
            type: "stat",
            datasource: { type: "prometheus", uid: "prom-1" },
            targets: [{ refId: "A", expr: "up" }],
          },
        ],
      },
      meta: {},
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-noaudit", { uid: "dash-noaudit", audit: false });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.panels[0]).not.toHaveProperty("health");
    expect(parsed).not.toHaveProperty("auditSummary");
    // Should NOT have called listDatasources
    expect(listDatasourcesMock).not.toHaveBeenCalled();
  });

  test("audit mode — unresolvable datasource skips panel", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-unresolvable",
        title: "Unresolvable DS",
        tags: [],
        panels: [
          {
            id: 1,
            title: "Unknown DS",
            type: "stat",
            datasource: { type: "elasticsearch", uid: "$elasticsearch" },
            targets: [{ refId: "A", expr: "some_query" }],
          },
        ],
      },
      meta: {},
    });

    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES); // No elasticsearch

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-unresolvable", { uid: "dash-unresolvable", audit: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.panels[0].health.status).toBe("skipped");
    expect(parsed.panels[0].health.error).toContain("Could not resolve datasource");
  });

  test("audit mode — panel without datasource field resolves to default", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "dash-default-ds",
        title: "Default DS Test",
        tags: [],
        panels: [
          {
            id: 1,
            title: "Uptime",
            type: "timeseries",
            // No datasource field — Grafana resolves to default
            targets: [{ refId: "A", expr: "up" }],
          },
        ],
      },
      meta: {},
    });

    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);
    queryPrometheusMock.mockResolvedValueOnce({
      data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "1"] }] },
    });

    const tool = createGetDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-default-ds", { uid: "dash-default-ds", audit: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.panels[0].health).toEqual({ status: "ok", sampleValue: 1 });
    expect(parsed.auditSummary).toEqual({ ok: 1, nodata: 0, error: 0, skipped: 0 });
    // Should have queried with the default datasource UID
    expect(queryPrometheusMock).toHaveBeenCalledWith("prom-1", "up");
  });
});
