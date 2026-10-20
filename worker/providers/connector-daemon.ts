import { startSubscriptionConnectorServer } from "./connector-server";
import { createConnectorEnvironment } from "./connector-environment";
import { loadConnectorConfig } from "./connector-config";

async function main(): Promise<void> {
  const safeEnvironment = createConnectorEnvironment(process.env);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, safeEnvironment);
  const config = loadConnectorConfig();
  const connector = await startSubscriptionConnectorServer({ config });
  process.stdout.write("Subscription connector ready\n");
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await connector.close();
      process.exitCode = 0;
    } catch {
      process.stderr.write("Subscription connector shutdown failed\n");
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
}

main().catch(() => {
  process.stderr.write("Subscription connector failed to start; verify local configuration\n");
  process.exitCode = 1;
});
