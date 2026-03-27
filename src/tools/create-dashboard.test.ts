import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const createDashboardMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    id: 1,
    uid: "abc123",
    url: "/d/abc123",
    status: "success",
    version: 1,
  }),
);

const dashboardUrlMock = vi.hoisted(() =>
  vi.fn((uid: string) => `http://localhost:3000/d/${uid}`),
);

const queryPrometheusMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    createDashboard = createDashboardMock;
    dashboardUrl = dashboardUrlMock;
    queryPrometheus = queryPrometheusMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createDashboardToolFactory, validateDashboardPanels } from "./create-dashboard.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { GrafanaClientRegistry } from "../grafana-client-registry.js";
import { GrafanaClient } from "../grafana-client.js";

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

describe("grafana_create_dashboard tool", () => {
  beforeEach(() => {
    createDashboardMock.mockClear();
    dashboardUrlMock.mockClear();
    queryPrometheusMock.mockReset();
    createDashboardMock.mockResolvedValue({
      id: 1,
      uid: "abc123",
      url: "/d/abc123",
      status: "success",
      version: 1,
    });
  });

  test("template 'llm-command-center' creates dashboard with correct title", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-1", { template: "llm-command-center" });

    expect(createDashboardMock).toHaveBeenCalledTimes(1);
    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("LLM Command Center");
    expect(callArgs.overwrite).toBe(true);

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.uid).toBe("abc123");
    expect(parsed.url).toContain("/d/abc123");
  });

  test("template 'session-explorer' creates dashboard with session variable", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-se", { template: "session-explorer" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("Session Explorer");
    expect(callArgs.dashboard.templating).toBeDefined();
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    const varNames = vars.map((v: { name: string }) => v.name);
    expect(varNames).toContain("session");
    expect(varNames).toContain("loki");
    expect(varNames).toContain("tempo");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.uid).toBe("abc123");
  });

  test("template 'cost-intelligence' creates dashboard with provider/model variables", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-ci", { template: "cost-intelligence" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("Cost Intelligence");
    expect(callArgs.dashboard.time.from).toBe("now-7d");
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    const varNames = vars.map((v: { name: string }) => v.name);
    expect(varNames).toContain("provider");
    expect(varNames).toContain("model");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
  });

  test("template 'tool-performance' creates dashboard with tool variable", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-tp", { template: "tool-performance" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("Tool Performance");
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    const varNames = vars.map((v: { name: string }) => v.name);
    expect(varNames).toContain("tool");
    expect(varNames).toContain("tempo");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.uid).toBe("abc123");
  });

  test("custom dashboard JSON passthrough", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = { title: "My Custom Dashboard", panels: [] };
    const result = await tool!.execute("call-2", { dashboard: customDash });

    expect(createDashboardMock).toHaveBeenCalledTimes(1);
    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("My Custom Dashboard");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
  });

  test("unknown template returns error via jsonResult", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-3", { template: "nonexistent" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Unknown template 'nonexistent'");
    expect(parsed.error).toContain("llm-command-center");
  });

  test("template 'node-exporter' creates dashboard with variables", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-ne", { template: "node-exporter" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("System Health (Node Exporter)");
    expect(callArgs.dashboard.templating).toBeDefined();
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    expect(vars.map((v: { name: string }) => v.name)).toContain("datasource");
    expect(vars.map((v: { name: string }) => v.name)).toContain("instance");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.uid).toBe("abc123");
  });

  test("template 'http-service' creates dashboard with job variable", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-hs", { template: "http-service" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("HTTP Service Health");
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    expect(vars.map((v: { name: string }) => v.name)).toContain("job");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
  });

  test("template 'metric-explorer' creates dashboard with metric variable", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-me", { template: "metric-explorer" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("Metric Explorer");
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    expect(vars.map((v: { name: string }) => v.name)).toContain("metric");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.uid).toBe("abc123");
  });

  test("template 'multi-kpi' creates dashboard with 4 metric variables", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-mk", { template: "multi-kpi" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("Multi-KPI Overview");
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    const varNames = vars.map((v: { name: string }) => v.name);
    expect(varNames).toContain("metric1");
    expect(varNames).toContain("metric2");
    expect(varNames).toContain("metric3");
    expect(varNames).toContain("metric4");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
  });

  test("template 'weekly-review' creates dashboard with metric1 and metric2 variables", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-wr", { template: "weekly-review" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("Weekly Review");
    expect(callArgs.dashboard.time.from).toBe("now-7d");
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    const varNames = vars.map((v: { name: string }) => v.name);
    expect(varNames).toContain("datasource");
    expect(varNames).toContain("metric1");
    expect(varNames).toContain("metric2");

    // Should have a table panel for all openclaw_ext_* metrics
    const panels = callArgs.dashboard.panels as Array<{ type: string; title: string }>;
    const tablePanel = panels.find((p) => p.type === "table");
    expect(tablePanel).toBeDefined();
    expect(tablePanel!.title).toContain("Custom Metrics");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.uid).toBe("abc123");
  });

  test("template 'sre-operations' creates dashboard with SRE health panels", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-sre", { template: "sre-operations" });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.title).toBe("SRE Operations");
    const vars = (callArgs.dashboard.templating as { list: Array<{ name: string }> }).list;
    const varNames = vars.map((v: { name: string }) => v.name);
    expect(varNames).toContain("prometheus");
    expect(varNames).toContain("loki");

    // Should have SRE-specific tags
    const tags = callArgs.dashboard.tags as string[];
    expect(tags).toContain("sre-operations");
    expect(tags).toContain("openclaw");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.uid).toBe("abc123");
    expect(parsed.status).toBe("success");
  });

  test("AI templates get stable UIDs assigned", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    // Test each AI template gets its stable UID
    const aiTemplates: Record<string, string> = {
      "llm-command-center": "openclaw-command-center",
      "session-explorer": "openclaw-session-explorer",
      "cost-intelligence": "openclaw-cost-intelligence",
      "tool-performance": "openclaw-tool-performance",
      "sre-operations": "openclaw-sre-operations",
    };

    for (const [template, expectedUid] of Object.entries(aiTemplates)) {
      createDashboardMock.mockClear();
      await tool!.execute(`call-${template}`, { template });
      const callArgs = createDashboardMock.mock.calls[0][0];
      expect(callArgs.dashboard.uid).toBe(expectedUid);
    }
  });

  test("non-AI templates do not get stable UIDs", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    // Generic templates should NOT have a uid set
    const genericTemplates = ["node-exporter", "http-service", "metric-explorer", "multi-kpi", "weekly-review"];

    for (const template of genericTemplates) {
      createDashboardMock.mockClear();
      await tool!.execute(`call-${template}`, { template });
      const callArgs = createDashboardMock.mock.calls[0][0];
      expect(callArgs.dashboard.uid).toBeUndefined();
    }
  });

  test("custom dashboard JSON does not get stable UID", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = { title: "My Custom", panels: [] };
    await tool!.execute("call-custom", { dashboard: customDash });

    const callArgs = createDashboardMock.mock.calls[0][0];
    expect(callArgs.dashboard.uid).toBeUndefined();
  });

  // ── suggestedNext template chaining tests ─────────────────────────

  test("AI template response includes suggestedNext with complementary templates", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-chain-1", { template: "llm-command-center" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.suggestedNext).toBeDefined();
    expect(parsed.suggestedNext).toHaveLength(3);
    const names = parsed.suggestedNext.map((s: { template: string }) => s.template);
    expect(names).toContain("session-explorer");
    expect(names).toContain("cost-intelligence");
    expect(names).toContain("sre-operations");
    // Each suggestion has a reason
    for (const suggestion of parsed.suggestedNext) {
      expect(suggestion.reason).toBeTruthy();
    }
  });

  test("session-explorer suggests cost-intelligence and tool-performance", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-chain-2", { template: "session-explorer" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.suggestedNext).toHaveLength(2);
    const names = parsed.suggestedNext.map((s: { template: string }) => s.template);
    expect(names).toContain("cost-intelligence");
    expect(names).toContain("tool-performance");
  });

  test("generic template also includes suggestedNext", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-chain-3", { template: "node-exporter" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.suggestedNext).toHaveLength(1);
    expect(parsed.suggestedNext[0].template).toBe("http-service");
  });

  test("custom dashboard JSON does not include suggestedNext", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = { title: "My Custom", panels: [] };
    const result = await tool!.execute("call-chain-4", { dashboard: customDash });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.suggestedNext).toBeUndefined();
  });

  test("all templates have suggestedNext entries", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const allTemplates = [
      "llm-command-center", "session-explorer", "cost-intelligence",
      "tool-performance", "sre-operations", "genai-observability",
      "node-exporter", "http-service", "metric-explorer", "multi-kpi", "weekly-review",
    ];

    for (const template of allTemplates) {
      createDashboardMock.mockClear();
      createDashboardMock.mockResolvedValue({
        id: 1, uid: "abc123", url: "/d/abc123", status: "success", version: 1,
      });
      const result = await tool!.execute(`call-all-${template}`, { template });
      const parsed = JSON.parse(getTextContent(result));
      expect(parsed.suggestedNext, `${template} should have suggestedNext`).toBeDefined();
      expect(parsed.suggestedNext.length, `${template} should have at least 1 suggestion`).toBeGreaterThanOrEqual(1);
    }
  });

  test("custom dashboard panels without IDs get auto-assigned sequential IDs", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = {
      title: "No Panel IDs",
      panels: [
        { title: "Panel A", type: "stat", targets: [] },
        { title: "Panel B", type: "timeseries", targets: [] },
        { title: "Panel C", type: "gauge", targets: [] },
      ],
    };

    await tool!.execute("call-auto-id", { dashboard: customDash });

    const callArgs = createDashboardMock.mock.calls[0][0];
    const panels = callArgs.dashboard.panels as Array<{ id: number; title: string }>;
    expect(panels[0].id).toBe(1);
    expect(panels[1].id).toBe(2);
    expect(panels[2].id).toBe(3);
  });

  test("custom dashboard panels with existing IDs are preserved and gaps filled", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = {
      title: "Mixed IDs",
      panels: [
        { id: 5, title: "Has ID", type: "stat", targets: [] },
        { title: "No ID", type: "timeseries", targets: [] },
      ],
    };

    await tool!.execute("call-mixed-id", { dashboard: customDash });

    const callArgs = createDashboardMock.mock.calls[0][0];
    const panels = callArgs.dashboard.panels as Array<{ id: number; title: string }>;
    expect(panels[0].id).toBe(5); // Preserved
    expect(panels[1].id).toBe(6); // Auto-assigned after max(5)
  });

  test("API error caught and returned gracefully", async () => {
    createDashboardMock.mockRejectedValueOnce(
      new Error("Grafana API error 500: internal server error"),
    );

    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-4", { template: "llm-command-center" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to create dashboard");
    expect(parsed.error).toContain("500");
  });

  // ── Custom dashboard validation tests ─────────────────────────────

  test("custom dashboard with valid PromQL includes validation with ok status", async () => {
    queryPrometheusMock.mockResolvedValue({
      status: "success",
      data: { resultType: "vector", result: [{ metric: {}, value: [0, "42"] }] },
    });

    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = {
      title: "Model Comparison",
      panels: [{
        id: 1, title: "Cost per Token", type: "timeseries",
        targets: [{ refId: "A", expr: "sum(rate(cost[1h]))", datasource: { uid: "prometheus" } }],
      }],
    };

    const result = await tool!.execute("call-v1", { dashboard: customDash });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.uid).toBe("abc123");
    expect(parsed.validation).toBeDefined();
    expect(parsed.validation.panelsTotal).toBe(1);
    expect(parsed.validation.panelsValid).toBe(1);
    expect(parsed.validation.panelsError).toBe(0);
    expect(parsed.validation.details[0].status).toBe("ok");
    expect(parsed.validation.details[0].queries[0].sampleValue).toBe(42);
  });

  test("custom dashboard with invalid PromQL shows error in validation", async () => {
    queryPrometheusMock.mockRejectedValue(
      new Error("parse error at line 1, char 5: unexpected character"),
    );

    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = {
      title: "Bad Dashboard",
      panels: [{
        id: 1, title: "Bad Panel", type: "timeseries",
        targets: [{ refId: "A", expr: "not valid!!!", datasource: { uid: "prometheus" } }],
      }],
    };

    const result = await tool!.execute("call-v2", { dashboard: customDash });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.uid).toBe("abc123"); // Dashboard was still created
    expect(parsed.validation.panelsError).toBe(1);
    expect(parsed.validation.details[0].status).toBe("error");
    expect(parsed.validation.details[0].error).toContain("parse error");
  });

  test("template dashboard does not include validation", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const result = await tool!.execute("call-v3", { template: "llm-command-center" });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.validation).toBeUndefined();
    expect(queryPrometheusMock).not.toHaveBeenCalled();
  });

  test("custom dashboard with no targets omits validation", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = {
      title: "Text Only",
      panels: [{ id: 1, title: "Instructions", type: "text", options: { content: "Hello" } }],
    };

    const result = await tool!.execute("call-v4", { dashboard: customDash });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.uid).toBe("abc123");
    expect(parsed.validation).toBeUndefined(); // No query panels → no details → omitted
  });

  test("custom dashboard with mixed valid/invalid queries shows per-panel status", async () => {
    queryPrometheusMock
      .mockResolvedValueOnce({
        status: "success",
        data: { resultType: "vector", result: [{ metric: {}, value: [0, "42"] }] },
      })
      .mockRejectedValueOnce(new Error("parse error at char 5"));

    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = {
      title: "Mixed Dashboard",
      panels: [
        { id: 1, title: "Good Panel", type: "timeseries", targets: [{ refId: "A", expr: "up", datasource: { uid: "prom" } }] },
        { id: 2, title: "Bad Panel", type: "timeseries", targets: [{ refId: "A", expr: "invalid!!!", datasource: { uid: "prom" } }] },
      ],
    };

    const result = await tool!.execute("call-v5", { dashboard: customDash });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.validation.panelsTotal).toBe(2);
    expect(parsed.validation.panelsValid).toBe(1);
    expect(parsed.validation.panelsError).toBe(1);
    expect(parsed.validation.details).toHaveLength(2);
    expect(parsed.validation.details[0].status).toBe("ok");
    expect(parsed.validation.details[1].status).toBe("error");
  });

  test("custom dashboard with no datasource UID shows skipped panels", async () => {
    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = {
      title: "No DS",
      panels: [{
        id: 1, title: "No DS Panel", type: "timeseries",
        targets: [{ refId: "A", expr: "up" }], // No datasource specified
      }],
    };

    const result = await tool!.execute("call-v6", { dashboard: customDash });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.validation.panelsSkipped).toBe(1);
    expect(parsed.validation.details[0].status).toBe("skipped");
    expect(parsed.validation.details[0].error).toContain("No datasource UID");
  });

  test("panel with nodata query returns nodata status", async () => {
    queryPrometheusMock.mockResolvedValue({
      status: "success",
      data: { resultType: "vector", result: [] }, // No data
    });

    const factory = createDashboardToolFactory(makeRegistry());
    const tool = factory({} as never);

    const customDash = {
      title: "No Data Dashboard",
      panels: [{
        id: 1, title: "Empty Metric", type: "timeseries",
        targets: [{ refId: "A", expr: "nonexistent_metric", datasource: { uid: "prom" } }],
      }],
    };

    const result = await tool!.execute("call-v7", { dashboard: customDash });
    const parsed = JSON.parse(getTextContent(result));

    expect(parsed.validation.panelsNoData).toBe(1);
    expect(parsed.validation.details[0].status).toBe("nodata");
  });
});

// ── validateDashboardPanels unit tests ──────────────────────────────

describe("validateDashboardPanels", () => {
  beforeEach(() => {
    queryPrometheusMock.mockReset();
  });

  test("returns correct counts for mixed panel dashboard", async () => {
    queryPrometheusMock
      .mockResolvedValueOnce({
        status: "success",
        data: { resultType: "vector", result: [{ metric: {}, value: [0, "1"] }] },
      })
      .mockResolvedValueOnce({
        status: "success",
        data: { resultType: "vector", result: [] },
      })
      .mockRejectedValueOnce(new Error("bad query"));

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test" });
    const panels = [
      { id: 1, title: "OK", type: "timeseries", targets: [{ refId: "A", expr: "up", datasource: { uid: "p" } }] },
      { id: 2, title: "NoData", type: "timeseries", targets: [{ refId: "A", expr: "missing", datasource: { uid: "p" } }] },
      { id: 3, title: "Error", type: "timeseries", targets: [{ refId: "A", expr: "bad!!!", datasource: { uid: "p" } }] },
      { id: 4, title: "Text", type: "text" }, // No targets
    ];

    const result = await validateDashboardPanels(client, panels);

    expect(result.panelsTotal).toBe(4);
    expect(result.panelsValid).toBe(1);
    expect(result.panelsNoData).toBe(1);
    expect(result.panelsError).toBe(1);
    expect(result.panelsSkipped).toBe(1); // text panel
    expect(result.details).toHaveLength(3); // only panels with targets
  });

  test("panel resolves datasource from sibling panel when own is missing", async () => {
    queryPrometheusMock.mockResolvedValue({
      status: "success",
      data: { resultType: "vector", result: [{ metric: {}, value: [0, "1"] }] },
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test" });
    const panels = [
      { id: 1, title: "No DS", type: "timeseries", targets: [{ refId: "A", expr: "up" }] },
      { id: 2, title: "Has DS", type: "timeseries", targets: [{ refId: "A", expr: "up", datasource: { uid: "prom" } }] },
    ];

    const result = await validateDashboardPanels(client, panels);

    // Panel 1 should resolve datasource from panel 2
    expect(result.panelsValid).toBe(2);
    expect(queryPrometheusMock).toHaveBeenCalledTimes(2);
    expect(queryPrometheusMock).toHaveBeenCalledWith("prom", "up");
  });

  test("skips template variable datasource UIDs", async () => {
    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test" });
    const panels = [
      {
        id: 1, title: "Template DS", type: "timeseries",
        targets: [{ refId: "A", expr: "up", datasource: { uid: "${DS_PROMETHEUS}" } }],
      },
    ];

    const result = await validateDashboardPanels(client, panels);

    expect(result.panelsSkipped).toBe(1);
    expect(result.details[0].status).toBe("skipped");
    expect(queryPrometheusMock).not.toHaveBeenCalled();
  });
});
