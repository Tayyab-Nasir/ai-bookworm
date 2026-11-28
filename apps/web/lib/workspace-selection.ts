export const workspacePreferenceKey = "bookworm:workspaceId";

export type WorkspacePreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class WorkspaceSelectionError extends Error {
  constructor() {
    super("Requested workspace is no longer available. Choose another workspace.");
    this.name = "WorkspaceSelectionError";
  }
}

export function workspacePreferenceStorage(): WorkspacePreferenceStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function readWorkspacePreference(storage = workspacePreferenceStorage()): string | null {
  try { return storage?.getItem(workspacePreferenceKey) ?? null; }
  catch { return null; }
}

export function forgetWorkspacePreference(storage = workspacePreferenceStorage()): void {
  try { storage?.removeItem(workspacePreferenceKey); }
  catch { /* Preference storage is optional, never an authorization source. */ }
}

/** Pass the current user-scoped API list, not a saved list or caller-provided IDs. */
export function resolveWorkspace<T extends { id: string }>(
  available: readonly T[],
  requestedId?: string | null,
  storage = workspacePreferenceStorage(),
): T | null {
  if (requestedId !== undefined && requestedId !== null) {
    const selected = available.find((workspace) => workspace.id === requestedId);
    if (!selected) throw new WorkspaceSelectionError();
    return selected;
  }
  const remembered = readWorkspacePreference(storage);
  const selected = remembered ? available.find((workspace) => workspace.id === remembered) : undefined;
  if (remembered && !selected) forgetWorkspacePreference(storage);
  return selected ?? available[0] ?? null;
}

/** Only remember an ID present in the current authorized list; never persist content. */
export function rememberWorkspace<T extends { id: string }>(
  available: readonly T[], id: string, storage = workspacePreferenceStorage(),
): boolean {
  if (!available.some((workspace) => workspace.id === id)) return false;
  try { storage?.setItem(workspacePreferenceKey, id); return Boolean(storage); }
  catch { return false; }
}

export function replaceWorkspaceQuery(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("ws", id);
  window.history.replaceState(null, "", url);
}
