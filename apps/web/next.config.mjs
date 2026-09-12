import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

const localEnv = fileURLToPath(new URL("../../.env.local", import.meta.url));
if (process.env.NODE_ENV !== "production" && existsSync(localEnv)) process.loadEnvFile(localEnv);
const isolatedOutput = process.env.BOOKWORM_DIST_DIR;
if (isolatedOutput && !/^\.next(?:-[a-z0-9]+)+$/.test(isolatedOutput)) throw new Error("BOOKWORM_DIST_DIR must be a local .next-* directory name.");

/** @type {(phase: string) => import('next').NextConfig} */
const nextConfig = (phase) => ({
  // Preserve the configured login origin; NextURL otherwise rewrites loopback IPs to localhost.
  skipMiddlewareUrlNormalize: true,
  distDir: isolatedOutput ?? (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"),
  transpilePackages: ["@bookworm/types", "@bookworm/book-model", "@bookworm/api-client"],
});

export default nextConfig;
