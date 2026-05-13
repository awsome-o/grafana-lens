import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { resolveDiagnosticHooks } from "./sdk-compat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const openclawInstalled = existsSync(
  path.join(repoRoot, "node_modules", "openclaw", "package.json"),
);

// Shape contract — that resolveDiagnosticHooks returns a function — is asserted
// against installed openclaw in `src/contracts.test.ts`. Here we cover the two
// pieces of new value-add in v0.5.5: logger-on-success and logger-on-failure.

describe("resolveDiagnosticHooks logger plumbing", () => {
  it.skipIf(!openclawInstalled)(
    "logs resolved path at debug when a logger is passed",
    async () => {
      const logger = { warn: vi.fn(), debug: vi.fn() };
      await resolveDiagnosticHooks(logger);
      expect(logger.debug).toHaveBeenCalled();
      const firstCall = logger.debug.mock.calls[0]?.[0] as string | undefined;
      expect(firstCall).toMatch(/resolved onDiagnosticEvent from openclaw\/plugin-sdk/);
    },
  );

  it.skipIf(!openclawInstalled)(
    "warns with path and 'failed:' when a subpath import fails, then falls through",
    async () => {
      vi.resetModules();
      vi.doMock("openclaw/plugin-sdk/diagnostic-runtime", () => {
        const err = new Error("forced module load failure for test") as NodeJS.ErrnoException;
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      });
      try {
        const mod = await import("./sdk-compat.js");
        const logger = { warn: vi.fn(), debug: vi.fn() };
        const hooks = await mod.resolveDiagnosticHooks(logger);

        expect(logger.warn).toHaveBeenCalled();
        const warnLine = logger.warn.mock.calls[0]?.[0] as string | undefined;
        expect(warnLine).toContain("openclaw/plugin-sdk/diagnostic-runtime");
        expect(warnLine).toContain("failed:");
        // vitest wraps the factory throw, hiding the original .code; we assert
        // the path + "failed:" are surfaced — that's the actionable triage data.
        expect(typeof hooks.onDiagnosticEvent).toBe("function");
      } finally {
        vi.doUnmock("openclaw/plugin-sdk/diagnostic-runtime");
        vi.resetModules();
      }
    },
  );
});
