"use client";

import { useState } from "react";
import { usePrivateImage } from "./usePrivateImage";

type ReferenceImage = { id: string; name: string };

export default function BibleReferenceImages({ actorId, workspaceId, savedIds, images }: {
  actorId: string;
  workspaceId: string;
  savedIds: string[];
  images: ReferenceImage[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const available = images.filter(image => savedIds.includes(image.id));
  const open = available.find(image => image.id === openId);
  const preview = usePrivateImage(open?.id ?? null, null, workspaceId, actorId);

  return <section aria-label="Saved reference images" className="mt-6 border-t border-white/10 pt-5">
    <h4 className="text-sm font-medium">Saved reference images</h4>
    <p className="mt-1 text-xs leading-5 text-[#aaa]">Preview the current file for a saved link.</p>
    {available.length > 0 && <ul className="mt-2 space-y-2">{available.map(image => <li key={image.id}>
      <button type="button" aria-pressed={open?.id === image.id}
        onClick={() => setOpenId(open?.id === image.id ? null : image.id)}
        className="min-h-11 max-w-full rounded-lg border border-white/20 px-3 text-left text-sm break-words hover:bg-white/10 focus-visible:outline-white">
        {open?.id === image.id ? "Close" : "Preview"} {image.name}
      </button>
    </li>)}</ul>}
    {new Set(savedIds).size > available.length && <p className="mt-2 text-xs text-amber-200">Some saved references are unavailable in this workspace.</p>}
    {open && (preview.url
      ? <img src={preview.url} alt={open.name} referrerPolicy="no-referrer" onError={preview.fail}
        className="mt-3 max-h-80 max-w-full rounded-lg object-contain" />
      : <div className="mt-3 text-sm">
        <p role="status">{preview.error ? "The private image preview is unavailable." : "Loading private image…"}</p>
        {preview.error && <button type="button" onClick={preview.retry} className="min-h-11 text-xs underline underline-offset-4">Retry image preview</button>}
      </div>)}
  </section>;
}
