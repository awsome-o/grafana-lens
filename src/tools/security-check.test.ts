import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const mockListDatasources = vi.hoisted(() => vi.fn());
const mockQueryPrometheus = vi.hoisted(() => vi.fn());
const mockQueryLokiRange = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: vi.fn().mockImplementation(() => ({
    listDatasources: mockListDatasources,
    queryPrometheus: mockQueryPrometheus,
    queryLokiRange: mockQueryLokiRange,
    getUrl: () => "http://localhost:3000",
  })),
}));

// ── Import after mocks ──────────────────────────────────────────────

import { createSecurityCheckToolFactory } from "./security-check.js";
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

/** Build a Prometheus instant query result with a scalar value. */
function promResult(value: number) {
  return { data: { result: [{ value: [Date.now() / 1000, String(value)] }] } };
}

describe("grafana_security_check", () => {
  let tool: ReturnType<ReturnType<typeof createSecurityCheckToolFactory>>;

  beforeEach(() => {
    mockListDatasources.mockReset();
    mockQueryPrometheus.mockReset();
    mockQueryLokiRange.mockReset();

    mockListDatasources.mockResolvedValue([
      { uid: "prom-1", name: "Prometheus", type: "prometheus", url: "" },
      { uid: "loki-1", name: "Loki", type: "loki", url: "" },
    ]);

    // Default: all checks return healthy values
    mockQueryPrometheus.mockResolvedValue(promResult(0));
    mockQueryLokiRange.mockResolvedValue({ data: { result: [] } });

    const factory = createSecurityCheckToolFactory(makeRegistry());
    tool = factory(undefined) as typeof tool;
  });

  test("returns green when all metrics are healthy", async () => {
    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.overallThreatLevel).toBe("green");
    expect(parsed.checks).toHaveLength(6);
    for (const check of parsed.checks) {
      expect(check.status).toBe("green");
    }
    expect(parsed.dashboardTemplate).toBe("security-overview");
  });

  test("returns yellow for moderate threats", async () => {
    // Webhook error ratio = 0.25 (above 0.2 warning threshold)
    mockQueryPrometheus
      .mockResolvedValueOnce(promResult(0.25))  // webhook_error_ratio
      .mockResolvedValueOnce(promResult(1.2))    // cost (green)
      .mockResolvedValueOnce(promResult(0))      // tool_loops (green)
      .mockResolvedValueOnce(promResult(2))      // injection_signals (yellow)
      .mockResolvedValueOnce(promResult(5))      // session_enumeration (green)
      .mockResolvedValueOnce(promResult(0));     // stuck_sessions (green)

    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.overallThreatLevel).toBe("yellow");
    const webhookCheck = parsed.checks.find((c: { name: string }) => c.name === "webhook_error_ratio");
    expect(webhookCheck.status).toBe("yellow");
  });

  test("returns red for critical threats", async () => {
    mockQueryPrometheus
      .mockResolvedValueOnce(promResult(0.6))    // webhook_error_ratio (red at 0.5)
      .mockResolvedValueOnce(promResult(100))    // cost (red at 50)
      .mockResolvedValueOnce(promResult(5))      // tool_loops (red at 3)
      .mockResolvedValueOnce(promResult(10))     // injection_signals (red at 5)
      .mockResolvedValueOnce(promResult(300))    // session_enumeration (red at 200)
      .mockResolvedValueOnce(promResult(5));     // stuck_sessions (red at 3)

    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.overallThreatLevel).toBe("red");
    for (const check of parsed.checks) {
      expect(check.status).toBe("red");
    }
  });

  test("handles partial query failure via Promise.allSettled", async () => {
    mockQueryPrometheus
      .mockResolvedValueOnce(promResult(0))      // webhook_error_ratio (ok)
      .mockRejectedValueOnce(new Error("network timeout"))  // cost (fails)
      .mockResolvedValueOnce(promResult(0))      // tool_loops (ok)
      .mockResolvedValueOnce(promResult(0))      // injection_signals (ok)
      .mockResolvedValueOnce(promResult(0))      // session_enumeration (ok)
      .mockResolvedValueOnce(promResult(0));     // stuck_sessions (ok)

    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    // Should still return results, not an error — but failed check is "yellow" (unknown), not "green" (safe)
    expect(parsed.overallThreatLevel).toBe("yellow");
    expect(parsed.checks).toHaveLength(6);
    const costCheck = parsed.checks.find((c: { name: string }) => c.name === "cost_anomaly");
    expect(costCheck.status).toBe("yellow");
    expect(costCheck.value).toBe(-1); // Failed query marker
    expect(costCheck.detail).toContain("Unable to assess");
    expect(parsed.limitations.length).toBeGreaterThan(1);
  });

  test("gracefully handles missing Loki datasource", async () => {
    mockListDatasources.mockResolvedValue([
      { uid: "prom-1", name: "Prometheus", type: "prometheus", url: "" },
      // No Loki
    ]);

    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.overallThreatLevel).toBe("green");
    expect(parsed.limitations).toContain(
      "No Loki datasource — security event log correlation unavailable",
    );
  });

  test("returns error when no Prometheus datasource found", async () => {
    mockListDatasources.mockResolvedValue([]);

    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.error).toContain("No Prometheus datasource found");
  });

  test("passes lookback parameter to injection signals query", async () => {
    await tool.execute("call-1", { lookback: "24h" });

    // The injection_signals query (4th call) should use the lookback
    const calls = mockQueryPrometheus.mock.calls;
    const injectionCall = calls[3]; // 4th PromQL check
    expect(injectionCall[1]).toContain("[24h]");
  });

  test("rejects invalid lookback parameter (PromQL injection prevention)", async () => {
    const result = await tool.execute("call-1", { lookback: '1h])) or vector(999) #' });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.error).toContain("Invalid lookback");
    expect(mockQueryPrometheus).not.toHaveBeenCalled();
  });

  test("accepts valid lookback durations", async () => {
    for (const lb of ["30s", "5m", "1h", "24h", "7d", "4w", "1y"]) {
      mockQueryPrometheus.mockReset();
      mockQueryLokiRange.mockReset();
      mockQueryPrometheus.mockResolvedValue(promResult(0));
      mockQueryLokiRange.mockResolvedValue({ data: { result: [] } });

      const result = await tool.execute("call-1", { lookback: lb });
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.error).toBeUndefined();
    }
  });

  test("includes suggested actions for non-green checks", async () => {
    mockQueryPrometheus
      .mockResolvedValueOnce(promResult(0.3))    // webhook_error_ratio (yellow)
      .mockResolvedValueOnce(promResult(0))
      .mockResolvedValueOnce(promResult(0))
      .mockResolvedValueOnce(promResult(0))
      .mockResolvedValueOnce(promResult(0))
      .mockResolvedValueOnce(promResult(0));

    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.suggestedActions.length).toBeGreaterThan(0);
    expect(parsed.suggestedActions[0]).toContain("webhook");
  });

  test("always includes auth limitation in limitations array", async () => {
    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.limitations[0]).toContain("Auth failures not observable");
  });
});
