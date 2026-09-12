import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Next.js loads `.env.local` for the web app automatically, while the
// standalone Fastify process does not. Load the repository-local development
// file once for Node services, without replacing environment values supplied
// by Docker, Railway, CI, or another process manager. Production deployments
// should use their configured environment/secret store instead of a file.
if (process.env.NODE_ENV !== "production") {
  const configDirectory = dirname(fileURLToPath(import.meta.url));
  const localEnvFile = resolve(configDirectory, "../../..", ".env.local");
  if (existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);
}

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QDRANT_URL: z.string().url(),
  QDRANT_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),
  DEFAULT_AI_PROVIDER: z.literal("openai").default("openai"),
  DEFAULT_AI_MODEL: z.string().default("gpt-6-astra"),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2.5-sunburst"),
  OPENAI_TTS_MODEL: z.string().default("gpt-4o-mini-tts"),
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
  STRIPE_PRICE_IDS_JSON: z.string().optional().default("{}"),
  SERVICE_AUTH_TOKEN: z.string().optional().default(""),
  SENTRY_DSN: z.string().optional().default(""),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional().default(""),
  API_PORT: z.coerce.number().int().positive().default(3001),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  AI_SERVICE_PORT: z.coerce.number().int().positive().default(8000),
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
