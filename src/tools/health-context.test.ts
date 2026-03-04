import { describe, expect, test } from "vitest";
import { getHealthContext, extractMetricName, _HEALTH_RULES } from "./health-context.js";

describe("extractMetricName", () => {
  test("plain metric name", () => {
    expect(extractMetricName("openclaw_lens_queue_depth")).toBe("openclaw_lens_queue_depth");
  });

  test("metric with label selector", () => {
    expect(extractMetricName('openclaw_lens_sessions_active{state="running"}')).toBe("openclaw_lens_sessions_active");
  });

  test("metric with empty selector", () => {
    expect(extractMetricName("openclaw_lens_queue_depth{}")).toBe("openclaw_lens_queue_depth");
  });

  test("complex expression returns undefined", () => {
    expect(extractMetricName("rate(openclaw_lens_tokens_total[5m])")).toBeUndefined();
  });

  test("binary expression returns undefined", () => {
    expect(extractMetricName("metric_a + metric_b")).toBeUndefined();
  });

  test("aggregation returns undefined", () => {
    expect(extractMetricName("sum(openclaw_lens_queue_depth)")).toBeUndefined();
  });
});

describe("getHealthContext", () => {
  test("returns undefined for unknown metrics", () => {
    expect(getHealthContext("some_random_metric", "42")).toBeUndefined();
  });

  test("returns undefined for complex expressions", () => {
    expect(getHealthContext("rate(openclaw_lens_queue_depth[5m])", "5")).toBeUndefined();
  });

  test("returns undefined for NaN values", () => {
    expect(getHealthContext("openclaw_lens_queue_depth", "NaN")).toBeUndefined();
  });

  test("returns undefined for +Inf values", () => {
    expect(getHealthContext("openclaw_lens_queue_depth", "+Inf")).toBeUndefined();
  });

  test("returns undefined for -Inf values", () => {
    expect(getHealthContext("openclaw_lens_cache_read_ratio", "-Inf")).toBeUndefined();
  });

  // ── higher_is_worse metrics ──

  test("queue_depth = 0 → healthy", () => {
    const ctx = getHealthContext("openclaw_lens_queue_depth", "0");
    expect(ctx).toBeDefined();
    expect(ctx!.status).toBe("healthy");
    expect(ctx!.direction).toBe("higher_is_worse");
  });

  test("queue_depth = 10 → warning (at threshold)", () => {
    const ctx = getHealthContext("openclaw_lens_queue_depth", "10");
    expect(ctx!.status).toBe("warning");
  });

  test("queue_depth = 50 → critical (at threshold)", () => {
    const ctx = getHealthContext("openclaw_lens_queue_depth", "50");
    expect(ctx!.status).toBe("critical");
  });

  test("queue_depth = 100 → critical (above threshold)", () => {
    const ctx = getHealthContext("openclaw_lens_queue_depth", "100");
    expect(ctx!.status).toBe("critical");
  });

  test("sessions_stuck = 0 → healthy", () => {
    const ctx = getHealthContext("openclaw_lens_sessions_stuck", "0");
    expect(ctx!.status).toBe("healthy");
  });

  test("sessions_stuck = 1 → warning", () => {
    const ctx = getHealthContext("openclaw_lens_sessions_stuck", "1");
    expect(ctx!.status).toBe("warning");
  });

  test("sessions_stuck = 5 → critical", () => {
    const ctx = getHealthContext("openclaw_lens_sessions_stuck", "5");
    expect(ctx!.status).toBe("critical");
  });

  test("daily_cost_usd = 3 → healthy", () => {
    const ctx = getHealthContext("openclaw_lens_daily_cost_usd", "3");
    expect(ctx!.status).toBe("healthy");
  });

  test("daily_cost_usd = 7 → warning", () => {
    const ctx = getHealthContext("openclaw_lens_daily_cost_usd", "7");
    expect(ctx!.status).toBe("warning");
  });

  test("daily_cost_usd = 25 → critical", () => {
    const ctx = getHealthContext("openclaw_lens_daily_cost_usd", "25");
    expect(ctx!.status).toBe("critical");
  });

  // ── lower_is_worse metrics ──

  test("cache_read_ratio = 0.5 → healthy", () => {
    const ctx = getHealthContext("openclaw_lens_cache_read_ratio", "0.5");
    expect(ctx!.status).toBe("healthy");
    expect(ctx!.direction).toBe("lower_is_worse");
  });

  test("cache_read_ratio = 0.2 → warning", () => {
    const ctx = getHealthContext("openclaw_lens_cache_read_ratio", "0.2");
    expect(ctx!.status).toBe("warning");
  });

  test("cache_read_ratio = 0.05 → critical", () => {
    const ctx = getHealthContext("openclaw_lens_cache_read_ratio", "0.05");
    expect(ctx!.status).toBe("critical");
  });

  test("cache_read_ratio = 0.3 → warning (at threshold)", () => {
    const ctx = getHealthContext("openclaw_lens_cache_read_ratio", "0.3");
    expect(ctx!.status).toBe("warning");
  });

  test("cache_read_ratio = 0.1 → critical (at threshold)", () => {
    const ctx = getHealthContext("openclaw_lens_cache_read_ratio", "0.1");
    expect(ctx!.status).toBe("critical");
  });

  // ── Response shape ──

  test("response includes thresholds and description", () => {
    const ctx = getHealthContext("openclaw_lens_queue_depth", "5");
    expect(ctx).toEqual({
      status: "healthy",
      thresholds: { warning: 10, critical: 50 },
      description: "Message queue depth — messages waiting for processing",
      direction: "higher_is_worse",
    });
  });

  // ── Metric with label selector ──

  test("works with label selector syntax", () => {
    const ctx = getHealthContext('openclaw_lens_tool_loops_active{level="critical"}', "2");
    expect(ctx!.status).toBe("warning");
  });

  // ── All rules are covered ──

  test("all health rules have valid thresholds", () => {
    for (const [name, rule] of Object.entries(_HEALTH_RULES)) {
      expect(rule.warning, `${name} warning`).toBeTypeOf("number");
      expect(rule.critical, `${name} critical`).toBeTypeOf("number");
      expect(rule.description, `${name} description`).toBeTruthy();
      expect(["higher_is_worse", "lower_is_worse"]).toContain(rule.direction);
      if (rule.direction === "higher_is_worse") {
        expect(rule.critical, `${name}: critical >= warning`).toBeGreaterThanOrEqual(rule.warning);
      } else {
        expect(rule.critical, `${name}: critical <= warning`).toBeLessThanOrEqual(rule.warning);
      }
    }
  });
});
