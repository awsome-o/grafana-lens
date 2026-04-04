/**
 * Shared utilities for trace connector recipes (span-metrics, service-graph).
 */

/**
 * Derive an OTLP metrics ingestion URL from a Prometheus remote_write URL.
 * Mimir: /api/prom/push → /api/v1/otlp
 * Prometheus: /api/v1/write → /api/v1/otlp
 * Fallback: strip path, append /api/v1/otlp
 */
export function deriveOtlpMetricsUrl(remoteWriteUrl: string): string {
  try {
    const url = new URL(remoteWriteUrl);
    url.pathname = url.pathname
      .replace(/\/api\/prom\/push$/, "/api/v1/otlp")
      .replace(/\/api\/v1\/write$/, "/api/v1/otlp");
    if (!url.pathname.includes("/otlp")) {
      url.pathname = "/api/v1/otlp";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return remoteWriteUrl.replace(/\/api\/prom\/push$/, "/api/v1/otlp");
  }
}
