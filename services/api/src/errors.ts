import { ERROR_CODES, type ErrorStatus } from "@bookworm/validation";

export class AppError extends Error {
  status: ErrorStatus;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: ErrorStatus, message: string, details?: Record<string, unknown>, code?: string) {
    super(message);
    this.status = status;
    this.code = code ?? ERROR_CODES[status];
    this.details = details;
  }
}
