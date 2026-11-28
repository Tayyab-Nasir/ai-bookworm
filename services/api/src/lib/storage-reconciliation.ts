import type { SupabaseClient } from "./supabase.js";

const PAGE_SIZE = 1000;
const MAX_OBJECTS = 100_000;
const managedPath = /^workspaces\/[0-9a-f-]{36}\/assets\/[0-9a-f-]{36}\/v[1-9]\d*\/[^/]+$/iu;
const managedExportPath = /^workspaces\/[0-9a-f-]{36}\/audiobook-exports\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.zip$/iu;

export type StorageObject = { path: string; createdAt: string | null };
export type OrphanReport = {
  generatedAt: string; graceHours: number; referenceCount: number; objectCount: number;
  referencedObjects: number; outOfScopeObjects: number; unverifiedAgeObjects: number;
  youngerUnreferencedObjects: number; candidates: StorageObject[];
};

function dateOrNull(value: string | null): Date | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value);
}

function assertGraceHours(graceHours: number) {
  if (!Number.isInteger(graceHours) || graceHours < 24 || graceHours > 24 * 365) {
    throw new Error("graceHours must be an integer from 24 through 8760");
  }
}

/** Pure classification. Candidates are never deleted by this module. */
export function classifyStorageObjects(input: {
  references: Iterable<string>; objects: StorageObject[]; graceHours: number; now?: Date;
}): OrphanReport {
  assertGraceHours(input.graceHours);
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - input.graceHours * 3_600_000;
  const references = new Set(input.references);
  let referencedObjects = 0, outOfScopeObjects = 0, unverifiedAgeObjects = 0, youngerUnreferencedObjects = 0;
  const candidates: StorageObject[] = [];
  for (const object of input.objects) {
    if (references.has(object.path)) { referencedObjects++; continue; }
    if (!managedPath.test(object.path) && !managedExportPath.test(object.path)) { outOfScopeObjects++; continue; }
    const createdAt = dateOrNull(object.createdAt);
    if (!createdAt) { unverifiedAgeObjects++; continue; }
    if (createdAt.getTime() > cutoff) { youngerUnreferencedObjects++; continue; }
    candidates.push(object);
  }
  return {
    generatedAt: now.toISOString(), graceHours: input.graceHours, referenceCount: references.size,
    objectCount: input.objects.length, referencedObjects, outOfScopeObjects, unverifiedAgeObjects,
    youngerUnreferencedObjects, candidates,
  };
}

async function loadPaths(sb: SupabaseClient, table: "assets" | "asset_versions") {
  const paths = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await sb.from(table).select("storage_path").range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("storage_reference_query_failed");
    for (const row of data ?? []) if (typeof row.storage_path === "string") paths.add(row.storage_path);
    if (!data || data.length < PAGE_SIZE) return paths;
  }
}

async function loadImageReceiptPaths(sb: SupabaseClient) {
  const paths = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await sb.from("image_completion_receipts")
      .select("completion_json").order("job_id").range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("image_recovery_reference_query_failed");
    for (const row of data ?? []) {
      const path = row.completion_json?.p_storage_path;
      // Incomplete reference evidence must not produce apparently safe candidates.
      if (typeof path !== "string" || !managedPath.test(path)) throw new Error("image_recovery_reference_invalid");
      paths.add(path);
    }
    if (!data || data.length < PAGE_SIZE) return paths;
  }
}

async function loadAudiobookExportPaths(sb: SupabaseClient) {
  const paths = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await sb.from("audiobook_google_play_export_jobs")
      .select("id,output_storage_path").not("output_storage_path", "is", null)
      .order("id").range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("audiobook_export_reference_query_failed");
    for (const row of data ?? []) {
      const path = row.output_storage_path;
      if (typeof path !== "string" || !managedExportPath.test(path)) throw new Error("audiobook_export_reference_invalid");
      paths.add(path);
    }
    if (!data || data.length < PAGE_SIZE) return paths;
  }
}

async function listObjects(sb: SupabaseClient, bucket: string) {
  const storage = sb.storage.from(bucket);
  const objects: StorageObject[] = [];
  const visit = async (prefix: string): Promise<void> => {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await storage.list(prefix, { limit: PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error("storage_list_failed");
      for (const item of data ?? []) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id) {
          objects.push({ path, createdAt: typeof item.created_at === "string" ? item.created_at : null });
          if (objects.length > MAX_OBJECTS) throw new Error("storage_inventory_limit_exceeded");
        } else await visit(path);
      }
      if (!data || data.length < PAGE_SIZE) return;
    }
  };
  await visit("workspaces");
  return objects;
}

/** Service-role inspection only. Intentionally has no delete capability. */
export async function inspectPrivateStorageOrphans(sb: SupabaseClient, input: { graceHours?: number; now?: Date } = {}) {
  const graceHours = input.graceHours ?? 168;
  assertGraceHours(graceHours);
  const [assetPaths, versionPaths, imageReceiptPaths, audiobookExportPaths, objects] = await Promise.all([
    loadPaths(sb, "assets"), loadPaths(sb, "asset_versions"), loadImageReceiptPaths(sb),
    loadAudiobookExportPaths(sb), listObjects(sb, "book-assets"),
  ]);
  return classifyStorageObjects({ references: [...assetPaths, ...versionPaths, ...imageReceiptPaths, ...audiobookExportPaths], objects, graceHours, now: input.now });
}
