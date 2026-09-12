"use client";

import { createClient } from "@bookworm/api-client";

const client = createClient({ baseUrl: "/api/backend" });

// Stable identity prevents effect loops; tokens stay in server-managed cookies.
export function apiClient() {
  return client;
}

// Compatibility fallback for pages that have not completed workspace onboarding yet.
export const DEMO_WORKSPACE = "demo-workspace";
