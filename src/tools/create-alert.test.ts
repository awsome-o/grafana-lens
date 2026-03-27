import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const createAlertRuleMock = vi.hoisted(() => vi.fn());
const listFoldersMock = vi.hoisted(() => vi.fn());
const createFolderMock = vi.hoisted(() => vi.fn());
const queryPrometheusMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    createAlertRule = createAlertRuleMock;
    listFolders = listFoldersMock;
    createFolder = createFolderMock;
    queryPrometheus = queryPrometheusMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createAlertToolFactory, wrapExpression } from "./create-alert.js";
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

describe("grafana_create_alert tool", () => {
  beforeEach(() => {
    createAlertRuleMock.mockReset();
    listFoldersMock.mockReset();
    createFolderMock.mockReset();
    queryPrometheusMock.mockReset();
    // Default: validation returns data (most tests don't care about validation specifics)
    queryPrometheusMock.mockResolvedValue({ data: { result: [{ value: [1234567890, "42"] }] } });
  });

  test("creates alert rule with auto-created folder", async () => {
    listFoldersMock.mockResolvedValueOnce([]);
    createFolderMock.mockResolvedValueOnce({ id: 1, uid: "auto-folder", title: "Grafana Lens Alerts", url: "/f/auto-folder" });
    createAlertRuleMock.mockResolvedValueOnce({
      uid: "alert-1",
      title: "High Cost",
      folderUID: "auto-folder",
    });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      title: "High Cost",
      datasourceUid: "prom1",
      expr: "openclaw_lens_daily_cost_usd",
      threshold: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("created");
    expect(parsed.uid).toBe("alert-1");
    expect(parsed.url).toContain("/alerting/alert-1/edit");

    // Verify folder was created
    expect(createFolderMock).toHaveBeenCalledWith({ title: "Grafana Lens Alerts" });
  });

  test("uses existing folder if found", async () => {
    listFoldersMock.mockResolvedValueOnce([
      { id: 1, uid: "existing-folder", title: "Grafana Lens Alerts", url: "/f/existing-folder" },
    ]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-2", title: "Low CPU" });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-2", {
      title: "Low CPU",
      datasourceUid: "prom1",
      expr: "cpu_usage",
      threshold: 10,
      condition: "lt",
    });

    expect(createFolderMock).not.toHaveBeenCalled();
    // Verify alert uses existing folder
    const alertArgs = createAlertRuleMock.mock.calls[0][0];
    expect(alertArgs.folderUID).toBe("existing-folder");
  });

  test("uses explicit folderUid without listing folders", async () => {
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-3", title: "Test" });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-3", {
      title: "Test",
      datasourceUid: "prom1",
      expr: "up",
      threshold: 0,
      folderUid: "my-folder",
    });

    expect(listFoldersMock).not.toHaveBeenCalled();
    expect(createAlertRuleMock.mock.calls[0][0].folderUID).toBe("my-folder");
  });

  test("builds three-query alert data (A=data, B=reduce, C=threshold)", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-4", title: "Test" });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-4", {
      title: "Test",
      datasourceUid: "prom1",
      expr: "my_metric",
      threshold: 100,
      condition: "gte",
    });

    const callArgs = createAlertRuleMock.mock.calls[0][0];
    const data = callArgs.data;
    expect(data).toHaveLength(3);
    expect(data[0].refId).toBe("A");
    expect(data[0].datasourceUid).toBe("prom1");
    expect(data[1].refId).toBe("B");
    expect(data[1].datasourceUid).toBe("__expr__");
    expect(data[2].refId).toBe("C");
    expect(data[2].model.type).toBe("threshold");

    // Verify managed_by label is auto-added
    expect(callArgs.labels.managed_by).toBe("openclaw");
  });

  test("API error caught and returned gracefully", async () => {
    listFoldersMock.mockResolvedValueOnce([]);
    createFolderMock.mockRejectedValueOnce(new Error("Grafana API error 500: internal"));

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-5", {
      title: "Fail",
      datasourceUid: "prom1",
      expr: "up",
      threshold: 1,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to create alert");
  });

  // ── Evaluation mode tests ──────────────────────────────────────────

  test("evaluation='rate' wraps expr in rate() with default 5m window", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-rate", title: "High Error Rate" });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-rate", {
      title: "High Error Rate",
      datasourceUid: "prom1",
      expr: "openclaw_lens_webhook_error_total",
      threshold: 0.1,
      evaluation: "rate",
    });

    // Verify the PromQL sent to Grafana has rate() wrapping
    const callArgs = createAlertRuleMock.mock.calls[0][0];
    expect(callArgs.data[0].model.expr).toBe("rate(openclaw_lens_webhook_error_total[5m])");

    // Verify response includes evaluation metadata
    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.evaluation).toEqual({
      mode: "rate",
      window: "5m",
      evaluatedExpr: "rate(openclaw_lens_webhook_error_total[5m])",
    });
    expect(parsed.message).toContain("rate(openclaw_lens_webhook_error_total[5m])");
  });

  test("evaluation='increase' wraps expr in increase() with custom window", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-inc", title: "High Token Increase" });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-inc", {
      title: "High Token Increase",
      datasourceUid: "prom1",
      expr: "openclaw_lens_tokens_total",
      threshold: 10000,
      evaluation: "increase",
      evaluationWindow: "1h",
    });

    const callArgs = createAlertRuleMock.mock.calls[0][0];
    expect(callArgs.data[0].model.expr).toBe("increase(openclaw_lens_tokens_total[1h])");

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.evaluation).toEqual({
      mode: "increase",
      window: "1h",
      evaluatedExpr: "increase(openclaw_lens_tokens_total[1h])",
    });
  });

  test("evaluation='instant' (default) passes expr unchanged, no evaluation in response", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-inst", title: "High Cost" });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-inst", {
      title: "High Cost",
      datasourceUid: "prom1",
      expr: "openclaw_lens_daily_cost_usd",
      threshold: 5,
    });

    // No evaluation param = instant mode
    const callArgs = createAlertRuleMock.mock.calls[0][0];
    expect(callArgs.data[0].model.expr).toBe("openclaw_lens_daily_cost_usd");

    // Response should NOT include evaluation metadata for instant mode
    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.evaluation).toBeUndefined();
  });

  test("evaluation='rate' with explicit evaluationWindow", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-rate-15m", title: "Slow Rate" });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-rate-15m", {
      title: "Slow Rate",
      datasourceUid: "prom1",
      expr: "http_requests_total",
      threshold: 100,
      evaluation: "rate",
      evaluationWindow: "15m",
    });

    const callArgs = createAlertRuleMock.mock.calls[0][0];
    expect(callArgs.data[0].model.expr).toBe("rate(http_requests_total[15m])");
  });
  // ── Metric validation tests ──────────────────────────────────────────

  test("response includes metricValidation with sampleValue when metric has data", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-v1", title: "Cost Alert" });
    queryPrometheusMock.mockResolvedValueOnce({ data: { result: [{ value: [1234567890, "3.14"] }] } });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-v1", {
      title: "Cost Alert",
      datasourceUid: "prom1",
      expr: "openclaw_lens_daily_cost_usd",
      threshold: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metricValidation).toEqual({ valid: true, sampleValue: 3.14 });
  });

  test("response includes metricValidation error when metric has no data", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-v2", title: "Disk Alert" });
    queryPrometheusMock.mockResolvedValueOnce({ data: { result: [] } });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-v2", {
      title: "Disk Alert",
      datasourceUid: "prom1",
      expr: "node_filesystem_usage_percent",
      threshold: 80,
    });

    const parsed = JSON.parse(getTextContent(result));
    // Alert is still created despite validation failure
    expect(parsed.status).toBe("created");
    expect(parsed.uid).toBe("alert-v2");
    expect(parsed.metricValidation.valid).toBe(false);
    expect(parsed.metricValidation.error).toContain("no data");
  });

  test("response includes metricValidation error when query fails", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-v3", title: "Bad Query" });
    queryPrometheusMock.mockRejectedValueOnce(new Error("parse error: unexpected end of input"));

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-v3", {
      title: "Bad Query",
      datasourceUid: "prom1",
      expr: "invalid_promql{",
      threshold: 1,
    });

    const parsed = JSON.parse(getTextContent(result));
    // Alert is still created — validation is informational
    expect(parsed.status).toBe("created");
    expect(parsed.metricValidation.valid).toBe(false);
    expect(parsed.metricValidation.error).toContain("parse error");
  });

  test("response echoes datasourceUid for confirmation", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-ds", title: "DS Check" });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-ds", {
      title: "DS Check",
      datasourceUid: "my-prometheus",
      expr: "up",
      threshold: 0,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.datasourceUid).toBe("my-prometheus");
  });

  test("validation runs the evaluated expression (with rate wrapping)", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-rv", title: "Rate Val" });
    queryPrometheusMock.mockResolvedValueOnce({ data: { result: [{ value: [0, "0.5"] }] } });

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-rv", {
      title: "Rate Val",
      datasourceUid: "prom1",
      expr: "http_requests_total",
      threshold: 100,
      evaluation: "rate",
      evaluationWindow: "5m",
    });

    // Validation should query the wrapped expression, not the raw one
    expect(queryPrometheusMock).toHaveBeenCalledWith("prom1", "rate(http_requests_total[5m])");
  });

  test("alert is still created when validation throws (allSettled resilience)", async () => {
    listFoldersMock.mockResolvedValueOnce([{ uid: "f1", title: "Grafana Lens Alerts" }]);
    createAlertRuleMock.mockResolvedValueOnce({ uid: "alert-resilient", title: "Resilient" });
    // Simulate validation timeout/crash — Promise rejects with unhandled error
    queryPrometheusMock.mockRejectedValueOnce(new Error("timeout of 30000ms exceeded"));

    const tool = createAlertToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-resilient", {
      title: "Resilient",
      datasourceUid: "prom1",
      expr: "some_metric",
      threshold: 100,
    });

    const parsed = JSON.parse(getTextContent(result));
    // Alert must still be created
    expect(parsed.status).toBe("created");
    expect(parsed.uid).toBe("alert-resilient");
    // Validation reports the failure gracefully
    expect(parsed.metricValidation.valid).toBe(false);
    expect(parsed.metricValidation.error).toContain("timeout");
  });
});

// ── wrapExpression unit tests ────────────────────────────────────────

describe("wrapExpression", () => {
  test("instant returns expression unchanged", () => {
    expect(wrapExpression("my_metric", "instant", "5m")).toBe("my_metric");
  });

  test("rate wraps in rate()", () => {
    expect(wrapExpression("http_requests_total", "rate", "5m")).toBe("rate(http_requests_total[5m])");
  });

  test("increase wraps in increase()", () => {
    expect(wrapExpression("tokens_total", "increase", "1h")).toBe("increase(tokens_total[1h])");
  });

  test("handles complex expressions", () => {
    expect(wrapExpression('sum(errors_total{job="api"})', "rate", "10m")).toBe(
      'rate(sum(errors_total{job="api"})[10m])',
    );
  });
});
