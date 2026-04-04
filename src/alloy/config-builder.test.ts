import { describe, expect, test } from "vitest";
import {
  escapeString,
  validateIdentifier,
  sanitizeIdentifier,
  renderValue,
  renderTargets,
  AlloyConfigBuilder,
  componentLabel,
} from "./config-builder.js";

describe("escapeString", () => {
  test("passes through plain strings", () => {
    expect(escapeString("hello world")).toBe("hello world");
  });

  test("escapes backslashes", () => {
    expect(escapeString("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  test("escapes double quotes", () => {
    expect(escapeString('say "hello"')).toBe('say \\"hello\\"');
  });

  test("escapes newlines and tabs", () => {
    expect(escapeString("line1\nline2\ttab")).toBe("line1\\nline2\\ttab");
  });

  test("escapes carriage returns", () => {
    expect(escapeString("windows\r\nlines")).toBe("windows\\r\\nlines");
  });

  test("rejects null bytes", () => {
    expect(() => escapeString("bad\0input")).toThrow("null bytes");
  });

  test("handles empty string", () => {
    expect(escapeString("")).toBe("");
  });

  test("handles unicode characters", () => {
    expect(escapeString("日本語テスト")).toBe("日本語テスト");
  });

  test("handles Alloy block delimiters inside strings (safe — they're quoted)", () => {
    // Alloy block delimiters inside quoted strings are safe — they're just characters
    expect(escapeString("prefix { inner } suffix")).toBe("prefix { inner } suffix");
  });

  test("handles combined escapes", () => {
    expect(escapeString('path\\to\\"file"\nnext')).toBe(
      'path\\\\to\\\\\\"file\\"\\nnext',
    );
  });
});

describe("validateIdentifier", () => {
  test("accepts valid identifiers", () => {
    expect(validateIdentifier("my_label")).toBe(true);
    expect(validateIdentifier("_private")).toBe(true);
    expect(validateIdentifier("Caps123")).toBe(true);
    expect(validateIdentifier("a")).toBe(true);
  });

  test("rejects identifiers starting with digits", () => {
    expect(validateIdentifier("123abc")).toBe(false);
  });

  test("rejects identifiers with hyphens", () => {
    expect(validateIdentifier("my-label")).toBe(false);
  });

  test("rejects identifiers with dots", () => {
    expect(validateIdentifier("my.label")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(validateIdentifier("")).toBe(false);
  });

  test("rejects identifiers with spaces", () => {
    expect(validateIdentifier("my label")).toBe(false);
  });
});

describe("sanitizeIdentifier", () => {
  test("passes through valid identifiers", () => {
    expect(sanitizeIdentifier("my_label")).toBe("my_label");
  });

  test("replaces hyphens with underscores", () => {
    expect(sanitizeIdentifier("my-label")).toBe("my_label");
  });

  test("replaces dots with underscores", () => {
    expect(sanitizeIdentifier("my.label")).toBe("my_label");
  });

  test("prepends underscore if starts with digit", () => {
    expect(sanitizeIdentifier("123abc")).toBe("_123abc");
  });

  test("handles empty string", () => {
    expect(sanitizeIdentifier("")).toBe("_unnamed");
  });

  test("handles all-invalid characters", () => {
    expect(sanitizeIdentifier("@#$%")).toBe("____");
  });
});

describe("renderValue", () => {
  test("renders strings with quotes and escaping", () => {
    expect(renderValue("hello")).toBe('"hello"');
    expect(renderValue('say "hi"')).toBe('"say \\"hi\\""');
  });

  test("renders numbers", () => {
    expect(renderValue(42)).toBe("42");
    expect(renderValue(3.14)).toBe("3.14");
    expect(renderValue(0)).toBe("0");
  });

  test("rejects non-finite numbers", () => {
    expect(() => renderValue(Infinity)).toThrow("finite");
    expect(() => renderValue(NaN)).toThrow("finite");
  });

  test("renders booleans", () => {
    expect(renderValue(true)).toBe("true");
    expect(renderValue(false)).toBe("false");
  });

  test("renders empty array", () => {
    expect(renderValue([])).toBe("[]");
  });

  test("renders string array", () => {
    expect(renderValue(["a", "b"])).toBe('["a", "b"]');
  });

  test("renders objects as Alloy block body", () => {
    const result = renderValue({ key: "value", num: 42 });
    expect(result).toContain('key = "value"');
    expect(result).toContain("num = 42");
  });
});

describe("renderTargets", () => {
  test("renders empty targets", () => {
    expect(renderTargets([])).toBe("[]");
  });

  test("renders single target", () => {
    const result = renderTargets([{ address: "localhost:8080" }]);
    expect(result).toContain("__address__");
    expect(result).toContain("localhost:8080");
  });

  test("renders target with labels", () => {
    const result = renderTargets([
      { address: "db:5432", labels: { job: "postgres", env: "prod" } },
    ]);
    expect(result).toContain("db:5432");
    expect(result).toContain("job");
    expect(result).toContain("postgres");
  });

  test("escapes special characters in addresses", () => {
    const result = renderTargets([{ address: 'host"with"quotes' }]);
    expect(result).toContain('\\"');
  });
});

describe("AlloyConfigBuilder", () => {
  test("builds config with header", () => {
    const builder = new AlloyConfigBuilder();
    builder.addBlock('prometheus.scrape "test" {\n  targets = []\n}');
    const result = builder.build("a1b2c3d4", "scrape-endpoint", "test-scrape");

    expect(result).toContain("// Managed by Grafana Lens");
    expect(result).toContain("pipeline: test-scrape (a1b2c3d4)");
    expect(result).toContain("Recipe: scrape-endpoint");
    expect(result).toContain("Do not edit manually");
    expect(result).toContain("prometheus.scrape");
  });

  test("supports multiple blocks", () => {
    const builder = new AlloyConfigBuilder();
    builder.addBlock("// block 1").addBlock("// block 2");
    const result = builder.build("id1", "test", "test");
    expect(result).toContain("// block 1");
    expect(result).toContain("// block 2");
  });
});

describe("componentLabel", () => {
  test("generates namespaced label", () => {
    expect(componentLabel("a1b2c3d4", "nginx")).toBe("lens_a1b2c3d4_nginx");
  });

  test("sanitizes suffix", () => {
    expect(componentLabel("a1b2c3d4", "my-app")).toBe("lens_a1b2c3d4_my_app");
  });
});
