import { loadEnv } from "@bookworm/config";
import { buildApp } from "./app.js";

const env = loadEnv();
const app = await buildApp();

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Graceful shutdown (PRD-SOW 29): stop accepting, drain in-flight, force-exit
// on timeout so orchestrators don't hang past their kill grace period.
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const killer = setTimeout(() => {
    app.log.error("shutdown timeout, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  killer.unref();
  app.close().then(
    () => process.exit(0),
    (err) => {
      app.log.error(err, "error during shutdown");
      process.exit(1);
    },
  );
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
