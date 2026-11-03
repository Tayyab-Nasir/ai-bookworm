import { assetLifecycleReady } from "../lib/asset-lifecycle-readiness.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor, requireWorkspaceMember } from "../lib/authorize.js";
import { assetRestoreFetch, verifyAssetRestoreBytes } from "../lib/verified-asset-restore.js";

const params = z.object({ assetId: z.string().uuid() }).strict();
const request = z.object({ workspaceId: z.string().uuid(), operationId: z.string().uuid(), expectedRevision: z.string().uuid().nullable() }).strict();
const restoreRequest = request.extend({ expectedDeletedAt: z.string().datetime({ offset: true }) });
const result = z.object({ assetId: z.string().uuid(), operationId: z.string().uuid(), action: z.enum(["remove", "restore"]), expectedRevision: z.string().uuid().nullable(), replayed: z.boolean() }).strict();
const status = z.object({ assetId: z.string().uuid(), operationId: z.string().uuid(), action: z.enum(["remove", "restore"]), expectedDeletedAt: z.string().datetime({ offset: true }).nullable(), expectedRevision: z.string().uuid().nullable(), outcome: z.enum(["committed", "closed"]), committedAt: z.string().datetime({ offset: true }).nullable(), closedAt: z.string().datetime({ offset: true }).nullable() }).strict().refine(v =>
  (v.action === "remove" ? v.expectedDeletedAt === null : v.expectedDeletedAt !== null) &&
  (v.outcome === "committed" ? v.committedAt !== null && v.closedAt === null : v.committedAt === null && v.closedAt !== null));
const closeRequest = request.extend({ action: z.enum(["remove", "restore"]), expectedDeletedAt: z.string().datetime({ offset: true }).nullable() }).strict();

// PostgreSQL timestamps preserve microseconds; Date.parse alone collapses them.
function timestampMicros(value: string): bigint | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds)) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  return BigInt(milliseconds) * 1000n + BigInt((match[7] ?? '').padEnd(6, '0').slice(3));
}

function checkResult(data: unknown, assetId: string, operationId: string, action: "remove" | "restore", expectedRevision: string | null) {
  const parsed = result.safeParse(data);
  if (!parsed.success || parsed.data.assetId !== assetId || parsed.data.operationId !== operationId || parsed.data.action !== action || parsed.data.expectedRevision !== expectedRevision) {
    throw new AppError(503, "The file operation could not be confirmed. Check its original status.");
  }
  return parsed.data;
}

export function assetLifecycleRoutes(app: FastifyInstance) {
  const requireReady = async () => { if (!await assetLifecycleReady(app.supabaseFactory)) throw new AppError(503, 'File operations are temporarily unavailable.'); };
  app.get('/assets/removed', { preHandler: requireReady }, async (req, reply) => {
    const query = z.object({ workspaceId: z.string().uuid(), beforeDeletedAt: z.string().datetime({ offset: true }).optional(), beforeId: z.string().uuid().optional() }).strict().safeParse(req.query);
    if (!query.success || (query.data.beforeDeletedAt === undefined) !== (query.data.beforeId === undefined)
        || (query.data.beforeDeletedAt !== undefined && timestampMicros(query.data.beforeDeletedAt) === null)) throw new AppError(422, 'Check the workspace and page.');
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, query.data.workspaceId, req.userId);
    let list = sb.from('assets').select('id,workspace_id,name,deleted_at,checksum,lifecycle_revision').eq('workspace_id', query.data.workspaceId).not('deleted_at', 'is', null);
    // Validated timestamp and UUID are the only interpolated values. Both parts
    // are needed to page deterministically when removals share a timestamp.
    if (query.data.beforeDeletedAt && query.data.beforeId) list = list.or(`deleted_at.lt.${query.data.beforeDeletedAt},and(deleted_at.eq.${query.data.beforeDeletedAt},id.lt.${query.data.beforeId})`);
    const { data, error } = await list.order('deleted_at', { ascending: false }).order('id', { ascending: false }).limit(51);
    if (error) throw new AppError(503, 'Removed files are unavailable.');
    await requireWorkspaceEditor(sb, query.data.workspaceId, req.userId);
    const rows = z.array(z.object({ id: z.string().uuid(), workspace_id: z.string().uuid(), name: z.string().max(500), deleted_at: z.string().datetime({ offset: true }), checksum: z.string().nullable(), lifecycle_revision: z.string().uuid().nullable() }).strict()).max(51).safeParse(data);
    if (!rows.success || rows.data.some(row => row.workspace_id !== query.data.workspaceId)) throw new AppError(503, 'Removed files could not be verified.');
    let previous = query.data.beforeDeletedAt && query.data.beforeId ? { time: timestampMicros(query.data.beforeDeletedAt)!, id: query.data.beforeId.toLowerCase() } : null;
    for (const row of rows.data) {
      const time = timestampMicros(row.deleted_at), id = row.id.toLowerCase();
      if (time === null || (previous && (time > previous.time || (time === previous.time && id >= previous.id)))) throw new AppError(503, 'Removed files could not be verified.');
      previous = { time, id };
    }
    const page = rows.data.slice(0, 50), last = page.at(-1);
    reply.header('cache-control', 'private, no-store');
    return { assets: page.map(({ checksum, ...row }) => ({ ...row, hasRecordedChecksum: typeof checksum === 'string' && /^[a-f0-9]{64}$/i.test(checksum) })),
      nextCursor: rows.data.length > 50 && last ? { beforeDeletedAt: last.deleted_at, beforeId: last.id } : null };
  });
  app.get("/assets/:assetId/lifecycle/:operationId", { preHandler: requireReady }, async (req, reply) => {
    const path = z.object({ assetId: z.string().uuid(), operationId: z.string().uuid() }).strict().safeParse(req.params);
    const query = z.object({ workspaceId: z.string().uuid() }).strict().safeParse(req.query);
    if (!path.success || !query.success) throw new AppError(422, "Check the file operation.");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, query.data.workspaceId, req.userId);
    const { data, error } = await sb.rpc("asset_lifecycle_status", { p_workspace_id: query.data.workspaceId, p_asset_id: path.data.assetId, p_operation_id: path.data.operationId });
    if (error) throw new AppError(503, "File operation status is unavailable.");
    await requireWorkspaceMember(sb, query.data.workspaceId, req.userId);
    const parsed = data === null ? null : status.safeParse(data);
    if (parsed && (!parsed.success || parsed.data.assetId !== path.data.assetId || parsed.data.operationId !== path.data.operationId)) throw new AppError(503, "File operation status could not be verified.");
    reply.header("cache-control", "private, no-store");
    return { operation: parsed && parsed.success ? parsed.data : null };
  });

  app.post("/assets/:assetId/lifecycle/close", { preHandler: requireReady }, async (req, reply) => {
    const path = params.safeParse(req.params), body = closeRequest.safeParse(req.body);
    if (!path.success || !body.success || (body.data.action === "remove" ? body.data.expectedDeletedAt !== null :
        body.data.expectedDeletedAt === null || timestampMicros(body.data.expectedDeletedAt) === null))
      throw new AppError(422, "Check the file operation.");
    const { workspaceId, operationId, action, expectedDeletedAt, expectedRevision } = body.data;
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, workspaceId, req.userId);
    const { data, error } = await sb.rpc("close_asset_lifecycle", { p_workspace_id: workspaceId, p_asset_id: path.data.assetId,
      p_operation_id: operationId, p_action: action, p_expected_deleted_at: expectedDeletedAt, p_expected_revision: expectedRevision });
    if (error) throw new AppError(error.code === "42501" ? 403 : error.code === "23505" ? 409 : error.code === "54000" ? 429 : 503,
      "The file request could not be closed. Check its status before trying again.");
    await requireWorkspaceEditor(sb, workspaceId, req.userId);
    const parsed = status.safeParse(data);
    if (!parsed.success || parsed.data.assetId !== path.data.assetId || parsed.data.operationId !== operationId || parsed.data.action !== action || parsed.data.expectedRevision !== expectedRevision ||
      (expectedDeletedAt === null ? parsed.data.expectedDeletedAt !== null : !parsed.data.expectedDeletedAt ||
       timestampMicros(parsed.data.expectedDeletedAt) !== timestampMicros(expectedDeletedAt)))
      throw new AppError(503, "The file request outcome could not be confirmed.");
    reply.header("cache-control", "private, no-store");
    return { operation: parsed.data };
  });

  app.post("/assets/:assetId/lifecycle/remove", { preHandler: requireReady }, async (req, reply) => {
    const path = params.safeParse(req.params), body = request.safeParse(req.body);
    if (!path.success || !body.success) throw new AppError(422, "Check the file operation.");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, body.data.workspaceId, req.userId);
    const { data, error } = await sb.rpc("mutate_asset_lifecycle", { p_workspace_id: body.data.workspaceId, p_asset_id: path.data.assetId, p_operation_id: body.data.operationId, p_action: "remove", p_expected_deleted_at: null, p_expected_revision: body.data.expectedRevision });
    if (error) throw new AppError(error.code === "42501" ? 403 : error.code === "40001" || error.code === "23505" ? 409 : 503, "The file removal could not be confirmed. Check the original operation.");
    await requireWorkspaceEditor(sb, body.data.workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    return checkResult(data, path.data.assetId, body.data.operationId, "remove", body.data.expectedRevision);
  });

  app.post("/assets/:assetId/lifecycle/restore", { preHandler: requireReady }, async (req, reply) => {
    const path = params.safeParse(req.params), body = restoreRequest.safeParse(req.body);
    if (!path.success || !body.success || timestampMicros(body.data.expectedDeletedAt) === null) throw new AppError(422, "Check the file operation.");
    const { workspaceId, operationId, expectedDeletedAt, expectedRevision } = body.data, { assetId } = path.data;
    const signal = AbortSignal.timeout(60_000);
    const sb = app.supabaseFactory(req.userToken, assetRestoreFetch(signal));
    await requireWorkspaceEditor(sb, workspaceId, req.userId);
    const known = await sb.rpc("asset_lifecycle_status", { p_workspace_id: workspaceId, p_asset_id: assetId, p_operation_id: operationId });
    if (known.error) throw new AppError(503, "The original file operation could not be checked.");
    if (known.data !== null) {
      const prior = status.safeParse(known.data);
      if (!prior.success || prior.data.assetId !== assetId || prior.data.operationId !== operationId || prior.data.action !== "restore" || prior.data.expectedRevision !== expectedRevision
          || !prior.data.expectedDeletedAt || timestampMicros(prior.data.expectedDeletedAt) !== timestampMicros(expectedDeletedAt)) {
        throw new AppError(409, "The file operation identity does not match.");
      }
      if (prior.data.outcome === "closed") throw new AppError(409, "The original file request was closed. Start a new request if needed.");
      await requireWorkspaceEditor(sb, workspaceId, req.userId);
      reply.header("cache-control", "private, no-store");
      return { assetId, operationId, action: "restore", expectedRevision, replayed: true };
    }
    const { data: asset, error: assetError } = await sb.from("assets").select("id,workspace_id,storage_path,checksum,mime_type,size_bytes,deleted_at,lifecycle_revision").eq("id", assetId).eq("workspace_id", workspaceId).maybeSingle();
    if (assetError) throw new AppError(503, "The removed file could not be checked.");
    if (!asset || !Object.hasOwn(asset,"lifecycle_revision") || asset.lifecycle_revision !== expectedRevision || !asset.deleted_at || timestampMicros(asset.deleted_at) !== timestampMicros(expectedDeletedAt)) throw new AppError(409, "The removed file changed. Refresh the library.");
    const checksum = typeof asset.checksum === "string" ? asset.checksum.toLowerCase() : "";
    const size = Number(asset.size_bytes);
    const prefix = `workspaces/${workspaceId}/assets/${assetId}/`;
    if (typeof asset.storage_path !== "string" || !asset.storage_path.startsWith(prefix) || !/^v[1-9][0-9]*\/[a-zA-Z0-9._-]+$/.test(asset.storage_path.slice(prefix.length))
        || [".", ".."].includes(asset.storage_path.slice(asset.storage_path.lastIndexOf("/") + 1))) throw new AppError(409, "The removed file location is invalid.");
    const { data: version, error: versionError } = await sb.from("asset_versions").select("id,asset_id,storage_path,checksum,mime_type,size_bytes,scan_status")
      .eq("asset_id", assetId).eq("storage_path", asset.storage_path).maybeSingle();
    if (versionError) throw new AppError(503, "The removed file version could not be checked.");
    if (!version || version.asset_id !== assetId || version.storage_path !== asset.storage_path || String(version.checksum).toLowerCase() !== checksum
        || version.mime_type !== asset.mime_type || Number(version.size_bytes) !== size || !["clean", "trusted_generated"].includes(String(version.scan_status))) {
      throw new AppError(409, "The removed file does not have a confirmed clean version.");
    }
    const service = app.supabaseFactory(undefined, assetRestoreFetch(signal));
    try { await verifyAssetRestoreBytes(() => service.storage.from("book-assets").download(asset.storage_path), size, checksum); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, "The removed file could not be verified. Try again later."); }
    const { data, error } = await service.rpc("restore_verified_asset", { p_actor_id: req.userId, p_workspace_id: workspaceId, p_asset_id: assetId,
      p_operation_id: operationId, p_expected_deleted_at: expectedDeletedAt, p_expected_revision: expectedRevision, p_version_id: version.id, p_storage_path: asset.storage_path, p_checksum: checksum, p_size_bytes: size });
    if (error) throw new AppError(error.code === "42501" ? 403 : ["40001", "23505", "23514"].includes(error.code) ? 409 : 503, "The file restore could not be confirmed. Check the original operation.");
    await requireWorkspaceEditor(sb, workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    return checkResult(data, assetId, operationId, "restore", expectedRevision);
  });
}
