import assert from "node:assert/strict";
import test from "node:test";
import type { Approval, Asset } from "@bookworm/types";
import { isArtworkPlaceable } from "../lib/approved-artwork.js";
import * as artworkModule from "../lib/approved-artwork.js";

const cleanDraft = {
  id: "asset-1", mime_type: "image/png", checksum: "a".repeat(64), status: "draft" as const,
  requires_approval: false, current_version_number: 2, current_scan_status: "clean", deleted_at: null,
};

test("clean imported manuscript art remains usable without a new approval", () => {
  assert.equal(isArtworkPlaceable(cleanDraft), true);
});

test("new review-required art is hidden until its current version is approved", () => {
  assert.equal(isArtworkPlaceable({ ...cleanDraft, requires_approval: true }), false);
  assert.equal(isArtworkPlaceable({ ...cleanDraft, requires_approval: true, status: "approved" }), true);
});

test("artwork must be a current clean, confirmed, live image", () => {
  assert.equal(isArtworkPlaceable({ ...cleanDraft, status: "archived" }), false);
  assert.equal(isArtworkPlaceable({ ...cleanDraft, status: "rejected" }), false);
  assert.equal(isArtworkPlaceable({ ...cleanDraft, current_scan_status: "pending" }), false);
  assert.equal(isArtworkPlaceable({ ...cleanDraft, checksum: "pending" }), false);
  assert.equal(isArtworkPlaceable({ ...cleanDraft, current_version_number: null }), false);
  assert.equal(isArtworkPlaceable({ ...cleanDraft, mime_type: "application/pdf" }), false);
  assert.equal(isArtworkPlaceable({ ...cleanDraft, deleted_at: "2026-09-29T00:00:00Z" }), false);
});

type ArtworkCandidate = Pick<Asset, "id" | "mime_type" | "checksum" | "status" | "deleted_at" | "requires_approval" | "current_version_number" | "current_scan_status">;
type ApprovalCandidate = Pick<Approval, "entity_type" | "entity_id" | "entity_version_number" | "status" | "superseded_at">;
type ApprovalUiHelpers = {
  isArtworkRequestable?: (asset: Pick<Asset, "mime_type" | "checksum" | "status" | "deleted_at" | "requires_approval" | "current_version_number" | "current_scan_status">) => boolean;
  getRequestableArtwork?: (assets: readonly ArtworkCandidate[], approvals: readonly ApprovalCandidate[]) => ArtworkCandidate[];
  getOrCreateApprovalRequestKey?: (keys: Map<string, string>, identity: string, create: () => string) => string;
};
const approvalUi = artworkModule as typeof artworkModule & ApprovalUiHelpers;

test("only current clean review-required draft artwork can be requested", () => {
  assert.equal(approvalUi.isArtworkRequestable?.({ ...cleanDraft, requires_approval: true }), true);
  assert.equal(approvalUi.isArtworkRequestable?.({ ...cleanDraft, requires_approval: false }), false);
  assert.equal(approvalUi.isArtworkRequestable?.({ ...cleanDraft, requires_approval: true, status: "approved" }), false);
  assert.equal(approvalUi.isArtworkRequestable?.({ ...cleanDraft, requires_approval: true, status: "rejected" }), false);
  assert.equal(approvalUi.isArtworkRequestable?.({ ...cleanDraft, requires_approval: true, current_scan_status: "pending" }), false);
});

test("a pending review suppresses only its exact current, non-superseded artwork version", () => {
  const assets: ArtworkCandidate[] = [
    { ...cleanDraft, requires_approval: true },
    { ...cleanDraft, id: "asset-2", requires_approval: true, current_version_number: 3 },
    { ...cleanDraft, id: "asset-3", requires_approval: true },
  ];
  const approvals: ApprovalCandidate[] = [
    { entity_type: "asset", entity_id: "asset-1", entity_version_number: 2, status: "pending", superseded_at: null },
    { entity_type: "asset", entity_id: "asset-2", entity_version_number: 2, status: "pending", superseded_at: null },
    { entity_type: "asset", entity_id: "asset-3", entity_version_number: 2, status: "pending", superseded_at: "2026-09-29T00:00:00Z" },
  ];

  assert.deepEqual(approvalUi.getRequestableArtwork?.(assets, approvals).map(({ id }) => id), ["asset-2", "asset-3"]);
});

test("review retries reuse a key for one exact version but a revision gets a new key", () => {
  const keys = new Map<string, string>();
  let sequence = 0;
  const create = () => `request-${++sequence}`;
  assert.equal(approvalUi.getOrCreateApprovalRequestKey?.(keys, "workspace:asset:v2", create), "request-1");
  assert.equal(approvalUi.getOrCreateApprovalRequestKey?.(keys, "workspace:asset:v2", create), "request-1");
  assert.equal(approvalUi.getOrCreateApprovalRequestKey?.(keys, "workspace:asset:v3", create), "request-2");
});
