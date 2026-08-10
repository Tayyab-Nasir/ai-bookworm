// Shared TS types mirroring the DB schema (MASTER-BUILD-SPEC sections 3-4).

export type MemberRole =
  | "owner" | "admin" | "editor" | "writer"
  | "illustrator" | "designer" | "reviewer" | "viewer";

export type BookStatus = "draft" | "in_review" | "approved" | "published" | "archived";
export type AssetStatus = "draft" | "in_review" | "approved" | "rejected" | "archived";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

export type OrgRole = "owner" | "admin" | "member";
export type MemberStatus = "invited" | "active" | "suspended";
export type SuggestionStatus = "pending" | "accepted" | "rejected" | "edited" | "expired";
export type CommunityVisibility = "private" | "public" | "unlisted";
export type EditionType = "ebook" | "print" | "audiobook";
export type Severity = "error" | "warning" | "info";

type Json = Record<string, unknown>;

interface Timestamps {
  created_at: string;
  updated_at: string;
}

export interface Profile extends Timestamps {
  id: string;
  display_name: string;
  avatar_url: string | null;
  locale: string;
  timezone: string;
}

export interface Organization extends Timestamps {
  id: string;
  name: string;
  slug: string;
  owner_user_id: string;
}

export interface Workspace extends Timestamps {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  created_by: string;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: MemberRole;
  status: MemberStatus;
  invited_by: string | null;
  created_at: string;
}

export interface Book extends Timestamps {
  id: string;
  workspace_id: string;
  title: string;
  subtitle: string | null;
  author_name: string;
  language: string;
  genre: string | null;
  status: BookStatus;
  current_version_id: string | null;
  created_by: string;
}

export interface BookVersion {
  id: string;
  book_id: string;
  version_number: number;
  source_type: string;
  created_by: string;
  change_summary: string | null;
  created_at: string;
}

export interface Chapter extends Timestamps {
  id: string;
  book_id: string;
  order_index: number;
  title: string;
  status: string;
  current_document_version_id: string | null;
}

export interface DocumentVersion {
  id: string;
  chapter_id: string;
  version_number: number;
  content_json: Json;
  plain_text: string;
  word_count: number;
  created_by: string;
  created_at: string;
}

export interface BookMetadata extends Timestamps {
  book_id: string;
  isbn13: string | null;
  description: string | null;
  keywords: string[];
  categories: string[];
  edition: string | null;
  publication_date: string | null;
  contributors: unknown[];
}

export interface StyleGuide extends Timestamps {
  id: string;
  book_id: string;
  rules_json: Json;
  tone: string | null;
  spelling_variant: string | null;
}

export interface BookBibleItem extends Timestamps {
  id: string;
  book_id: string;
  type: string;
  name: string;
  description: string | null;
  attributes_json: Json;
  source_refs_json: unknown[];
  confidence: number | null;
}

export interface Folder {
  id: string;
  workspace_id: string;
  parent_folder_id: string | null;
  name: string;
  folder_type: string;
  created_by: string;
  created_at: string;
}

export interface Asset extends Timestamps {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  type: string;
  name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  status: AssetStatus;
  deleted_at?: string | null;
  created_by: string;
}

export interface Task extends Timestamps {
  id: string;
  workspace_id: string;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  description: string | null;
  assignee_id: string | null;
  status: TaskStatus;
  priority: string;
  due_at: string | null;
  created_by: string;
}

export interface Approval extends Timestamps {
  id: string;
  workspace_id: string;
  entity_type: string;
  entity_id: string;
  requested_by: string;
  reviewer_id: string | null;
  status: ApprovalStatus;
  comment: string | null;
}

export interface AiJob {
  id: string;
  workspace_id: string;
  book_id: string | null;
  agent_type: string;
  status: JobStatus;
  input_ref: Json;
  output_ref: Json | null;
  model: string | null;
  usage_json: Json;
  idempotency_key: string;
  error_code: string | null;
  error_message: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AiSuggestion {
  id: string;
  ai_job_id: string;
  entity_type: string;
  entity_id: string | null;
  operation_json: Json;
  rationale: string | null;
  confidence: number | null;
  status: SuggestionStatus;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface AiRun {
  id: string;
  workspace_id: string;
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  estimated_cost: number;
  latency_ms: number | null;
  status: string;
  created_at: string;
}

export interface Edition extends Timestamps {
  id: string;
  book_id: string;
  type: EditionType;
  trim_size: string | null;
  language: string | null;
  edition_metadata_json: Json;
  status: string;
}

export interface PublishingJob {
  id: string;
  book_id: string;
  edition_id: string | null;
  channel: string;
  status: JobStatus;
  request_json: Json;
  response_json: Json | null;
  idempotency_key: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}
