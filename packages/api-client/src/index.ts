// Typed fetch client for the /v1 API (spec section 9 paths).
// ponytail: hand-written minimal client — will be replaced by a generated
// client from services/api/openapi.yaml (e.g. openapi-typescript) later.
import type { Workspace, Book, Chapter, AiJob, PublishingJob } from "@bookworm/types";

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

export function createClient(opts: ClientOptions) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
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
    createAssetUploadUrl: (body: { workspaceId: string; filename: string; mimeType: string; sizeBytes: number }) =>
      call<{ uploadUrl: string; assetId: string; storagePath: string }>("POST", "/v1/assets/upload-url", body),
    createAiJob: (body: CreateAiJobRequest) => call<AiJob>("POST", "/v1/ai/jobs", body),
    getAiJob: (jobId: string) => call<AiJob>("GET", `/v1/ai/jobs/${jobId}`),
    applySuggestion: (id: string) => call<Record<string, unknown>>("POST", `/v1/ai/suggestions/${id}/apply`),
    runPreflight: (body: { bookId: string; editionId?: string }) =>
      call<Record<string, unknown>>("POST", "/v1/publishing/validate", body),
    createPublishingJob: (body: { bookId: string; editionId?: string; channel: string; request?: Record<string, unknown>; idempotencyKey: string }) =>
      call<PublishingJob>("POST", "/v1/publishing/jobs", body),
    getUsage: (workspaceId: string) =>
      call<Record<string, unknown>>("GET", `/v1/usage?workspaceId=${encodeURIComponent(workspaceId)}`),
    createBillingCheckout: (body: { workspaceId: string; planId: string }) =>
      call<{ checkoutUrl: string }>("POST", "/v1/billing/checkout", body),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
