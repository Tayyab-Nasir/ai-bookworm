"use client";

import { useCallback, useEffect, useState } from "react";
import type { Referral, CreditLedgerEntry } from "@bookworm/api-client";
import { apiClient } from "../../components/api";

export default function ReferralsPage() {
  const api = apiClient();
  const [code, setCode] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [claimCode, setClaimCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setCode((await api.getReferralCode()).code);
      setReferrals((await api.listReferrals()).referrals);
      setEntries((await api.listCreditLedger()).entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ padding: 16 }}>
      <h1>Referrals</h1>
      {error && <p role="alert" style={{ color: "#e53935" }}>{error}</p>}
      {!api && <p>Demo mode — set NEXT_PUBLIC_API_URL / NEXT_PUBLIC_API_TOKEN.</p>}

      <section>
        <h2>Your code</h2>
        <p>
          <code>{code ?? "..."}</code>{" "}
          <button
            disabled={!code}
            onClick={async () => {
              await navigator.clipboard.writeText(code ?? "");
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </p>
      </section>

      <section>
        <h2>Claim a code</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api?.claimReferral(claimCode);
              setClaimCode("");
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "claim failed");
            }
          }}
        >
          <input placeholder="Referral code" value={claimCode} onChange={(e) => setClaimCode(e.target.value)} />
          <button type="submit" disabled={!api}>Claim</button>
        </form>
      </section>

      <section>
        <h2>Your referrals</h2>
        <table>
          <thead>
            <tr><th>Referred user</th><th>Status</th><th>Flag</th><th>Created</th></tr>
          </thead>
          <tbody>
            {referrals.map((r) => (
              <tr key={r.id}>
                <td>{r.referred_user_id}</td>
                <td>{r.status}</td>
                <td>{r.flagged ? r.flag_reason : ""}</td>
                <td>{new Date(r.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Credit ledger</h2>
        <table>
          <thead>
            <tr><th>When</th><th>Source</th><th>Amount</th><th>Balance</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td>{e.source}</td>
                <td>{e.amount}</td>
                <td>{e.balance_after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
