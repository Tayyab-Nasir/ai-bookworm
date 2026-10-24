export const AI_PROVIDERS = ["openai", "anthropic", "google", "openrouter", "xai"] as const;
export type AiProvider = typeof AI_PROVIDERS[number];
export interface AiConnection {
  id: string; provider: AiProvider; revision: number; status: "saved" | "revoked";
  keySuffix: string | null; lastOperationId: string; createdAt: string; updatedAt: string;
}
export interface AiConnections {
  viewerId: string; canSave: boolean; generationAvailable: boolean; connections: AiConnection[];
}
export interface AiConnectionMutation { connectionId: string; operationId: string; expectedRevision: number | null }
export interface AiConnectionPending extends AiConnectionMutation { provider: AiProvider; action: "save" | "revoke" }
export interface AiConnectionReceipt extends AiConnectionPending { status: "not_found" | "closed" | "saved" | "revoked"; revision: number | null }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI connection response could not be verified.");
  return value as Record<string, unknown>;
}
export function parseAiConnection(value: unknown): AiConnection {
  const row = record(value);
  if (typeof row.id !== "string" || !uuid.test(row.id) || typeof row.provider !== "string" || !AI_PROVIDERS.includes(row.provider as AiProvider)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || Number(row.revision) > 2_147_483_647
    || !["saved", "revoked"].includes(String(row.status)) || typeof row.lastOperationId !== "string" || !uuid.test(row.lastOperationId)
    || (row.status === "saved" ? typeof row.keySuffix !== "string" || !/^[A-Za-z0-9_./+=-]{4}$/u.test(row.keySuffix) : row.keySuffix !== null)
    || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) {
    throw new Error("AI connection response could not be verified.");
  }
  return { id: row.id, provider: row.provider as AiProvider, revision: Number(row.revision), status: row.status as AiConnection["status"],
    keySuffix: row.keySuffix as string | null, lastOperationId: row.lastOperationId, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export function parseAiConnections(value: unknown, expectedActor: string): AiConnections {
  const data = record(value);
  if (!uuid.test(expectedActor) || data.viewerId !== expectedActor || typeof data.canSave !== "boolean" || typeof data.generationAvailable !== "boolean"
    || !Array.isArray(data.connections) || data.connections.length > AI_PROVIDERS.length) throw new Error("AI connection response could not be verified.");
  const connections = data.connections.map(parseAiConnection);
  if (new Set(connections.map(connection => connection.provider)).size !== connections.length) throw new Error("AI connection response could not be verified.");
  return { viewerId: expectedActor, canSave: data.canSave, generationAvailable: data.generationAvailable, connections };
}
export function parseAiConnectionMutation(value: unknown, expectedActor: string, provider: AiProvider, mutation: AiConnectionMutation, action: "save" | "revoke") {
  const data = record(value), connection = parseAiConnection(data.connection);
  if (data.viewerId !== expectedActor || connection.id !== mutation.connectionId || connection.provider !== provider
    || connection.revision !== (mutation.expectedRevision ?? 0) + 1 || connection.lastOperationId !== mutation.operationId || connection.status !== (action === "save" ? "saved" : "revoked")) {
    throw new Error("The AI connection change could not be confirmed. Reload saved status.");
  }
  return { viewerId: expectedActor, connection };
}
export function parseAiConnectionReceipt(value: unknown, expectedActor: string, pending: AiConnectionPending, close: boolean) {
  const data = record(value), receipt = record(data.receipt);
  if (data.viewerId !== expectedActor || receipt.connectionId !== pending.connectionId || receipt.provider !== pending.provider
    || receipt.operationId !== pending.operationId || receipt.expectedRevision !== pending.expectedRevision || receipt.action !== pending.action
    || !["not_found", "closed", "saved", "revoked"].includes(String(receipt.status)) || (close && receipt.status === "not_found")
    || (["saved", "revoked"].includes(String(receipt.status)) ? receipt.revision !== (pending.expectedRevision ?? 0) + 1
      || receipt.status !== (pending.action === "save" ? "saved" : "revoked") : receipt.revision !== null)) {
    throw new Error("Connection recovery could not be verified.");
  }
  return { viewerId: expectedActor, receipt: { ...pending, status: receipt.status as AiConnectionReceipt["status"], revision: receipt.revision as number | null } };
}
