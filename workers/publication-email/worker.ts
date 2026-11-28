import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sendOnePublicationEmail } from "../../services/api/src/lib/publication-email.js";
import { boundedSupabaseFetch, defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";

const email = z.string().max(254).email();

async function main() {
  if (process.env.MANAGED_PUBLICATION_EMAIL_ENABLED !== "true") {
    console.log("Publication email worker is disabled.");
    return;
  }
  const config = { apiKey: process.env.RESEND_API_KEY?.trim() ?? "", from: process.env.BOOKWORM_PUBLICATION_EMAIL_FROM?.trim() ?? "" };
  if (!config.apiKey || !email.safeParse(config.from).success) throw new Error("Email sender configuration is invalid.");
  const once = process.argv.includes("--once");
  let stopping = false;
  const wake = new AbortController();
  const stop = () => { stopping = true; wake.abort(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      const db = defaultSupabaseFactory(undefined, boundedSupabaseFetch(AbortSignal.timeout(30_000)));
      const status = await sendOnePublicationEmail(db, config);
      if (status !== "idle" || once) console.log(JSON.stringify({ status }));
      if (once || stopping) break;
      if (status === "idle") await wait(5000, undefined, { signal: wake.signal }).catch(error => { if (!stopping) throw error; });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error("Publication email worker stopped. Check sender configuration and the private dispatch state.");
  process.exitCode = 1;
});
