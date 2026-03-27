/**
 * GrafanaClientRegistry — manages named GrafanaClient instances.
 *
 * Replaces the pattern of each tool factory creating its own GrafanaClient.
 * Clients are created once at startup and looked up by name at tool-call time.
 *
 * For single-instance setups, `get()` with no argument returns the sole client.
 * For multi-instance setups, `get("prod")` targets a specific instance while
 * `get()` returns the configured default.
 */

import { GrafanaClient } from "./grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "./config.js";

export type InstanceInfo = {
  name: string;
  url: string;
  isDefault: boolean;
};

export class GrafanaClientRegistry {
  private clients: Map<string, GrafanaClient>;
  private defaultName: string;

  constructor(config: ValidatedGrafanaLensConfig) {
    this.clients = new Map();
    this.defaultName = config.grafana.defaultInstance;

    for (const [name, inst] of Object.entries(config.grafana.instances)) {
      this.clients.set(name, new GrafanaClient({
        url: inst.url,
        apiKey: inst.apiKey,
        orgId: inst.orgId,
      }));
    }
  }

  /**
   * Get a client by instance name. Pass `undefined` or omit for the default.
   * Throws with available instance names if the name is unknown.
   */
  get(name?: string): GrafanaClient {
    const key = name ?? this.defaultName;
    const client = this.clients.get(key);
    if (!client) {
      throw new Error(
        `Unknown Grafana instance "${key}". Available: ${this.formatInstanceNames()}`,
      );
    }
    return client;
  }

  /** Name of the default instance. */
  getDefaultName(): string {
    return this.defaultName;
  }

  /** All registered instances with metadata for agent discovery. */
  listInstances(): InstanceInfo[] {
    return Array.from(this.clients.entries()).map(([name, client]) => ({
      name,
      url: client.getUrl(),
      isDefault: name === this.defaultName,
    }));
  }

  /** True when more than one instance is configured. */
  isMultiInstance(): boolean {
    return this.clients.size > 1;
  }

  /** Human-readable list of instance names for error messages and descriptions. */
  formatInstanceNames(): string {
    return this.listInstances()
      .map(i => i.isDefault ? `${i.name} (default)` : i.name)
      .join(", ");
  }
}
