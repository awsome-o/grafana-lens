import { describe, expect, test } from "vitest";
import {
  getPromQLGuidance,
  getLogQLGuidance,
  parsePrometheusWarnings,
  getEmptyResultHint,
} from "./query-guidance.js";

describe("getPromQLGuidance", () => {
  test("unclosed parenthesis → syntax fix hint", () => {
    const g = getPromQLGuidance(
      'invalid parameter "query": 1:34: parse error: unclosed left parenthesis',
      "rate(openclaw_lens_daily_cost_usd[5m]",
    );
    expect(g).toBeDefined();
    expect(g!.cause).toContain("parenthesis");
    expect(g!.suggestion).toContain("closing ')'");
  });

  test("unexpected end of input → incomplete expression", () => {
    const g = getPromQLGuidance("parse error: unexpected end of input", "rate(");
    expect(g).toBeDefined();
    expect(g!.cause).toContain("Incomplete");
  });

  test("range vector expected → missing [duration]", () => {
    const g = getPromQLGuidance(
      "expected type range vector in call to function rate",
      "rate(http_requests_total)",
    );
    expect(g).toBeDefined();
    expect(g!.suggestion).toContain("[5m]");
    expect(g!.example).toContain("rate(http_requests_total[5m])");
  });

  test("bad_data → general syntax hint", () => {
    const g = getPromQLGuidance("bad_data: invalid query", "???");
    expect(g).toBeDefined();
    expect(g!.cause).toContain("malformed");
  });

  test("timeout → narrowing hint", () => {
    const g = getPromQLGuidance("context deadline exceeded", '{__name__=~".+"}');
    expect(g).toBeDefined();
    expect(g!.cause).toContain("timed out");
    expect(g!.example).toContain("regex");
  });

  test("timeout without regex → time range hint", () => {
    const g = getPromQLGuidance("context deadline exceeded", "rate(http_total[5m])");
    expect(g).toBeDefined();
    expect(g!.example).toContain("shorter time range");
  });

  test("Not found → datasource mismatch hint", () => {
    const g = getPromQLGuidance("Not found: query prometheus", "up");
    expect(g).toBeDefined();
    expect(g!.suggestion).toContain("grafana_explore_datasources");
  });

  test("auth failure → token hint", () => {
    const g = getPromQLGuidance("Grafana authentication failed", "up");
    expect(g).toBeDefined();
    expect(g!.suggestion).toContain("GRAFANA_SERVICE_ACCOUNT_TOKEN");
  });

  test("unknown error → returns undefined", () => {
    const g = getPromQLGuidance("some completely unknown error", "up");
    expect(g).toBeUndefined();
  });
});

describe("getLogQLGuidance", () => {
  test("unexpected IDENTIFIER → missing stream selector", () => {
    const g = getLogQLGuidance("syntax error: unexpected IDENTIFIER", "error");
    expect(g).toBeDefined();
    expect(g!.cause).toContain("stream selector");
    expect(g!.example).toContain("|=");
  });

  test("empty stream selector {} → needs label matcher", () => {
    const g = getLogQLGuidance(
      "queries require at least one regexp or equality matcher",
      "{}",
    );
    expect(g).toBeDefined();
    expect(g!.suggestion).toContain("label filter");
  });

  test("unexpected $end → incomplete expression", () => {
    const g = getLogQLGuidance("syntax error: unexpected $end", '{job=');
    expect(g).toBeDefined();
    expect(g!.cause).toContain("Incomplete");
  });

  test("Not found → datasource mismatch", () => {
    const g = getLogQLGuidance("Not found: query loki", '{job="api"}');
    expect(g).toBeDefined();
    expect(g!.suggestion).toContain("grafana_query instead");
  });

  test("unknown error → returns undefined", () => {
    const g = getLogQLGuidance("some completely unknown error", '{job="api"}');
    expect(g).toBeUndefined();
  });
});

describe("parsePrometheusWarnings", () => {
  test("rate on gauge → actionable warning", () => {
    const warnings = parsePrometheusWarnings([
      'PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "openclaw_lens_daily_cost_usd" (1:6)',
    ]);
    expect(warnings).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings![0].cause).toContain("gauge");
    expect(warnings![0].cause).toContain("openclaw_lens_daily_cost_usd");
    expect(warnings![0].suggestion).toContain("delta()");
    expect(warnings![0].example).toContain("delta(openclaw_lens_daily_cost_usd");
  });

  test("undefined/empty infos → returns undefined", () => {
    expect(parsePrometheusWarnings(undefined)).toBeUndefined();
    expect(parsePrometheusWarnings([])).toBeUndefined();
  });

  test("unknown info → passthrough warning", () => {
    const warnings = parsePrometheusWarnings(["some other prometheus info"]);
    expect(warnings).toBeDefined();
    expect(warnings![0].cause).toBe("some other prometheus info");
  });
});

describe("getEmptyResultHint", () => {
  test("expression with labels → label mismatch hint", () => {
    const hint = getEmptyResultHint('http_requests_total{job="nonexistent"}');
    expect(hint.cause).toContain("label filters");
    expect(hint.suggestion).toContain("grafana_list_metrics");
  });

  test("bare metric name → metric not found hint", () => {
    const hint = getEmptyResultHint("nonexistent_metric");
    expect(hint.cause).toContain("may not exist");
    expect(hint.suggestion).toContain("grafana_list_metrics");
  });
});
