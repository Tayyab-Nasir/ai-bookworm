import { randomUUID } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { ERROR_CODES, type ErrorStatus } from "@bookworm/validation";
import { AppError } from "../errors.js";
import { isAiConnectionPath } from "../lib/redact.js";

declare module "fastify" {
  interface FastifyRequest {
    id: string;
  }
}

// ApiError envelope {error:{code,message,requestId,details?}} per spec section 9.
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("onRequest", async (req) => {
    req.id = isAiConnectionPath(req.url) ? randomUUID() : (req.headers["x-request-id"] as string) || randomUUID();
  });

  app.setErrorHandler((err, req, reply) => {
    let status: ErrorStatus = 500;
    let code: string = ERROR_CODES[500];
    let message = "internal error";
    let details: Record<string, unknown> | undefined;

    if (err instanceof AppError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = isAiConnectionPath(req.url) ? undefined : err.details;
    } else if (err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" && err.statusCode < 500) {
      status = (err.statusCode in ERROR_CODES ? err.statusCode : 400) as ErrorStatus;
      code = ERROR_CODES[status];
      message = isAiConnectionPath(req.url) ? "Check the AI connection request format and size." : err.message;
    } else {
      if (isAiConnectionPath(req.url)) req.log.error("AI connection request failed.");
      else req.log.error(err);
    }

    void reply.status(status).send({
      error: { code, message, requestId: req.id, ...(details ? { details } : {}) },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: { code: ERROR_CODES[404], message: "not found", requestId: req.id },
    });
  });
});
