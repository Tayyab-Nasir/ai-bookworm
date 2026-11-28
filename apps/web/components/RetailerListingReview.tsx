"use client";

import { useState } from "react";
import type { BookMetadata } from "@bookworm/book-model";

export default function RetailerListingReview({ metadata, isCurrent, inline = false }: {
  metadata: BookMetadata; isCurrent: () => boolean; inline?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const { description } = metadata;
  const fields = [
    ["Title", metadata.title], ["Subtitle", metadata.subtitle], ["Author", metadata.author],
    ["Language", metadata.language], ["ISBN-13", metadata.isbn13], ["Edition", metadata.edition],
    ["Publication date", metadata.publicationDate],
  ] as const;
  const lists = [
    { label: "Keywords", item: "Keyword", values: metadata.keywords ?? [] },
    { label: "Categories", item: "Category", values: metadata.categories ?? [] },
  ];
  async function copyField(label: string, value: string) {
    if (!isCurrent()) return;
    try {
      await navigator.clipboard.writeText(value);
      if (isCurrent()) setCopyStatus(`${label} copied.`);
    } catch {
      if (isCurrent()) setCopyStatus(`Select the ${label.toLowerCase()} to copy it.`);
    }
  }
  const listing = <div className="border-t border-white/10 py-4 text-sm text-white/75">
      <dl className="grid gap-3 sm:grid-cols-2">
        {fields.map(([label, value]) => <div key={label} className="min-w-0">
          <dt className="text-xs text-white/55">{label}</dt>
          <dd className="mt-1 break-words"><span dir="auto">{value || "—"}</span>
            {value && <button type="button"
              onClick={() => void copyField(label, value)} className="ml-3 min-h-11 text-violet-200 underline underline-offset-4">Copy {label === "ISBN-13" ? label : label.toLowerCase()}</button>}
          </dd>
        </div>)}
        {lists.map(({ label, item, values }) => <div key={label} className="min-w-0">
          <dt className="text-xs text-white/55">{label}</dt>
          <dd className="mt-1">
            {values.length === 0 ? "—" : <>
              <ul className="divide-y divide-white/10">
                {values.map((value, index) => {
                  const itemLabel = `${item} ${index + 1}`;
                  return <li key={index} className="flex flex-wrap items-center justify-between gap-x-3">
                    <span dir="auto" className="min-w-0 break-words">{value}</span>
                    {value && <button type="button" onClick={() => void copyField(itemLabel, value)}
                      className="min-h-11 shrink-0 text-violet-200 underline underline-offset-4">Copy {itemLabel.toLowerCase()}</button>}
                  </li>;
                })}
              </ul>
              <button type="button" onClick={() => void copyField(label, values.join(", "))}
                className="min-h-11 text-violet-200 underline underline-offset-4">Copy {label.toLowerCase()}</button>
            </>}
          </dd>
        </div>)}
      </dl>
      <dl className="mt-4"><dt className="text-xs text-white/55">Description</dt>
        <dd className="mt-1 whitespace-pre-wrap break-words" dir="auto">{description || "No saved description."}</dd>
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-x-3">
        {description && <button type="button" onClick={() => void copyField("Description", description)} className="min-h-11 text-violet-200 underline underline-offset-4">Copy description</button>}
        <span className="text-xs text-white/60" role="status">{copyStatus}</span>
      </div>
    </div>;
  if (inline) return listing;
  return <details className="min-w-0 rounded-xl border border-white/10 bg-black/20 px-4">
    <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-white">Review retailer listing</summary>
    {listing}
  </details>;
}
