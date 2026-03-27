import { describe, expect, test, vi } from "vitest";

// Mock GrafanaClient — we just need getUrl() and constructor tracking
const constructorCalls: Array<{ url: string; apiKey: string; orgId?: number }> = [];

vi.mock("./grafana-client.js", () => ({
  GrafanaClient: class {
    private _url: string;
    constructor(opts: { url: string; apiKey: string; orgId?: number }) {
      constructorCalls.push(opts);
      this._url = opts.url;
    }
    getUrl() {
      return this._url;
    }
  },
}));

import { GrafanaClientRegistry } from "./grafana-client-registry.js";
import type { ValidatedGrafanaLensConfig } from "./config.js";

function makeConfig(
  instances: Record<string, { url: string; apiKey: string; orgId?: number }>,
  defaultInstance: string,
): ValidatedGrafanaLensConfig {
  return {
    grafana: { instances, defaultInstance },
    metrics: { enabled: true },
  } as ValidatedGrafanaLensConfig;
}

describe("GrafanaClientRegistry", () => {
  test("single instance: get() returns default client", () => {
    const config = makeConfig(
      { default: { url: "http://g:3000", apiKey: "key" } },
      "default",
    );
    const registry = new GrafanaClientRegistry(config);
    const client = registry.get();
    expect(client.getUrl()).toBe("http://g:3000");
  });

  test("single instance: get(undefined) returns default", () => {
    const config = makeConfig(
      { default: { url: "http://g:3000", apiKey: "key" } },
      "default",
    );
    const registry = new GrafanaClientRegistry(config);
    expect(registry.get(undefined).getUrl()).toBe("http://g:3000");
  });

  test("multi-instance: get() returns default, get(name) returns named", () => {
    const config = makeConfig(
      {
        dev: { url: "http://dev:3000", apiKey: "key_dev" },
        prd: { url: "http://prd:3000", apiKey: "key_prd" },
      },
      "dev",
    );
    const registry = new GrafanaClientRegistry(config);
    expect(registry.get().getUrl()).toBe("http://dev:3000");
    expect(registry.get("dev").getUrl()).toBe("http://dev:3000");
    expect(registry.get("prd").getUrl()).toBe("http://prd:3000");
  });

  test("unknown name throws with available instances", () => {
    const config = makeConfig(
      {
        dev: { url: "http://dev:3000", apiKey: "key_dev" },
        prd: { url: "http://prd:3000", apiKey: "key_prd" },
      },
      "dev",
    );
    const registry = new GrafanaClientRegistry(config);
    expect(() => registry.get("staging")).toThrow(/Unknown Grafana instance "staging"/);
    expect(() => registry.get("staging")).toThrow(/Available:/);
    expect(() => registry.get("staging")).toThrow(/dev \(default\)/);
    expect(() => registry.get("staging")).toThrow(/prd/);
  });

  test("getDefaultName() returns default instance name", () => {
    const config = makeConfig(
      { dev: { url: "http://dev:3000", apiKey: "key" } },
      "dev",
    );
    const registry = new GrafanaClientRegistry(config);
    expect(registry.getDefaultName()).toBe("dev");
  });

  test("listInstances() returns all instances with isDefault flag", () => {
    const config = makeConfig(
      {
        dev: { url: "http://dev:3000", apiKey: "key_dev" },
        prd: { url: "http://prd:3000", apiKey: "key_prd" },
      },
      "dev",
    );
    const registry = new GrafanaClientRegistry(config);
    const instances = registry.listInstances();
    expect(instances).toEqual([
      { name: "dev", url: "http://dev:3000", isDefault: true },
      { name: "prd", url: "http://prd:3000", isDefault: false },
    ]);
  });

  test("isMultiInstance() false for single, true for multiple", () => {
    const single = new GrafanaClientRegistry(
      makeConfig({ default: { url: "http://g:3000", apiKey: "k" } }, "default"),
    );
    expect(single.isMultiInstance()).toBe(false);

    const multi = new GrafanaClientRegistry(
      makeConfig({
        a: { url: "http://a:3000", apiKey: "k" },
        b: { url: "http://b:3000", apiKey: "k" },
      }, "a"),
    );
    expect(multi.isMultiInstance()).toBe(true);
  });

  test("passes orgId to GrafanaClient constructor", () => {
    constructorCalls.length = 0;
    const config = makeConfig(
      { dev: { url: "http://dev:3000", apiKey: "key", orgId: 5 } },
      "dev",
    );
    new GrafanaClientRegistry(config);
    expect(constructorCalls).toEqual([
      { url: "http://dev:3000", apiKey: "key", orgId: 5 },
    ]);
  });
});
