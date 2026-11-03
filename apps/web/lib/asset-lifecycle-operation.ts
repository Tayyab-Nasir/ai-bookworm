export type AssetOperation = { actor: string; workspaceId: string; assetId: string; operationId: string; action: 'remove' | 'restore'; expectedDeletedAt: string | null; expectedRevision: string | null };
export function isAssetMutationReceipt(value: unknown): value is { assetId: string; operationId: string; action: 'remove' | 'restore'; expectedRevision: string | null; replayed: boolean } {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).sort().join(',') === 'action,assetId,expectedRevision,operationId,replayed'
    && typeof receipt.assetId === 'string' && uuid.test(receipt.assetId)
    && typeof receipt.operationId === 'string' && uuid.test(receipt.operationId)
    && (receipt.action === 'remove' || receipt.action === 'restore')
    && (receipt.expectedRevision === null || typeof receipt.expectedRevision === 'string' && uuid.test(receipt.expectedRevision))
    && typeof receipt.replayed === 'boolean';
}
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class LegacyAssetOperationError extends Error {
  constructor() { super('An older file request cannot be retried safely. Keep this tab open and contact support for help.'); }
}
function key(actor: string, workspaceId: string, assetId: string) { return `bookworm:asset-operation:v1:${actor}:${workspaceId}:${assetId}`; }
function valid(op: unknown): op is AssetOperation {
  if (!op || typeof op !== 'object') return false;
  const v = op as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'action,actor,assetId,expectedDeletedAt,expectedRevision,operationId,workspaceId'
    && ['actor','workspaceId','assetId','operationId'].every(k => typeof v[k] === 'string' && uuid.test(v[k] as string))
    && (v.expectedRevision === null || typeof v.expectedRevision === 'string' && uuid.test(v.expectedRevision))
    && ((v.action === 'remove' && v.expectedDeletedAt === null)
      || (v.action === 'restore' && typeof v.expectedDeletedAt === 'string' && Number.isFinite(Date.parse(v.expectedDeletedAt))));
}
function scope(actor: string, workspaceId: string, assetId: string) {
  if (![actor,workspaceId,assetId].every(x => uuid.test(x))) throw new Error('File operation scope is invalid.');
  return key(actor,workspaceId,assetId);
}
export function readAssetOperation(store: Store, actor: string, workspaceId: string, assetId: string): AssetOperation | null {
  const saved = store.getItem(scope(actor,workspaceId,assetId));
  if (saved === null) return null;
  let value: unknown;
  try { value = JSON.parse(saved); } catch { throw new Error('The original file operation could not be read.'); }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') === 'action,actor,assetId,expectedDeletedAt,operationId,workspaceId'
        && v.actor === actor && v.workspaceId === workspaceId && v.assetId === assetId
        && typeof v.operationId === 'string' && uuid.test(v.operationId)
        && ((v.action === 'remove' && v.expectedDeletedAt === null) || (v.action === 'restore'
          && typeof v.expectedDeletedAt === 'string' && Number.isFinite(Date.parse(v.expectedDeletedAt)))))
      throw new LegacyAssetOperationError();
  }
  if (!valid(value) || value.actor !== actor || value.workspaceId !== workspaceId || value.assetId !== assetId)
    throw new Error('The original file operation could not be verified.');
  return value;
}
export function beginAssetOperation(store: Store, input: Omit<AssetOperation, 'operationId'>, newId: () => string): AssetOperation {
  const existing = readAssetOperation(store,input.actor,input.workspaceId,input.assetId);
  if (existing) {
    if (existing.action !== input.action || existing.expectedDeletedAt !== input.expectedDeletedAt || existing.expectedRevision !== input.expectedRevision)
      throw new Error('Check the original file operation before starting another.');
    return existing;
  }
  const op = {...input, operationId: newId()};
  if (!valid(op)) throw new Error('File operation could not be prepared.');
  const storageKey = scope(op.actor,op.workspaceId,op.assetId);
  store.setItem(storageKey,JSON.stringify(op));
  // Refuse to send when persistence is unavailable, malformed or overwritten.
  const saved = readAssetOperation(store,op.actor,op.workspaceId,op.assetId);
  if (JSON.stringify(saved) !== JSON.stringify(op)) throw new Error('File operation could not be saved for recovery.');
  return op;
}
export function clearConfirmedAssetOperation(store: Store, op: AssetOperation, receipt: { assetId: string; operationId: string; action: string } | null): void {
  const existing=readAssetOperation(store,op.actor,op.workspaceId,op.assetId);
  if (!existing || JSON.stringify(existing) !== JSON.stringify(op) || !receipt
    || receipt.assetId !== op.assetId || receipt.operationId !== op.operationId || receipt.action !== op.action)
    throw new Error('The original file operation is not confirmed.');
  store.removeItem(scope(op.actor,op.workspaceId,op.assetId));
}
export function listAssetOperations(store: Storage, actor: string, workspaceId: string): { operations: AssetOperation[]; legacyAssetIds: string[] } {
  if (![actor, workspaceId].every(x => uuid.test(x)) || store.length > 5000) throw new Error('Saved file operations could not be checked.');
  const prefix = `bookworm:asset-operation:v1:${actor}:${workspaceId}:`;
  const operations: AssetOperation[] = [];
  const legacyAssetIds: string[] = [];
  for (let i=0; i<store.length; i++) {
    const storageKey=store.key(i);
    if (!storageKey?.startsWith(prefix)) continue;
    const assetId=storageKey.slice(prefix.length);
    try {
      const operation=readAssetOperation(store,actor,workspaceId,assetId);
      if (!operation) throw new Error('Saved file operations could not be checked.');
      operations.push(operation);
    } catch (error) {
      if (!(error instanceof LegacyAssetOperationError)) throw error;
      legacyAssetIds.push(assetId);
    }
    if (operations.length + legacyAssetIds.length > 100) throw new Error('Too many saved file operations. Resolve them before continuing.');
  }
  return { operations, legacyAssetIds };
}
