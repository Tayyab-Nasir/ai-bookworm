import { setTimeout } from "node:timers/promises";
import { boundedSupabaseFetch, defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneQuotedNarrationJob } from "../../services/api/src/lib/quoted-narration-worker.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--once") || args.length > 1) throw new Error("Usage: worker:narration-quotes [--once]");
  // Bound headers and bodies without SDK retries. Shutdown aborts private
  // transport as well; ambiguous writes can only recover original evidence.
  const once = args.includes("--once"), shutdown = new AbortController();
  const sb = defaultSupabaseFactory(undefined, boundedSupabaseFetch(shutdown.signal));
  const stop = () => shutdown.abort(); process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    do {
      let delay = 2_000;
      try {
        const outcome = await runOneQuotedNarrationJob(sb, { signal: shutdown.signal });
        if (outcome.status !== "idle") console.log(JSON.stringify(outcome));
        if (outcome.status === "completion_unknown") { delay = 5_000; if (once) process.exitCode = 1; }
      } catch {
        console.error(JSON.stringify({ status: "narration_quote_worker_unavailable" }));
        if (once) process.exitCode = 1; delay = 5_000;
      }
      if (once || shutdown.signal.aborted) break;
      await setTimeout(delay, undefined, { signal: shutdown.signal }).catch(() => {});
    } while (!shutdown.signal.aborted);
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}
main().catch(() => { console.error("Narration quote worker startup failed. Check configuration and arguments."); process.exitCode = 1; });
