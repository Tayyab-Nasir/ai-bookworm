export type BlueprintRecovery =
  | { idempotencyKey: string }
  | { requestId: string }
  | { proposalId: string; acceptancePending?: boolean };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function storyBlueprintProposalSessionKey(bookId: string, actor?: string) {
  return actor ? `story-blueprint-proposal:v2:${actor}:${bookId}` : `story-blueprint-proposal:${bookId}`;
}

function parse(raw: string): BlueprintRecovery {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Story Blueprint recovery checkpoint.");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length === 1 && typeof item.idempotencyKey === "string" && uuid.test(item.idempotencyKey)) return { idempotencyKey: item.idempotencyKey };
  if (keys.length === 1 && typeof item.requestId === "string" && uuid.test(item.requestId)) return { requestId: item.requestId };
  if ((keys.length === 1 || (keys.length === 2 && item.acceptancePending === true)) && typeof item.proposalId === "string" && uuid.test(item.proposalId)
    && keys.every(key => key === "proposalId" || key === "acceptancePending")) {
    return { proposalId: item.proposalId, ...(item.acceptancePending === true ? { acceptancePending: true } : {}) };
  }
  throw new Error("Invalid Story Blueprint recovery checkpoint.");
}

export function readBlueprintRecovery(bookId: string, actor: string) {
  const current = sessionStorage.getItem(storyBlueprintProposalSessionKey(bookId, actor));
  const legacy = sessionStorage.getItem(storyBlueprintProposalSessionKey(bookId));
  if (current !== null && legacy !== null) throw new Error("Multiple Story Blueprint requests need reconciliation.");
  const raw = current ?? legacy;
  return raw === null ? null : { pointer: parse(raw), raw, legacy: legacy !== null };
}

/** Replace only the checkpoint that was observed, preserving unknown or concurrent work. */
export function writeBlueprintRecovery(bookId: string, actor: string, pointer: BlueprintRecovery, expectedRaw: string | null, legacyRaw?: string) {
  const key = storyBlueprintProposalSessionKey(bookId, actor);
  const legacyKey = storyBlueprintProposalSessionKey(bookId);
  if (sessionStorage.getItem(key) !== expectedRaw || sessionStorage.getItem(legacyKey) !== (legacyRaw ?? null)) {
    throw new Error("A different Story Blueprint request needs recovery first.");
  }
  const next = JSON.stringify(pointer);
  parse(next);
  sessionStorage.setItem(key, next);
  if (sessionStorage.getItem(key) !== next) throw new Error("Story Blueprint recovery storage could not be verified.");
  if (legacyRaw !== undefined) {
    if (sessionStorage.getItem(legacyKey) !== legacyRaw) throw new Error("The older Story Blueprint checkpoint changed.");
    sessionStorage.removeItem(legacyKey);
    if (sessionStorage.getItem(legacyKey) !== null) throw new Error("The older Story Blueprint checkpoint could not be migrated.");
  }
}

export function clearBlueprintRecovery(bookId: string, actor: string, expectedRaw: string) {
  const key = storyBlueprintProposalSessionKey(bookId, actor);
  if (sessionStorage.getItem(storyBlueprintProposalSessionKey(bookId)) !== null || sessionStorage.getItem(key) !== expectedRaw) {
    throw new Error("The Story Blueprint recovery checkpoint changed.");
  }
  sessionStorage.removeItem(key);
  if (sessionStorage.getItem(key) !== null) throw new Error("The Story Blueprint checkpoint could not be cleared.");
}
