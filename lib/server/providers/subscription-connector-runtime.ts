import type { SubscriptionConnectorControl } from "../../domain/subscription-provider";
import { isAbsolute } from "node:path";
import { createSubscriptionConnectorClient } from "./subscription-connector-client";
import { SubscriptionProviderError } from "./subscription-errors";

export function createLocalSubscriptionConnector(
  environment: Record<string, string | undefined> = process.env,
): SubscriptionConnectorControl {
  const socketPath = environment.NAIL_CONNECTOR_SOCKET;
  if (!socketPath || !isAbsolute(socketPath) || Buffer.byteLength(socketPath, "utf8") > 100) {
    throw new SubscriptionProviderError("invalid_binding");
  }
  return createSubscriptionConnectorClient(socketPath);
}
