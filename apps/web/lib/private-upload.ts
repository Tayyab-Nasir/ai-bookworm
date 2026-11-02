/** Verify the destination before sending a private file to a signed Storage URL. */
export function privateUploadUrl(ticket: { assetId: string; path: string; uploadUrl: string }, expected: {
  workspaceId: string; assetId: string; filename: string; storageOrigin: string;
}): string {
  const base = expected.filename.split(/[\\/]/).pop() ?? "file";
  const filename = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 128) || "file";
  const path = `workspaces/${expected.workspaceId}/assets/${expected.assetId}/v1/${filename}`;
  try {
    if (ticket.assetId !== expected.assetId || ticket.path !== path || typeof ticket.uploadUrl !== "string" || ticket.uploadUrl.length > 8192 || ticket.uploadUrl.trim() !== ticket.uploadUrl) throw new Error();
    const url = new URL(ticket.uploadUrl);
    if (url.origin !== expected.storageOrigin || url.username || url.password || url.hash
      || decodeURIComponent(url.pathname) !== `/storage/v1/object/upload/sign/book-assets/${path}`
      || url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token")
      || [...url.searchParams.keys()].some(key => key !== "token")) throw new Error();
    return url.href;
  } catch {
    throw new Error("The private upload destination could not be verified. Your file was not sent.");
  }
}
