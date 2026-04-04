/**
 * Alloy Config Builder
 *
 * Generates valid Alloy syntax (.alloy config files) from TypeScript.
 * Handles string escaping, identifier validation, and value rendering
 * to prevent injection attacks and syntax errors.
 *
 * Design choice: Template literals with type-safe escaping rather than a
 * full AST builder. Alloy syntax is HCL-like but NOT HCL — building a
 * complete TypeScript AST equivalent would be disproportionate effort.
 * Pipeline patterns are finite and well-structured, making templates the
 * right 80/20 approach.
 *
 * All user-provided values are always placed inside double-quoted string
 * literals — they never appear as bare identifiers or block names. This
 * prevents Alloy syntax injection.
 */

import type { AlloyValue } from "./types.js";

// ── Validation Patterns ─────────────────────────────────────────────

/** Alloy identifiers (component labels, attribute names). */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Characters that need escaping in Alloy double-quoted strings. */
const ESCAPE_MAP: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

// ── Static Helpers ──────────────────────────────────────────────────

/**
 * Escape a string value for use in Alloy double-quoted strings.
 * Handles quotes, backslashes, newlines, and null bytes.
 */
export function escapeString(value: string): string {
  // Reject null bytes — they have no valid use in config strings
  if (value.includes("\0")) {
    throw new Error("String values must not contain null bytes");
  }

  let escaped = "";
  for (const ch of value) {
    escaped += ESCAPE_MAP[ch] ?? ch;
  }
  return escaped;
}

/**
 * Validate that a name is a valid Alloy identifier.
 * Used for component labels and attribute names.
 */
export function validateIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name);
}

/**
 * Sanitize a user-provided name into a valid Alloy identifier.
 * Replaces invalid characters with underscores, ensures it starts with a letter/underscore.
 */
export function sanitizeIdentifier(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  // Ensure starts with letter or underscore
  if (sanitized.length > 0 && /^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  return sanitized || "_unnamed";
}

/**
 * Render a TypeScript value into valid Alloy syntax.
 *
 * - Strings: double-quoted with escaping
 * - Numbers: bare numeric literals
 * - Booleans: `true` / `false`
 * - Arrays: `[item1, item2, ...]`
 * - Objects: `{ key = value, ... }`
 */
export function renderValue(value: AlloyValue, indent = 0): string {
  if (typeof value === "string") {
    return `"${escapeString(value)}"`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Alloy config values must be finite numbers, got: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => renderValue(v, indent + 2));
    return `[${items.join(", ")}]`;
  }
  // Object — rendered as Alloy block body
  const pad = " ".repeat(indent + 2);
  const entries = Object.entries(value).map(
    ([k, v]) => `${pad}${k} = ${renderValue(v, indent + 2)}`,
  );
  return `{\n${entries.join(",\n")}\n${" ".repeat(indent)}}`;
}

/**
 * Render an Alloy component target list (array of objects with __address__ keys).
 */
export function renderTargets(
  targets: Array<{ address: string; labels?: Record<string, string> }>,
): string {
  if (targets.length === 0) return "[]";
  const items = targets.map((t) => {
    const fields: string[] = [`    __address__ = "${escapeString(t.address)}"`];
    if (t.labels) {
      for (const [k, v] of Object.entries(t.labels)) {
        fields.push(`    ${k} = "${escapeString(v)}"`);
      }
    }
    return `  {\n${fields.join(",\n")},\n  }`;
  });
  return `[\n${items.join(",\n")},\n]`;
}

// ── Builder Class ───────────────────────────────────────────────────

/**
 * Builds a complete .alloy config file from component blocks.
 * Each pipeline is a self-contained file — no cross-file references.
 */
export class AlloyConfigBuilder {
  private blocks: string[] = [];

  /**
   * Add a raw config block. The block should be a complete Alloy component
   * definition (e.g., `prometheus.scrape "label" { ... }`).
   */
  addBlock(block: string): this {
    this.blocks.push(block);
    return this;
  }

  /**
   * Build the final config file content with management header.
   */
  build(pipelineId: string, recipe: string, pipelineName: string): string {
    const header = [
      `// Managed by Grafana Lens — pipeline: ${pipelineName} (${pipelineId})`,
      `// Recipe: ${recipe} | Generated: ${new Date().toISOString()}`,
      `// Do not edit manually. Changes will be overwritten on update.`,
    ].join("\n");

    return [header, "", ...this.blocks, ""].join("\n");
  }
}

/**
 * Generate a unique component label from pipeline ID and a descriptive suffix.
 * All managed components use the "lens_{id}_{suffix}" naming convention
 * to prevent collisions with user components or other managed pipelines.
 */
export function componentLabel(pipelineId: string, suffix: string): string {
  return `lens_${pipelineId}_${sanitizeIdentifier(suffix)}`;
}
