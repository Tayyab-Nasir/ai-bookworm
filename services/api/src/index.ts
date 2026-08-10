import { loadEnv } from "@bookworm/config";
import { buildApp } from "./app.js";

const env = loadEnv();
const app = await buildApp();

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
