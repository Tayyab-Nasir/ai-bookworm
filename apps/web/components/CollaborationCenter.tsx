"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEvent, TaskPriority, WorkspaceInvitation, WorkspaceTargetType } from "@bookworm/api-client";
import type { Approval, Asset, Book, MemberRole, Task, Workspace, WorkspaceMember } from "@bookworm/types";
import { apiClient } from "./api";

type View = "tasks" | "approvals" | "team";
type MemberProfile = { id: string; display_name: string; avatar_url: string | null };
type SessionUser = { id: string; email: string | null; displayName: string | null };
type InviteRole = Exclude<MemberRole, "owner">;

const card = "rounded-2xl border border-white/10 bg-white/[0.035]";
const input = "mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-2.5 text-sm text-white outline-none focus:border-white/40";
const roles: MemberRole[] = ["owner", "admin", "editor", "writer", "illustrator", "designer", "reviewer", "viewer"];
const taskStatuses: Task["status"][] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const editRoles = new Set<MemberRole>(["owner", "admin", "editor", "writer", "illustrator", "designer"]);
const approveRoles = new Set<MemberRole>([...editRoles, "reviewer"]);

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function statusTone(status: string) {
  if (["active", "approved", "done"].includes(status)) return "border-emerald-400/20 bg-emerald-400/10 text-emerald-100";
  if (["blocked", "rejected", "suspended"].includes(status)) return "border-red-400/20 bg-red-400/10 text-red-100";
  if (["pending", "invited", "in_progress"].includes(status)) return "border-amber-300/20 bg-amber-300/10 text-amber-50";
  return "border-white/10 bg-white/5 text-white/60";
}

export default function CollaborationCenter({ view }: { view: View }) {
  const api = apiClient();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState("");
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [profiles, setProfiles] = useState<MemberProfile[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskPriority, setTaskPriority] = useState<TaskPriority>("medium");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("viewer");
  const [inviteLink, setInviteLink] = useState("");
  const [approvalTarget, setApprovalTarget] = useState("");
  const [approvalReviewer, setApprovalReviewer] = useState("");
  const [approvalComment, setApprovalComment] = useState("");
  const requestGeneration = useRef(0);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.listWorkspaces(),
      fetch("/api/auth/session").then(async (response) => response.ok ? response.json() as Promise<{ user: SessionUser }> : { user: null }),
    ]).then(([workspaceResult, session]) => {
      if (!live) return;
      const requested = new URLSearchParams(window.location.search).get("ws") ?? window.localStorage.getItem("bookworm:workspaceId");
      const selected = workspaceResult.workspaces.find((item) => item.id === requested) ?? workspaceResult.workspaces[0];
      setWorkspaces(workspaceResult.workspaces);
      setSessionUser(session.user);
      setWorkspaceId(selected?.id ?? "");
    }).catch((reason: unknown) => {
      if (live) { setError(reason instanceof Error ? reason.message : "Could not load collaboration workspace."); setLoading(false); }
    });
    return () => { live = false; };
  }, [api]);

  const load = useCallback(async (): Promise<boolean> => {
    if (!workspaceId) { setLoading(false); return false; }
    const generation = ++requestGeneration.current;
    setLoading(true); setError(null);
    try {
      const [memberResult, taskResult, approvalBundle, activityResult] = await Promise.all([
        api.listMembers(workspaceId),
        view === "tasks" ? api.listTasks(workspaceId) : Promise.resolve(null),
        view === "approvals" ? Promise.all([api.listApprovals(workspaceId), api.listBooks(workspaceId), api.listAssets(workspaceId)]) : Promise.resolve(null),
        api.listActivity(workspaceId, 20),
      ]);
      if (generation !== requestGeneration.current) return false;
      const currentRole = memberResult.members.find((member) => member.user_id === sessionUser?.id && member.status === "active")?.role;
      const invitationResult = view === "team" && (currentRole === "owner" || currentRole === "admin")
        ? await api.listInvitations(workspaceId)
        : null;
      if (generation !== requestGeneration.current) return false;
      setMembers(memberResult.members);
      setProfiles(memberResult.profiles);
      setInvitations(invitationResult?.invitations ?? []);
      setActivity(activityResult.events);
      if (taskResult) setTasks(taskResult.tasks);
      else setTasks([]);
      if (view === "approvals") {
        const [approvalResult, bookResult, assetResult] = approvalBundle!;
        setApprovals(approvalResult.approvals);
        setBooks(bookResult.books);
        setAssets(assetResult.assets.filter((asset) => asset.status !== "archived"));
      } else { setApprovals([]); setBooks([]); setAssets([]); }
      setLoadedWorkspaceId(workspaceId);
      window.localStorage.setItem("bookworm:workspaceId", workspaceId);
      return true;
    } catch (reason) {
      if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : "Could not load collaboration data.");
      return false;
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [api, sessionUser?.id, view, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const membership = members.find((member) => member.user_id === sessionUser?.id && member.status === "active");
  const role = membership?.role;
  const canEdit = Boolean(role && editRoles.has(role));
  const canApprove = Boolean(role && approveRoles.has(role));
  const canManage = role === "owner" || role === "admin";
  const activeMembers = members.filter((member) => member.status === "active");
  const nameOf = useCallback((userId: string | null) => {
    if (!userId) return "Unassigned";
    return profiles.find((profile) => profile.id === userId)?.display_name || (userId === sessionUser?.id ? sessionUser.displayName : null) || shortId(userId);
  }, [profiles, sessionUser]);
  const pending = approvals.filter((approval) => approval.status === "pending");
  const resolved = approvals.filter((approval) => approval.status !== "pending");
  const targets = useMemo(() => [
    ...books.map((book) => ({ value: `book:${book.id}`, label: `Book · ${book.title}` })),
    ...assets.map((asset) => ({ value: `asset:${asset.id}`, label: `Asset · ${asset.name}` })),
  ], [assets, books]);
  const targetName = useCallback((entityType: string, entityId: string) => {
    if (entityType === "book") return books.find((book) => book.id === entityId)?.title ?? shortId(entityId);
    if (entityType === "asset") return assets.find((asset) => asset.id === entityId)?.name ?? shortId(entityId);
    return shortId(entityId);
  }, [assets, books]);

  function changeWorkspace(nextId: string) {
    requestGeneration.current += 1;
    setLoadedWorkspaceId("");
    setMembers([]); setProfiles([]); setTasks([]); setApprovals([]); setBooks([]); setAssets([]); setInvitations([]); setActivity([]);
    setTaskAssignee(""); setApprovalTarget(""); setApprovalReviewer(""); setInviteLink(""); setNotice(null); setError(null);
    setWorkspaceId(nextId);
    const url = new URL(window.location.href); url.searchParams.set("ws", nextId); window.history.replaceState(null, "", url);
  }

  async function perform(key: string, action: () => Promise<void>, success: string) {
    if (busy || loadedWorkspaceId !== workspaceId || loading) return;
    setBusy(key); setError(null); setNotice(null);
    try { await action(); if (await load()) setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The action could not be completed."); }
    finally { setBusy(null); }
  }

  const workspaceQuery = workspaceId ? `?ws=${encodeURIComponent(workspaceId)}` : "";
  const scopeReady = Boolean(workspaceId && loadedWorkspaceId === workspaceId && !loading);
  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
    <div className="flex flex-wrap items-end justify-between gap-5 border-b border-white/10 pb-7">
      <div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#8f8f8f]">Workspace operations</p><h1 className="mt-2 text-4xl font-medium tracking-[-0.055em]">{titleCase(view)}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-white/55">Coordinate assignments, review decisions, and access without leaving the publishing workspace.</p></div>
      {workspaces.length > 0 && <label className="text-xs text-white/50">Workspace<select value={workspaceId} onChange={(event) => changeWorkspace(event.target.value)} disabled={Boolean(busy)} className="mt-2 block min-w-56 rounded-xl border border-white/15 bg-black px-3 py-2.5 text-sm text-white">{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>}
    </div>
    <nav aria-label="Collaboration sections" className="mt-5 flex flex-wrap gap-2">{(["tasks", "approvals", "team"] as View[]).map((item) => <Link key={item} href={`/${item}${workspaceQuery}`} aria-current={view === item ? "page" : undefined} className={`rounded-full px-4 py-2 text-sm ${view === item ? "bg-white text-black" : "border border-white/10 text-white/55 hover:text-white"}`}>{titleCase(item)}</Link>)}</nav>
    {role && <p className="mt-4 text-xs text-white/40">Your workspace role: <span className="capitalize text-white/70">{role}</span></p>}
    {error && <div role="alert" className="mt-5 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}
    {notice && <div role="status" className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</div>}
    {workspaceId && !scopeReady && <section aria-live="polite" className={`${card} mt-8 p-8 text-center text-sm text-white/45`}>Loading workspace collaboration data…</section>}
    {!loading && !workspaceId && <section className={`${card} mt-8 p-6`}><h2 className="text-xl font-medium">No workspace yet</h2><p className="mt-2 text-sm text-white/50">Create a workspace from the dashboard before coordinating a team.</p><Link href="/dashboard" className="mt-4 inline-block underline">Go to dashboard</Link></section>}

    {scopeReady && view === "tasks" && <div className="mt-8 space-y-6">
      {canEdit && <form className={`${card} grid gap-4 p-5 lg:grid-cols-6`} onSubmit={(event) => { event.preventDefault(); if (!taskTitle.trim()) return; void perform("create-task", async () => { await api.createTask({ workspaceId, title: taskTitle.trim(), description: taskDescription.trim() || undefined, priority: taskPriority, assigneeId: taskAssignee || null, dueAt: taskDue ? new Date(taskDue).toISOString() : null }); setTaskTitle(""); setTaskDescription(""); setTaskDue(""); }, "Task created."); }}>
        <label className="text-xs text-white/55 lg:col-span-2">Task title<input required maxLength={256} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} className={input} placeholder="Review chapter opening" /></label>
        <label className="text-xs text-white/55 lg:col-span-2">Description<input maxLength={10000} value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} className={input} placeholder="Optional context" /></label>
        <label className="text-xs text-white/55">Assignee<select value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)} className={input}><option value="">Unassigned</option>{activeMembers.map((member) => <option key={member.user_id} value={member.user_id}>{nameOf(member.user_id)}</option>)}</select></label>
        <label className="text-xs text-white/55">Priority<select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as TaskPriority)} className={input}>{["low", "medium", "high", "urgent"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="text-xs text-white/55 lg:col-span-2">Due date<input type="datetime-local" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} className={input} /></label>
        <button disabled={busy === "create-task" || !taskTitle.trim()} className="glass-solid mt-auto min-h-10 rounded-full px-5 text-sm font-semibold text-black disabled:opacity-40 lg:col-span-2">{busy === "create-task" ? "Creating…" : "Create task"}</button>
      </form>}
      <section className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-5" aria-label="Task board">{taskStatuses.map((status) => { const column = tasks.filter((task) => task.status === status); return <div key={status} className={`${card} min-h-48 p-4`}><div className="flex items-center justify-between"><h2 className="text-sm font-medium">{titleCase(status)}</h2><span className="text-xs text-white/35">{column.length}</span></div><div className="mt-4 space-y-3">{column.map((task) => <article key={task.id} className="rounded-xl border border-white/10 bg-black/50 p-3"><h3 className="text-sm font-medium">{task.title}</h3>{task.description && <p className="mt-2 line-clamp-3 text-xs leading-5 text-white/45">{task.description}</p>}<div className="mt-3 flex flex-wrap gap-1.5 text-[10px]"><span className={`rounded-full border px-2 py-1 ${statusTone(task.priority === "urgent" ? "blocked" : task.priority)}`}>{titleCase(task.priority)}</span><span className="rounded-full border border-white/10 px-2 py-1 text-white/45">{nameOf(task.assignee_id)}</span>{task.due_at && <span className="rounded-full border border-white/10 px-2 py-1 text-white/45">Due {new Date(task.due_at).toLocaleDateString()}</span>}</div>{canEdit && <select aria-label={`Status for ${task.title}`} value={task.status} disabled={Boolean(busy)} onChange={(event) => void perform(`task-${task.id}`, () => api.updateTask(task.id, { status: event.target.value as Task["status"] }).then(() => undefined), "Task updated.")} className="mt-3 w-full rounded-lg border border-white/10 bg-black px-2 py-2 text-xs text-white">{taskStatuses.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</select>}</article>)}{!loading && column.length === 0 && <p className="py-6 text-center text-xs text-white/30">No tasks</p>}</div></div>; })}</section>
    </div>}

    {scopeReady && view === "approvals" && <div className="mt-8 grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
      <div className="space-y-6">{canEdit && <form className={`${card} p-5`} onSubmit={(event) => { event.preventDefault(); const [entityType, entityId] = approvalTarget.split(":"); if (!entityType || !entityId) return; void perform("request-approval", async () => { await api.createApproval({ workspaceId, entityType: entityType as WorkspaceTargetType, entityId, reviewerId: approvalReviewer || null, comment: approvalComment.trim() || undefined }); setApprovalTarget(""); setApprovalComment(""); }, "Approval requested."); }}><h2 className="text-lg font-medium">Request a review</h2><p className="mt-1 text-xs leading-5 text-white/45">Choose a saved book or asset in this workspace.</p><label className="mt-5 block text-xs text-white/55">Review target<select required value={approvalTarget} onChange={(event) => setApprovalTarget(event.target.value)} className={input}><option value="">Select a target</option>{targets.map((target) => <option key={target.value} value={target.value}>{target.label}</option>)}</select></label><label className="mt-4 block text-xs text-white/55">Reviewer<select value={approvalReviewer} onChange={(event) => setApprovalReviewer(event.target.value)} className={input}><option value="">Any eligible reviewer</option>{activeMembers.filter((member) => approveRoles.has(member.role)).map((member) => <option key={member.user_id} value={member.user_id}>{nameOf(member.user_id)} · {member.role}</option>)}</select></label><label className="mt-4 block text-xs text-white/55">Review note<textarea rows={4} maxLength={2000} value={approvalComment} onChange={(event) => setApprovalComment(event.target.value)} className={input} placeholder="What should the reviewer check?" /></label><button disabled={!approvalTarget || busy === "request-approval"} className="glass-solid mt-5 min-h-10 w-full rounded-full px-5 text-sm font-semibold text-black disabled:opacity-40">{busy === "request-approval" ? "Requesting…" : "Request approval"}</button></form>}
        <section className={`${card} p-5`}><h2 className="text-lg font-medium">Resolved</h2><div className="mt-4 space-y-2">{resolved.map((approval) => <article key={approval.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 p-3 text-sm"><div><p>{titleCase(approval.entity_type)} · {targetName(approval.entity_type, approval.entity_id)}</p><p className="mt-1 text-xs text-white/35">Requested by {nameOf(approval.requested_by)}</p></div><span className={`rounded-full border px-2.5 py-1 text-[10px] ${statusTone(approval.status)}`}>{titleCase(approval.status)}</span></article>)}{!loading && resolved.length === 0 && <p className="py-4 text-sm text-white/35">No resolved decisions yet.</p>}</div></section>
      </div>
      <section className={`${card} p-5`}><div className="flex items-center justify-between"><h2 className="text-xl font-medium">Pending review</h2><span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/45">{pending.length}</span></div><div className="mt-5 space-y-3">{pending.map((approval) => { const assignedElsewhere = Boolean(approval.reviewer_id && approval.reviewer_id !== sessionUser?.id); return <article key={approval.id} className="rounded-xl border border-white/10 bg-black/40 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{titleCase(approval.entity_type)} · {targetName(approval.entity_type, approval.entity_id)}</h3><p className="mt-1 text-xs text-white/40">Requested by {nameOf(approval.requested_by)} · {new Date(approval.created_at).toLocaleString()}</p></div><span className={`rounded-full border px-2.5 py-1 text-[10px] ${statusTone(approval.status)}`}>Pending</span></div>{approval.comment && <p className="mt-4 rounded-lg bg-white/[0.04] p-3 text-sm leading-6 text-white/60">{approval.comment}</p>}<p className="mt-3 text-xs text-white/35">Reviewer: {approval.reviewer_id ? nameOf(approval.reviewer_id) : "Any eligible reviewer"}</p>{canApprove && !assignedElsewhere && <div className="mt-4 flex gap-2"><button disabled={Boolean(busy)} onClick={() => void perform(`approve-${approval.id}`, () => api.resolveApproval(approval.id, "approve").then(() => undefined), "Approval accepted.")} className="glass-solid rounded-full px-4 py-2 text-xs font-semibold text-black disabled:opacity-40">Approve</button><button disabled={Boolean(busy)} onClick={() => void perform(`reject-${approval.id}`, () => api.resolveApproval(approval.id, "reject").then(() => undefined), "Approval rejected.")} className="rounded-full border border-white/15 px-4 py-2 text-xs disabled:opacity-40">Reject</button></div>}{assignedElsewhere && <p className="mt-3 text-xs text-amber-100/60">This decision is assigned to {nameOf(approval.reviewer_id)}.</p>}</article>; })}{!loading && pending.length === 0 && <div className="py-16 text-center"><p className="text-lg">Queue is clear</p><p className="mt-2 text-sm text-white/35">New review requests will appear here.</p></div>}</div></section>
    </div>}

    {scopeReady && view === "team" && <div className="mt-8 grid gap-6 lg:grid-cols-[0.75fr_1.25fr]">
      <div className="space-y-6"><section className={`${card} p-5`}><h2 className="text-lg font-medium">Invite a collaborator</h2><p className="mt-2 text-xs leading-5 text-white/45">Links expire after seven days and can be accepted only by the invited email. Until email delivery is connected, share the generated link directly.</p>{canManage ? <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); if (!inviteEmail.trim()) return; void perform("invite", async () => { const result = await api.inviteMember(workspaceId, { email: inviteEmail.trim(), role: inviteRole }); setInviteLink(result.acceptanceUrl); setInviteEmail(""); }, "Secure invitation created."); }}><label className="block text-xs text-white/55">Email<input required type="email" maxLength={254} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} className={input} placeholder="editor@example.com" /></label><label className="block text-xs text-white/55">Role<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as InviteRole)} className={input}>{roles.filter((item): item is InviteRole => item !== "owner").map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</select></label><button disabled={busy === "invite"} className="glass-solid min-h-10 w-full rounded-full px-5 text-sm font-semibold text-black disabled:opacity-40">{busy === "invite" ? "Creating…" : "Create invite link"}</button></form> : <p className="mt-5 rounded-xl border border-white/10 p-4 text-sm text-white/45">Only workspace owners and admins can invite or change roles.</p>}{inviteLink && <div className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-3"><label className="text-xs text-emerald-100">Copy this link now<input readOnly value={inviteLink} className={`${input} border-emerald-400/20 text-xs`} onFocus={(event) => event.currentTarget.select()} /></label><button type="button" onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => setNotice("Invitation link copied."), () => setError("Copy failed. Select and copy the link manually."))} className="mt-3 rounded-full border border-emerald-200/20 px-4 py-2 text-xs text-emerald-50">Copy link</button></div>}</section>
      {canManage && <section className={`${card} p-5`}><h2 className="text-lg font-medium">Pending invitations</h2><div className="mt-4 space-y-2">{invitations.filter((invitation) => invitation.status === "pending").map((invitation) => <article key={invitation.id} className="rounded-xl border border-white/10 p-3"><p className="truncate text-sm">{invitation.email}</p><p className="mt-1 text-xs capitalize text-white/40">{invitation.role} · expires {new Date(invitation.expires_at).toLocaleDateString()}</p><button type="button" disabled={Boolean(busy)} onClick={() => void perform(`revoke-${invitation.id}`, () => api.revokeInvitation(workspaceId, invitation.id).then(() => undefined), "Invitation revoked.")} className="mt-3 text-xs text-red-200 underline disabled:opacity-40">Revoke</button></article>)}{!loading && invitations.every((invitation) => invitation.status !== "pending") && <p className="text-sm text-white/35">No pending invitations.</p>}</div></section>}</div>
      <section className={`${card} overflow-hidden`}><div className="flex items-center justify-between border-b border-white/10 p-5"><h2 className="text-xl font-medium">Members</h2><span className="text-xs text-white/40">{members.length} total</span></div><div className="divide-y divide-white/10">{members.map((member) => <article key={member.user_id} className="flex flex-wrap items-center justify-between gap-4 p-5"><div className="flex min-w-0 items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-sm">{nameOf(member.user_id).slice(0, 1).toUpperCase()}</div><div className="min-w-0"><p className="truncate text-sm font-medium">{nameOf(member.user_id)}</p><p className="mt-1 text-xs text-white/35">{shortId(member.user_id)}</p></div></div><div className="flex items-center gap-3">{canManage ? <select aria-label={`Role for ${nameOf(member.user_id)}`} value={member.role} disabled={Boolean(busy)} onChange={(event) => void perform(`member-${member.user_id}`, () => api.updateMemberRole(workspaceId, member.user_id, event.target.value as MemberRole).then(() => undefined), "Member role updated.")} className="rounded-lg border border-white/10 bg-black px-3 py-2 text-xs text-white">{roles.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</select> : <span className="text-xs capitalize text-white/55">{member.role}</span>}<span className={`rounded-full border px-2.5 py-1 text-[10px] ${statusTone(member.status)}`}>{titleCase(member.status)}</span></div></article>)}{!loading && members.length === 0 && <p className="p-8 text-center text-sm text-white/35">No members found.</p>}</div></section>
    </div>}

    {scopeReady && <section className={`${card} mt-8 overflow-hidden`} aria-labelledby="workspace-activity-title"><div className="flex items-center justify-between border-b border-white/10 p-5"><div><p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Audit trail</p><h2 id="workspace-activity-title" className="mt-1 text-lg font-medium">Recent workspace activity</h2></div><button type="button" disabled={loading || Boolean(busy)} onClick={() => void load()} className="rounded-full border border-white/10 px-3 py-2 text-xs text-white/55 disabled:opacity-40">Refresh</button></div><div className="divide-y divide-white/10">{activity.map((event) => <article key={event.id} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center"><div><p className="text-sm"><span className="text-white/75">{nameOf(event.actor_id)}</span> <span className="text-white/45">{titleCase(event.event_type).toLowerCase()}</span></p><p className="mt-1 text-xs text-white/30">{event.entity_type ? `${titleCase(event.entity_type)}${event.entity_id ? ` · ${shortId(event.entity_id)}` : ""}` : "Workspace"}</p></div><time dateTime={event.created_at} className="text-xs text-white/30">{new Date(event.created_at).toLocaleString()}</time></article>)}{activity.length === 0 && <p className="p-8 text-center text-sm text-white/35">No activity has been recorded yet.</p>}</div></section>}
  </main>;
}
