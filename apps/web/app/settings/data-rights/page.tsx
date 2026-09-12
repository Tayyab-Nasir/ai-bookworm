"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthorHeader, AuthorPage } from "../../../components/AuthorShell";
import { apiClient } from "../../../components/api";

type DataRequest = {
  id: string;
  request_type: "export" | "delete";
  status: string;
  reason: string | null;
  requested_at: string;
  due_at: string;
  completed_at: string | null;
};

type SupportTicket = {
  id: string;
  category: string;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
};

const tabStyles = {
  container: "flex flex-wrap gap-2",
  base: "rounded-full px-4 py-2.5 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40",
  active: "bg-white font-semibold text-black",
  inactive: "border border-white/15 text-white/60 hover:text-white",
};

function date(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Date unavailable";
  return new Date(value).toLocaleString();
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    submitted: "border-amber-400/30 bg-amber-400/10 text-amber-100",
    processing: "border-blue-400/30 bg-blue-400/10 text-blue-100",
    completed: "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
    rejected: "border-red-400/30 bg-red-400/10 text-red-100",
    cancelled: "border-white/15 bg-white/5 text-white/40",
    open: "border-amber-400/30 bg-amber-400/10 text-amber-100",
    pending: "border-blue-400/30 bg-blue-400/10 text-blue-100",
    resolved: "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
    closed: "border-white/15 bg-white/5 text-white/40",
  };
  return <span className={`rounded-full border px-3 py-1.5 text-xs capitalize ${colors[status] || "border-white/15 text-white/70"}`}>{status}</span>;
}

export default function DataRightsPage() {
  const api = apiClient();
  const [tab, setTab] = useState<"requests" | "support">("requests");
  const [dataRequests, setDataRequests] = useState<DataRequest[]>([]);
  const [supportTickets, setSupportTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [exportReason, setExportReason] = useState("");
  const [deleteReason, setDeleteReason] = useState("");

  async function loadData(target: "requests" | "support" = tab) {
    setLoading(true);
    setError(null);
    try {
      if (target === "requests") {
        const res = await api.listDataRequests();
        setDataRequests(res.requests);
      } else {
        const res = await api.listSupportTickets();
        setSupportTickets(res.tickets);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [tab]);

  async function submitRequest(type: "export" | "delete", reason: string, confirmation?: string) {
    if (busy) return;
    setBusy(type);
    setError(null);
    setNotice(null);
    try {
      await api.createDataRequest({ type, reason: reason.trim() || undefined, confirmation });
      setNotice(`${type === "export" ? "Export" : "Deletion"} request submitted.`);
      if (type === "export") { setExportReason(""); setShowExportModal(false); }
      else { setDeleteReason(""); setDeleteConfirmation(""); setShowDeleteModal(false); }
      await loadData("requests");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit request.");
    } finally {
      setBusy(null);
    }
  }

  async function cancelRequest(requestId: string) {
    if (busy) return;
    setBusy(requestId);
    setError(null);
    try {
      await api.cancelDataRequest(requestId);
      setNotice("Request cancelled.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel request.");
    } finally {
      setBusy(null);
    }
  }

  async function submitSupportTicket(values: { category: string; subject: string; body: string }) {
    if (busy) return;
    setBusy("support");
    setError(null);
    try {
      await api.createSupportTicket(values);
      setNotice("Support request submitted.");
      setTab("support");
      await loadData("support");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit ticket.");
    } finally {
      setBusy(null);
    }
  }

  const inputStyle = "rounded-xl border border-white/15 bg-[#101010] px-3 py-2.5 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-white";
  const buttonStyle = "rounded-full border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40";
  const primaryButton = "glass-solid metal-shine group mt-2 flex h-14 w-full items-center justify-between rounded-full pl-6 pr-2 text-[15px] font-semibold text-black outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-black";
  const modalPrimaryButton = "glass-solid metal-shine flex min-h-11 flex-1 items-center justify-center rounded-full px-5 text-sm font-semibold text-black outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40";
  const labelStyle = "mb-2 ml-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]";

  return (
    <AuthorPage>
      <AuthorHeader />
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-5 border-b border-white/10 pb-8">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">Account & privacy</p>
            <h1 className="mt-3 text-4xl font-medium tracking-[-0.055em]">Data rights & support</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-white/55">
              Request a copy of your data, submit a deletion request, or open a support ticket.
              Requests enter a private review queue. Nothing is deleted automatically from this screen.
            </p>
          </div>
          <Link href="/settings/password" className={buttonStyle}>Change password</Link>
        </div>

        <nav aria-label="Data rights sections" className="mt-6 flex flex-wrap gap-2">
          {(["requests", "support"] as const).map((item) => (
            <button
              key={item}
              disabled={busy === item}
              onClick={() => setTab(item)}
              aria-current={tab === item ? "page" : undefined}
              className={`${tabStyles.base} ${tab === item ? tabStyles.active : tabStyles.inactive}`}
            >
              {item === "requests" ? "Data requests" : "Support tickets"}
            </button>
          ))}
        </nav>

        {error && <p role="alert" className="mt-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{error}</p>}
        {notice && <p role="status" className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</p>}

        {tab === "requests" && (
          <>
            <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-xl font-medium">Your data requests</h2>
                <p className="mt-1 text-xs text-white/40">Track review status here. Support will provide fulfillment instructions when a request is complete.</p>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={busy === "export"}
                  onClick={() => setShowExportModal(true)}
                  className={buttonStyle}
                >
                  Request data export
                </button>
                <button
                  type="button"
                  disabled={busy === "delete"}
                  onClick={() => setShowDeleteModal(true)}
                  className={buttonStyle}
                >
                  Request account deletion
                </button>
              </div>
            </div>

            <section aria-label="Data requests" aria-busy={loading} className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
              {loading ? (
                <p role="status" className="p-12 text-center text-sm text-white/45">Loading requests…</p>
              ) : dataRequests.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-base text-white/80">No data requests yet</p>
                  <p className="mt-2 text-sm text-white/40">Use the buttons above to request an export or account deletion.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/10">
                  {dataRequests.map((req) => (
                    <article key={req.id} className="p-5 sm:p-6">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <h3 className="font-medium capitalize">{req.request_type} request</h3>
                          <p className="mt-2 break-all font-mono text-xs text-white/40">{req.id}</p>
                          <p className="mt-2 text-xs text-white/40">Submitted {date(req.requested_at)} · Due {date(req.due_at)}</p>
                          {req.reason && <p className="mt-2 text-sm text-white/60">Reason: {req.reason}</p>}
                          {req.completed_at && <p className="mt-2 text-xs text-white/40">Completed {date(req.completed_at)}</p>}
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          {statusBadge(req.status)}
                          {req.status === "submitted" && (
                            <button
                              type="button"
                              disabled={busy === req.id}
                              onClick={() => cancelRequest(req.id)}
                              className={buttonStyle}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {tab === "support" && (
          <>
            <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-xl font-medium">Support tickets</h2>
                <p className="mt-1 text-xs text-white/40">Open a new ticket or view existing ones.</p>
              </div>
            </div>

            <section aria-label="Support tickets" aria-busy={loading} className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
              {loading ? (
                <p role="status" className="p-12 text-center text-sm text-white/45">Loading tickets…</p>
              ) : supportTickets.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-base text-white/80">No support tickets yet</p>
                  <p className="mt-2 text-sm text-white/40">Use the form below to open a new ticket.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/10">
                  {supportTickets.map((t) => (
                    <article key={t.id} className="p-5 sm:p-6">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <h3 className="font-medium">{t.subject}</h3>
                          <p className="mt-2 break-all font-mono text-xs text-white/40">{t.id}</p>
                          <p className="mt-2 text-xs text-white/40">{date(t.created_at)} · {t.category} · {t.priority} priority</p>
                        </div>
                        {statusBadge(t.status)}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <form onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              submitSupportTicket({
                category: fd.get("category") as string,
                subject: fd.get("subject") as string,
                body: fd.get("body") as string,
              });
            }} className="mt-8 rounded-2xl border border-white/10 bg-white/[0.025] p-6 space-y-5">
              <h3 className="text-lg font-medium">Open a new ticket</h3>
              <div>
                <label htmlFor="category" className={labelStyle}>Category</label>
                <select id="category" name="category" required className={inputStyle}>
                  <option value="general">General</option>
                  <option value="technical">Technical</option>
                  <option value="billing">Billing</option>
                  <option value="publishing">Publishing</option>
                  <option value="account">Account</option>
                  <option value="privacy">Privacy</option>
                </select>
              </div>
              <div>
                <label htmlFor="subject" className={labelStyle}>Subject</label>
                <input id="subject" name="subject" type="text" required minLength={3} maxLength={160} placeholder="Brief summary of your issue" className={inputStyle} />
              </div>
              <div>
                <label htmlFor="body" className={labelStyle}>Description</label>
                <textarea id="body" name="body" required minLength={10} maxLength={5000} rows={6} placeholder="Describe your issue in detail…" className={`${inputStyle} h-auto min-h-[120px] resize-y`} />
              </div>
              <button type="submit" disabled={busy === "support"} className={primaryButton}>
                <span className="relative z-10 tracking-[-0.01em]">{busy === "support" ? "Submitting…" : "Submit ticket"}</span>
              </button>
            </form>
          </>
        )}

        {/* Export Modal */}
        {showExportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setShowExportModal(false)}>
            <div role="dialog" aria-modal="true" aria-labelledby="export-dialog-title" className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0a0a0a] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <h3 id="export-dialog-title" className="text-xl font-medium">Request data export</h3>
              <p className="mt-3 text-sm leading-6 text-white/60">We'll review the request and prepare an account-data copy. You can track its status on this page.</p>
              <label htmlFor="exportReason" className="mt-5 block">
                <span className={labelStyle}>Reason (optional)</span>
                <textarea id="exportReason" value={exportReason} onChange={(e) => setExportReason(e.target.value)} rows={3} maxLength={2000} placeholder="Why are you requesting this export?" className={`${inputStyle} mt-2 w-full`} />
              </label>
              <div className="mt-6 flex gap-3">
                <button onClick={() => setShowExportModal(false)} className={`flex-1 ${buttonStyle}`}>Cancel</button>
                <button disabled={busy === "export"} onClick={() => submitRequest("export", exportReason)} className={modalPrimaryButton}>
                  <span className="relative z-10 tracking-[-0.01em]">{busy === "export" ? "Submitting…" : "Request export"}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Modal */}
        {showDeleteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setShowDeleteModal(false)}>
            <div role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" className="w-full max-w-md rounded-2xl border border-red-400/20 bg-[#0a0a0a] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <h3 id="delete-dialog-title" className="text-xl font-medium">Request account deletion</h3>
              <p className="mt-3 text-sm leading-6 text-red-100">Submitting this request does not delete data immediately. Support will review ownership, shared workspaces, billing, and retention obligations before any irreversible action.</p>
              <label htmlFor="deleteReason" className="mt-5 block">
                <span className={labelStyle}>Reason (optional)</span>
                <textarea id="deleteReason" value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} rows={3} maxLength={2000} placeholder="Why do you want to delete your account?" className={`${inputStyle} mt-2 w-full`} />
              </label>
              <label htmlFor="deleteConfirmation" className="mt-5 block">
                <span className={labelStyle}>Type <code className="font-mono text-red-300">DELETE MY ACCOUNT</code> to confirm</span>
                <input id="deleteConfirmation" value={deleteConfirmation} onChange={(e) => setDeleteConfirmation(e.target.value)} type="text" required placeholder="DELETE MY ACCOUNT" className={`${inputStyle} mt-2 w-full font-mono`} />
              </label>
              <div className="mt-6 flex gap-3">
                <button onClick={() => setShowDeleteModal(false)} className={`flex-1 ${buttonStyle}`}>Cancel</button>
                <button disabled={busy === "delete" || deleteConfirmation !== "DELETE MY ACCOUNT"} onClick={() => submitRequest("delete", deleteReason, deleteConfirmation)} className={modalPrimaryButton}>
                  <span className="relative z-10 tracking-[-0.01em]">{busy === "delete" ? "Submitting…" : "Request deletion"}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </AuthorPage>
  );
}
