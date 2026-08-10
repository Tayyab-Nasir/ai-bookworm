"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Community } from "@bookworm/api-client";
import { apiClient } from "../../components/api";

export default function CommunityPage() {
  const api = apiClient();
  const [communities, setCommunities] = useState<Community[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [visibility, setVisibility] = useState<Community["visibility"]>("public");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setCommunities((await api.listCommunities()).communities);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ padding: 16 }}>
      <h1>Communities</h1>
      {error && <p role="alert" style={{ color: "#e53935" }}>{error}</p>}
      {!api && <p>Demo mode — set NEXT_PUBLIC_API_URL / NEXT_PUBLIC_API_TOKEN.</p>}

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api?.createCommunity({ name, slug, visibility });
            setName("");
            setSlug("");
            await load();
          } catch (err) {
            setError(err instanceof Error ? err.message : "create failed");
          }
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16 }}
      >
        <input required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input required placeholder="slug" pattern="[a-z0-9-]+" value={slug} onChange={(e) => setSlug(e.target.value)} />
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as Community["visibility"])}>
          <option value="public">public</option>
          <option value="private">private</option>
          <option value="unlisted">unlisted</option>
        </select>
        <button type="submit" disabled={!api}>Create</button>
      </form>

      <ul>
        {communities.map((c) => (
          <li key={c.id}>
            <Link href={`/community/${c.id}`}>{c.name}</Link> ({c.visibility}) — {c.description}
          </li>
        ))}
      </ul>
    </main>
  );
}
