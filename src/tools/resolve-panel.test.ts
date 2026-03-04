import { describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const getDashboardMock = vi.hoisted(() => vi.fn());
const listDatasourcesMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", async () => {
  const actual = await vi.importActual<typeof import("../grafana-client.js")>("../grafana-client.js");
  return {
    ...actual,
    GrafanaClient: class {
      getDashboard = getDashboardMock;
      listDatasources = listDatasourcesMock;
    },
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────

import { resolvePanelQuery } from "./resolve-panel.js";
import { GrafanaClient } from "../grafana-client.js";

function makeClient(): GrafanaClient {
  return new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
}

const MOCK_DATASOURCES = [
  { id: 1, uid: "prom1", name: "Prometheus", type: "prometheus", isDefault: true },
  { id: 2, uid: "loki1", name: "Loki", type: "loki", isDefault: false },
];

describe("resolvePanelQuery", () => {
  test("resolves a Prometheus panel query", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "test-dash",
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
    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);

    const result = await resolvePanelQuery(makeClient(), "test-dash", 2);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.expr).toBe("sum(increase(cost_total[1d]))");
      expect(result.datasourceUid).toBe("prom1");
      expect(result.datasourceType).toBe("prometheus");
      expect(result.queryTool).toBe("grafana_query");
      expect(result.panelTitle).toBe("Today's Cost");
      expect(result.panelType).toBe("stat");
      expect(result.templateVarsReplaced).toBe(false);
    }
  });

  test("resolves a Loki panel query", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "logs-dash",
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
    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);

    const result = await resolvePanelQuery(makeClient(), "logs-dash", 5);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.expr).toBe('{job="api"} |= "error"');
      expect(result.queryTool).toBe("grafana_query_logs");
      expect(result.datasourceType).toBe("loki");
    }
  });

  test("replaces template variables in expressions", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "tmpl-dash",
        panels: [
          {
            id: 3,
            title: "Templated Panel",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "prom1" },
            targets: [{ refId: "A", expr: 'rate(http_requests{job=~"$job"}[$__rate_interval])' }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);

    const result = await resolvePanelQuery(makeClient(), "tmpl-dash", 3);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.expr).toBe('rate(http_requests{job=~".*"}[5m])');
      expect(result.templateVarsReplaced).toBe(true);
    }
  });

  test("resolves template variable datasource UIDs", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "var-ds-dash",
        panels: [
          {
            id: 1,
            title: "Variable DS",
            type: "stat",
            datasource: { type: "prometheus", uid: "$prometheus" },
            targets: [{ refId: "A", expr: "up" }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);

    const result = await resolvePanelQuery(makeClient(), "var-ds-dash", 1);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.datasourceUid).toBe("prom1");
    }
  });

  test("returns error when panel not found", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "test-dash",
        panels: [
          { id: 1, title: "Panel One", type: "stat", targets: [] },
        ],
      },
    });

    const result = await resolvePanelQuery(makeClient(), "test-dash", 99);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Panel 99 not found");
      expect(result.error).toContain("1 (Panel One)");
    }
  });

  test("returns error when panel has no targets", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "test-dash",
        panels: [
          { id: 1, title: "Row Panel", type: "row", targets: [] },
        ],
      },
    });

    const result = await resolvePanelQuery(makeClient(), "test-dash", 1);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("no query targets");
    }
  });

  test("returns error when dashboard not found", async () => {
    getDashboardMock.mockRejectedValueOnce(new Error("get dashboard: 404"));

    const result = await resolvePanelQuery(makeClient(), "nonexistent", 1);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not found");
    }
  });

  test("returns error for unsupported datasource type", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "es-dash",
        panels: [
          {
            id: 1,
            title: "ES Panel",
            type: "table",
            datasource: { type: "elasticsearch", uid: "es1" },
            targets: [{ refId: "A", query: "error" }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce([
      ...MOCK_DATASOURCES,
      { id: 3, uid: "es1", name: "Elasticsearch", type: "elasticsearch", isDefault: false },
    ]);

    const result = await resolvePanelQuery(makeClient(), "es-dash", 1);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not supported");
    }
  });

  test("falls back to default datasource when panel has no datasource config", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        uid: "no-ds-dash",
        panels: [
          {
            id: 1,
            title: "No DS",
            type: "stat",
            targets: [{ refId: "A", expr: "up" }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce(MOCK_DATASOURCES);

    const result = await resolvePanelQuery(makeClient(), "no-ds-dash", 1);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      // Falls back to default (Prometheus, which is isDefault: true)
      expect(result.datasourceUid).toBe("prom1");
    }
  });
});
