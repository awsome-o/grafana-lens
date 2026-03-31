/**
 * Shared OTel Resource construction for all signal providers.
 *
 * Centralizes the Resource identity (service.name, service.namespace,
 * service.version, service.instance.id) so that adding a new attribute
 * requires touching one file instead of three.
 */

import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export type OtelResourceConfig = {
  serviceVersion?: string;
  serviceInstanceId?: string;
};

export function createOtelResource(config: OtelResourceConfig): Resource {
  return new Resource({
    [ATTR_SERVICE_NAME]: "openclaw",
    "service.namespace": "grafana-lens",
    ...(config.serviceVersion ? { "service.version": config.serviceVersion } : {}),
    ...(config.serviceInstanceId ? { "service.instance.id": config.serviceInstanceId } : {}),
  });
}
