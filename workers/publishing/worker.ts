import { setTimeout } from "node:timers/promises";
import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { publishingActions, runOnePublishingJob, type PublishingAction } from "../../services/api/src/lib/publishing-worker.js";

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const actionArg = args.find((arg) => arg.startsWith("--actions="));
  const actions = actionArg ? actionArg.slice("--actions=".length).split(",") : [...publishingActions];
  if (args.some((arg) => arg !== "--once" && arg !== actionArg) || !actions.length
    || actions.some((action) => !publishingActions.includes(action as PublishingAction))) {
    throw new Error("Usage: worker:publishing [--once] [--actions=render,validate,export_package]");
  }
  // Credentials are loaded only when the operator explicitly starts this command.
  const sb = defaultSupabaseFactory();
  let stopped = false;
  const wake = new AbortController();
  const owned = process.connected;
  let activate!: () => void;
  const activation = new Promise<void>(resolve => { activate = resolve; });
  const stop = () => { stopped = true; wake.abort(); activate(); };
  const message = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return;
    const command = (value as { command?: unknown }).command;
    if (command === "stop") stop();
    if (command === "start" && !stopped) activate();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("message", message);
  process.on("disconnect", stop);
  try {
    if (owned) {
      process.send!({ event: "publishing_worker_control_ready" }, error => { if (error) stop(); });
      await activation;
    }
    while (!stopped) {
      let delay = 0;
      try {
        const outcome = await runOnePublishingJob(sb, { actions: actions as PublishingAction[] });
        if (outcome.status !== "idle") console.log(JSON.stringify(outcome));
        else delay = 2000;
      } catch {
        // No arbitrary errors/provider responses/connection strings enter logs.
        console.error(JSON.stringify({ status: "worker_unavailable" }));
        if (once) process.exitCode = 1;
        delay = 5000;
      }
      if (stopped || once) break;
      if (delay) {
        try { await setTimeout(delay, undefined, { signal: wake.signal }); }
        catch (error) { if (!stopped) throw error; }
      }
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("message", message);
    process.removeListener("disconnect", stop);
    if (process.connected) process.disconnect?.();
  }
}

main().catch(() => { console.error("Worker startup failed. Check configuration and CLI arguments."); process.exitCode = 1; });
