/**
 * Shared instance parameter helper for multi-Grafana-instance support.
 *
 * Returns an empty object for single-instance setups (agent never sees the param).
 * Returns { instance: schema } for multi-instance (with actual names baked into description).
 */

import type { GrafanaClientRegistry } from "../grafana-client-registry.js";

/**
 * Conditionally produces the `instance` property for tool parameter schemas.
 * Spread into `parameters.properties`: `{ ...instanceProperties(registry), expr: {...} }`.
 */
export function instanceProperties(
  registry: GrafanaClientRegistry,
): Record<string, unknown> {
  if (!registry.isMultiInstance()) return {};

  return {
    instance: {
      type: "string" as const,
      description: `Target Grafana instance. Available: ${registry.formatInstanceNames()}. Omit for default.`,
    },
  };
}
