import { AppError } from "../errors.js";

/** Map only known transaction refusals; never return raw database diagnostics. */
export function imageCompletionError(error: unknown): AppError | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; message?: unknown };
  if (value.code === "23514" && value.message === "image credit quota exceeded at completion") {
    return new AppError(422, "Your image credit allowance is exhausted. The generated file is preserved. Finalize it from image history when credits are available; do not generate it again.", undefined, "image_completion_quota_exceeded");
  }
  if (value.code === "42501" && value.message === "image creator can no longer edit this workspace") {
    return new AppError(403, "Your editing permission changed before this image was saved. The generated file is preserved. Ask a workspace administrator to restore access before finalizing it.", undefined, "image_completion_access_changed");
  }
  return null;
}
