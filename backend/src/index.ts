import { buildApp } from "./server.js";
import { config } from "./config.js";
import { closeDb } from "./db/driver.js";

async function main() {
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: config.HOST });
  console.log(`escrow backend on http://${config.HOST}:${config.PORT}`);
  const shutdown = async () => {
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
