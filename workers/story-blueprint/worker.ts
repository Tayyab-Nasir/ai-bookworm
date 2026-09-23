import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { runOneQuotedStoryBlueprintJob } from "../../services/api/src/lib/quoted-story-blueprint-worker.js";
import { runOneStoryBlueprintQuoteStep } from "../../services/api/src/lib/story-blueprint-quote-worker.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--once", "--quoted", "--prepare-quotes"].includes(arg))
    || (args.includes("--quoted") && args.includes("--prepare-quotes"))) {
    throw new Error("Usage: worker:story-blueprint [--once] [--quoted | --prepare-quotes]");
  }
  const once = args.includes("--once");
  const mode = args.includes("--prepare-quotes") ? "prepare-quotes" : "quoted";
  const sb = defaultSupabaseFactory();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  do {
    let delay = 0;
    try {
      const outcome = await (mode === "prepare-quotes" ? runOneStoryBlueprintQuoteStep(sb) : runOneQuotedStoryBlueprintJob(sb));
      if (outcome.status === "idle") delay = 2_000;
      else console.log(JSON.stringify(outcome));
    } catch {
      console.error(JSON.stringify({ status: "story_blueprint_worker_unavailable" }));
      if (once) process.exitCode = 1;
      delay = 5_000;
    }
    if (once || stopped) break;
    if (delay) await setTimeout(delay);
  } while (!stopped);
}

main().catch(() => {
  console.error("Story Blueprint worker startup failed. Check configuration and arguments.");
  process.exitCode = 1;
});
