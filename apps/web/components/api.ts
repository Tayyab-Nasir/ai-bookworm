"use client";

import { createClient } from "@bookworm/api-client";

// Same env convention as BookEditorClient: null => offline demo mode.
export function apiClient() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL;
  const token = process.env.NEXT_PUBLIC_API_TOKEN;
  return baseUrl && token ? createClient({ baseUrl, token }) : null;
}

// Demo workspace used when no API is configured so pages still render.
export const DEMO_WORKSPACE = "demo-workspace";
