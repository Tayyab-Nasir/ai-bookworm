# AI Bookworm live rollout: 2026-09-12

## Verified findings

- C: disk recovered to ~240GB free.
- Connected Supabase project: AI-BookWorm, cyhqtwndadlyzpeatxws, healthy.
- Live migration history empty. public.profiles/books/assets absent. One
  unrelated empty public.AI-BookWorm table exists; preserve it.
- Auth settings: Google disabled, email enabled, signup enabled.
- Local .env.local points at this project; APP_URL localhost3000 differs from
  the user's app3001. OpenAI key absent in this file. Never publish secrets.
- Git remote targets Tayyab-Nasir/ai-bookworm and embeds a credential.
  Rotate that credential and use credential manager/SSH. Do not print it.

## Product policy requested by owner

OpenAI only for text, translation, images and audiobook speech. No free
provider-funded generation. Current first change sets implicit and seed free
text/image quotas to0; focused regression tests pass. Existing fixtures that
assumed free generation must use explicit paid entitlements. This is not yet
a complete prepaid billing implementation or a migrated live pricing policy.

## Execution order

1. Finish paid generation controls: reserve credit before provider execution,
   reject insufficient funds, settle actual recorded usage once, release unused
   reservation, reconcile ambiguous outcomes without blind retries. Separate
   provider cost from retail price. Include image size/quality, audio usage,
   cached text tokens, extraction/embedding overhead, payment fees and margin.
   No unlimited/free AI promises. Final retail rates require owner approval.
2. After explicit approval, review all migrations for native extensions/storage
   compatibility, initialize confirmed live Supabase project, run advisors and
   tenant/profile/storage checks. No reset, no deleting existing Auth users.
3. Configure Google OAuth in Google Cloud and Supabase. Google callback:
   https://cyhqtwndadlyzpeatxws.supabase.co/auth/v1/callback
   App redirect allowlist needs exact local3001/auth/callback and eventual
   HTTPS production URL. Confirm route query handling. Test first-time Google
   signup, repeat login, profile creation and isolated workspace access.
4. Install server-side OPENAI_API_KEY securely. Verify model availability;
   migrate text endpoint/tool results and cost accounting with mocks then a
   bounded approved paid test. No implicit Anthropic or mock production fallback.
5. Secrets scan, review shared tree, establish new codex branch and push only
   approved files to confirmed GitHub repo after approval. No force push.
6. Re-run full gates, browser journeys and production build now disk is available.
7. LightRAG: benchmark a private per-book retrieval adapter with citations,
   version/deletion safety and cost caps before replacing current PostgreSQL
   source search. SnapOtter: licensing decision first, then isolated private OCR/
   image processor with opt-in asset transfer, malware checks and resource limits.

## Current official model targets to validate

- Text: gpt-6-astra, latest flagship; GPT-5.6 cost tiers may be optional only
  with deliberate user-visible pricing/quality choices.
  https://developers.openai.com/api/docs/models/gpt-6-astra
- Images: gpt-image-2.5-sunburst; verify Images API schema/cost/account access.
  https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- Audiobook synthesis: gpt-4o-mini-tts, documented newest dedicated TTS model.
  Do not substitute a realtime conversation model for batch narration.
  https://developers.openai.com/api/docs/guides/text-to-speech

These are verified documentation targets, NOT implemented/live-tested model
upgrades. Existing defaults are still older. Audiobook orchestration needs
chapter jobs, pronunciation/voice settings, private audio artifacts, previews,
retry-safe billing and AI-voice disclosure. No audiobook completion claim.
