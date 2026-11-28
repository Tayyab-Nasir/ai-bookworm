"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { readArtifactSession } from "../lib/browser-session";
import { privateDownloadUrl } from "../lib/private-download";

/**
 * Keep bearer URLs out of the rendered DOM and recheck the original actor at
 * activation. A URL already delivered to this browser cannot be revoked here.
 */
export default function PrivateArtifactDownload({ actor, url, filename, expectedPath, isCurrent, isExpired, onInvalid, className, children }: {
  actor: string | null; url: string; filename: string; expectedPath: string | RegExp; isCurrent: () => boolean; isExpired: () => boolean;
  onInvalid: (message: string, kind: "expired" | "session" | "link") => void; className?: string; children: string;
}) {
  const mounted = useRef(false), generation = useRef(0), committed = useRef<object | null>(null), flight = useRef<object | null>(null);
  const [busy, setBusy] = useState(false);
  const render = {};
  useLayoutEffect(() => { committed.current = render; });
  useLayoutEffect(() => {
    mounted.current = true;
    const invalidate = () => { generation.current++; flight.current = null; setBusy(false); };
    window.addEventListener("focus", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    return () => { mounted.current = false; generation.current++; flight.current = null; window.removeEventListener("focus", invalidate); document.removeEventListener("visibilitychange", invalidate); };
  }, []);
  useLayoutEffect(() => { generation.current++; flight.current = null; setBusy(false); }, [actor, url, filename, String(expectedPath)]);

  const activate = async () => {
    if (!mounted.current || committed.current !== render || flight.current || !actor || !isCurrent()) return;
    if (isExpired()) { onInvalid("This private link expired. Prepare a new one.", "expired"); return; }
    const token = {}, version = generation.current; flight.current = token; setBusy(true);
    const current = () => mounted.current && flight.current === token && generation.current === version && isCurrent();
    try {
      let storageOrigin: string;
      try { ({ storageOrigin } = await readArtifactSession(actor)); }
      catch (reason) {
        if (current()) onInvalid(reason instanceof Error ? reason.message : "Your session could not be verified.", "session");
        return;
      }
      if (!current()) return;
      if (isExpired()) { onInvalid("This private link expired. Prepare a new one.", "expired"); return; }
      const destination = new URL(privateDownloadUrl(url, filename));
      const prefix = "/storage/v1/object/sign/book-assets/";
      const pathname = decodeURIComponent(destination.pathname);
      const storagePath = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
      const pathMatches = typeof expectedPath === "string" ? storagePath === expectedPath : expectedPath.test(storagePath);
      if (destination.origin !== storageOrigin || destination.username || destination.password || destination.hash || !pathMatches
        || destination.searchParams.getAll("token").length !== 1 || !destination.searchParams.get("token")
        || [...destination.searchParams.keys()].some(key => key !== "token" && key !== "download")) {
        throw new Error("The private download link could not be verified.");
      }
      const link = document.createElement("a");
      link.href = destination.href;
      link.download = destination.searchParams.get("download") || "file"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
      link.click();
    } catch (reason) {
      if (current()) onInvalid(reason instanceof Error ? reason.message : "The download could not be verified.", "link");
    } finally { if (flight.current === token) { flight.current = null; if (mounted.current) setBusy(false); } }
  };
  return <button type="button" className={className} disabled={busy || !actor} onClick={() => void activate()}>{children}</button>;
}
