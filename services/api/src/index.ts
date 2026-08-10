import Fastify from "fastify";
import { loadEnv } from "@bookworm/config";

const env = loadEnv();
const app = Fastify({ logger: { level: env.LOG_LEVEL } });

app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
