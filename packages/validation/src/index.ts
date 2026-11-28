import { z } from "zod";

// ApiError envelope per spec section 9.
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// Standard error codes per spec section 9.
export const ERROR_CODES = {
  400: "malformed",
  401: "unauthenticated",
  403: "unauthorized",
  404: "not_found",
  410: "gone",
  409: "conflict",
  413: "payload_too_large",
  422: "business_validation",
  429: "rate_limit",
  500: "internal",
  503: "dependency_unavailable",
} as const;
export type ErrorStatus = keyof typeof ERROR_CODES;
