import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const createAnnotationMock = vi.hoisted(() => vi.fn());
const getAnnotationsMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../grafana-client.js")>();
  return {
    ...actual,
    GrafanaClient: class {
      createAnnotation = createAnnotationMock;
      getAnnotations = getAnnotationsMock;
      getUrl() { return "http://localhost:3000"; }
    },
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────

import { createAnnotateToolFactory, resolveTimeParam, buildComparisonHint } from "./annotate.js";
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

describe("grafana_annotate tool", () => {
  beforeEach(() => {
    createAnnotationMock.mockReset();
    getAnnotationsMock.mockReset();
  });

  test("create annotation with text and tags", async () => {
    createAnnotationMock.mockResolvedValueOnce({ id: 42, message: "Annotation added" });

    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      text: "Deployed v2",
      tags: ["deploy"],
      time: 1700000000000,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("created");
    expect(parsed.id).toBe(42);

    const callArgs = createAnnotationMock.mock.calls[0][0];
    expect(callArgs.text).toBe("Deployed v2");
    expect(callArgs.tags).toEqual(["deploy"]);
    expect(callArgs.time).toBe(1700000000000);
  });

  test("list annotations returns formatted results", async () => {
    getAnnotationsMock.mockResolvedValueOnce([
      {
        id: 1,
        text: "Deploy v1",
        tags: ["deploy"],
        time: 1700000000000,
        timeEnd: 0,
        dashboardUID: "",
        panelId: 0,
        created: 1700000000000,
        updated: 1700000000000,
      },
    ]);

    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-2", {
      action: "list",
      from: 1699900000000,
      to: 1700100000000,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(1);
    expect(parsed.annotations[0].text).toBe("Deploy v1");
  });

  test("defaults to create action", async () => {
    createAnnotationMock.mockResolvedValueOnce({ id: 10, message: "ok" });

    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-3", { text: "Test annotation" });

    expect(createAnnotationMock).toHaveBeenCalledTimes(1);
    expect(getAnnotationsMock).not.toHaveBeenCalled();
  });

  test("API error caught gracefully", async () => {
    createAnnotationMock.mockRejectedValueOnce(new Error("Grafana API error 403"));

    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-4", { text: "fail" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Annotation create failed");
  });

  // ── Relative time tests ──────────────────────────────────────────────

  test("list accepts relative time strings for from/to", async () => {
    getAnnotationsMock.mockResolvedValueOnce([]);

    const before = Date.now() - 7 * 86400000;
    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-5", {
      action: "list",
      from: "now-7d",
      to: "now",
    });

    const callArgs = getAnnotationsMock.mock.calls[0][0];
    // "now-7d" should resolve to approximately 7 days ago
    expect(callArgs.from).toBeGreaterThanOrEqual(before - 1000);
    expect(callArgs.from).toBeLessThanOrEqual(Date.now());
    // "now" should resolve to approximately now
    expect(callArgs.to).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(callArgs.to).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("create accepts relative time string for time param", async () => {
    createAnnotationMock.mockResolvedValueOnce({ id: 99, message: "ok" });

    const before = Date.now() - 2 * 3600000;
    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-6", {
      text: "Incident 2 hours ago",
      time: "now-2h",
    });

    const callArgs = createAnnotationMock.mock.calls[0][0];
    // "now-2h" should resolve to approximately 2 hours ago
    expect(callArgs.time).toBeGreaterThanOrEqual(before - 1000);
    expect(callArgs.time).toBeLessThanOrEqual(Date.now());

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("created");
  });

  test("numeric epoch ms values still work (backward compat)", async () => {
    getAnnotationsMock.mockResolvedValueOnce([]);

    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-7", {
      action: "list",
      from: 1700000000000,
      to: 1700100000000,
    });

    const callArgs = getAnnotationsMock.mock.calls[0][0];
    expect(callArgs.from).toBe(1700000000000);
    expect(callArgs.to).toBe(1700100000000);
  });

  // ── comparisonHint tests ──────────────────────────────────────────

  test("create response includes comparisonHint with before/after windows", async () => {
    createAnnotationMock.mockResolvedValueOnce({ id: 50, message: "ok" });

    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-hint-1", {
      text: "Deployed v2.3.0",
      tags: ["deploy"],
      time: 1700000000000,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.comparisonHint).toBeDefined();
    expect(parsed.comparisonHint.beforeWindow).toBeDefined();
    expect(parsed.comparisonHint.afterWindow).toBeDefined();
    expect(parsed.comparisonHint.suggestion).toContain("grafana_query");

    // beforeWindow should end at annotation time
    expect(parsed.comparisonHint.beforeWindow.to).toBe(
      new Date(1700000000000).toISOString(),
    );
    // beforeWindow.from should be 30 minutes before
    expect(parsed.comparisonHint.beforeWindow.from).toBe(
      new Date(1700000000000 - 30 * 60 * 1000).toISOString(),
    );
  });

  test("create response comparisonHint uses timeEnd for region annotations", async () => {
    createAnnotationMock.mockResolvedValueOnce({ id: 51, message: "ok" });

    const timeStart = 1700000000000;
    const timeEnd = 1700001800000; // 30 min later

    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-hint-2", {
      text: "Maintenance window",
      time: timeStart,
      timeEnd: timeEnd,
    });

    const parsed = JSON.parse(getTextContent(result));
    // beforeWindow ends at annotation start time
    expect(parsed.comparisonHint.beforeWindow.to).toBe(
      new Date(timeStart).toISOString(),
    );
    // afterWindow starts at annotation end time
    expect(parsed.comparisonHint.afterWindow.from).toBe(
      new Date(timeEnd).toISOString(),
    );
  });

  test("list response does not include comparisonHint", async () => {
    getAnnotationsMock.mockResolvedValueOnce([]);

    const tool = createAnnotateToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-hint-3", {
      action: "list",
      from: "now-1h",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.comparisonHint).toBeUndefined();
  });
});

describe("buildComparisonHint", () => {
  test("point annotation: symmetric 30-min windows", () => {
    const time = 1700000000000;
    const hint = buildComparisonHint(time, undefined);

    expect(hint.beforeWindow.from).toBe(new Date(time - 30 * 60 * 1000).toISOString());
    expect(hint.beforeWindow.to).toBe(new Date(time).toISOString());
    expect(hint.afterWindow.from).toBe(new Date(time).toISOString());
    expect(hint.suggestion).toContain("grafana_query");
  });

  test("region annotation: afterWindow starts at timeEnd", () => {
    const time = 1700000000000;
    const timeEnd = 1700003600000; // 1 hour later
    const hint = buildComparisonHint(time, timeEnd);

    expect(hint.beforeWindow.to).toBe(new Date(time).toISOString());
    expect(hint.afterWindow.from).toBe(new Date(timeEnd).toISOString());
  });

  test("afterWindow.to capped at now for recent annotations", () => {
    const recentTime = Date.now() - 5 * 60 * 1000; // 5 min ago
    const hint = buildComparisonHint(recentTime, undefined);

    const afterTo = new Date(hint.afterWindow.to).getTime();
    // Should be capped at approximately now (not 25 min in the future)
    expect(afterTo).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("custom window size", () => {
    const time = 1700000000000;
    const windowMs = 60 * 60 * 1000; // 1 hour
    const hint = buildComparisonHint(time, undefined, windowMs);

    expect(hint.beforeWindow.from).toBe(new Date(time - windowMs).toISOString());
    expect(hint.beforeWindow.to).toBe(new Date(time).toISOString());
  });
});

describe("resolveTimeParam", () => {
  test("returns undefined for undefined/null", () => {
    expect(resolveTimeParam(undefined)).toBeUndefined();
    expect(resolveTimeParam(null)).toBeUndefined();
  });

  test("passes through numbers unchanged", () => {
    expect(resolveTimeParam(1700000000000)).toBe(1700000000000);
  });

  test("parses relative time strings to epoch ms", () => {
    const result = resolveTimeParam("now-1h");
    expect(result).toBeTypeOf("number");
    const expected = Date.now() - 3600000;
    expect(result).toBeGreaterThanOrEqual(expected - 1000);
    expect(result).toBeLessThanOrEqual(expected + 1000);
  });

  test("parses 'now' to approximately current time", () => {
    const result = resolveTimeParam("now");
    expect(result).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(result).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("returns undefined for non-number non-string", () => {
    expect(resolveTimeParam(true)).toBeUndefined();
    expect(resolveTimeParam([])).toBeUndefined();
  });
});
