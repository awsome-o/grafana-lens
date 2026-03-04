import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  METRIC_DEFINITIONS,
  KNOWN_METRICS_MAP,
  KNOWN_BREAKDOWNS_MAP,
  HEALTH_RULES_MAP,
  DEFINITIONS_BY_OTEL_NAME,
  prometheusName,
  prometheusType,
  type PrometheusMetricType,
} from "./metric-definitions.js";

describe("METRIC_DEFINITIONS", () => {
  test("has at least 30 definitions", () => {
    expect(METRIC_DEFINITIONS.length).toBeGreaterThanOrEqual(30);
  });

  test("all otelNames are unique", () => {
    const names = METRIC_DEFINITIONS.map((d) => d.otelName);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all otelNames start with openclaw_lens_", () => {
    for (const d of METRIC_DEFINITIONS) {
      expect(d.otelName).toMatch(/^openclaw_lens_/);
    }
  });

  test("all definitions have non-empty help text", () => {
    for (const d of METRIC_DEFINITIONS) {
      expect(d.help.length, `${d.otelName} help`).toBeGreaterThan(0);
    }
  });

  test("health thresholds only on gauge-type instruments", () => {
    for (const d of METRIC_DEFINITIONS) {
      if (d.health) {
        expect(
          ["observable_gauge", "updown_counter"],
          `${d.otelName} has health but is ${d.instrument}`,
        ).toContain(d.instrument);
      }
    }
  });

  test("health threshold direction consistency", () => {
    for (const d of METRIC_DEFINITIONS) {
      if (!d.health) continue;
      if (d.health.direction === "higher_is_worse") {
        expect(d.health.critical, `${d.otelName}: critical >= warning`).toBeGreaterThanOrEqual(d.health.warning);
      } else {
        expect(d.health.critical, `${d.otelName}: critical <= warning`).toBeLessThanOrEqual(d.health.warning);
      }
    }
  });
});

describe("prometheusName", () => {
  test("counters get _total suffix", () => {
    const counter = METRIC_DEFINITIONS.find((d) => d.instrument === "counter")!;
    expect(prometheusName(counter)).toBe(`${counter.otelName}_total`);
  });

  test("histograms keep their name", () => {
    const histogram = METRIC_DEFINITIONS.find((d) => d.instrument === "histogram")!;
    expect(prometheusName(histogram)).toBe(histogram.otelName);
  });

  test("observable_gauge keeps its name", () => {
    const gauge = METRIC_DEFINITIONS.find((d) => d.instrument === "observable_gauge")!;
    expect(prometheusName(gauge)).toBe(gauge.otelName);
  });

  test("updown_counter keeps its name", () => {
    const udc = METRIC_DEFINITIONS.find((d) => d.instrument === "updown_counter")!;
    expect(prometheusName(udc)).toBe(udc.otelName);
  });
});

describe("prometheusType", () => {
  const cases: Array<[string, PrometheusMetricType]> = [
    ["counter", "counter"],
    ["histogram", "histogram"],
    ["updown_counter", "gauge"],
    ["observable_gauge", "gauge"],
  ];
  for (const [instrument, expected] of cases) {
    test(`${instrument} → ${expected}`, () => {
      expect(prometheusType(instrument as any)).toBe(expected);
    });
  }
});

describe("KNOWN_METRICS_MAP", () => {
  test("has same count as METRIC_DEFINITIONS", () => {
    expect(KNOWN_METRICS_MAP.size).toBe(METRIC_DEFINITIONS.length);
  });

  test("counter entries have _total suffix", () => {
    const counters = METRIC_DEFINITIONS.filter((d) => d.instrument === "counter");
    for (const c of counters) {
      const promName = `${c.otelName}_total`;
      expect(KNOWN_METRICS_MAP.has(promName), `Missing ${promName}`).toBe(true);
      expect(KNOWN_METRICS_MAP.get(promName)!.type).toBe("counter");
    }
  });

  test("gauge entries have no _total suffix", () => {
    const gauges = METRIC_DEFINITIONS.filter((d) => d.instrument === "observable_gauge" || d.instrument === "updown_counter");
    for (const g of gauges) {
      expect(KNOWN_METRICS_MAP.has(g.otelName), `Missing ${g.otelName}`).toBe(true);
      expect(KNOWN_METRICS_MAP.get(g.otelName)!.type).toBe("gauge");
    }
  });
});

describe("KNOWN_BREAKDOWNS_MAP", () => {
  test("only includes metrics with labels", () => {
    const withLabels = METRIC_DEFINITIONS.filter((d) => d.labels && d.labels.length > 0);
    expect(Object.keys(KNOWN_BREAKDOWNS_MAP).length).toBe(withLabels.length);
  });

  test("all entries are non-empty arrays", () => {
    for (const [name, labels] of Object.entries(KNOWN_BREAKDOWNS_MAP)) {
      expect(Array.isArray(labels), `${name} labels`).toBe(true);
      expect(labels.length, `${name} has labels`).toBeGreaterThan(0);
    }
  });
});

describe("HEALTH_RULES_MAP", () => {
  test("only includes metrics with health definitions", () => {
    const withHealth = METRIC_DEFINITIONS.filter((d) => d.health);
    expect(Object.keys(HEALTH_RULES_MAP).length).toBe(withHealth.length);
  });

  test("all entries have required fields", () => {
    for (const [name, rule] of Object.entries(HEALTH_RULES_MAP)) {
      expect(rule.warning, `${name} warning`).toBeTypeOf("number");
      expect(rule.critical, `${name} critical`).toBeTypeOf("number");
      expect(rule.description, `${name} description`).toBeTruthy();
      expect(["higher_is_worse", "lower_is_worse"]).toContain(rule.direction);
    }
  });

  test("includes queue_depth with correct thresholds", () => {
    expect(HEALTH_RULES_MAP.openclaw_lens_queue_depth).toEqual({
      warning: 10,
      critical: 50,
      description: "Message queue depth — messages waiting for processing",
      direction: "higher_is_worse",
    });
  });
});

describe("DEFINITIONS_BY_OTEL_NAME", () => {
  test("has same count as METRIC_DEFINITIONS", () => {
    expect(DEFINITIONS_BY_OTEL_NAME.size).toBe(METRIC_DEFINITIONS.length);
  });

  test("round-trips correctly", () => {
    for (const d of METRIC_DEFINITIONS) {
      expect(DEFINITIONS_BY_OTEL_NAME.get(d.otelName)).toBe(d);
    }
  });
});

describe("security metric definitions", () => {
  const SECURITY_METRICS = [
    "openclaw_lens_gateway_restarts",
    "openclaw_lens_session_resets",
    "openclaw_lens_tool_error_classes",
    "openclaw_lens_prompt_injection_signals",
    "openclaw_lens_unique_sessions_1h",
  ];

  test("all 5 security metrics are present", () => {
    for (const name of SECURITY_METRICS) {
      expect(DEFINITIONS_BY_OTEL_NAME.has(name), `Missing ${name}`).toBe(true);
    }
  });

  test("security counters have correct instrument type", () => {
    const counters = ["openclaw_lens_gateway_restarts", "openclaw_lens_session_resets",
      "openclaw_lens_tool_error_classes", "openclaw_lens_prompt_injection_signals"];
    for (const name of counters) {
      expect(DEFINITIONS_BY_OTEL_NAME.get(name)!.instrument).toBe("counter");
    }
  });

  test("unique_sessions_1h is an observable_gauge with health thresholds", () => {
    const def = DEFINITIONS_BY_OTEL_NAME.get("openclaw_lens_unique_sessions_1h")!;
    expect(def.instrument).toBe("observable_gauge");
    expect(def.health).toBeDefined();
    expect(def.health!.warning).toBe(50);
    expect(def.health!.critical).toBe(200);
    expect(def.health!.direction).toBe("higher_is_worse");
  });

  test("tool_error_classes has correct labels", () => {
    const def = DEFINITIONS_BY_OTEL_NAME.get("openclaw_lens_tool_error_classes")!;
    expect(def.labels).toEqual(["tool", "error_class"]);
  });

  test("prompt_injection_signals has detector label", () => {
    const def = DEFINITIONS_BY_OTEL_NAME.get("openclaw_lens_prompt_injection_signals")!;
    expect(def.labels).toEqual(["detector"]);
  });
});

describe("consistency: metrics-collector.ts instruments match METRIC_DEFINITIONS", () => {
  // Extract all openclaw_lens_* instrument names from metrics-collector.ts source code.
  // This catches drift: if someone adds a new instrument in metrics-collector without
  // adding it to METRIC_DEFINITIONS, this test fails.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const collectorSrc = readFileSync(join(__dirname, "services/metrics-collector.ts"), "utf-8");

  // Match meter.createCounter("openclaw_lens_..."), meter.createHistogram("..."), etc.
  const instrumentNameRegex = /meter\.create(?:Counter|Histogram|UpDownCounter|ObservableGauge)\(\s*"(openclaw_lens_[^"]+)"/g;
  const instrumentNames: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = instrumentNameRegex.exec(collectorSrc)) !== null) {
    instrumentNames.push(match[1]);
  }

  test("found instrument names in source", () => {
    expect(instrumentNames.length).toBeGreaterThanOrEqual(30);
  });

  test("every instrument in metrics-collector.ts exists in METRIC_DEFINITIONS", () => {
    const missing = instrumentNames.filter((name) => !DEFINITIONS_BY_OTEL_NAME.has(name));
    expect(missing, `Instruments in metrics-collector.ts missing from METRIC_DEFINITIONS: ${missing.join(", ")}`).toEqual([]);
  });

  test("every METRIC_DEFINITION has an instrument in metrics-collector.ts", () => {
    const instrumentSet = new Set(instrumentNames);
    const missing = METRIC_DEFINITIONS
      .map((d) => d.otelName)
      .filter((name) => !instrumentSet.has(name));
    expect(missing, `Definitions in METRIC_DEFINITIONS not created in metrics-collector.ts: ${missing.join(", ")}`).toEqual([]);
  });

  test("all instruments use desc() for description (no hardcoded strings)", () => {
    // Verify that every openclaw_lens_* instrument uses desc("...") not a hardcoded description string
    const hardcodedPattern = /meter\.create(?:Counter|Histogram|UpDownCounter|ObservableGauge)\(\s*"(openclaw_lens_[^"]+)",\s*\{\s*description:\s*"([^"]+)"/g;
    const hardcoded: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = hardcodedPattern.exec(collectorSrc)) !== null) {
      hardcoded.push(m[1]);
    }
    expect(hardcoded, `Instruments with hardcoded descriptions (should use desc()): ${hardcoded.join(", ")}`).toEqual([]);
  });
});
