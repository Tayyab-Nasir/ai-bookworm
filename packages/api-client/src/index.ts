// Typed fetch client for the /v1 API (spec section 9 paths).
// ponytail: hand-written minimal client — will be replaced by a generated
// client from services/api/openapi.yaml (e.g. openapi-typescript) later.
import type { Workspace, Book, Chapter, AiJob, PublishingJob, Folder, Asset, Task, Approval, WorkspaceMember } from "@bookworm/types";

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

export interface ClientOptions {
  baseUrl: string;
  token: string;
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
  workspaceId: string;
  bookId: string;
  agentType: string;
  input?: Record<string, unknown>;
  idempotencyKey: string;
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
  billing_period: string;
  price_cents: number;
  currency: string;
  entitlements_json: Record<string, unknown>;
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
  async function request<T>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      if (method === "POST") headers["idempotency-key"] = opts.idempotencyKey?.() ?? crypto.randomUUID();
    }
    const res = await fetch(`${opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: { code: string; message: string; requestId: string; details?: Record<string, unknown> } } & T;
    if (!res.ok) {
      const e = json.error ?? { code: "internal", message: res.statusText, requestId: "" };
      throw new ApiClientError(res.status, e.code, e.message, e.requestId, e.details);
    }
    return json;
  }

  const call = <T>(method: string, path: string, body?: unknown) =>
    request<T>(method, path, { authorization: `Bearer ${opts.token}` }, body);
  const callService = <T>(path: string, body: unknown, serviceToken: string) =>
    request<T>("POST", path, { "x-service-token": serviceToken }, body);

  return {
    listWorkspaces: () => call<{ workspaces: Workspace[] }>("GET", "/v1/workspaces"),
    createWorkspace: (body: { name: string; orgName?: string; slug?: string }) =>
      call<Workspace>("POST", "/v1/workspaces", body),
    listBooks: (workspaceId: string) =>
      call<{ books: Book[] }>("GET", `/v1/books?workspaceId=${encodeURIComponent(workspaceId)}`),
    createBook: (body: CreateBookRequest) => call<Book>("POST", "/v1/books", body),
    listChapters: (bookId: string) => call<{ chapters: Chapter[] }>("GET", `/v1/books/${bookId}/chapters`),
    applyOperation: (chapterId: string, op: DocumentOperation) =>
      call<{ version: number }>("POST", `/v1/chapters/${chapterId}/operations`, op),
    createAssetUploadUrl: (body: { workspaceId: string; filename: string; mimeType: string; sizeBytes: number; folderId?: string | null; type?: string }) =>
      call<{ uploadUrl: string; assetId: string; storagePath: string }>("POST", "/v1/assets/upload-url", body),
    confirmAssetUpload: (assetId: string, body: { checksumSha256: string; sizeBytes: number }) =>
      call<{ assetId: string; status: string; confirmed: boolean }>("POST", `/v1/assets/${assetId}/confirm`, body),
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
    updateAsset: (assetId: string, body: { name?: string; folderId?: string | null; status?: Asset["status"] }) =>
      call<Asset>("PATCH", `/v1/assets/${assetId}`, body),
    deleteAsset: (assetId: string) => call<{ assetId: string; deleted: boolean }>("DELETE", `/v1/assets/${assetId}`),
    restoreAsset: (assetId: string) => call<{ assetId: string; restored: boolean }>("POST", `/v1/assets/${assetId}/restore`),
    createAssetVersion: (assetId: string, body: { filename: string; mimeType: string; sizeBytes: number }) =>
      call<{ assetId: string; version: number; uploadUrl: string; path: string }>("POST", `/v1/assets/${assetId}/versions`, body),
    confirmAssetVersion: (assetId: string, version: number, body: { checksumSha256: string }) =>
      call<{ assetId: string; version: number; confirmed: boolean }>("POST", `/v1/assets/${assetId}/versions/${version}/confirm`, body),
    listAssetVersions: (assetId: string) =>
      call<{ versions: { id: string; version_number: number; checksum: string; created_by: string; created_at: string }[] }>(
        "GET", `/v1/assets/${assetId}/versions`),
    getAssetUsage: (assetId: string) =>
      call<{ links: { id: string; entity_type: string; entity_id: string; usage_role: string | null }[] }>("GET", `/v1/assets/${assetId}/usage`),
    listComments: (workspaceId: string, entityType: string, entityId: string) =>
      call<{ comments: ApiComment[] }>("GET", `/v1/comments?workspaceId=${workspaceId}&entityType=${entityType}&entityId=${entityId}`),
    createComment: (body: { workspaceId: string; entityType: string; entityId: string; body: string }) =>
      call<ApiComment>("POST", "/v1/comments", body),
    resolveComment: (commentId: string) => call<ApiComment>("POST", `/v1/comments/${commentId}/resolve`),
    listTasks: (workspaceId: string, filter?: { status?: string; assigneeId?: string }) => {
      const qs = new URLSearchParams({ workspaceId });
      if (filter?.status) qs.set("status", filter.status);
      if (filter?.assigneeId) qs.set("assigneeId", filter.assigneeId);
      return call<{ tasks: Task[] }>("GET", `/v1/tasks?${qs}`);
    },
    createTask: (body: { workspaceId: string; title: string; description?: string; assigneeId?: string | null; priority?: string; dueAt?: string | null; entityType?: string; entityId?: string }) =>
      call<Task>("POST", "/v1/tasks", body),
    updateTask: (taskId: string, body: { title?: string; status?: Task["status"]; priority?: string; dueAt?: string | null; assigneeId?: string | null }) =>
      call<Task>("PATCH", `/v1/tasks/${taskId}`, body),
    listApprovals: (workspaceId: string, status?: string) =>
      call<{ approvals: Approval[] }>("GET", `/v1/approvals?workspaceId=${workspaceId}${status ? `&status=${status}` : ""}`),
    createApproval: (body: { workspaceId: string; entityType: string; entityId: string; reviewerId?: string | null; comment?: string }) =>
      call<Approval>("POST", "/v1/approvals", body),
    resolveApproval: (approvalId: string, action: "approve" | "reject") =>
      call<Approval>("POST", `/v1/approvals/${approvalId}/${action}`),
    listActivity: (workspaceId: string, limit?: number) =>
      call<{ events: ActivityEvent[] }>("GET", `/v1/activity?workspaceId=${workspaceId}${limit ? `&limit=${limit}` : ""}`),
    listMembers: (workspaceId: string) =>
      call<{ members: WorkspaceMember[]; profiles: { id: string; display_name: string; avatar_url: string | null }[] }>(
        "GET", `/v1/workspaces/${workspaceId}/members`),
    inviteMember: (workspaceId: string, body: { email: string; role?: WorkspaceMember["role"] }) =>
      call<WorkspaceMember>("POST", `/v1/workspaces/${workspaceId}/invitations`, body),
    updateMemberRole: (workspaceId: string, userId: string, role: WorkspaceMember["role"]) =>
      call<WorkspaceMember>("PATCH", `/v1/workspaces/${workspaceId}/members/${userId}`, { role }),
    createAiJob: (body: CreateAiJobRequest) => call<AiJob>("POST", "/v1/ai/jobs", body),
    getAiJob: (jobId: string) => call<AiJob>("GET", `/v1/ai/jobs/${jobId}`),
    applySuggestion: (id: string) => call<Record<string, unknown>>("POST", `/v1/ai/suggestions/${id}/apply`),
    runPreflight: (body: { bookId: string; editionId?: string }) =>
      call<Record<string, unknown>>("POST", "/v1/publishing/validate", body),
    createPublishingJob: (body: { bookId: string; editionId?: string; channel: string; request?: Record<string, unknown>; idempotencyKey: string }) =>
      call<PublishingJob>("POST", "/v1/publishing/jobs", body),
    getUsage: (organizationId: string) =>
      call<{ entitlements: unknown; usage: Record<string, number>; creditBalance: number }>(
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
      call<{ communityId: string; role: string }>("POST", `/v1/communities/${communityId}/join`),
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
      call<{ referral: Referral; alreadyAttributed?: boolean }>("POST", "/v1/referrals/claim", { code }),
    listReferrals: () => call<{ referrals: Referral[] }>("GET", "/v1/referrals"),
    listCreditLedger: () => call<{ entries: CreditLedgerEntry[] }>("GET", "/v1/referrals/ledger"),
    qualifyReferral: (referredUserId: string, serviceToken: string) =>
      callService<{ qualified: boolean; held?: boolean; rewarded?: boolean }>("/v1/referrals/qualify", { referredUserId }, serviceToken),
    // Step 14: admin console (403 for non-admins)
    adminList: (tab: "users" | "jobs" | "flags" | "support" | "audit") => {
      const paths: Record<string, string> = {
        users: "/v1/admin/users", jobs: "/v1/admin/jobs", flags: "/v1/admin/flags",
        support: "/v1/admin/support", audit: "/v1/admin/audit",
      };
      const keys: Record<string, string> = {
        users: "users", jobs: "jobs", flags: "flags", support: "tickets", audit: "entries",
      };
      return call<Record<string, unknown[]>>( "GET", paths[tab]).then((d) => d[keys[tab]] ?? []);
    },
    adminSuspendUser: (userId: string) =>
      call<{ userId: string; suspended: boolean }>("POST", `/v1/admin/users/${userId}/suspend`),
    adminRetryJob: (type: "ai" | "publishing", jobId: string) =>
      call<{ job: unknown }>("POST", `/v1/admin/jobs/${type}/${jobId}/retry`),
    adminToggleFlag: (key: string, enabled: boolean) =>
      request<{ flag: unknown }>("PUT", `/v1/admin/flags/${key}`, { authorization: `Bearer ${opts.token}` }, { enabled }),
    adminUpdateTicket: (ticketId: string, status: string) =>
      call<{ ticket: unknown }>("POST", `/v1/admin/support/${ticketId}`, { status }),
    adminUsageSummary: (days = 30) =>
      call<{ days: number; orgs: { organizationId: string; total: number; byMeter: Record<string, number> }[] }>(
        "GET", `/v1/admin/usage/summary?days=${days}`),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
