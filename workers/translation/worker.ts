import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneQuotedTranslationJob } from "../../services/api/src/lib/quoted-translation-worker.js";
import { runOneTranslationQuoteStep } from "../../services/api/src/lib/translation-quote-worker.js";
import { parseTranslationWorkerArguments } from "../../services/api/src/lib/translation-worker-mode.js";

async function main() {
  const { once, mode } = parseTranslationWorkerArguments(process.argv.slice(2));
  const sb = defaultSupabaseFactory(); let stopped = false;
  const stop = () => { stopped = true; }; process.on("SIGTERM", stop); process.on("SIGINT", stop);
  do {
    let delay = 0;
    try { const result = await (mode === "prepare-quotes" ? runOneTranslationQuoteStep(sb) : runOneQuotedTranslationJob(sb)); if (result.status === "idle") delay = 2_000; else console.log(JSON.stringify(result)); }
    catch { console.error(JSON.stringify({ status: "translation_worker_unavailable" })); if (once) process.exitCode = 1; delay = 5_000; }
    if (once || stopped) break; if (delay) await setTimeout(delay);
  } while (!stopped);
}

main().catch(() => { console.error("Translation worker startup failed. Check configuration and arguments."); process.exitCode = 1; });
