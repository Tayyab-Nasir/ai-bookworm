"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { createClient } from '@bookworm/api-client';
import { beginAssetOperation, clearConfirmedAssetOperation, isAssetMutationReceipt, listAssetOperations, type AssetOperation } from '../lib/asset-lifecycle-operation';

type Client = ReturnType<typeof createClient>;
type Removed = { id: string; workspace_id: string; name: string; deleted_at: string; lifecycle_revision: string | null; hasRecordedChecksum: boolean };
type Cursor = { beforeDeletedAt: string; beforeId: string };
type Scope = { actor: string; begin: () => () => boolean };
function sameTimestamp(a: string | null, b: string | null) {
  if (a === null || b === null) return a === b;
  const micros = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
    const milliseconds = Date.parse(value);
    if (!match || !Number.isFinite(milliseconds)) return null;
    const [year,month,day,hour,minute,second] = match.slice(1,7).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
    if (month < 1 || month > 12 || day < 1 || day > days[month-1] || hour > 23 || minute > 59 || second > 59) return null;
    return BigInt(milliseconds) * 1000n + BigInt((match[7] ?? '').padEnd(6, '0').slice(3));
  };
  const left = micros(a), right = micros(b);
  return left !== null && right !== null && left === right;
}
function validOutcome(value: { outcome: string; committedAt: string | null; closedAt: string | null }) {
  return value.outcome === 'committed'
    ? typeof value.committedAt === 'string' && sameTimestamp(value.committedAt,value.committedAt) && value.closedAt === null
    : value.outcome === 'closed' && typeof value.closedAt === 'string' && sameTimestamp(value.closedAt,value.closedAt) && value.committedAt === null;
}
function checkedPage(value: { assets: Removed[]; nextCursor: Cursor | null }, workspaceId: string, prior: Removed[] = []) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!value || !Array.isArray(value.assets) || value.assets.length > 50) throw new Error('Invalid page');
  const ids = new Set(prior.map(row => row.id.toLowerCase()));
  for (const row of value.assets) {
    if (!row || typeof row.id !== 'string' || !uuid.test(row.id) || ids.has(row.id.toLowerCase()) || row.workspace_id !== workspaceId
        || typeof row.name !== 'string' || row.name.length > 500 || typeof row.deleted_at !== 'string' || !sameTimestamp(row.deleted_at, row.deleted_at)
        || typeof row.hasRecordedChecksum !== 'boolean' || !Object.hasOwn(row, 'lifecycle_revision')
        || (row.lifecycle_revision !== null && (typeof row.lifecycle_revision !== 'string' || !uuid.test(row.lifecycle_revision)))) throw new Error('Invalid page');
    ids.add(row.id.toLowerCase());
  }
  const last=value.assets.at(-1), next=value.nextCursor ?? null;
  if (next && (!last || next.beforeId !== last.id || !sameTimestamp(next.beforeDeletedAt,last.deleted_at))) throw new Error('Invalid page cursor');
  return next;
}
export default function RemovedAssets({ api, scope, workspaceId, canEdit, current, revision, onChanged }: {
  api: Client; scope: Scope; workspaceId: string; canEdit: boolean; current: () => boolean; revision: number; onChanged: () => Promise<void>;
}) {
  const [removed,setRemoved] = useState<Removed[]>([]), [pending,setPending] = useState<AssetOperation[]>([]);
  const [legacyAssetIds,setLegacyAssetIds] = useState<string[]>([]);
  const [error,setError] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(''), [refresh,setRefresh] = useState(0);
  const [nextCursor,setNextCursor] = useState<Cursor | null>(null), [paginationUnavailable,setPaginationUnavailable] = useState(false), [listLoading,setListLoading] = useState(false), [pageBusy,setPageBusy] = useState(false);
  const flight=useRef<object | null>(null);
  const listEpoch=useRef(0), pageFlight=useRef(false), removedRef=useRef<Removed[]>([]);
  useEffect(() => { if (!canEdit) { flight.current=null; setBusy(''); } }, [canEdit]);
  const load = useCallback(async () => {
    if (!canEdit || !current()) return;
    const epoch=++listEpoch.current, valid=scope.begin(); const alive=()=>epoch===listEpoch.current && valid() && current();
    pageFlight.current=false; setPageBusy(false); setListLoading(true); setNextCursor(null); setPaginationUnavailable(false); removedRef.current=[]; setRemoved([]);
    try {
      const saved=listAssetOperations(sessionStorage,scope.actor,workspaceId);
      if (alive()) { setPending(saved.operations); setLegacyAssetIds(saved.legacyAssetIds); }
      const result=await api.listRemovedAssets(workspaceId);
      if (alive()) { const next=checkedPage(result,workspaceId); removedRef.current=result.assets; setRemoved(result.assets); setNextCursor(next); setPaginationUnavailable(!Object.hasOwn(result,'nextCursor')); setError(''); }
    } catch { if (alive()) setError('Removed files or saved operations could not be loaded. Refresh to try again.'); }
    finally { if (alive()) setListLoading(false); }
  },[api,scope,workspaceId,canEdit,current]);
  useEffect(()=>{ void load(); return () => { ++listEpoch.current; }; },[load,revision,refresh]);
  async function loadOlder() {
    if (!canEdit || !current() || !nextCursor || pageFlight.current || flight.current || listLoading) return;
    const cursor=nextCursor, epoch=listEpoch.current, valid=scope.begin();
    const alive=()=>epoch===listEpoch.current && valid() && current();
    pageFlight.current=true; setPageBusy(true); setError('');
    try {
      const result=await api.listRemovedAssets(workspaceId,cursor);
      if (!alive()) return;
      if (!Object.hasOwn(result,'nextCursor')) throw new Error('The file service does not support paging.');
      const prior=removedRef.current, following=checkedPage(result,workspaceId,prior);
      const combined=[...prior,...result.assets]; removedRef.current=combined; setRemoved(combined); setNextCursor(following);
    } catch { if (alive()) setError('Older removed files could not be loaded. Try again or refresh the list.'); }
    finally { if (alive()) { pageFlight.current=false; setPageBusy(false); } }
  }
  async function complete(op: AssetOperation, mode: 'check' | 'retry' | 'close') {
    if (!canEdit || !current() || flight.current || pageFlight.current || listLoading) return;
    const token={}; flight.current=token;
    const valid=scope.begin(); const alive=()=>valid() && current();
    setBusy(op.assetId); setError(''); setNotice('Checking the original request…');
    let cleared = false;
    try {
      const status=await api.getAssetLifecycleStatus(workspaceId,op.assetId,op.operationId);
      if (!alive()) return;
      if (status.operation && (status.operation.assetId !== op.assetId || status.operation.operationId !== op.operationId ||
          status.operation.action !== op.action || status.operation.expectedRevision !== op.expectedRevision || !sameTimestamp(status.operation.expectedDeletedAt,op.expectedDeletedAt) ||
          !validOutcome(status.operation))) throw new Error('Unverified operation');
      let receipt: { assetId: string; operationId: string; action: string; outcome: 'committed' | 'closed' } | null=status.operation;
      if (!receipt && mode === 'close') {
        setNotice('Closing the original request…');
        const result=(await api.closeAssetLifecycle(op.assetId,{workspaceId,operationId:op.operationId,action:op.action,expectedDeletedAt:op.expectedDeletedAt,expectedRevision:op.expectedRevision})).operation;
        if (result.assetId !== op.assetId || result.operationId !== op.operationId || result.action !== op.action ||
            result.expectedRevision !== op.expectedRevision || !sameTimestamp(result.expectedDeletedAt,op.expectedDeletedAt) || !validOutcome(result)) throw new Error('Unverified operation');
        receipt=result;
      } else if (!receipt && mode === 'retry') {
        setNotice(op.action === 'restore' ? 'Checking the saved file and restoring…' : 'Retrying the original removal…');
        const result=op.action === 'remove'
          ? await api.removeAssetLifecycle(op.assetId,{workspaceId,operationId:op.operationId,expectedRevision:op.expectedRevision})
          : await api.restoreAssetLifecycle(op.assetId,{workspaceId,operationId:op.operationId,expectedDeletedAt:op.expectedDeletedAt!,expectedRevision:op.expectedRevision});
        if (!isAssetMutationReceipt(result) || result.expectedRevision !== op.expectedRevision) throw new Error('Unverified operation');
        receipt={...result,outcome:'committed'};
      }
      if (!alive()) return;
      if (!receipt) { setNotice('The original request is not confirmed yet. Retry it with the same request ID.'); return; }
      clearConfirmedAssetOperation(sessionStorage,op,receipt);
      cleared = true;
      const saved=listAssetOperations(sessionStorage,scope.actor,workspaceId);
      setPending(saved.operations); setLegacyAssetIds(saved.legacyAssetIds);
      setNotice(receipt.outcome === 'closed' ? 'The original request was closed. It cannot complete later.' : op.action === 'restore' ? 'Restoration confirmed. The file was verified at that time.' : 'Removal confirmed.');
      try { await onChanged(); if (alive()) setRefresh(n=>n+1); }
      catch { if (alive()) setError('The request was confirmed, but the file list could not refresh. Refresh the page to update it.'); }
    } catch { if (alive()) setError(cleared ? 'The request was confirmed, but the file list could not refresh. Refresh the page to update it.' : 'The request could not be confirmed. Check the original request before trying again.'); }
    finally { if (flight.current===token) { flight.current=null; if (alive()) setBusy(''); } }
  }
  function restore(row: Removed) {
    if (!canEdit || !current() || flight.current || pageFlight.current || listLoading || !row.hasRecordedChecksum) return;
    try {
      if (!Object.hasOwn(row,'lifecycle_revision')) throw new Error('File version is unavailable.');
      const op=beginAssetOperation(sessionStorage,{actor:scope.actor,workspaceId,assetId:row.id,action:'restore',expectedDeletedAt:row.deleted_at,expectedRevision:row.lifecycle_revision},()=>crypto.randomUUID());
      const saved=listAssetOperations(sessionStorage,scope.actor,workspaceId);
      setPending(saved.operations); setLegacyAssetIds(saved.legacyAssetIds);
      void complete(op,'retry');
    } catch { setError('The original request must be resolved before starting a restore.'); }
  }
  if (!canEdit) return null;
  return <section className="mb-8 rounded-2xl border border-white/10 p-5" aria-labelledby="removed-files-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="removed-files-title" className="text-lg font-semibold">Removed files</h2><button type="button" disabled={!!busy} onClick={()=>{ ++listEpoch.current; setRefresh(n=>n+1); }} className="text-sm underline disabled:opacity-50">Refresh removed files</button></div>
    <p className="mt-2 text-xs leading-5 text-[#999]">Files are shown newest first. Refresh to see changes made in another tab. Restore checks that the saved file is available and matches its recorded contents. Prior approvals do not carry over.</p>
    {paginationUnavailable && <p className="mt-3 text-sm text-amber-200">Older removed files may not be shown because this file service does not support paging yet. Refresh after the service is updated.</p>}
    {notice && <p role="status" className="mt-3 text-sm text-[#bbb]">{notice}</p>}{error && <p role="alert" className="mt-3 text-sm text-amber-200">{error}</p>}
    {legacyAssetIds.length > 0 && <div role="alert" className="mt-3 text-sm text-amber-200"><p>An older file request cannot be retried safely. Keep this tab open and contact support for help.</p><ul>{legacyAssetIds.map(id=><li key={id} className="break-all">File {id}</li>)}</ul></div>}
    {pending.length > 0 && <div className="mt-4"><h3 className="text-sm font-medium">Requests needing confirmation on this tab</h3><ul className="mt-2 space-y-3">{pending.map(op=><li key={op.operationId} className="text-sm"><p className="break-all text-[#bbb]">{op.action === 'remove' ? 'Removal' : 'Restoration'} · file {op.assetId}</p><div className="mt-2 flex flex-wrap gap-4"><button type="button" disabled={!!busy || pageBusy || listLoading} onClick={()=>void complete(op,'check')} className="underline disabled:opacity-50">Check status</button><button type="button" disabled={!!busy || pageBusy || listLoading} onClick={()=>void complete(op,'retry')} className="underline disabled:opacity-50">Retry original request</button><button type="button" disabled={!!busy || pageBusy || listLoading} onClick={()=>{if(window.confirm('Close this unconfirmed request? If it has not completed, it will not complete later.')) void complete(op,'close');}} className="underline disabled:opacity-50">Close unconfirmed request</button></div></li>)}</ul></div>}
    {listLoading ? <p role="status" className="mt-4 text-sm text-[#999]">Loading removed files…</p> : !removed.length ? !error && <p className="mt-4 text-sm text-[#999]">No removed files in this list.</p> : <ul className="mt-3 divide-y divide-white/10">{removed.map(row=><li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><span className="break-all">{row.name}</span>{row.hasRecordedChecksum ? <button type="button" disabled={!!busy || pageBusy || legacyAssetIds.includes(row.id) || pending.some(op=>op.assetId===row.id)} onClick={()=>restore(row)} className="underline disabled:opacity-50">{busy===row.id ? 'Checking…' : 'Restore'}</button> : <span className="text-[#999]">Restore unavailable: no usable file checksum was recorded.</span>}</li>)}</ul>}
    {nextCursor && <button type="button" disabled={!!busy || pageBusy || listLoading} onClick={()=>void loadOlder()} className="mt-4 text-sm underline disabled:opacity-50">{pageBusy ? 'Loading older files…' : 'Load older removed files'}</button>}
  </section>;
}
