// Typed fetch client for the /v1 API (spec section 9 paths).
// ponytail: hand-written minimal client — will be replaced by a generated
// client from services/api/openapi.yaml (e.g. openapi-typescript) later.
import type { Workspace, Book, Chapter, AiJob, AiSuggestion, Folder, Asset, Task, Approval, WorkspaceMember, Edition } from "@bookworm/types";
import type { BookNode } from "@bookworm/book-model";

export interface ChapterDocument { chapterId: string; version: number; nodes: BookNode[] }
export interface BookSearchResult {
  id: string; source_type: "manuscript" | "bible"; chapter_id: string | null;
  bible_item_id: string | null; document_version_id: string | null; node_id: string | null;
  chunk_index: number; title: string; excerpt: string; text_hash: string; score: number;
}
export interface DocumentVersionSummary {
  id: string; chapter_id: string; version_number: number; plain_text: string; word_count: number;
  created_by: string; created_at: string; change_summary: string | null;
}
export interface ManuscriptImportJob {
  id: string; book_id: string; source_asset_id: string;
  status: "queued" | "running" | "succeeded" | "failed"; attempts: number;
  error_code: string | null; created_at: string; available_at: string; completed_at: string | null;
}

export interface ManuscriptImportResult {
  chapters: Chapter[]; sourceAssetId: string; assetIds?: string[];
  report: { warnings: string[]; confidence?: string; chapterCount: number; imageCount?: number };
}

export interface ApiComment {
  id: string;
  workspace_id: string;
  entity_type: string;
  entity_id: string;
  author_id: string;
  body: string;
  resolved_at: string | null;
  created_at: string;
  mentioned?: string[];
}

export interface ActivityEvent {
  id: number;
  workspace_id: string;
  actor_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload_json: Record<string, unknown>;
  created_at: string;
}

export interface WorkspaceInvitation {
  id: string;
  workspace_id: string;
  email: string;
  role: Exclude<WorkspaceMember["role"], "owner">;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  invited_by: string;
  accepted_by: string | null;
  accepted_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export type WorkspaceTargetType = "book" | "asset" | "chapter" | "edition";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  idempotencyKey?: () => string;
}

export interface DocumentOperation {
  operationId: string;
  type: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  source?: "human" | "ai";
  sourceRef?: string;
  expectedVersion: number;
}

export interface CreateBookRequest {
  workspaceId: string;
  title: string;
  subtitle?: string;
  authorName: string;
  language?: string;
  genre?: string;
}

export interface CreateAiJobRequest {
  bookId: string;
  chapterIds: string[];
  agentType: "writer" | "proofreader" | "copyeditor" | "consistency";
  userInstruction?: string;
  idempotencyKey: string;
  contextPolicy?: { includeBookBible?: boolean; includeStyleGuide?: boolean; includeRelatedContext?: boolean; semanticTopK?: number; maxTokens?: number };
}

export interface AiJobReview {
  id: string;
  book_id: string | null;
  agent_type: string;
  status: AiJob["status"];
  model: string | null;
  usage_json: AiJob["usage_json"];
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  chapter_ids: string[];
  context_source_count: number;
}

export type AiJobWithSuggestions = AiJobReview & { suggestions: AiSuggestion[] };

export interface GenerateBookMetadataRequest {
  idempotencyKey: string;
  chapterIds?: string[];
  audience?: string;
  tone?: string;
  maxTokens?: number;
}

export interface MetadataSourceRef {
  chapterId: string;
  nodeId: string;
  documentVersionId?: string;
  textHash?: string;
}

export interface GeneratedBookMetadataCandidate {
  suggestionKind: "metadata_candidate";
  description: string;
  keywords: string[];
  categories: string[];
  audience: string;
  rationale: string;
  confidence: number | null;
  sourceRefs: MetadataSourceRef[];
  status: "pending";
}

export interface GeneratedBookMetadataResponse {
  job: AiJob;
  candidate: GeneratedBookMetadataCandidate;
}

export interface GenerateImageRequest {
  referenceAssetIds?: string[];
  workspaceId: string;
  bookId?: string | null;
  folderId?: string | null;
  kind: "illustration" | "front_cover";
  name: string;
  prompt: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  quality?: "low" | "medium" | "high";
  idempotencyKey: string;
}

export interface ImageGenerationJob {
  id: string;
  bookId: string | null;
  kind: "illustration" | "front_cover";
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export interface GeneratedAssetResult {
  jobId: string;
  asset: Asset;
  preview: { url: string; expiresIn: number };
  provider: string;
  model: string;
  requestId?: string | null;
}

export interface EditionCoverConfig {
  asset_id?: string | null;
  title_on_cover?: boolean;
  subtitle_on_cover?: boolean;
  author_on_cover?: boolean;
  text_color?: string;
  overlay_opacity?: number;
  qr_code?: { enabled?: boolean; url?: string | null; label?: string | null; position?: "bottom-left" | "bottom-right"; size_px?: number };
}

export type EditionConfig = {
  fixed_layout?: Pick<Extract<EditionConfig, { kind: "print" }>, "trim_size" | "margins" | "typography">;
  include_title_page?: boolean;
  kind: "ebook";
  schema_version?: "1.0.0" | "1.1.0";
  text_direction?: "auto" | "ltr" | "rtl";
  flow?: "reflowable" | "fixed";
  navigation?: "toc" | "toc+landmarks" | "none";
  cover?: EditionCoverConfig;
  metadata_overrides?: Record<string, string>;
  front_matter?: { copyright_notice?: string; publisher?: string };
  image_policy?: { max_width_px?: number; max_bytes?: number; embed?: boolean; allowed_formats?: ("jpeg" | "png" | "gif" | "webp")[] };
} | {
  kind: "print";
  include_table_of_contents?: boolean;
  schema_version?: "1.0.0" | "1.1.0";
  text_direction?: "auto" | "ltr" | "rtl";
  trim_size?: "5x8" | "5.5x8.5" | "6x9" | "7x10" | "8.5x11";
  bleed_in?: number;
  bleed_edges?: "all" | "outer";
  margins?: { top?: number; bottom?: number; inner?: number; outer?: number };
  front_matter?: { copyright_notice?: string; publisher?: string };
  typography?: {
    body_font?: "Times-Roman" | "Times-Bold" | "Helvetica" | "Helvetica-Bold" | "Courier" | "Courier-Bold" | "BookwormVera" | "BookwormVera-Bold";
    body_size_pt?: number;
    heading_font?: "Times-Roman" | "Times-Bold" | "Helvetica" | "Helvetica-Bold" | "Courier" | "Courier-Bold" | "BookwormVera" | "BookwormVera-Bold";
    heading_size_pt?: number;
    leading?: number;
    paragraph_spacing_pt?: number;
    first_line_indent_in?: number;
    text_align?: "left" | "justify";
  };
  page_numbering?: { style?: "arabic" | "roman" | "none"; start_at?: number; position?: "bottom-center" | "bottom-outer" | "top-center" };
  wrap_cover?: {
    enabled?: boolean;
    profile?: "kdp-white" | "kdp-cream" | "kdp-standard-color" | "kdp-premium-color" | "custom";
    spine_width_in?: number; expected_page_count?: number | null;
    back_text?: string; spine_text?: string; background_color?: string; text_color?: string;
  };
  cover?: EditionCoverConfig;
} | {
  kind: "audiobook";
  schema_version?: "1.0.0";
  voice?: AudiobookVoice;
  instructions?: string | null;
  speed?: number;
};

export type AudiobookVoice = "alloy" | "ash" | "ballad" | "coral" | "echo" | "fable" | "onyx" | "nova" | "sage" | "shimmer" | "verse" | "marin" | "cedar";

export interface AudiobookSegmentResult {
  index: number;
  status: string;
  asset: Asset | null;
  download: { url: string; expiresIn: number } | null;
}

export interface AudiobookProjectResult {
  id: string;
  editionId: string;
  chapterId: string;
  documentVersionId: string;
  voice: AudiobookVoice;
  speed: number;
  status: string;
  segmentCount: number;
  creditUnits: number;
  createdAt: string;
  completedAt: string | null;
  segments: AudiobookSegmentResult[];
}

export interface TranslationChapterResult {
  id: string;
  chapterId: string;
  documentVersionId: string;
  chapterOrder: number;
  chapterTitle: string;
  status: string;
  failureCode: string | null;
  wordCount: number | null;
  translatedText?: string;
}

export interface TranslationProjectResult {
  billingMode?: "operational" | "quoted";
  canCancelBeforeDispatch?: boolean;
  id: string;
  bookId: string;
  sourceLanguage: string;
  targetLanguage: string;
  status: string;
  chapterCount: number;
  completedChapterCount: number;
  creditUnits: number;
  adoptedBookId: string | null;
  createdAt: string;
  completedAt: string | null;
  chapters: TranslationChapterResult[];
}

export interface RenderedEditionResult {
  jobId: string;
  status: string;
  artifacts: {
    asset: Asset;
    role: "rendered_ebook" | "rendered_print" | "rendered_cover";
    download: { url: string; expiresIn: number };
  }[];
}

export interface PreflightFinding {
  code: string;
  message: string;
  location: string;
  severity: "error" | "warning" | "info";
  category: "package_integrity" | "epub_structure" | "navigation" | "metadata" | "images" | "fonts" | "accessibility" | "links" | "language" | "channel";
  rule_id: string;
  rule_version: string;
}

export interface PreflightResult {
  jobId: string;
  ruleVersion: string;
  channel: string | null;
  requestedChannel: "export" | "kdp" | "apple" | "barnesnoble" | "lulu";
  errors: number;
  warnings: number;
  findings: PreflightFinding[];
}

export type RetailerChannel = "kdp" | "apple" | "barnesnoble" | "lulu";

export interface PublishingPackageJob {
  id: string;
  bookId: string;
  editionId: string;
  channel: RetailerChannel;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  sourceRenderJobId: string | null;
  sourcePreflightJobId: string | null;
  ruleVersion: string | null;
  failureCode: string | null;
  submissionMode: "manual";
  package: { asset: Asset; download: { url: string; expiresIn: number } } | null;
}

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface Plan {
  id: string;
  name: string;
  is_active: boolean;
  billing_period: string;
  price_cents: number;
  currency: string;
  entitlements_json: Record<string, unknown>;
}

export interface BillingEntitlements {
  seats: number;
  workspaces: number;
  books: number;
  ai_credits_monthly: number;
  image_credits_monthly: number;
  audio_credits_monthly: number;
  translation_credits_monthly: number;
  storage_gb: number;
  rendering: boolean;
  publishing_channels: string[];
  [key: string]: unknown;
}

export interface BillingUsageSummary {
  entitlements: {
    plan: { id: string | null; name: string };
    subscription: { id: string; status: string; current_period_end: string | null } | null;
    entitlements: BillingEntitlements;
  };
  usage: Record<string, number>;
  creditBalance: number;
}

export interface DashboardRecentJob {
  id: string;
  kind: "ai" | "publishing";
  label: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  bookId: string | null;
  bookTitle: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type RetailerSource = "amazon_kdp" | "barnes_noble" | "apple_books" | "google_play" | "lulu" | "other";
export interface RetailerSalesRowInput {
  bookId?: string | null; soldOn: string; title: string; externalId?: string | null;
  marketplace?: string | null; format?: string | null; units: number; reportedProceedsCents?: number | null;
  royaltyCents: number; currency: string;
}
export interface RetailerSalesSummary {
  status: "not_connected" | "imported"; imports: number; latestImportedAt: string | null; units: number | null;
  reportedProceedsCents: number | null; royaltyCents: number | null; currency: string | null;
  currencies: { currency: string; units: number; reportedProceedsCents: number | null; royaltyCents: number }[];
  available: boolean;
  message: string;
}
export interface RetailerSalesImport {
  id: string; workspace_id: string; source: RetailerSource; file_name: string; row_count: number;
  period_start: string; period_end: string; supersedes_import_id: string | null; superseded_at: string | null;
  superseded_by: string | null; created_by: string; created_at: string;
}

export interface DashboardOverview {
  workspace: { id: string; name: string; organizationId: string; role: string };
  books: Book[];
  summary: {
    activeBooks: number; inProductionBooks: number; publishedBooks: number;
    assets: number; visualAssets: number; pendingJobs: number;
    failedJobs: number; readyPackages: number;
  };
  usage: BillingUsageSummary;
  recentJobs: DashboardRecentJob[];
  activity: ActivityEvent[];
  sales: RetailerSalesSummary;
}

// Step 12: community + referrals
export interface Community {
  id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "private" | "public" | "unlisted";
  created_at: string;
}

export interface CommunityPost {
  id: string;
  community_id: string;
  author_id: string;
  title: string | null;
  body: string;
  status: string;
  created_at: string;
}

export interface CommunityComment {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  created_at: string;
}

export interface Report {
  id: string;
  reporter_id: string;
  entity_type: string;
  entity_id: string;
  reason: string;
  status: "open" | "actioned" | "dismissed";
  created_at: string;
}

export interface ReferralCode {
  id: string;
  user_id: string;
  code: string;
  status: string;
  created_at: string;
}

export interface Referral {
  id: string;
  referrer_id: string;
  referred_user_id: string | null;
  code_id: string;
  status: "attributed" | "qualified" | "rewarded" | "held" | "rejected" | "reversed";
  flagged: boolean;
  flag_reason: string | null;
  qualified_at: string | null;
  created_at: string;
}

export interface CreditLedgerEntry {
  id: number;
  user_id: string;
  source: string;
  amount: number;
  balance_after: number;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export function createClient(opts: ClientOptions) {
  async function request<T>(method: string, path: string, headers: Record<string, string>, body?: unknown, useIdempotencyKey = true): Promise<T> {
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (method === "POST" && useIdempotencyKey) headers["idempotency-key"] = opts.idempotencyKey?.() ?? crypto.randomUUID();
    const res = await fetch(`${opts.baseUrl}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (res.status === 204 ? {} : await res.json().catch(() => ({ error: { code: "invalid_response", message: "The service returned an unreadable response.", requestId: "" } }))) as { error?: { code: string; message: string; requestId: string; details?: Record<string, unknown> } } & T;
    if (!res.ok) {
      const e = json.error ?? { code: "internal", message: res.statusText, requestId: "" };
      throw new ApiClientError(res.status, e.code, e.message, e.requestId, e.details);
    }
    return json;
  }

  const call = <T>(method: string, path: string, body?: unknown, useIdempotencyKey = true) =>
    request<T>(method, path, opts.token ? { authorization: `Bearer ${opts.token}` } : {}, body, useIdempotencyKey);
  const callService = <T>(path: string, body: unknown, serviceToken: string) =>
    request<T>("POST", path, { "x-service-token": serviceToken }, body);

  return {
    listWorkspaces: () => call<{ workspaces: Workspace[] }>("GET", "/v1/workspaces"),
    getDashboardOverview: (workspaceId: string) =>
      call<DashboardOverview>("GET", `/v1/dashboard?workspaceId=${encodeURIComponent(workspaceId)}`),
    listRetailerSalesImports: (workspaceId: string) =>
      call<{ imports: RetailerSalesImport[]; summary: RetailerSalesSummary }>("GET", `/v1/sales/imports?workspaceId=${encodeURIComponent(workspaceId)}`),
    importRetailerSales: (body: { workspaceId: string; source: RetailerSource; fileName: string; supersedeImportId?: string | null; rows: RetailerSalesRowInput[] }) =>
      call<{ importId: string; rowCount: number; duplicate: boolean }>("POST", "/v1/sales/imports", body, false),
    createWorkspace: (body: { name: string; orgName?: string; slug?: string }) =>
      call<Workspace>("POST", "/v1/workspaces", body),
    listBooks: (workspaceId: string) =>
      call<{ books: Book[] }>("GET", `/v1/books?workspaceId=${encodeURIComponent(workspaceId)}`),
    createBook: (body: CreateBookRequest) => call<Book>("POST", "/v1/books", body),
    getBook: (bookId: string) => call<{ book: Book; role: string }>("GET", `/v1/books/${bookId}`),
    updateBook: (bookId: string, body: Partial<Omit<CreateBookRequest, "workspaceId" | "subtitle" | "genre">> & { subtitle?: string | null; genre?: string | null; expectedUpdatedAt: string }) =>
      call<{ book: Book }>("PATCH", `/v1/books/${bookId}`, body),
    listChapters: (bookId: string) => call<{ chapters: Chapter[] }>("GET", `/v1/books/${bookId}/chapters`),
    createChapter: (bookId: string, body: { title: string; nodes?: BookNode[]; idempotencyKey?: string }) =>
      call<{ chapter: Chapter }>("POST", `/v1/books/${bookId}/chapters`, body),
    reorderChapters: (bookId: string, body: { orderedIds: string[]; expectedIds: string[] }) =>
      call<{ chapters: Chapter[] }>("PUT", `/v1/books/${bookId}/chapters/order`, body),
    importManuscript: (bookId: string, assetId: string) =>
      call<ManuscriptImportResult>("POST", `/v1/books/${bookId}/import`, { assetId }),
    getManuscriptImport: (bookId: string, assetId: string) =>
      call<{ import: ManuscriptImportResult | null }>("GET", `/v1/books/${bookId}/imports/${assetId}`),
    queueManuscriptImport: (bookId: string, assetId: string) =>
      call<{ job: ManuscriptImportJob }>("POST", `/v1/books/${bookId}/import-jobs`, { assetId }),
    listManuscriptImports: (bookId: string) =>
      call<{ jobs: ManuscriptImportJob[] }>("GET", `/v1/books/${bookId}/import-jobs`),
    retryManuscriptImport: (bookId: string, jobId: string) =>
      call<{ job: ManuscriptImportJob }>("POST", `/v1/books/${bookId}/import-jobs/${jobId}/retry`, {}),
    getChapterDocument: (chapterId: string) =>
      call<{ chapter: Chapter; role: string; document: ChapterDocument }>("GET", `/v1/chapters/${chapterId}/document`),
    listDocumentVersions: (chapterId: string) =>
      call<{ versions: DocumentVersionSummary[] }>("GET", `/v1/chapters/${chapterId}/versions`),
    saveChapterDocument: (chapterId: string, body: { nodes: BookNode[]; expectedVersion: number; operationId: string; changeSummary?: string }) =>
      call<{ version: number; versionId: string; document: ChapterDocument }>("PUT", `/v1/chapters/${chapterId}/document`, body),
    restoreDocumentVersion: (chapterId: string, versionId: string, body: { expectedVersion: number; operationId: string }) =>
      call<{ version: number; versionId: string; document: ChapterDocument }>("POST", `/v1/chapters/${chapterId}/versions/${versionId}/restore`, body),
    applyOperation: (chapterId: string, op: DocumentOperation) =>
      call<{ version: number }>("POST", `/v1/chapters/${chapterId}/operations`, op),
    createAssetUploadUrl: (body: { workspaceId: string; filename: string; mimeType: string; sizeBytes: number; folderId?: string | null; type?: string }) =>
      call<{ uploadUrl: string; assetId: string; path: string }>("POST", "/v1/assets/upload-url", body),
    confirmAssetUpload: (assetId: string, body: { checksumSha256: string; sizeBytes: number }) =>
      call<{ assetId: string; status: string; scanStatus: "clean"; detectedMimeType: string; confirmed: true }>("POST", `/v1/assets/${assetId}/confirm`, body),
    // Step 9: folders / assets / collaboration / team
    listFolders: (workspaceId: string) =>
      call<{ folders: Folder[] }>("GET", `/v1/workspaces/${workspaceId}/folders`),
    createFolder: (workspaceId: string, body: { name: string; parentFolderId?: string | null }) =>
      call<Folder>("POST", `/v1/workspaces/${workspaceId}/folders`, body),
    seedFolderTemplate: (workspaceId: string) =>
      call<{ created: number; folders: Folder[] }>("POST", `/v1/workspaces/${workspaceId}/folders/template`),
    updateFolder: (folderId: string, body: { name?: string; parentFolderId?: string | null }) =>
      call<Folder>("PATCH", `/v1/folders/${folderId}`, body),
    listAssets: (workspaceId: string, filter?: { folderId?: string; type?: string; status?: string }) => {
      const qs = new URLSearchParams({ workspaceId });
      if (filter?.folderId) qs.set("folderId", filter.folderId);
      if (filter?.type) qs.set("type", filter.type);
      if (filter?.status) qs.set("status", filter.status);
      return call<{ assets: Asset[] }>("GET", `/v1/assets?${qs}`);
    },
    generateImage: (body: GenerateImageRequest) => call<GeneratedAssetResult>("POST", "/v1/assets/generate", body),
    getAssetAccess: (workspaceId: string) => call<{ canEdit: boolean }>("GET", `/v1/assets/access?${new URLSearchParams({ workspaceId })}`),
    listImageGenerationJobs: (workspaceId: string) => call<{ jobs: ImageGenerationJob[] }>("GET", `/v1/assets/generation-jobs?${new URLSearchParams({ workspaceId })}`),
    finalizeImageJob: (jobId: string) => call<{ jobId: string; status: string }>("POST", `/v1/assets/generation-jobs/${encodeURIComponent(jobId)}/finalize`),
    getAssetDownloadUrl: (assetId: string) =>
      call<{ url: string; expiresIn: number }>("GET", `/v1/assets/${assetId}/download-url`),
    updateAsset: (assetId: string, body: { name?: string; folderId?: string | null; status?: Asset["status"] }) =>
      call<Asset>("PATCH", `/v1/assets/${assetId}`, body),
    deleteAsset: (assetId: string) => call<{ assetId: string; deleted: boolean }>("DELETE", `/v1/assets/${assetId}`),
    restoreAsset: (assetId: string) => call<{ assetId: string; restored: boolean }>("POST", `/v1/assets/${assetId}/restore`),
    createAssetVersion: (assetId: string, body: { filename: string; mimeType: string; sizeBytes: number }) =>
      call<{ assetId: string; version: number; uploadUrl: string; path: string }>("POST", `/v1/assets/${assetId}/versions`, body),
    confirmAssetVersion: (assetId: string, version: number, body: { checksumSha256: string; sizeBytes: number }) =>
      call<{ assetId: string; version: number; scanStatus: "clean"; detectedMimeType: string; confirmed: true }>("POST", `/v1/assets/${assetId}/versions/${version}/confirm`, body),
    listAssetVersions: (assetId: string) =>
      call<{ versions: { id: string; version_number: number; checksum: string; scan_status: "pending" | "clean" | "infected" | "error" | "trusted_generated"; detected_mime_type?: string | null; created_by: string; created_at: string }[] }>(
        "GET", `/v1/assets/${assetId}/versions`),
    getAssetUsage: (assetId: string) =>
      call<{ links: { id: string; entity_type: string; entity_id: string; usage_role: string | null }[] }>("GET", `/v1/assets/${assetId}/usage`),
    listComments: (workspaceId: string, entityType: string, entityId: string) =>
      call<{ comments: ApiComment[] }>("GET", `/v1/comments?workspaceId=${workspaceId}&entityType=${entityType}&entityId=${entityId}`),
    createComment: (body: { workspaceId: string; entityType: string; entityId: string; body: string }) =>
      call<ApiComment>("POST", "/v1/comments", body),
    resolveComment: (commentId: string) => call<ApiComment>("POST", `/v1/comments/${commentId}/resolve`),
    listTasks: (workspaceId: string, filter?: { status?: Task["status"]; assigneeId?: string }) => {
      const qs = new URLSearchParams({ workspaceId });
      if (filter?.status) qs.set("status", filter.status);
      if (filter?.assigneeId) qs.set("assigneeId", filter.assigneeId);
      return call<{ tasks: Task[] }>("GET", `/v1/tasks?${qs}`);
    },
    createTask: (body: { workspaceId: string; title: string; description?: string; assigneeId?: string | null; priority?: TaskPriority; dueAt?: string | null; entityType?: WorkspaceTargetType; entityId?: string }) =>
      call<Task>("POST", "/v1/tasks", body),
    updateTask: (taskId: string, body: { title?: string; status?: Task["status"]; priority?: TaskPriority; dueAt?: string | null; assigneeId?: string | null }) =>
      call<Task>("PATCH", `/v1/tasks/${taskId}`, body),
    listApprovals: (workspaceId: string, status?: Approval["status"]) =>
      call<{ approvals: Approval[] }>("GET", `/v1/approvals?workspaceId=${workspaceId}${status ? `&status=${status}` : ""}`),
    createApproval: (body: { workspaceId: string; entityType: WorkspaceTargetType; entityId: string; reviewerId?: string | null; comment?: string }) =>
      call<Approval>("POST", "/v1/approvals", body),
    resolveApproval: (approvalId: string, action: "approve" | "reject") =>
      call<Approval>("POST", `/v1/approvals/${approvalId}/${action}`),
    listActivity: (workspaceId: string, limit?: number) =>
      call<{ events: ActivityEvent[] }>("GET", `/v1/activity?workspaceId=${workspaceId}${limit ? `&limit=${limit}` : ""}`),
    listMembers: (workspaceId: string) =>
      call<{ members: WorkspaceMember[]; profiles: { id: string; display_name: string; avatar_url: string | null }[] }>(
        "GET", `/v1/workspaces/${workspaceId}/members`),
    listInvitations: (workspaceId: string) =>
      call<{ invitations: WorkspaceInvitation[] }>("GET", `/v1/workspaces/${workspaceId}/invitations`),
    inviteMember: (workspaceId: string, body: { email: string; role?: Exclude<WorkspaceMember["role"], "owner"> }) =>
      call<{ invitation: WorkspaceInvitation; acceptanceUrl: string }>("POST", `/v1/workspaces/${workspaceId}/invitations`, body),
    revokeInvitation: (workspaceId: string, invitationId: string) =>
      call<{ invitationId: string; revoked: true }>("DELETE", `/v1/workspaces/${workspaceId}/invitations/${invitationId}`),
    acceptWorkspaceInvitation: (token: string) =>
      call<{ workspaceId: string; organizationId: string; role: WorkspaceMember["role"]; status: "active" }>("POST", "/v1/workspaces/invitations/accept", { token }),
    updateMemberRole: (workspaceId: string, userId: string, role: WorkspaceMember["role"]) =>
      call<WorkspaceMember>("PATCH", `/v1/workspaces/${workspaceId}/members/${userId}`, { role }),
    createAiJob: (body: CreateAiJobRequest) => call<AiJobWithSuggestions>("POST", "/v1/ai/jobs", body),
    generateBookMetadata: (bookId: string, body: GenerateBookMetadataRequest) =>
      call<GeneratedBookMetadataResponse>("POST", `/v1/books/${encodeURIComponent(bookId)}/metadata/generate`, body),
    listAiJobs: (bookId: string, limit = 8) =>
      call<{ jobs: AiJobReview[] }>("GET", `/v1/ai/jobs?bookId=${encodeURIComponent(bookId)}&limit=${limit}`),
    getAiJob: (jobId: string) => call<AiJobWithSuggestions>("GET", `/v1/ai/jobs/${jobId}`),
    applySuggestion: (id: string) => call<{ suggestionId: string; status: "accepted"; version: number; versionId: string }>("POST", `/v1/ai/suggestions/${id}/apply`),
    rejectSuggestion: (id: string) => call<{ suggestion: AiSuggestion }>("POST", `/v1/ai/suggestions/${id}/reject`),
    listEditions: (bookId: string) => call<{ editions: Edition[] }>("GET", `/v1/books/${bookId}/editions`),
    createEdition: (bookId: string, body: { config: EditionConfig; language?: string }) =>
      call<Edition>("POST", `/v1/books/${bookId}/editions`, body),
    getEdition: (editionId: string) => call<Edition>("GET", `/v1/editions/${editionId}`),
    updateEdition: (editionId: string, body: { config?: EditionConfig; language?: string; status?: "draft" | "in_review" | "approved" | "archived"; expectedUpdatedAt: string }) =>
      call<Edition>("PATCH", `/v1/editions/${editionId}`, body),
    renderEdition: (editionId: string, body: { idempotencyKey: string }) =>
      call<RenderedEditionResult>("POST", `/v1/editions/${editionId}/render`, body),
    listAudiobookProjects: (editionId: string) =>
      call<{ projects: AudiobookProjectResult[] }>("GET", `/v1/editions/${editionId}/audiobook-jobs`),
    getAudiobookProject: (projectId: string) =>
      call<AudiobookProjectResult>("GET", `/v1/audiobook-jobs/${projectId}`),
    createAudiobookProject: (editionId: string, body: { chapterId: string; idempotencyKey: string; aiDisclosureAccepted: true }) =>
      call<AudiobookProjectResult>("POST", `/v1/editions/${editionId}/audiobook-jobs`, body),
    listTranslationProjects: (bookId: string) =>
      call<{ projects: TranslationProjectResult[] }>("GET", `/v1/books/${bookId}/translations`),
    getTranslationProject: (projectId: string, includeText = false) =>
      call<TranslationProjectResult>("GET", `/v1/translations/${projectId}${includeText ? "?includeText=true" : ""}`),
    createTranslationProject: (bookId: string, body: { targetLanguage: string; idempotencyKey: string }) =>
      call<TranslationProjectResult>("POST", `/v1/books/${bookId}/translations`, body),
    adoptTranslationProject: (projectId: string, body: { title: string }) =>
      call<{ book: Book }>("POST", `/v1/translations/${projectId}/adopt`, body),
    cancelQuotedTranslation: (projectId: string) =>
      call<{ projectId: string; status: "cancelled"; releasedCredits: string; cancelledChapters: number }>("POST", `/v1/translations/${projectId}/cancel`, {}),
    runPreflight: (body: { bookId: string; editionId: string; channel: PreflightResult["requestedChannel"]; idempotencyKey: string }) =>
      call<PreflightResult>("POST", "/v1/publishing/validate", body),
    createPublishingJob: (body: { bookId: string; editionId: string; channel: RetailerChannel; renderJobId: string; preflightJobId: string; idempotencyKey: string }) =>
      call<PublishingPackageJob>("POST", "/v1/publishing/jobs", body),
    listPublishingJobs: (bookId: string, filter?: { editionId?: string; channel?: RetailerChannel; limit?: number }) => {
      const qs = new URLSearchParams({ bookId });
      if (filter?.editionId) qs.set("editionId", filter.editionId);
      if (filter?.channel) qs.set("channel", filter.channel);
      if (filter?.limit) qs.set("limit", String(filter.limit));
      return call<{ jobs: PublishingPackageJob[] }>("GET", `/v1/publishing/jobs?${qs}`);
    },
    getPublishingJob: (jobId: string) => call<PublishingPackageJob>("GET", `/v1/publishing/jobs/${jobId}`),
    getUsage: (organizationId: string) =>
      call<BillingUsageSummary>(
        "GET", `/v1/usage?organizationId=${encodeURIComponent(organizationId)}`),
    listPlans: () => call<{ plans: Plan[] }>("GET", "/v1/plans"),
    createBillingCheckout: (body: { organizationId: string; planId: string; successUrl: string; cancelUrl: string }) =>
      call<{ checkoutUrl: string; sessionId: string }>("POST", "/v1/billing/checkout", body),
    createBillingPortal: (body: { organizationId: string; returnUrl: string }) =>
      call<{ portalUrl: string }>("POST", "/v1/billing/portal", body),
    // Service-to-service only: requires x-service-token, not a user JWT.
    deductCredits: (body: { userId: string; workspaceId?: string | null; organizationId?: string | null; meter: string; amount: number; jobId: string }, serviceToken: string) =>
      callService<{ usage: unknown; entry: unknown }>("/v1/credits/deduct", body, serviceToken),
    // Step 12: community
    listCommunities: () => call<{ communities: Community[] }>("GET", "/v1/communities"),
    createCommunity: (body: { name: string; slug: string; description?: string; visibility?: Community["visibility"] }) =>
      call<Community>("POST", "/v1/communities", body),
    joinCommunity: (communityId: string) =>
      call<{ communityId: string; role: string; alreadyMember?: boolean }>("POST", `/v1/communities/${communityId}/join`),
    listCommunityPosts: (communityId: string) =>
      call<{ posts: CommunityPost[]; role: string | null }>("GET", `/v1/communities/${communityId}/posts`),
    createCommunityPost: (communityId: string, body: { title?: string; body: string }) =>
      call<CommunityPost>("POST", `/v1/communities/${communityId}/posts`, body),
    listPostComments: (postId: string) =>
      call<{ comments: CommunityComment[] }>("GET", `/v1/posts/${postId}/comments`),
    createPostComment: (postId: string, body: { body: string }) =>
      call<CommunityComment>("POST", `/v1/posts/${postId}/comments`, body),
    toggleReaction: (postId: string, kind: string) =>
      call<{ postId: string; kind: string; active: boolean }>("POST", `/v1/posts/${postId}/reactions`, { kind }),
    createReport: (body: { entityType: "post" | "comment"; entityId: string; reason: string }) =>
      call<Report>("POST", "/v1/reports", body),
    moderationQueue: () => call<{ reports: Report[] }>("GET", "/v1/moderation/queue"),
    moderateReport: (reportId: string, action: "remove" | "dismiss") =>
      call<Report>("POST", `/v1/moderation/${reportId}/${action}`),
    // Step 12: referrals
    getReferralCode: () => call<ReferralCode>("GET", "/v1/referrals/code"),
    claimReferral: (code: string) =>
      call<{ referral?: Referral; alreadyAttributed?: boolean }>("POST", "/v1/referrals/claim", { code }),
    listReferrals: () => call<{ referrals: Referral[] }>("GET", "/v1/referrals"),
    listCreditLedger: () =>
      call<{ entries: CreditLedgerEntry[]; summary: { creditBalance: number; referralCredits: number; rewardedReferrals: number } }>(
        "GET",
        "/v1/referrals/ledger"
      ),
    searchBook: (bookId: string, body: { query: string; limit?: number; chapterIds?: string[]; includeBible?: boolean }) =>
      call<{ results: BookSearchResult[]; strategy: "postgres_full_text"; query: string }>("POST", `/v1/books/${encodeURIComponent(bookId)}/search`, body),
    qualifyReferral: (referredUserId: string, serviceToken: string) =>
      callService<{ qualified: boolean; held?: boolean; rewarded?: boolean }>("/v1/referrals/qualify", { referredUserId }, serviceToken),
    // Step 14: admin console (403 for non-admins)
    adminAccess: () => call<{ admin: boolean }>("GET", "/v1/admin/access"),
    adminList: (tab: "users" | "jobs" | "flags" | "support" | "audit", filter: { type?: "ai" | "publishing" | "document"; status?: string; search?: string; action?: string; offset?: number; limit?: number } = {}) => {
      const paths: Record<string, string> = {
        users: "/v1/admin/users", jobs: "/v1/admin/jobs", flags: "/v1/admin/flags",
        support: "/v1/admin/support", audit: "/v1/admin/audit",
      };
      const keys: Record<string, string> = {
        users: "users", jobs: "jobs", flags: "flags", support: "tickets", audit: "entries",
      };
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined && value !== "") query.set(key, String(value));
      }
      return call<Record<string, Record<string, unknown>[]>>("GET", `${paths[tab]}?${query}`).then((d) => d[keys[tab]] ?? []);
    },
    adminSuspendUser: (userId: string) =>
      call<{ userId: string; suspended: boolean }>("POST", `/v1/admin/users/${userId}/suspend`),
    adminRetryJob: (type: "ai" | "publishing", jobId: string) =>
      call<{ job: unknown }>("POST", `/v1/admin/jobs/${type}/${jobId}/retry`),
    adminToggleFlag: (key: string, enabled: boolean, scope: { scopeType: string; scopeId: string | null; config?: Record<string, unknown> } = { scopeType: "global", scopeId: null }) =>
      call<{ flag: unknown }>("PUT", `/v1/admin/flags/${encodeURIComponent(key)}`, { enabled, ...scope }),
    adminUpdateTicket: (ticketId: string, status: "open" | "pending" | "resolved" | "closed", priority?: "low" | "normal" | "high" | "urgent") =>
      call<{ ticket: unknown }>("POST", `/v1/admin/support/${ticketId}`, { status, priority }),
    adminUsageSummary: (days = 30) =>
      call<{ days: number; orgs: { organizationId: string; total: number; byMeter: Record<string, number> }[] }>(
        "GET", `/v1/admin/usage/summary?days=${days}`),
    adminDocumentJobHealth: () => call<{ health: {
      generated_at: string; queued: number; due_queued: number; running: number;
      expired_running: number; succeeded: number; failed: number; dead_letters: number;
      oldest_queued_at: string | null; oldest_running_at: string | null;
    } }>("GET", "/v1/admin/jobs/document/health"),
    listSupportTickets: () =>
      call<{ tickets: { id: string; category: string; subject: string; status: string; priority: string; created_at: string }[] }>(
        "GET", "/v1/support/tickets"),
    createSupportTicket: (input: { category: string; subject: string; body: string }) =>
      call<{ ticket: { id: string } }>("POST", "/v1/support/tickets", input),
    listDataRequests: () =>
      call<{ requests: { id: string; request_type: "export" | "delete"; status: string; reason: string | null; requested_at: string; due_at: string; completed_at: string | null }[] }>(
        "GET", "/v1/account/data-requests"),
    createDataRequest: (input: { type: "export" | "delete"; reason?: string; confirmation?: string }) =>
      call<{ request: { id: string } }>("POST", "/v1/account/data-requests", input),
    cancelDataRequest: (requestId: string) =>
      call<{ request: unknown }>("DELETE", `/v1/account/data-requests/${requestId}`),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
