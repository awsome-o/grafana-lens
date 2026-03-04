import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import _Ajv from "ajv";
// AJV is CJS — under NodeNext, default export wraps the module namespace
const Ajv = _Ajv.default;
import { afterEach, describe, expect, test } from "vitest";
import { parseConfig, parseOtlpHeadersEnv, validateConfig } from "./config.js";

describe("parseConfig", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  test("valid config parses with correct defaults", () => {
    const config = parseConfig({
      grafana: {
        url: "http://localhost:3000",
        apiKey: "glsa_test",
      },
    });

    expect(config.grafana.url).toBe("http://localhost:3000");
    expect(config.grafana.apiKey).toBe("glsa_test");
    expect(config.grafana.orgId).toBe(1);
    expect(config.metrics?.enabled).toBe(true);
    expect(config.otlp?.endpoint).toBeUndefined();
    expect(config.proactive?.enabled).toBe(false);
    expect(config.proactive?.costAlertThreshold).toBe(5.0);
  });

  test("missing grafana url and apiKey does NOT throw — returns partial config", () => {
    const config = parseConfig({});
    expect(config.grafana.url).toBeUndefined();
    expect(config.grafana.apiKey).toBeUndefined();
  });

  test("env var fallback works when config values missing", () => {
    process.env = {
      ...originalEnv,
      GRAFANA_URL: "http://env-grafana:3000",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_env_token",
    };

    const config = parseConfig({});

    expect(config.grafana.url).toBe("http://env-grafana:3000");
    expect(config.grafana.apiKey).toBe("glsa_env_token");
  });

  test("URL trailing slash stripped", () => {
    const config = parseConfig({
      grafana: {
        url: "http://localhost:3000///",
        apiKey: "glsa_test",
      },
    });

    expect(config.grafana.url).toBe("http://localhost:3000");
  });
});

describe("validateConfig", () => {
  test("returns valid for complete config", () => {
    const config = parseConfig({
      grafana: { url: "http://localhost:3000", apiKey: "glsa_test" },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  test("returns errors for missing url and apiKey", () => {
    const config = parseConfig({});
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain("grafana.url");
      expect(result.errors[1]).toContain("grafana.apiKey");
    }
  });

  test("returns error for missing apiKey only", () => {
    const config = parseConfig({ grafana: { url: "http://localhost:3000" } });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("grafana.apiKey");
    }
  });
});

describe("manifest schema", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../openclaw.plugin.json"), "utf-8"),
  );
  const ajv = new Ajv();
  const validate = ajv.compile(manifest.configSchema);

  test("empty config passes (fresh install)", () => {
    expect(validate({})).toBe(true);
  });

  test("partial config passes (env var fallback case)", () => {
    expect(validate({ grafana: { url: "http://localhost:3000" } })).toBe(true);
  });

  test("full config passes", () => {
    const full = {
      grafana: { url: "http://localhost:3000", apiKey: "glsa_test", orgId: 1 },
      metrics: { enabled: true },
      otlp: { endpoint: "http://localhost:4318/v1/metrics", exportIntervalMs: 15000 },
      proactive: { enabled: false, webhookPath: "/grafana-lens/alerts", costAlertThreshold: 5.0 },
      customMetrics: { enabled: true, maxMetrics: 100, maxLabelsPerMetric: 5, maxLabelValues: 50, defaultTtlDays: 30 },
    };
    expect(validate(full)).toBe(true);
  });

  test("typo in sub-object key rejected (api_key)", () => {
    expect(validate({ grafana: { url: "http://localhost:3000", api_key: "glsa_test" } })).toBe(false);
    expect(validate.errors?.[0]?.keyword).toBe("additionalProperties");
  });

  test("typo at top level rejected (grfana)", () => {
    expect(validate({ grfana: { url: "http://localhost:3000" } })).toBe(false);
    expect(validate.errors?.[0]?.keyword).toBe("additionalProperties");
  });

  test("wrong types rejected (url: 123)", () => {
    expect(validate({ grafana: { url: 123 } })).toBe(false);
    expect(validate.errors?.[0]?.keyword).toBe("type");
  });
});

describe("parseOtlpHeadersEnv", () => {
  test("parses valid key=value pairs", () => {
    const result = parseOtlpHeadersEnv("key1=val1,key2=val2");
    expect(result.headers).toEqual({ key1: "val1", key2: "val2" });
    expect(result.skipped).toBe(0);
  });

  test("reports skipped malformed pairs without '=' separator", () => {
    const result = parseOtlpHeadersEnv("bad,key=val");
    expect(result.headers).toEqual({ key: "val" });
    expect(result.skipped).toBe(1);
  });

  test("handles empty string", () => {
    const result = parseOtlpHeadersEnv("");
    expect(result.headers).toEqual({});
    expect(result.skipped).toBe(0);
  });

  test("trims whitespace around keys and values", () => {
    const result = parseOtlpHeadersEnv("  key = value , key2=value2  ");
    expect(result.headers).toEqual({ key: "value", key2: "value2" });
    expect(result.skipped).toBe(0);
  });

  test("skips empty segments from trailing commas", () => {
    const result = parseOtlpHeadersEnv("key=val,,");
    expect(result.headers).toEqual({ key: "val" });
    expect(result.skipped).toBe(0);
  });
});

describe("parseConfig _warnings", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns warning when OTEL_EXPORTER_OTLP_HEADERS has malformed pairs", () => {
    process.env = {
      ...originalEnv,
      OTEL_EXPORTER_OTLP_HEADERS: "bad-pair,good=value",
    };
    const config = parseConfig({});
    expect(config._warnings).toBeDefined();
    expect(config._warnings!.length).toBe(1);
    expect(config._warnings![0]).toContain("malformed");
    expect(config.otlp?.headers).toEqual({ good: "value" });
  });

  test("no warnings when headers are well-formed", () => {
    process.env = {
      ...originalEnv,
      OTEL_EXPORTER_OTLP_HEADERS: "key=val",
    };
    const config = parseConfig({});
    expect(config._warnings).toBeUndefined();
  });
});
