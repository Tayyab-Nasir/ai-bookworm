const key = "bookworm:pendingReferral";
let pending: Promise<void> | undefined;

export function rememberReferral(search: string, storage?: Storage): void {
  try {
    const code = new URLSearchParams(search).get("ref");
    if (code && /^bw-[a-f0-9]{8}$/i.test(code)) {
      (storage ?? window.localStorage).setItem(key, code.toLowerCase());
    }
  } catch {
    // Referral attribution is optional; blocked storage must never block login.
  }
}

export function claimPendingReferral(claim: (code: string) => Promise<unknown>, storage?: Storage): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    try {
      const store = storage ?? window.localStorage;
      const code = store.getItem(key);
      if (!code) return;
      const clear = () => { if (store.getItem(key) === code) store.removeItem(key); };
      try {
        await claim(code);
        clear();
      } catch (reason) {
        const status = (reason as { status?: number } | null)?.status;
        // Preserve attribution across expired sessions, rate limits and outages.
        if (status && [400, 404, 409, 422].includes(status)) clear();
      }
    } catch {
      // Browsers may deny storage access, including during removal.
    }
  })().finally(() => { pending = undefined; });
  return pending;
}
