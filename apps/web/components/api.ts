"use client";

import { createClient } from "@bookworm/api-client";

const client = createClient({ baseUrl: "/api/backend" });
const scopedClients = new Map<string, ReturnType<typeof createClient>>();

// Stable identity prevents effect loops; tokens stay in server-managed cookies.
export function apiClient(expectedActor?: string) {
  if (!expectedActor) return client;
  let scoped = scopedClients.get(expectedActor);
  if (!scoped) { scoped = createClient({ baseUrl: "/api/backend", expectedActor }); scopedClients.set(expectedActor, scoped); }
  return scoped;
}

// Compatibility fallback for pages that have not completed workspace onboarding yet.
export const DEMO_WORKSPACE = "demo-workspace";
