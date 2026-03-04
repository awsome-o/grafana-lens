import { afterEach, describe, expect, test, vi } from "vitest";
import type { Meter, Counter as OtelCounter } from "@opentelemetry/api";
import { CustomMetricsStore, normalizeMetricName, getPromQLName } from "./custom-metrics-store.js";
import type { OtlpJsonWriter } from "./otlp-json-writer.js";

// ── Mock Meter ──────────────────────────────────────────────────────

type MockGaugeEntry = {
  callbacks: Array<(result: { observe: (value: number, attrs?: Record<string, string>) => void }) => void>;
};

function makeMockMeter() {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const gauges = new Map<string, MockGaugeEntry>();

  const meter = {
    createCounter(name: string) {
      const mock = { add: vi.fn() };
      counters.set(name, mock);
      return mock as unknown as OtelCounter;
    },
    createObservableGauge(name: string) {
      const entry: MockGaugeEntry = { callbacks: [] };
      gauges.set(name, entry);
      return {
        addCallback(cb: MockGaugeEntry["callbacks"][0]) {
          entry.callbacks.push(cb);
        },
      };
    },
    // Unused but required by Meter interface
    createHistogram: vi.fn(),
    createUpDownCounter: vi.fn(),
    createObservableCounter: vi.fn(),
    createObservableUpDownCounter: vi.fn(),
  } as unknown as Meter;

  return { meter, counters, gauges };
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeStore(opts?: { limits?: { maxMetrics?: number; maxLabelsPerMetric?: number; maxLabelValues?: number } }) {
  const { meter, counters, gauges } = makeMockMeter();
  const logger = makeLogger();
  const forceFlush = vi.fn().mockResolvedValue(undefined);
  const store = new CustomMetricsStore(meter, forceFlush, "/tmp/custom-metrics-test", logger, opts?.limits);
  return { store, logger, counters, gauges, forceFlush };
}

/**
 * Collect observable gauge values by triggering all callbacks.
 * Returns a map of attribute-key → value for the given metric name.
 */
function collectGaugeValues(gauges: Map<string, MockGaugeEntry>, name: string): Array<{ value: number; attrs: Record<string, string> }> {
  const entry = gauges.get(name);
  if (!entry) return [];
  const results: Array<{ value: number; attrs: Record<string, string> }> = [];
  for (const cb of entry.callbacks) {
    cb({
      observe(value: number, attrs?: Record<string, string>) {
        results.push({ value, attrs: attrs ?? {} });
      },
    });
  }
  return results;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("normalizeMetricName", () => {
  test("leaves prefixed names unchanged", () => {
    const result = normalizeMetricName("openclaw_ext_my_metric");
    expect(result).toEqual({ normalized: "openclaw_ext_my_metric", wasAutoPrepended: false });
  });

  test("auto-prepends prefix when missing", () => {
    const result = normalizeMetricName("my_metric");
    expect(result).toEqual({ normalized: "openclaw_ext_my_metric", wasAutoPrepended: true });
  });
});

describe("getPromQLName", () => {
  test("counter gets _total suffix", () => {
    expect(getPromQLName("openclaw_ext_events", "counter")).toBe("openclaw_ext_events_total");
  });

  test("counter already ending with _total is not doubled", () => {
    expect(getPromQLName("openclaw_ext_events_total", "counter")).toBe("openclaw_ext_events_total");
  });

  test("gauge is unchanged", () => {
    expect(getPromQLName("openclaw_ext_steps", "gauge")).toBe("openclaw_ext_steps");
  });
});

describe("CustomMetricsStore — registration", () => {
  test("creates a gauge metric", () => {
    const { store } = makeStore();
    const def = store.registerMetric({
      name: "openclaw_ext_test_gauge",
      type: "gauge",
      help: "A test gauge",
      labelNames: [],
    });

    expect(def.name).toBe("openclaw_ext_test_gauge");
    expect(def.type).toBe("gauge");
    expect(store.listMetrics()).toHaveLength(1);
  });

  test("creates a counter metric", () => {
    const { store } = makeStore();
    const def = store.registerMetric({
      name: "openclaw_ext_test_counter",
      type: "counter",
      help: "A test counter",
      labelNames: ["method"],
    });

    expect(def.type).toBe("counter");
    expect(def.labelNames).toEqual(["method"]);
  });

  test("rejects names with hyphens", () => {
    const { store } = makeStore();
    expect(() =>
      store.registerMetric({ name: "openclaw_ext_bad-name", type: "gauge", help: "test", labelNames: [] }),
    ).toThrow("Invalid metric name");
  });

  test("rejects names with dots", () => {
    const { store } = makeStore();
    expect(() =>
      store.registerMetric({ name: "openclaw_ext_bad.name", type: "gauge", help: "test", labelNames: [] }),
    ).toThrow("Invalid metric name");
  });

  test("rejects names with leading numbers after prefix", () => {
    const { store } = makeStore();
    expect(() =>
      store.registerMetric({ name: "openclaw_ext_1bad", type: "gauge", help: "test", labelNames: [] }),
    ).toThrow("Invalid metric name");
  });

  test("rejects names without prefix", () => {
    const { store } = makeStore();
    expect(() =>
      store.registerMetric({ name: "my_metric", type: "gauge", help: "test", labelNames: [] }),
    ).toThrow("Invalid metric name");
  });

  test("rejects too many label names", () => {
    const { store } = makeStore({ limits: { maxLabelsPerMetric: 2 } });
    expect(() =>
      store.registerMetric({
        name: "openclaw_ext_too_many",
        type: "gauge",
        help: "test",
        labelNames: ["a", "b", "c"],
      }),
    ).toThrow("Too many labels");
  });

  test("rejects invalid label names (hyphens)", () => {
    const { store } = makeStore();
    expect(() =>
      store.registerMetric({
        name: "openclaw_ext_bad_label",
        type: "gauge",
        help: "test",
        labelNames: ["bad-label"],
      }),
    ).toThrow("Invalid label name");
  });

  test("idempotent re-registration with same type", () => {
    const { store } = makeStore();
    store.registerMetric({ name: "openclaw_ext_idem", type: "gauge", help: "test", labelNames: [] });
    const def2 = store.registerMetric({ name: "openclaw_ext_idem", type: "gauge", help: "test", labelNames: [] });

    expect(def2.name).toBe("openclaw_ext_idem");
    expect(store.listMetrics()).toHaveLength(1);
  });

  test("type conflict error on re-registration", () => {
    const { store } = makeStore();
    store.registerMetric({ name: "openclaw_ext_conflict", type: "gauge", help: "test", labelNames: [] });

    expect(() =>
      store.registerMetric({ name: "openclaw_ext_conflict", type: "counter", help: "test", labelNames: [] }),
    ).toThrow("already registered as gauge, cannot re-register as counter");
  });

  test("rejects over max custom metrics", () => {
    const { store } = makeStore({ limits: { maxMetrics: 2 } });
    store.registerMetric({ name: "openclaw_ext_one", type: "gauge", help: "test", labelNames: [] });
    store.registerMetric({ name: "openclaw_ext_two", type: "gauge", help: "test", labelNames: [] });

    expect(() =>
      store.registerMetric({ name: "openclaw_ext_three", type: "gauge", help: "test", labelNames: [] }),
    ).toThrow("Maximum custom metrics reached");
  });
});

describe("CustomMetricsStore — push", () => {
  test("sets gauge values (via ObservableGauge callback)", () => {
    const { store, gauges } = makeStore();
    store.pushValues([{ name: "openclaw_ext_temperature", value: 22.5 }]);

    const values = collectGaugeValues(gauges, "openclaw_ext_temperature");
    expect(values).toEqual([{ value: 22.5, attrs: {} }]);
  });

  test("increments counter values", () => {
    const { store, counters } = makeStore();
    store.registerMetric({ name: "openclaw_ext_events", type: "counter", help: "events", labelNames: [] });
    store.pushValues([{ name: "openclaw_ext_events", value: 5, type: "counter" }]);

    const counter = counters.get("openclaw_ext_events");
    expect(counter?.add).toHaveBeenCalledWith(5, {});
  });

  test("rejects negative counter increment", () => {
    const { store } = makeStore();
    store.registerMetric({ name: "openclaw_ext_bad_counter", type: "counter", help: "test", labelNames: [] });

    const result = store.pushValues([{ name: "openclaw_ext_bad_counter", value: -1, type: "counter" }]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("Counter values must be >= 0");
  });

  test("rejects NaN values", () => {
    const { store } = makeStore();
    const result = store.pushValues([{ name: "openclaw_ext_nan_test", value: NaN }]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("finite number");
  });

  test("rejects Infinity values", () => {
    const { store } = makeStore();
    const result = store.pushValues([{ name: "openclaw_ext_inf_test", value: Infinity }]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("finite number");
  });

  test("auto-registers unknown metrics as gauge", () => {
    const { store, gauges } = makeStore();
    store.pushValues([{ name: "openclaw_ext_auto_registered", value: 42 }]);

    expect(store.listMetrics()).toHaveLength(1);
    expect(store.listMetrics()[0].type).toBe("gauge");

    const values = collectGaugeValues(gauges, "openclaw_ext_auto_registered");
    expect(values).toEqual([{ value: 42, attrs: {} }]);
  });

  test("auto-prepends prefix when pushing", () => {
    const { store } = makeStore();
    store.pushValues([{ name: "steps_today", value: 8000 }]);

    const defs = store.listMetrics();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("openclaw_ext_steps_today");
  });

  test("rejects labels not in declared labelNames", () => {
    const { store } = makeStore();
    store.registerMetric({
      name: "openclaw_ext_labeled",
      type: "gauge",
      help: "test",
      labelNames: ["region"],
    });

    const result = store.pushValues([
      { name: "openclaw_ext_labeled", value: 1, labels: { region: "us", extra: "bad" } },
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("Label mismatch");
    expect(result.rejected[0].reason).toContain("delete the metric first");
  });

  test("rejects missing labels from declared set", () => {
    const { store } = makeStore();
    store.registerMetric({
      name: "openclaw_ext_needs_labels",
      type: "gauge",
      help: "test",
      labelNames: ["a", "b"],
    });

    const result = store.pushValues([
      { name: "openclaw_ext_needs_labels", value: 1, labels: { a: "val" } },
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("missing: [b]");
    expect(result.rejected[0].reason).toContain("delete the metric first");
  });

  test("rejects cardinality overflow", () => {
    const { store } = makeStore({ limits: { maxLabelValues: 2 } });
    store.registerMetric({
      name: "openclaw_ext_high_card",
      type: "gauge",
      help: "test",
      labelNames: ["id"],
    });

    store.pushValues([
      { name: "openclaw_ext_high_card", value: 1, labels: { id: "a" } },
      { name: "openclaw_ext_high_card", value: 2, labels: { id: "b" } },
    ]);

    const result = store.pushValues([
      { name: "openclaw_ext_high_card", value: 3, labels: { id: "c" } },
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("Cardinality limit");
  });

  test("partial success — accepts some, rejects others", () => {
    const { store } = makeStore();
    const result = store.pushValues([
      { name: "openclaw_ext_good", value: 1 },
      { name: "openclaw_ext_bad", value: NaN },
      { name: "openclaw_ext_also_good", value: 2 },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe("openclaw_ext_bad");
  });

  test("pushValues returns queryNames map", () => {
    const { store } = makeStore();
    store.registerMetric({ name: "openclaw_ext_events", type: "counter", help: "events", labelNames: [] });
    const result = store.pushValues([
      { name: "openclaw_ext_steps", value: 8000 },
      { name: "openclaw_ext_events", value: 5, type: "counter" },
    ]);

    expect(result.queryNames).toEqual({
      openclaw_ext_steps: "openclaw_ext_steps",
      openclaw_ext_events: "openclaw_ext_events_total",
    });
  });

  test("queryNames excludes rejected metrics", () => {
    const { store } = makeStore();
    const result = store.pushValues([
      { name: "openclaw_ext_good", value: 1 },
      { name: "openclaw_ext_bad", value: NaN },
    ]);

    expect(result.queryNames).toEqual({ openclaw_ext_good: "openclaw_ext_good" });
    expect(result.queryNames).not.toHaveProperty("openclaw_ext_bad");
  });

  test("pushes with labels correctly (gauge)", () => {
    const { store, gauges } = makeStore();
    store.pushValues([
      { name: "openclaw_ext_by_region", value: 100, labels: { region: "us" } },
      { name: "openclaw_ext_by_region", value: 200, labels: { region: "eu" } },
    ]);

    const values = collectGaugeValues(gauges, "openclaw_ext_by_region");
    expect(values).toContainEqual({ value: 100, attrs: { region: "us" } });
    expect(values).toContainEqual({ value: 200, attrs: { region: "eu" } });
  });
});

describe("CustomMetricsStore — list / delete", () => {
  test("listMetrics returns all definitions", () => {
    const { store } = makeStore();
    store.registerMetric({ name: "openclaw_ext_a", type: "gauge", help: "a", labelNames: [] });
    store.registerMetric({ name: "openclaw_ext_b", type: "counter", help: "b", labelNames: [] });

    const list = store.listMetrics();
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.name).sort()).toEqual(["openclaw_ext_a", "openclaw_ext_b"]);
  });

  test("deleteMetric removes from store (gauge callback becomes inert)", () => {
    const { store, gauges } = makeStore();
    store.pushValues([{ name: "openclaw_ext_deletable", value: 42 }]);
    expect(store.listMetrics()).toHaveLength(1);

    const deleted = store.deleteMetric("openclaw_ext_deletable");
    expect(deleted).toBe(true);
    expect(store.listMetrics()).toHaveLength(0);

    // Gauge callback should now return nothing (inert)
    const values = collectGaugeValues(gauges, "openclaw_ext_deletable");
    expect(values).toEqual([]);
  });

  test("deleteMetric returns false for unknown metric", () => {
    const { store } = makeStore();
    expect(store.deleteMetric("openclaw_ext_nonexistent")).toBe(false);
  });

  test("deleteMetric accepts name without prefix", () => {
    const { store } = makeStore();
    store.pushValues([{ name: "openclaw_ext_removeme", value: 1 }]);
    expect(store.deleteMetric("removeme")).toBe(true);
    expect(store.listMetrics()).toHaveLength(0);
  });
});

describe("CustomMetricsStore — persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("load handles ENOENT gracefully", async () => {
    const { meter } = makeMockMeter();
    const logger = makeLogger();
    const forceFlush = vi.fn().mockResolvedValue(undefined);
    // Use a path that definitely doesn't exist
    const store = new CustomMetricsStore(meter, forceFlush, "/nonexistent/path", logger);
    await store.load();
    expect(store.listMetrics()).toHaveLength(0);
  });

  test("flush writes to state dir", async () => {
    const { store } = makeStore();
    store.pushValues([{ name: "openclaw_ext_persistent", value: 99 }]);

    // flush() uses real fs in this integration test — verify it doesn't throw
    await store.flush();
  });
});

describe("CustomMetricsStore — TTL eviction", () => {
  test("evicts expired metrics on listMetrics", () => {
    const { store } = makeStore();

    store.registerMetric({
      name: "openclaw_ext_will_expire",
      type: "gauge",
      help: "test",
      labelNames: [],
      ttlMs: 1,
    });

    expect(store.listMetrics()).toHaveLength(1);

    // Manually make it expired by setting updatedAt in the past
    const def = store.listMetrics()[0];
    (def as { updatedAt: number }).updatedAt = Date.now() - 100;

    // Now listMetrics should evict it
    const afterEviction = store.listMetrics();
    expect(afterEviction).toHaveLength(0);
  });
});

describe("CustomMetricsStore — forceFlush", () => {
  test("delegates to provided forceFlush function", async () => {
    const { store, forceFlush } = makeStore();
    await store.forceFlush();
    expect(forceFlush).toHaveBeenCalledTimes(1);
  });
});

describe("CustomMetricsStore — trackPush", () => {
  test("increments counter with accepted and rejected counts", () => {
    const { meter, counters } = makeMockMeter();
    const logger = makeLogger();
    const forceFlush = vi.fn().mockResolvedValue(undefined);
    const pushCounter = meter.createCounter("openclaw_lens_custom_metrics_pushed_total");

    const store = new CustomMetricsStore(meter, forceFlush, "/tmp/test", logger, undefined, null, pushCounter);
    store.trackPush(3, 1);

    const counter = counters.get("openclaw_lens_custom_metrics_pushed_total");
    expect(counter?.add).toHaveBeenCalledWith(3, { status: "accepted" });
    expect(counter?.add).toHaveBeenCalledWith(1, { status: "rejected" });
  });

  test("skips zero counts", () => {
    const { meter, counters } = makeMockMeter();
    const logger = makeLogger();
    const forceFlush = vi.fn().mockResolvedValue(undefined);
    const pushCounter = meter.createCounter("openclaw_lens_custom_metrics_pushed_total");

    const store = new CustomMetricsStore(meter, forceFlush, "/tmp/test", logger, undefined, null, pushCounter);
    store.trackPush(5, 0);

    const counter = counters.get("openclaw_lens_custom_metrics_pushed_total");
    expect(counter?.add).toHaveBeenCalledTimes(1);
    expect(counter?.add).toHaveBeenCalledWith(5, { status: "accepted" });
  });

  test("no-ops when no pushCounter provided", () => {
    const { store } = makeStore(); // no pushCounter
    // Should not throw
    store.trackPush(3, 1);
  });
});

describe("CustomMetricsStore — label key ordering", () => {
  test("different key order does not create duplicate gauge entries", () => {
    const { store, gauges } = makeStore();
    store.registerMetric({
      name: "openclaw_ext_ordered",
      type: "gauge",
      help: "test",
      labelNames: ["a", "b"],
    });

    store.pushValues([{ name: "openclaw_ext_ordered", value: 1, labels: { a: "1", b: "2" } }]);
    store.pushValues([{ name: "openclaw_ext_ordered", value: 99, labels: { b: "2", a: "1" } }]);

    // Should have single entry with overwritten value (99), not two entries
    const values = collectGaugeValues(gauges, "openclaw_ext_ordered");
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe(99);
  });

  test("different key order does not inflate cardinality", () => {
    const { store } = makeStore({ limits: { maxLabelValues: 2 } });
    store.registerMetric({
      name: "openclaw_ext_card_test",
      type: "gauge",
      help: "test",
      labelNames: ["x", "y"],
    });

    store.pushValues([{ name: "openclaw_ext_card_test", value: 1, labels: { x: "1", y: "2" } }]);
    store.pushValues([{ name: "openclaw_ext_card_test", value: 2, labels: { y: "2", x: "1" } }]);

    // Both pushes represent the same label combo — cardinality should be 1, not 2
    // A third push with genuinely different labels should still succeed (capacity: 2)
    const result = store.pushValues([
      { name: "openclaw_ext_card_test", value: 3, labels: { x: "3", y: "4" } },
    ]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("persistence roundtrip preserves label key consistency", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cms-label-test-"));

    // Create store 1, push with {b,a} order, flush
    const { meter: m1 } = makeMockMeter();
    const store1 = new CustomMetricsStore(m1, vi.fn().mockResolvedValue(undefined), tmpDir, makeLogger());
    store1.registerMetric({ name: "openclaw_ext_roundtrip", type: "gauge", help: "test", labelNames: ["a", "b"] });
    store1.pushValues([{ name: "openclaw_ext_roundtrip", value: 42, labels: { b: "2", a: "1" } }]);
    await store1.flush();

    // Create store 2, load from disk, push with {a,b} order
    const { meter: m2, gauges: g2 } = makeMockMeter();
    const store2 = new CustomMetricsStore(m2, vi.fn().mockResolvedValue(undefined), tmpDir, makeLogger());
    await store2.load();
    store2.pushValues([{ name: "openclaw_ext_roundtrip", value: 99, labels: { a: "1", b: "2" } }]);

    // Should be single value (overwritten), not two
    const values = collectGaugeValues(g2, "openclaw_ext_roundtrip");
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe(99);

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Timestamped push tests ──────────────────────────────────────────

function makeMockWriter() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    buildPayload: vi.fn(),
  } as unknown as OtlpJsonWriter & { write: ReturnType<typeof vi.fn> };
}

function makeStoreWithWriter(opts?: { limits?: { maxMetrics?: number; maxLabelsPerMetric?: number; maxLabelValues?: number } }) {
  const { meter, counters, gauges } = makeMockMeter();
  const logger = makeLogger();
  const forceFlush = vi.fn().mockResolvedValue(undefined);
  const writer = makeMockWriter();
  const store = new CustomMetricsStore(meter, forceFlush, "/tmp/custom-metrics-test", logger, opts?.limits, writer);
  return { store, logger, counters, gauges, forceFlush, writer };
}

describe("CustomMetricsStore — pushTimestampedValues", () => {
  test("pushes gauge values with timestamps via OtlpJsonWriter", async () => {
    const { store, writer } = makeStoreWithWriter();

    const result = await store.pushTimestampedValues([
      { name: "steps", value: 8000, timestamp: "2025-01-15" },
      { name: "steps", value: 10500, timestamp: "2025-01-16" },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.rejected).toHaveLength(0);
    expect(writer.write).toHaveBeenCalledTimes(1);

    const samples = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(samples).toHaveLength(2);
    expect(samples[0].metricName).toBe("openclaw_ext_steps");
    expect(samples[0].value).toBe(8000);
    expect(samples[1].value).toBe(10500);
  });

  test("rejects counters with timestamps", async () => {
    const { store, writer } = makeStoreWithWriter();

    const result = await store.pushTimestampedValues([
      { name: "events", value: 5, type: "counter", timestamp: "2025-01-15" },
    ]);

    expect(result.accepted).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("Timestamped pushes only support gauge type");
    expect(writer.write).not.toHaveBeenCalled();
  });

  test("rejects invalid timestamps", async () => {
    const { store } = makeStoreWithWriter();

    const result = await store.pushTimestampedValues([
      { name: "steps", value: 8000, timestamp: "not-a-date" },
    ]);

    expect(result.accepted).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("Invalid timestamp");
    expect(result.rejected[0].reason).toContain("ISO 8601");
  });

  test("registers metric in store definitions", async () => {
    const { store } = makeStoreWithWriter();

    await store.pushTimestampedValues([
      { name: "weight_kg", value: 72.5, timestamp: "2025-01-15" },
    ]);

    const defs = store.listMetrics();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("openclaw_ext_weight_kg");
    expect(defs[0].type).toBe("gauge");
  });

  test("does not update OTel gauge value maps", async () => {
    const { store, gauges } = makeStoreWithWriter();

    await store.pushTimestampedValues([
      { name: "steps", value: 8000, timestamp: "2025-01-15" },
    ]);

    // Gauge callback should report nothing (no value set in OTel maps)
    const values = collectGaugeValues(gauges, "openclaw_ext_steps");
    expect(values).toEqual([]);
  });

  test("returns queryNames for accepted metrics", async () => {
    const { store } = makeStoreWithWriter();

    const result = await store.pushTimestampedValues([
      { name: "steps", value: 8000, timestamp: "2025-01-15" },
    ]);

    expect(result.queryNames).toEqual({
      openclaw_ext_steps: "openclaw_ext_steps",
    });
  });

  test("handles partial success", async () => {
    const { store } = makeStoreWithWriter();

    const result = await store.pushTimestampedValues([
      { name: "steps", value: 8000, timestamp: "2025-01-15" },
      { name: "bad_metric", value: NaN, timestamp: "2025-01-15" },
      { name: "weight", value: 72.5, timestamp: "2025-01-16" },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe("bad_metric");
  });

  test("parses full ISO 8601 timestamps with time", async () => {
    const { store, writer } = makeStoreWithWriter();

    await store.pushTimestampedValues([
      { name: "heart_rate", value: 72, timestamp: "2025-01-15T14:30:00Z" },
    ]);

    const samples = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(samples[0].timestampMs).toBe(new Date("2025-01-15T14:30:00Z").getTime());
  });

  test("throws when no OtlpJsonWriter configured", async () => {
    const { store } = makeStore(); // no writer

    await expect(
      store.pushTimestampedValues([{ name: "steps", value: 8000, timestamp: "2025-01-15" }]),
    ).rejects.toThrow("OtlpJsonWriter");
  });

  test("validates labels on timestamped pushes", async () => {
    const { store } = makeStoreWithWriter();

    // First push registers with no labels
    await store.pushTimestampedValues([
      { name: "steps", value: 8000, timestamp: "2025-01-15" },
    ]);

    // Second push with extra labels should be rejected
    const result = await store.pushTimestampedValues([
      { name: "steps", value: 9000, labels: { extra: "bad" }, timestamp: "2025-01-16" },
    ]);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("Label mismatch");
  });

  test("rejects pre-registered counter even when point.type is omitted", async () => {
    const { store } = makeStoreWithWriter();

    // Pre-register as counter via real-time push
    store.pushValues([{ name: "events", type: "counter", value: 5 }]);

    // Timestamped push without type — should still be rejected because def.type is "counter"
    const result = await store.pushTimestampedValues([
      { name: "events", value: 3, timestamp: "2025-01-15" },
    ]);

    expect(result.accepted).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("gauge type");
  });

  test("skips OtlpJsonWriter.write when all points rejected", async () => {
    const { store, writer } = makeStoreWithWriter();

    await store.pushTimestampedValues([
      { name: "events", value: 5, type: "counter", timestamp: "2025-01-15" },
    ]);

    expect(writer.write).not.toHaveBeenCalled();
  });

  test("sorts accepted samples chronologically before writing", async () => {
    const { store, writer } = makeStoreWithWriter();

    // Push out-of-order: Jan 5, Jan 1, Jan 3
    await store.pushTimestampedValues([
      { name: "steps", value: 5000, timestamp: "2025-01-05" },
      { name: "steps", value: 1000, timestamp: "2025-01-01" },
      { name: "steps", value: 3000, timestamp: "2025-01-03" },
    ]);

    expect(writer.write).toHaveBeenCalledTimes(1);
    const samples = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(samples).toHaveLength(3);

    // Should be sorted: Jan 1, Jan 3, Jan 5
    expect(samples[0].timestampMs).toBe(new Date("2025-01-01").getTime());
    expect(samples[1].timestampMs).toBe(new Date("2025-01-03").getTime());
    expect(samples[2].timestampMs).toBe(new Date("2025-01-05").getTime());

    expect(samples[0].value).toBe(1000);
    expect(samples[1].value).toBe(3000);
    expect(samples[2].value).toBe(5000);
  });
});
