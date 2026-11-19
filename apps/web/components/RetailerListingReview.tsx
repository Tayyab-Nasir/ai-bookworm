"use client";

import { useState } from "react";
import type { BookMetadata } from "@bookworm/book-model";

export default function RetailerListingReview({ metadata, isCurrent }: { metadata: BookMetadata; isCurrent: () => boolean }) {
  const [copyStatus, setCopyStatus] = useState("");
  const fields = [
    ["Title", metadata.title], ["Subtitle", metadata.subtitle], ["Author", metadata.author],
    ["Language", metadata.language], ["ISBN-13", metadata.isbn13], ["Edition", metadata.edition],
    ["Publication date", metadata.publicationDate], ["Keywords", metadata.keywords?.join(", ")],
    ["Categories", metadata.categories?.join(", ")],
  ];
  async function copyDescription() {
    if (!isCurrent() || !metadata.description) return;
    try {
      await navigator.clipboard.writeText(metadata.description);
      if (isCurrent()) setCopyStatus("Description copied.");
    } catch {
      if (isCurrent()) setCopyStatus("Select the description to copy it.");
    }
  }
  return <details className="min-w-0 rounded-xl border border-white/10 bg-black/20 px-4">
    <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-white">Review retailer listing</summary>
    <div className="border-t border-white/10 py-4 text-sm text-white/75">
      <dl className="grid gap-3 sm:grid-cols-2">
        {fields.map(([label, value]) => <div key={label} className="min-w-0">
          <dt className="text-xs text-white/55">{label}</dt>
          <dd className="mt-1 break-words" dir="auto">{value || "—"}</dd>
        </div>)}
      </dl>
      <dl className="mt-4"><dt className="text-xs text-white/55">Description</dt>
        <dd className="mt-1 whitespace-pre-wrap break-words" dir="auto">{metadata.description || "No saved description."}</dd>
      </dl>
      {metadata.description && <div className="mt-2 flex flex-wrap items-center gap-x-3">
        <button type="button" onClick={() => void copyDescription()} className="min-h-11 text-violet-200 underline underline-offset-4">Copy description</button>
        <span className="text-xs text-white/60" role="status">{copyStatus}</span>
      </div>}
    </div>
  </details>;
}
