import type { CreateAiJobRequest, AiJobWithSuggestions } from "@bookworm/api-client";

// Keep the accepted request unchanged until its response is known. This object
// lives only in the editor tab; private instructions never enter web storage.
export function retryableAiDraft(send: (body: CreateAiJobRequest) => Promise<AiJobWithSuggestions>, body: CreateAiJobRequest) {
  const original = structuredClone(body);
  let pending: Promise<AiJobWithSuggestions> | null = null;
  return {
    chapterId: original.chapterIds[0],
    run() {
      if (!pending) {
        pending = Promise.resolve().then(() => send(structuredClone(original))).catch((error) => {
          pending = null;
          throw error;
        });
      }
      return pending;
    },
  };
}
