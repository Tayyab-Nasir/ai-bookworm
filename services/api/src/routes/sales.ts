import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceMember } from "../lib/authorize.js";
import type { SupabaseClient } from "../lib/supabase.js";

const sourceSchema = z.enum(["amazon_kdp", "barnes_noble", "apple_books", "google_play", "lulu", "other"]);
function isIsoCalendarDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isIsoCalendarDate, "Invalid date");
const money = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);
const salesRowSchema = z.object({
  bookId: z.string().uuid().nullable().optional(), soldOn: isoDate,
  title: z.string().trim().min(1).max(500), externalId: z.string().trim().max(200).nullable().optional(),
  marketplace: z.string().trim().max(100).nullable().optional(), format: z.string().trim().max(100).nullable().optional(),
  units: z.number().int().min(-1_000_000).max(1_000_000), reportedProceedsCents: money.nullable().optional(),
  royaltyCents: money, currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
}).strict();
const importSchema = z.object({
  workspaceId: z.string().uuid(), source: sourceSchema, fileName: z.string().trim().min(1).max(255),
  supersedeImportId: z.string().uuid().nullable().optional(), rows: z.array(salesRowSchema).min(1).max(2000),
}).strict();
const querySchema = z.object({ workspaceId: z.string().uuid() }).strict();
const SALES_EDIT_ROLES = new Set(["owner", "admin", "editor", "writer"]);

const summarySchema = z.object({
  status: z.enum(["not_connected", "imported"]), imports: z.number().int().min(0), latestImportedAt: z.string().nullable(),
  units: z.number().int().nullable(), reportedProceedsCents: z.number().int().nullable(), royaltyCents: z.number().int().nullable(),
  currency: z.string().nullable(), currencies: z.array(z.object({
    currency: z.string(), units: z.number().int(), reportedProceedsCents: z.number().int().nullable(), royaltyCents: z.number().int(),
  }).strict()),
}).strict();

export type RetailerSalesSummary = z.infer<typeof summarySchema> & { available: boolean; message: string };

export const disconnectedSales = (message = "No retailer sales report is imported. Package creation is not a sale."): RetailerSalesSummary => ({
  status: "not_connected", imports: 0, latestImportedAt: null, units: null, reportedProceedsCents: null,
  royaltyCents: null, currency: null, currencies: [], available: false, message,
});

function canonicalRows(rows: z.infer<typeof salesRowSchema>[]) {
  return rows.map((row) => ({
    bookId: row.bookId ?? null, soldOn: row.soldOn, title: row.title, externalId: row.externalId ?? null,
    marketplace: row.marketplace ?? null, format: row.format ?? null, units: row.units,
    reportedProceedsCents: row.reportedProceedsCents ?? null, royaltyCents: row.royaltyCents, currency: row.currency,
  }));
}

function rpcError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "42501") throw new AppError(403, "Editing access is required to import retailer sales.");
  if (error.code === "22023") throw new AppError(422, "This retailer report has invalid or unsupported rows.");
  if (error.code === "23505") throw new AppError(409, "This retailer report is already being imported. Refresh to see its result.");
  if (error.code === "PGRST202" || error.code === "42883") throw new AppError(503, "Retailer sales imports are not installed in this environment yet.");
  throw new AppError(503, "Retailer sales are temporarily unavailable.");
}

export async function loadRetailerSalesSummary(sb: SupabaseClient, workspaceId: string): Promise<RetailerSalesSummary> {
  const result = await sb.rpc("retailer_sales_summary", { p_workspace_id: workspaceId });
  if (result.error?.code === "PGRST202" || result.error?.code === "42883") {
    return disconnectedSales("Retailer sales imports are not installed in this environment yet.");
  }
  rpcError(result.error);
  const parsed = summarySchema.safeParse(result.data);
  if (!parsed.success) throw new AppError(503, "Retailer sales summary is temporarily unavailable.");
  return {
    ...parsed.data,
    available: true,
    message: parsed.data.status === "imported"
      ? "Totals come from imported retailer reports. Multiple currencies stay separate."
      : "No retailer sales report is imported. Package creation is not a sale.",
  };
}

export function salesRoutes(app: FastifyInstance) {
  app.get("/sales/imports", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(422, "Choose a valid workspace.");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, parsed.data.workspaceId, req.userId);
    const [{ data: imports, error }, summary] = await Promise.all([
      sb.from("retailer_sales_imports").select("id,workspace_id,source,file_name,row_count,period_start,period_end,supersedes_import_id,superseded_at,superseded_by,created_by,created_at")
        .eq("workspace_id", parsed.data.workspaceId).order("created_at", { ascending: false }).limit(50),
      loadRetailerSalesSummary(sb, parsed.data.workspaceId),
    ]);
    if (error) {
      if (["PGRST202", "PGRST205", "42P01"].includes((error as { code?: string }).code ?? "")) {
        reply.header("cache-control", "private, no-store");
        return { imports: [], summary: disconnectedSales("Retailer sales imports are not installed in this environment yet.") };
      }
      throw new AppError(503, "Retailer sales imports are temporarily unavailable.");
    }
    reply.header("cache-control", "private, no-store");
    return { imports: imports ?? [], summary };
  });

  app.post("/sales/imports", async (req, reply) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Provide a valid retailer report.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const role = await requireWorkspaceMember(sb, parsed.data.workspaceId, req.userId);
    if (!SALES_EDIT_ROLES.has(role)) throw new AppError(403, "Editing access is required to import retailer sales.");
    const rows = canonicalRows(parsed.data.rows);
    const result = await sb.rpc("import_retailer_sales", {
      p_workspace_id: parsed.data.workspaceId, p_source: parsed.data.source, p_file_name: parsed.data.fileName,
      p_rows: rows,
      p_supersedes_import_id: parsed.data.supersedeImportId ?? null,
    });
    rpcError(result.error);
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    const response = z.object({ import_id: z.string().uuid(), row_count: z.number().int(), duplicate: z.boolean() }).safeParse(row);
    if (!response.success) throw new AppError(503, "Retailer import returned no receipt.");
    reply.header("cache-control", "private, no-store");
    return reply.status(response.data.duplicate ? 200 : 201).send({
      importId: response.data.import_id, rowCount: response.data.row_count, duplicate: response.data.duplicate,
    });
  });
}
