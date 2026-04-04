/**
 * Alloy HTTP Client
 *
 * Communicates with Grafana Alloy's HTTP API for pipeline management:
 *   - Health checks (/-/healthy, /-/ready)
 *   - Config reload (/-/reload)
 *   - Component introspection (/api/v0/component/{id})
 *
 * Follows the same pattern as grafana-client.ts: class with typed methods,
 * fetch-based HTTP calls, actionable error messages.
 *
 * Alloy's HTTP API runs on a configurable port (default: 12345).
 * Key behaviors:
 *   - /-/healthy returns 500 with unhealthy component names if any are unhealthy
 *   - /-/reload returns 400 with error message if config reload fails
 *   - A failed reload keeps the previous running config (safe by default)
 */

import type {
  AlloyClientOptions,
  AlloyComponentInfo,
  PipelineHealthResult,
} from "./types.js";

const DEFAULT_TIMEOUT = 5_000;

export class AlloyClient {
  private readonly url: string;
  private readonly timeout: number;

  constructor(opts: AlloyClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  }

  /** Base URL for display in error messages. */
  get baseUrl(): string {
    return this.url;
  }

  // ── Health Checks ───────────────────────────────────────────────────

  /**
   * Check if Alloy is healthy (all components running).
   * Returns { ok: true } if healthy, or { ok: false, unhealthyComponents } if not.
   * Returns { ok: false } with error if Alloy is unreachable.
   */
  async healthy(): Promise<{ ok: boolean; unhealthyComponents?: string[]; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(`${this.url}/-/healthy`);
      if (res.ok) return { ok: true };
      // Alloy returns "unhealthy components: comp1, comp2\n" (comma-separated, single line)
      const body = await res.text();
      const stripped = body.replace(/^unhealthy components:\s*/i, "").trim();
      const components = stripped
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      return { ok: false, unhealthyComponents: components };
    } catch (err) {
      return { ok: false, error: this.formatError(err) };
    }
  }

  /**
   * Check if Alloy is ready (initial config load complete).
   */
  async ready(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.url}/-/ready`);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Config Management ───────────────────────────────────────────────

  /**
   * Trigger config reload. Alloy re-reads all .alloy files from its config directory.
   *
   * On success: returns { ok: true }.
   * On failure: returns { ok: false, error } — Alloy keeps previous config running.
   */
  async reload(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(`${this.url}/-/reload`, {
        method: "POST",
      });
      if (res.ok) return { ok: true };
      const body = await res.text();
      return {
        ok: false,
        error: body || `Reload failed with status ${res.status}`,
      };
    } catch (err) {
      return { ok: false, error: this.formatError(err) };
    }
  }

  // ── Component Introspection ─────────────────────────────────────────

  /**
   * List all running components.
   */
  async listComponents(): Promise<AlloyComponentInfo[]> {
    const res = await this.fetchWithTimeout(`${this.url}/api/v0/web/components`);
    if (!res.ok) {
      throw new Error(`Failed to list Alloy components: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as AlloyComponentInfo[];
    return data;
  }

  /**
   * Get a specific component's status by ID.
   * Returns null if the component doesn't exist.
   */
  async getComponent(id: string): Promise<AlloyComponentInfo | null> {
    try {
      const encoded = encodeURIComponent(id);
      const res = await this.fetchWithTimeout(
        `${this.url}/api/v0/web/components/${encoded}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Failed to get component ${id}: ${res.status}`);
      }
      return (await res.json()) as AlloyComponentInfo;
    } catch (err) {
      // Component not found or API error
      if (err instanceof Error && err.message.includes("404")) return null;
      throw err;
    }
  }

  /**
   * Check health of specific components by their IDs.
   * Fetches all components in a single request, then does local lookups.
   */
  async checkPipelineHealth(
    componentIds: string[],
  ): Promise<PipelineHealthResult> {
    const result: PipelineHealthResult = {
      healthy: [],
      unhealthy: [],
      missing: [],
    };

    // Single batch fetch instead of N individual requests
    let allComponents: AlloyComponentInfo[];
    try {
      allComponents = await this.listComponents();
    } catch {
      // If we can't list components, treat all as unhealthy
      for (const id of componentIds) {
        result.unhealthy.push({ id, message: "Failed to list Alloy components" });
      }
      return result;
    }

    const byId = new Map(allComponents.map((c) => [c.localID, c]));

    for (const id of componentIds) {
      const comp = byId.get(id);
      if (!comp) {
        result.missing.push(id);
      } else if (comp.health.state === "healthy") {
        result.healthy.push(id);
      } else {
        result.unhealthy.push({ id, message: comp.health.message });
      }
    }

    return result;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init?.headers,
          Accept: "application/json",
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `Alloy request timed out after ${this.timeout}ms — is Alloy running at ${this.url}?`,
        );
      }
      throw new Error(
        `Alloy request failed: ${this.formatError(err)} — check that Alloy is running at ${this.url}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) {
      // Improve common error messages
      if (err.message.includes("ECONNREFUSED")) {
        return `Connection refused at ${this.url} — Alloy may not be running`;
      }
      if (err.message.includes("ETIMEDOUT") || err.message.includes("AbortError")) {
        return `Request timed out — Alloy may be overloaded or unreachable at ${this.url}`;
      }
      return err.message;
    }
    return String(err);
  }
}
