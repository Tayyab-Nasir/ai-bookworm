// Read only the public, server-verified identity. Never persist a session or JWT
// in browser storage, and never surface provider payloads in an error message.
async function readSessionPayload(expectedActorId?: string): Promise<{ id: string; email: string | null; storageOrigin: unknown }> {
  let result: unknown;
  try {
    const response = await fetch("/api/auth/session", {
      cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch {
    throw new Error("Your session could not be verified. Sign in again or retry.");
  }
  const user = (result as { user?: { id?: unknown; email?: unknown } } | null)?.user;
  if (typeof user?.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(user.id)) {
    throw new Error("Your session could not be verified. Sign in again or retry.");
  }
  if (expectedActorId !== undefined && user.id !== expectedActorId) {
    throw new Error("Your account changed. Reload saved data before continuing.");
  }
  return { id: user.id, email: typeof user.email === "string" && user.email.length <= 320 ? user.email : null,
    storageOrigin: (result as { storageOrigin?: unknown }).storageOrigin };
}

export async function readBrowserSession(expectedActorId?: string): Promise<{ id: string; email: string | null }> {
  const { id, email } = await readSessionPayload(expectedActorId);
  return { id, email };
}

/** The web server supplies its configured Storage origin, never a client-selected one. */
export async function readArtifactSession(expectedActorId: string): Promise<{ storageOrigin: string }> {
  const { storageOrigin } = await readSessionPayload(expectedActorId);
  if (typeof storageOrigin !== "string") throw new Error("The private Storage origin could not be verified.");
  try {
    const url = new URL(storageOrigin);
    if (url.origin !== storageOrigin || url.username || url.password || url.search || url.hash
      || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
    return { storageOrigin };
  } catch { throw new Error("The private Storage origin could not be verified."); }
}
