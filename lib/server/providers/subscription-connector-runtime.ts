import type {
  SubscriptionCompletionInput,
  SubscriptionConnector,
} from "../../domain/subscription-provider";
import { createSubscriptionConnectorClient } from "./subscription-connector-client";
import { loadConnectorConfig } from "../../../worker/providers/connector-config";

export function createLocalSubscriptionConnector(): SubscriptionConnector {
  const getClient = () => createSubscriptionConnectorClient(loadConnectorConfig().socketPath);
  return {
    check(bindingId, signal) {
      return getClient().check(bindingId, signal);
    },
    cancel(bindingId, signal) {
      return getClient().cancel(bindingId, signal);
    },
    complete(input: SubscriptionCompletionInput, signal) {
      return getClient().complete(input, signal);
    },
  };
}
