/** Only publish a canonical configured origin; never expose credentials or paths. */
export function configuredStorageOrigin(configured: string | undefined): string | null {
  try {
    if (!configured) return null;
    const storage = new URL(configured);
    if (storage.username || storage.password || storage.search || storage.hash || storage.pathname !== "/"
      || (configured !== storage.origin && configured !== `${storage.origin}/`)
      || !(storage.protocol === "https:" || (storage.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(storage.hostname)))) return null;
    return storage.origin;
  } catch { return null; }
}
