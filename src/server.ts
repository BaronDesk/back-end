import { createApp } from "./app";
import { env } from "./config/env";
import { initDashboardGateway } from "./modules/ops/dashboard-gateway";

async function main() {
  const app = await createApp();
  initDashboardGateway(app.server);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: env.port, host: "0.0.0.0" });
  app.log.info(`[identity] listening on :${env.port} (${env.nodeEnv})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
