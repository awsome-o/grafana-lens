import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const getDashboardMock = vi.hoisted(() => vi.fn());
const createDashboardMock = vi.hoisted(() => vi.fn());
const deleteDashboardMock = vi.hoisted(() => vi.fn());
const dashboardUrlMock = vi.hoisted(() => vi.fn((uid: string) => `http://localhost:3000/d/${uid}`));
const queryPrometheusMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    getDashboard = getDashboardMock;
    createDashboard = createDashboardMock;
    deleteDashboard = deleteDashboardMock;
    dashboardUrl = dashboardUrlMock;
    queryPrometheus = queryPrometheusMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createUpdateDashboardToolFactory, validateTargetQueries } from "./update-dashboard.js";
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

function parse(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text?: string }> };
  const first = r.content[0];
  if (first.type === "text" && first.text) return JSON.parse(first.text);
  throw new Error("Expected text content");
}

function makeDashboardResponse(overrides?: {
  panels?: Array<Record<string, unknown>>;
  provisioned?: boolean;
  folderUid?: string;
}) {
  return {
    dashboard: {
      id: 42,
      uid: "dash-1",
      title: "Test Dashboard",
      version: 1,
      tags: ["test"],
      panels: overrides?.panels ?? [
        {
          id: 1,
          title: "Token Usage",
          type: "timeseries",
          gridPos: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", expr: "rate(openclaw_lens_tokens_total[5m])" }],
        },
        {
          id: 2,
          title: "Daily Cost",
          type: "stat",
          gridPos: { x: 0, y: 8, w: 6, h: 4 },
          targets: [{ refId: "A", expr: "openclaw_lens_daily_cost_usd" }],
        },
      ],
    },
    meta: {
      folderUid: overrides?.folderUid ?? "folder-1",
      provisioned: overrides?.provisioned ?? false,
    },
  };
}

function setupSaveMock() {
  createDashboardMock.mockResolvedValueOnce({
    id: 42,
    uid: "dash-1",
    url: "/d/dash-1",
    status: "success",
    version: 2,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("grafana_update_dashboard tool", () => {
  beforeEach(() => {
    getDashboardMock.mockReset();
    createDashboardMock.mockReset();
    deleteDashboardMock.mockReset();
    dashboardUrlMock.mockClear();
    queryPrometheusMock.mockReset();
  });

  // ── add_panel ──────────────────────────────────────────────────

  describe("add_panel", () => {
    test("adds panel below existing panels with auto-layout", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-1", {
        uid: "dash-1",
        operation: "add_panel",
        panel: {
          title: "Error Rate",
          type: "timeseries",
          targets: [{ refId: "A", expr: "rate(errors_total[5m])" }],
        },
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");
      expect(parsed.operation).toBe("add_panel");
      expect(parsed.panelCount).toBe(3);
      expect(parsed.affectedPanel).toEqual({ id: 3, title: "Error Rate" });

      // Verify the saved dashboard has correct grid position
      const savedDashboard = createDashboardMock.mock.calls[0][0].dashboard;
      const newPanel = savedDashboard.panels[2];
      expect(newPanel.gridPos).toEqual({ x: 0, y: 12, w: 12, h: 8 });
      expect(newPanel.id).toBe(3);
    });

    test("adds panel at y=0 on empty dashboard", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse({ panels: [] }));
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-2", {
        uid: "dash-1",
        operation: "add_panel",
        panel: { title: "First Panel", type: "stat", targets: [] },
      });

      const parsed = parse(result);
      expect(parsed.panelCount).toBe(1);

      const savedDashboard = createDashboardMock.mock.calls[0][0].dashboard;
      expect(savedDashboard.panels[0].gridPos).toEqual({ x: 0, y: 0, w: 12, h: 8 });
      expect(savedDashboard.panels[0].id).toBe(1);
    });

    test("preserves explicit gridPos when provided", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      await tool!.execute("call-3", {
        uid: "dash-1",
        operation: "add_panel",
        panel: {
          title: "Custom Pos",
          type: "gauge",
          gridPos: { x: 6, y: 0, w: 6, h: 4 },
        },
      });

      const savedDashboard = createDashboardMock.mock.calls[0][0].dashboard;
      const newPanel = savedDashboard.panels[2];
      expect(newPanel.gridPos).toEqual({ x: 6, y: 0, w: 6, h: 4 });
    });

    test("returns error when panel param missing", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-4", {
        uid: "dash-1",
        operation: "add_panel",
      });

      const parsed = parse(result);
      expect(parsed.error).toContain("add_panel requires");
      expect(createDashboardMock).not.toHaveBeenCalled();
    });
  });

  // ── remove_panel ───────────────────────────────────────────────

  describe("remove_panel", () => {
    test("removes panel by panelId", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-5", {
        uid: "dash-1",
        operation: "remove_panel",
        panelId: 1,
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");
      expect(parsed.panelCount).toBe(1);
      expect(parsed.affectedPanel).toEqual({ id: 1, title: "Token Usage" });
    });

    test("removes panel by panelTitle (case-insensitive substring)", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-6", {
        uid: "dash-1",
        operation: "remove_panel",
        panelTitle: "daily cost",
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");
      expect(parsed.affectedPanel).toEqual({ id: 2, title: "Daily Cost" });
    });

    test("returns error with available panels when not found", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-7", {
        uid: "dash-1",
        operation: "remove_panel",
        panelId: 99,
      });

      const parsed = parse(result);
      expect(parsed.error).toContain("Panel not found");
      expect(parsed.error).toContain("Token Usage");
      expect(parsed.error).toContain("Daily Cost");
      expect(createDashboardMock).not.toHaveBeenCalled();
    });
  });

  // ── update_panel ───────────────────────────────────────────────

  describe("update_panel", () => {
    test("merges updates into panel by ID", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-8", {
        uid: "dash-1",
        operation: "update_panel",
        panelId: 1,
        updates: { title: "Updated Token Usage" },
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");
      expect(parsed.affectedPanel).toEqual({ id: 1, title: "Updated Token Usage" });

      const savedDashboard = createDashboardMock.mock.calls[0][0].dashboard;
      expect(savedDashboard.panels[0].title).toBe("Updated Token Usage");
      // Original fields preserved
      expect(savedDashboard.panels[0].type).toBe("timeseries");
    });

    test("finds panel by title and replaces targets entirely", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const newTargets = [{ refId: "A", expr: "new_query" }];
      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-9", {
        uid: "dash-1",
        operation: "update_panel",
        panelTitle: "token",
        updates: { targets: newTargets },
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");

      const savedDashboard = createDashboardMock.mock.calls[0][0].dashboard;
      expect(savedDashboard.panels[0].targets).toEqual(newTargets);
    });

    test("returns error when panel not found", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-10", {
        uid: "dash-1",
        operation: "update_panel",
        panelId: 99,
        updates: { title: "Won't work" },
      });

      const parsed = parse(result);
      expect(parsed.error).toContain("Panel not found");
    });
  });

  // ── update_metadata ────────────────────────────────────────────

  describe("update_metadata", () => {
    test("updates multiple metadata fields", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-11", {
        uid: "dash-1",
        operation: "update_metadata",
        title: "New Title",
        description: "A great dashboard",
        tags: ["production", "api"],
        time: { from: "now-7d", to: "now" },
        refresh: "1m",
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");
      expect(parsed.changedFields).toEqual(["title", "description", "tags", "time", "refresh"]);

      const savedDashboard = createDashboardMock.mock.calls[0][0].dashboard;
      expect(savedDashboard.title).toBe("New Title");
      expect(savedDashboard.description).toBe("A great dashboard");
      expect(savedDashboard.tags).toEqual(["production", "api"]);
      expect(savedDashboard.time).toEqual({ from: "now-7d", to: "now" });
      expect(savedDashboard.refresh).toBe("1m");
    });

    test("partial update preserves other fields", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      await tool!.execute("call-12", {
        uid: "dash-1",
        operation: "update_metadata",
        title: "Only Title Changed",
      });

      const savedDashboard = createDashboardMock.mock.calls[0][0].dashboard;
      expect(savedDashboard.title).toBe("Only Title Changed");
      // Original tags preserved
      expect(savedDashboard.tags).toEqual(["test"]);
    });
  });

  // ── Safety ─────────────────────────────────────────────────────

  describe("safety", () => {
    test("rejects provisioned dashboard with clear error", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse({ provisioned: true }));

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-13", {
        uid: "dash-1",
        operation: "update_metadata",
        title: "Can't touch this",
      });

      const parsed = parse(result);
      expect(parsed.error).toContain("provisioned");
      expect(createDashboardMock).not.toHaveBeenCalled();
    });
  });

  // ── Error handling ─────────────────────────────────────────────

  describe("error handling", () => {
    test("unknown operation returns error", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-14", {
        uid: "dash-1",
        operation: "invalid_op",
      });

      const parsed = parse(result);
      expect(parsed.error).toContain("Unknown operation 'invalid_op'");
    });

    test("API error during save caught gracefully", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      createDashboardMock.mockRejectedValueOnce(new Error("Grafana API error 500"));

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-15", {
        uid: "dash-1",
        operation: "update_metadata",
        title: "Will Fail",
      });

      const parsed = parse(result);
      expect(parsed.error).toContain("Failed to update dashboard");
    });

    test("dashboard not found returns error", async () => {
      getDashboardMock.mockRejectedValueOnce(new Error("Not found: get dashboard by uid bad-uid"));

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-16", {
        uid: "bad-uid",
        operation: "update_metadata",
        title: "Ghost",
      });

      const parsed = parse(result);
      expect(parsed.error).toContain("Failed to get dashboard");
    });
  });

  // ── delete ──────────────────────────────────────────────────────

  describe("delete", () => {
    test("deletes dashboard and returns confirmation", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      deleteDashboardMock.mockResolvedValueOnce({ title: "Test Dashboard" });

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-17", {
        uid: "dash-1",
        operation: "delete",
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("deleted");
      expect(parsed.uid).toBe("dash-1");
      expect(parsed.title).toBe("Test Dashboard");
      expect(deleteDashboardMock).toHaveBeenCalledWith("dash-1");
      // Should NOT call createDashboard (save)
      expect(createDashboardMock).not.toHaveBeenCalled();
    });

    test("delete handles API error gracefully", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      deleteDashboardMock.mockRejectedValueOnce(new Error("Grafana API error 403"));

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-18", {
        uid: "dash-1",
        operation: "delete",
      });

      const parsed = parse(result);
      expect(parsed.error).toContain("Failed to delete dashboard");
    });

    test("delete allowed on provisioned dashboards (Grafana decides)", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse({ provisioned: true }));
      deleteDashboardMock.mockResolvedValueOnce({ title: "Provisioned Dashboard" });

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-19", {
        uid: "dash-1",
        operation: "delete",
      });

      const parsed = parse(result);
      // Should not block provisioned delete (let Grafana decide)
      expect(parsed.status).toBe("deleted");
    });
  });

  // ── Query validation ────────────────────────────────────────────

  describe("query validation", () => {
    test("add_panel validates PromQL and returns sampleValue on success", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();
      queryPrometheusMock.mockResolvedValueOnce({
        data: { result: [{ metric: {}, value: [1700000000, "42.5"] }] },
      });

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-v1", {
        uid: "dash-1",
        operation: "add_panel",
        panel: {
          title: "Latency P99",
          type: "timeseries",
          targets: [
            { refId: "A", expr: "histogram_quantile(0.99, rate(http_duration_bucket[5m]))", datasource: { uid: "prom-1" } },
          ],
        },
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");

      const qv = parsed.queryValidation as Record<string, unknown>;
      expect(qv.validated).toBe(true);
      expect(qv.datasourceUid).toBe("prom-1");

      const results = qv.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0].refId).toBe("A");
      expect(results[0].valid).toBe(true);
      expect(results[0].sampleValue).toBe(42.5);
    });

    test("add_panel returns validation error for bad PromQL", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();
      queryPrometheusMock.mockRejectedValueOnce(new Error('parse error at char 5: unexpected ")"'));

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-v2", {
        uid: "dash-1",
        operation: "add_panel",
        panel: {
          title: "Bad Query",
          type: "timeseries",
          targets: [
            { refId: "A", expr: "rate()", datasource: { uid: "prom-1" } },
          ],
        },
      });

      const parsed = parse(result);
      // Panel is still saved
      expect(parsed.status).toBe("updated");

      const qv = parsed.queryValidation as Record<string, unknown>;
      expect(qv.validated).toBe(true);

      const results = qv.results as Array<Record<string, unknown>>;
      expect(results[0].valid).toBe(false);
      expect(results[0].error).toContain("parse error");
    });

    test("add_panel skips validation when no datasource UID available", async () => {
      // Use panels without datasource UIDs on targets
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-v3", {
        uid: "dash-1",
        operation: "add_panel",
        panel: {
          title: "No DS",
          type: "timeseries",
          targets: [{ refId: "A", expr: "up" }],
        },
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");

      const qv = parsed.queryValidation as Record<string, unknown>;
      expect(qv.validated).toBe(false);
      expect(qv.skippedReason).toContain("No datasource UID");
      expect(queryPrometheusMock).not.toHaveBeenCalled();
    });

    test("add_panel resolves datasource from existing panel targets", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse({
        panels: [{
          id: 1, title: "Existing", type: "stat",
          gridPos: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", expr: "up", datasource: { uid: "prom-existing" } }],
        }],
      }));
      setupSaveMock();
      queryPrometheusMock.mockResolvedValueOnce({
        data: { result: [] },
      });

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-v4", {
        uid: "dash-1",
        operation: "add_panel",
        panel: {
          title: "New Panel",
          type: "timeseries",
          targets: [{ refId: "A", expr: "new_metric" }],
        },
      });

      const parsed = parse(result);
      const qv = parsed.queryValidation as Record<string, unknown>;
      expect(qv.validated).toBe(true);
      expect(qv.datasourceUid).toBe("prom-existing");
    });

    test("add_panel omits queryValidation when panel has no targets", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-v5", {
        uid: "dash-1",
        operation: "add_panel",
        panel: { title: "Text Panel", type: "text" },
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");
      expect(parsed.queryValidation).toBeUndefined();
    });

    test("update_panel validates when targets are changed", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse({
        panels: [{
          id: 1, title: "Panel", type: "timeseries",
          gridPos: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", expr: "old_query", datasource: { uid: "prom-1" } }],
        }],
      }));
      setupSaveMock();
      queryPrometheusMock.mockResolvedValueOnce({
        data: { result: [{ metric: {}, value: [1700000000, "7"] }] },
      });

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-v6", {
        uid: "dash-1",
        operation: "update_panel",
        panelId: 1,
        updates: {
          targets: [{ refId: "A", expr: "rate(new_metric[5m])", datasource: { uid: "prom-1" } }],
        },
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");

      const qv = parsed.queryValidation as Record<string, unknown>;
      expect(qv.validated).toBe(true);
      const results = qv.results as Array<Record<string, unknown>>;
      expect(results[0].valid).toBe(true);
      expect(results[0].sampleValue).toBe(7);
    });

    test("update_panel omits queryValidation when only title changes", async () => {
      getDashboardMock.mockResolvedValueOnce(makeDashboardResponse());
      setupSaveMock();

      const tool = createUpdateDashboardToolFactory(makeRegistry())({} as never);
      const result = await tool!.execute("call-v7", {
        uid: "dash-1",
        operation: "update_panel",
        panelId: 1,
        updates: { title: "Renamed Panel" },
      });

      const parsed = parse(result);
      expect(parsed.status).toBe("updated");
      expect(parsed.queryValidation).toBeUndefined();
      expect(queryPrometheusMock).not.toHaveBeenCalled();
    });
  });

  // ── validateTargetQueries unit tests ─────────────────────────────

  describe("validateTargetQueries", () => {
    test("returns results for each target with expr", async () => {
      const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "k" });
      queryPrometheusMock
        .mockResolvedValueOnce({ data: { result: [{ metric: {}, value: [1, "10"] }] } })
        .mockRejectedValueOnce(new Error("metric not found"));

      const result = await validateTargetQueries(
        client,
        [
          { refId: "A", expr: "up" },
          { refId: "B", expr: "nonexistent" },
        ],
        "prom-1",
      );

      expect(result.validated).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({ refId: "A", expr: "up", valid: true, sampleValue: 10 });
      expect(result.results[1]).toMatchObject({ refId: "B", expr: "nonexistent", valid: false });
      expect(result.results[1].error).toContain("metric not found");
    });

    test("skips targets without expr", async () => {
      const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "k" });

      const result = await validateTargetQueries(
        client,
        [{ refId: "A" }, { refId: "B" }],
        "prom-1",
      );

      expect(result.validated).toBe(false);
      expect(result.skippedReason).toContain("No PromQL expressions");
      expect(queryPrometheusMock).not.toHaveBeenCalled();
    });
  });
});
