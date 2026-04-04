import { describe, expect, test } from "vitest";
import {
  buildProcessBlock,
  extractProcessingParams,
  hasProcessingParams,
} from "./_process-builder.js";

describe("buildProcessBlock", () => {
  const PID = "abc123";
  const FORWARD = "loki.write.lens_abc123_write.receiver";

  test("returns null when no processing params are set", () => {
    const result = buildProcessBlock(PID, {}, FORWARD);
    expect(result).toBeNull();
  });

  test("returns null for empty objects", () => {
    const result = buildProcessBlock(PID, { jsonExpressions: {}, labelFields: {} }, FORWARD);
    expect(result).toBeNull();
  });

  test("generates stage.json block", () => {
    const result = buildProcessBlock(PID, {
      jsonExpressions: { level: "", message: "", rid: "context.request_id" },
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('stage.json');
    expect(result!.block).toContain('"level" = ""');
    expect(result!.block).toContain('"rid" = "context.request_id"');
    expect(result!.block).toContain(`forward_to = [${FORWARD}]`);
    expect(result!.componentId).toBe("loki.process.lens_abc123_process");
    expect(result!.receiverRef).toBe("loki.process.lens_abc123_process.receiver");
  });

  test("generates stage.labels block", () => {
    const result = buildProcessBlock(PID, {
      labelFields: { level: "", service: "svc_name" },
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('stage.labels');
    expect(result!.block).toContain('"level" = ""');
    expect(result!.block).toContain('"service" = "svc_name"');
  });

  test("generates stage.structured_metadata block", () => {
    const result = buildProcessBlock(PID, {
      structuredMetadata: { request_id: "", user_id: "" },
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('stage.structured_metadata');
    expect(result!.block).toContain('"request_id" = ""');
  });

  test("generates stage.static_labels block", () => {
    const result = buildProcessBlock(PID, {
      staticLabels: { environment: "production" },
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('stage.static_labels');
    expect(result!.block).toContain('"environment" = "production"');
  });

  test("generates stage.timestamp block", () => {
    const result = buildProcessBlock(PID, {
      timestampSource: "ts",
      timestampFormat: "RFC3339",
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('stage.timestamp');
    expect(result!.block).toContain('source = "ts"');
    expect(result!.block).toContain('format = "RFC3339"');
  });

  test("generates stage.regex block", () => {
    const result = buildProcessBlock(PID, {
      regexExpression: "^(?P<ts>\\S+) (?P<level>\\w+)",
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('stage.regex');
    expect(result!.block).toContain('expression = "');
  });

  test("generates stage.output block", () => {
    const result = buildProcessBlock(PID, {
      outputSource: "message",
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('stage.output');
    expect(result!.block).toContain('source = "message"');
  });

  test("combines multiple stages in correct order", () => {
    const result = buildProcessBlock(PID, {
      jsonExpressions: { timestamp: "", level: "" },
      timestampSource: "timestamp",
      timestampFormat: "RFC3339",
      labelFields: { level: "" },
      structuredMetadata: { request_id: "" },
      staticLabels: { service: "myapp" },
      outputSource: "message",
    }, FORWARD);

    expect(result).not.toBeNull();
    const block = result!.block;

    // Verify ordering: json < timestamp < labels < structured_metadata < static_labels < output
    const jsonPos = block.indexOf("stage.json");
    const tsPos = block.indexOf("stage.timestamp");
    const labelsPos = block.indexOf("stage.labels");
    const metaPos = block.indexOf("stage.structured_metadata");
    const staticPos = block.indexOf("stage.static_labels");
    const outputPos = block.indexOf("stage.output");

    expect(jsonPos).toBeLessThan(tsPos);
    expect(tsPos).toBeLessThan(labelsPos);
    expect(labelsPos).toBeLessThan(metaPos);
    expect(metaPos).toBeLessThan(staticPos);
    expect(staticPos).toBeLessThan(outputPos);
  });

  test("escapes special characters in field names and values", () => {
    const result = buildProcessBlock(PID, {
      jsonExpressions: { 'field"with"quotes': 'path.to."nested"' },
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('field\\"with\\"quotes');
    expect(result!.block).toContain('path.to.\\"nested\\"');
  });

  // ── stage.tenant ────────────────────────────────────────────────

  test("generates stage.tenant with static value", () => {
    const result = buildProcessBlock(PID, {
      tenantValue: "prod-tenant",
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain("stage.tenant");
    expect(result!.block).toContain('value = "prod-tenant"');
  });

  test("generates stage.tenant with dynamic source", () => {
    const result = buildProcessBlock(PID, {
      tenantSource: "tenant_id",
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain("stage.tenant");
    expect(result!.block).toContain('source = "tenant_id"');
  });

  test("tenantValue takes precedence over tenantSource", () => {
    const result = buildProcessBlock(PID, {
      tenantValue: "static-tenant",
      tenantSource: "dynamic_field",
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('value = "static-tenant"');
    expect(result!.block).not.toContain('source = "dynamic_field"');
  });

  // ── stage.match ─────────────────────────────────────────────────

  test("generates stage.match with selector and tenantValue", () => {
    const result = buildProcessBlock(PID, {
      matchRoutes: [
        { selector: '{env="prod"}', tenantValue: "prod-tenant" },
      ],
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain("stage.match");
    expect(result!.block).toContain('selector = "{env=\\"prod\\"}"');
    expect(result!.block).toContain('value = "prod-tenant"');
  });

  test("generates stage.match with tenantSource", () => {
    const result = buildProcessBlock(PID, {
      matchRoutes: [
        { selector: '{app="api"}', tenantSource: "org_id" },
      ],
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('source = "org_id"');
  });

  test("generates stage.match with pipelineName", () => {
    const result = buildProcessBlock(PID, {
      matchRoutes: [
        { selector: '{level="error"}', pipelineName: "Error routing", tenantValue: "errors" },
      ],
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain('pipeline_name = "Error routing"');
  });

  test("generates multiple match routes", () => {
    const result = buildProcessBlock(PID, {
      matchRoutes: [
        { selector: '{env="prod"}', tenantValue: "prod-tenant" },
        { selector: '{env="staging"}', tenantValue: "staging-tenant" },
      ],
    }, FORWARD);

    expect(result).not.toBeNull();
    const block = result!.block;
    expect(block.match(/stage\.match/g)?.length).toBe(2);
    expect(block).toContain('value = "prod-tenant"');
    expect(block).toContain('value = "staging-tenant"');
  });

  test("generates stage.match without tenant (routing only)", () => {
    const result = buildProcessBlock(PID, {
      matchRoutes: [
        { selector: '{source="api"}', pipelineName: "API logs" },
      ],
    }, FORWARD);

    expect(result).not.toBeNull();
    expect(result!.block).toContain("stage.match");
    expect(result!.block).not.toContain("stage.tenant");
  });

  // ── Stage ordering with tenant + match ──────────────────────────

  test("tenant and match are ordered between static_labels and output", () => {
    const result = buildProcessBlock(PID, {
      jsonExpressions: { level: "" },
      staticLabels: { source: "test" },
      tenantValue: "my-tenant",
      matchRoutes: [
        { selector: '{level="error"}', tenantValue: "error-tenant" },
      ],
      outputSource: "message",
    }, FORWARD);

    expect(result).not.toBeNull();
    const block = result!.block;

    const staticPos = block.indexOf("stage.static_labels");
    const tenantPos = block.indexOf("stage.tenant");
    const matchPos = block.indexOf("stage.match");
    const outputPos = block.indexOf("stage.output");

    expect(staticPos).toBeLessThan(tenantPos);
    expect(tenantPos).toBeLessThan(matchPos);
    expect(matchPos).toBeLessThan(outputPos);
  });
});

describe("hasProcessingParams", () => {
  test("returns false for empty params", () => {
    expect(hasProcessingParams({})).toBe(false);
  });

  test("returns true when jsonExpressions is set", () => {
    expect(hasProcessingParams({ jsonExpressions: { level: "" } })).toBe(true);
  });

  test("returns true when outputSource is set", () => {
    expect(hasProcessingParams({ outputSource: "message" })).toBe(true);
  });

  test("returns true when tenantValue is set", () => {
    expect(hasProcessingParams({ tenantValue: "my-tenant" })).toBe(true);
  });

  test("returns true when tenantSource is set", () => {
    expect(hasProcessingParams({ tenantSource: "org_id" })).toBe(true);
  });

  test("returns true when matchRoutes is set", () => {
    expect(hasProcessingParams({ matchRoutes: [{ selector: '{env="prod"}' }] })).toBe(true);
  });

  test("ignores unrelated params", () => {
    expect(hasProcessingParams({ paths: ["/var/log/*.log"] })).toBe(false);
  });
});

describe("extractProcessingParams", () => {
  test("extracts only processing fields", () => {
    const raw = {
      paths: ["/var/log/*.log"],
      jsonExpressions: { level: "" },
      labelFields: { level: "" },
      unrelatedField: "ignored",
    };

    const result = extractProcessingParams(raw);
    expect(result.jsonExpressions).toEqual({ level: "" });
    expect(result.labelFields).toEqual({ level: "" });
    expect(result.regexExpression).toBeUndefined();
    expect(result.tenantValue).toBeUndefined();
    expect(result.matchRoutes).toBeUndefined();
    expect((result as Record<string, unknown>).paths).toBeUndefined();
    expect((result as Record<string, unknown>).unrelatedField).toBeUndefined();
  });

  test("extracts tenant and match fields", () => {
    const raw = {
      tenantValue: "my-tenant",
      matchRoutes: [{ selector: '{env="prod"}', tenantValue: "prod" }],
    };
    const result = extractProcessingParams(raw);
    expect(result.tenantValue).toBe("my-tenant");
    expect(result.matchRoutes).toHaveLength(1);
    expect(result.matchRoutes![0].selector).toBe('{env="prod"}');
  });
});
