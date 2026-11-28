import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneAiReviewJob } from "../../services/api/src/lib/ai-review-worker.js";

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--once")) throw new Error("Usage: worker:ai [--once]");
  const once = process.argv.includes("--once"); const sb = defaultSupabaseFactory(); let stopped = false;
  const stop = () => { stopped = true; }; process.on("SIGTERM", stop); process.on("SIGINT", stop);
  do { let delay = 0; try { const outcome = await runOneAiReviewJob(sb); if (outcome.status === "idle") delay = 2000; else console.log(JSON.stringify(outcome)); }
    catch { console.error(JSON.stringify({ status: "ai_worker_unavailable" })); if (once) process.exitCode = 1; delay = 5000; }
    if (once || stopped) break; if (delay) await setTimeout(delay);
  } while (!stopped);
}
main().catch(() => { console.error("AI worker startup failed. Check configuration and arguments."); process.exitCode = 1; });
