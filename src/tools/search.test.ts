import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const searchDashboardsMock = vi.hoisted(() => vi.fn());
const getDashboardMock = vi.hoisted(() => vi.fn());
const dashboardUrlMock = vi.hoisted(() => vi.fn((uid: string) => `http://localhost:3000/d/${uid}`));

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    searchDashboards = searchDashboardsMock;
    getDashboard = getDashboardMock;
    dashboardUrl = dashboardUrlMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createSearchToolFactory } from "./search.js";
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

describe("grafana_search tool", () => {
  beforeEach(() => {
    searchDashboardsMock.mockReset();
    getDashboardMock.mockReset();
    dashboardUrlMock.mockClear();
  });

  test("returns formatted search results with URLs", async () => {
    searchDashboardsMock.mockResolvedValueOnce([
      { id: 1, uid: "abc", title: "Agent Overview", url: "/d/abc", type: "dash-db", tags: ["agent"] },
    ]);

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", { query: "agent" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(1);
    expect(parsed.enriched).toBe(false);
    expect(parsed.dashboards[0].uid).toBe("abc");
    expect(parsed.dashboards[0].url).toContain("/d/abc");
    expect(parsed.dashboards[0].title).toBe("Agent Overview");
  });

  test("empty results returns count 0", async () => {
    searchDashboardsMock.mockResolvedValueOnce([]);

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-2", { query: "nonexistent" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(0);
    expect(parsed.dashboards).toEqual([]);
  });

  test("API error caught gracefully", async () => {
    searchDashboardsMock.mockRejectedValueOnce(new Error("Grafana authentication failed"));

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-3", { query: "test" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Search failed");
  });

  test("passes optional params (tags, starred, sort, limit) to client", async () => {
    searchDashboardsMock.mockResolvedValueOnce([]);

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-4", {
      query: "api",
      tags: ["production"],
      starred: true,
      sort: "alpha-desc",
      limit: 10,
    });

    expect(searchDashboardsMock).toHaveBeenCalledWith("api", {
      tags: ["production"],
      starred: true,
      sort: "alpha-desc",
      limit: 10,
    });
  });

  test("omits undefined optional params", async () => {
    searchDashboardsMock.mockResolvedValueOnce([]);

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-5", { query: "test" });

    expect(searchDashboardsMock).toHaveBeenCalledWith("test", {
      tags: undefined,
      starred: undefined,
      sort: undefined,
      limit: undefined,
    });
  });

  // ── Folder fields ──────────────────────────────────────────────────

  test("includes folderTitle and folderUid when present in search results", async () => {
    searchDashboardsMock.mockResolvedValueOnce([
      {
        id: 2, uid: "in-folder", title: "In Folder", url: "/d/in-folder",
        type: "dash-db", tags: [],
        folderUid: "folder-1", folderTitle: "Production", folderUrl: "/f/folder-1",
      },
      {
        id: 3, uid: "root-level", title: "Root Level", url: "/d/root-level",
        type: "dash-db", tags: [],
        // No folder fields — root/General folder
      },
    ]);

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-6", { query: "test" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.dashboards[0].folderTitle).toBe("Production");
    expect(parsed.dashboards[0].folderUid).toBe("folder-1");
    expect(parsed.dashboards[1].folderTitle).toBeUndefined();
    expect(parsed.dashboards[1].folderUid).toBeUndefined();
  });

  // ── Enrichment ─────────────────────────────────────────────────────

  test("enrich=true adds updatedAt and panelCount from dashboard details", async () => {
    searchDashboardsMock.mockResolvedValueOnce([
      { id: 1, uid: "dash-1", title: "Dashboard 1", url: "/d/dash-1", type: "dash-db", tags: [] },
      { id: 2, uid: "dash-2", title: "Dashboard 2", url: "/d/dash-2", type: "dash-db", tags: [] },
    ]);

    getDashboardMock
      .mockResolvedValueOnce({
        meta: { updated: "2026-02-20T10:00:00Z" },
        dashboard: { panels: [{}, {}, {}] },
      })
      .mockResolvedValueOnce({
        meta: { updated: "2026-01-15T08:30:00Z" },
        dashboard: { panels: [{}] },
      });

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-7", { query: "dash", enrich: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.enriched).toBe(true);
    expect(parsed.dashboards[0].updatedAt).toBe("2026-02-20T10:00:00Z");
    expect(parsed.dashboards[0].panelCount).toBe(3);
    expect(parsed.dashboards[1].updatedAt).toBe("2026-01-15T08:30:00Z");
    expect(parsed.dashboards[1].panelCount).toBe(1);

    expect(getDashboardMock).toHaveBeenCalledTimes(2);
    expect(getDashboardMock).toHaveBeenCalledWith("dash-1");
    expect(getDashboardMock).toHaveBeenCalledWith("dash-2");
  });

  test("enrich=true tolerates individual dashboard fetch failures", async () => {
    searchDashboardsMock.mockResolvedValueOnce([
      { id: 1, uid: "ok-dash", title: "OK", url: "/d/ok", type: "dash-db", tags: [] },
      { id: 2, uid: "fail-dash", title: "Fail", url: "/d/fail", type: "dash-db", tags: [] },
    ]);

    getDashboardMock
      .mockResolvedValueOnce({
        meta: { updated: "2026-03-01T12:00:00Z" },
        dashboard: { panels: [{}, {}] },
      })
      .mockRejectedValueOnce(new Error("403 Forbidden"));

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-8", { query: "test", enrich: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(2);
    // First dashboard enriched successfully
    expect(parsed.dashboards[0].updatedAt).toBe("2026-03-01T12:00:00Z");
    expect(parsed.dashboards[0].panelCount).toBe(2);
    // Second dashboard: enrichment failed, still has basic fields
    expect(parsed.dashboards[1].uid).toBe("fail-dash");
    expect(parsed.dashboards[1].updatedAt).toBeUndefined();
    expect(parsed.dashboards[1].panelCount).toBeUndefined();
  });

  test("enrich=false (default) does not call getDashboard", async () => {
    searchDashboardsMock.mockResolvedValueOnce([
      { id: 1, uid: "abc", title: "Test", url: "/d/abc", type: "dash-db", tags: [] },
    ]);

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-9", { query: "test" });

    expect(getDashboardMock).not.toHaveBeenCalled();
  });

  test("enrich=true with empty results does not call getDashboard", async () => {
    searchDashboardsMock.mockResolvedValueOnce([]);

    const tool = createSearchToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-10", { query: "nonexistent", enrich: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.enriched).toBe(true);
    expect(parsed.count).toBe(0);
    expect(getDashboardMock).not.toHaveBeenCalled();
  });
});
