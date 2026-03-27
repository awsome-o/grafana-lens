import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const listDatasourcesMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    listDatasources = listDatasourcesMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createExploreDatasourcesToolFactory, getQueryCapability } from "./explore-datasources.js";
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

describe("grafana_explore_datasources tool", () => {
  beforeEach(() => {
    listDatasourcesMock.mockReset();
  });

  test("returns formatted datasource list with query routing hints", async () => {
    listDatasourcesMock.mockResolvedValueOnce([
      { id: 1, uid: "prom1", name: "Prometheus", type: "prometheus", url: "http://prom:9090", isDefault: true, access: "proxy" },
      { id: 2, uid: "loki1", name: "Loki", type: "loki", url: "http://loki:3100", isDefault: false, access: "proxy" },
      { id: 3, uid: "tempo1", name: "Tempo", type: "tempo", url: "http://tempo:3200", isDefault: false, access: "proxy" },
    ]);

    const tool = createExploreDatasourcesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(3);

    // Prometheus → grafana_query (PromQL)
    expect(parsed.datasources[0]).toMatchObject({
      uid: "prom1",
      type: "prometheus",
      isDefault: true,
      queryTool: "grafana_query",
      queryLanguage: "PromQL",
      supported: true,
    });

    // Loki → grafana_query_logs (LogQL)
    expect(parsed.datasources[1]).toMatchObject({
      uid: "loki1",
      type: "loki",
      queryTool: "grafana_query_logs",
      queryLanguage: "LogQL",
      supported: true,
    });

    // Tempo → grafana_query_traces (TraceQL)
    expect(parsed.datasources[2]).toMatchObject({
      uid: "tempo1",
      type: "tempo",
      queryTool: "grafana_query_traces",
      queryLanguage: "TraceQL",
      supported: true,
    });
  });

  test("API error caught gracefully", async () => {
    listDatasourcesMock.mockRejectedValueOnce(new Error("Grafana authentication failed"));

    const tool = createExploreDatasourcesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-2", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to list datasources");
  });
});

describe("getQueryCapability", () => {
  test("prometheus maps to grafana_query with PromQL", () => {
    expect(getQueryCapability("prometheus")).toEqual({
      queryTool: "grafana_query",
      queryLanguage: "PromQL",
      supported: true,
    });
  });

  test("loki maps to grafana_query_logs with LogQL", () => {
    expect(getQueryCapability("loki")).toEqual({
      queryTool: "grafana_query_logs",
      queryLanguage: "LogQL",
      supported: true,
    });
  });

  test("tempo maps to grafana_query_traces with TraceQL", () => {
    expect(getQueryCapability("tempo")).toEqual({
      queryTool: "grafana_query_traces",
      queryLanguage: "TraceQL",
      supported: true,
    });
  });

  test("unknown types return unsupported", () => {
    expect(getQueryCapability("elasticsearch")).toEqual({
      queryTool: null,
      queryLanguage: null,
      supported: false,
    });
  });
});
