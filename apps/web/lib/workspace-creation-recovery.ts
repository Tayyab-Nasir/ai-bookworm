const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function key(actor: string) {
  if (!uuid.test(actor)) throw new Error("Recheck your account before creating a workspace.");
  return `bookworm:workspace-creation:${actor}`;
}

export function readPendingWorkspaceCreation(actor: string): string | null {
  let operationId: string | null;
  try { operationId = sessionStorage.getItem(key(actor)); }
  catch { throw new Error("Workspace recovery storage is unavailable. Enable browser storage before continuing."); }
  if (operationId !== null && !uuid.test(operationId)) throw new Error("Workspace recovery details are unreadable. Contact support before creating another workspace.");
  return operationId;
}

export function savePendingWorkspaceCreation(actor: string, operationId: string): void {
  if (!uuid.test(operationId) || readPendingWorkspaceCreation(actor)) throw new Error("Check the earlier workspace request before starting another.");
  // Store only the operation ID, never the workspace name or account token.
  try { sessionStorage.setItem(key(actor), operationId); }
  catch { throw new Error("Workspace recovery could not be saved. No workspace was submitted."); }
  if (readPendingWorkspaceCreation(actor) !== operationId) throw new Error("Workspace recovery could not be saved. No workspace was submitted.");
}

export function clearPendingWorkspaceCreation(actor: string, operationId: string): void {
  if (readPendingWorkspaceCreation(actor) === operationId) {
    try { sessionStorage.removeItem(key(actor)); }
    catch { throw new Error("Workspace recovery storage is unavailable. Enable browser storage before continuing."); }
    if (readPendingWorkspaceCreation(actor) === operationId) throw new Error("Workspace recovery could not be cleared. Reload before continuing.");
  }
}
