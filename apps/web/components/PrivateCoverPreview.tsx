"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { readArtifactSession } from "../lib/browser-session";

/** Validate the actor and Storage destination before mounting a cover image. */
export default function PrivateCoverPreview({ actor, url, expectedPath, expiresAt, isCurrent }: {
  actor: string | null; url: string; expectedPath: string; expiresAt?: number; isCurrent: () => boolean;
}) {
  const current = useRef(isCurrent);
  useLayoutEffect(() => { current.current = isCurrent; });
  const key = JSON.stringify([actor, url, expectedPath, expiresAt]);
  const [preview, setPreview] = useState<{ key: string; url: string | null; error: string | null }>({ key: "", url: null, error: null });
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const valid = () => !cancelled && current.current();
    const fail = () => { if (valid()) setPreview({ key, url: null, error: "Cover preview could not be verified. Download the private file to review it." }); };
    void (async () => {
      try {
        if (!actor || !expectedPath || !Number.isFinite(expiresAt) || expiresAt! <= Date.now() || !valid()) return fail();
        const { storageOrigin } = await readArtifactSession(actor);
        if (!valid()) return;
        const destination = new URL(url);
        if (destination.origin !== storageOrigin || destination.username || destination.password || destination.hash
          || decodeURIComponent(destination.pathname) !== `/storage/v1/object/sign/book-assets/${expectedPath}`
          || destination.searchParams.getAll("token").length !== 1 || !destination.searchParams.get("token")
          || [...destination.searchParams.keys()].some(name => name !== "token") || expiresAt! <= Date.now()) throw new Error();
        setPreview({ key, url: destination.href, error: null });
        timer = window.setTimeout(() => { if (valid()) setPreview({ key, url: null, error: "Cover preview expired. Open the saved proof again to renew it." }); }, Math.max(0, expiresAt! - Date.now()));
      } catch { fail(); }
    })();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [actor, url, expectedPath, expiresAt, key]);
  if (!isCurrent()) return null;
  if (preview.key !== key || !preview.url) return <p role="status" className="mt-3 text-xs text-white/55">{preview.key === key && preview.error ? preview.error : "Checking private cover preview…"}</p>;
  return <img src={preview.url} alt="Rendered book cover" referrerPolicy="no-referrer" className="mt-3 max-h-80 w-full rounded-lg object-contain"
    onError={() => { if (current.current()) setPreview({ key, url: null, error: "Cover preview could not be loaded. Download the private file to review it." }); }} />;
}
