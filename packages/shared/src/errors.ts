export const ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  UPLOAD_SESSION_EXPIRED: "UPLOAD_SESSION_EXPIRED",
  INVALID_ARTIFACT: "INVALID_ARTIFACT",
  INVALID_MANIFEST: "INVALID_MANIFEST",
  COMPARISON_FAILED: "COMPARISON_FAILED",
  CLEANUP_FAILED: "CLEANUP_FAILED",
  OIDC_NOT_CONFIGURED: "OIDC_NOT_CONFIGURED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface SerializedChromaSnapError {
  error: string;
  code: ErrorCode;
  status: number;
  requestId?: string;
  details?: Record<string, unknown>;
}

export class ChromaSnapError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(input: { code: ErrorCode; status: number; message: string; details?: Record<string, unknown> }) {
    super(input.message);
    this.name = "ChromaSnapError";
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
  }
}

export function errorCodeForHttpStatus(status: number): ErrorCode {
  if (status === 400) {
    return ERROR_CODES.INVALID_REQUEST;
  }
  if (status === 401) {
    return ERROR_CODES.UNAUTHORIZED;
  }
  if (status === 403) {
    return ERROR_CODES.FORBIDDEN;
  }
  if (status === 404) {
    return ERROR_CODES.NOT_FOUND;
  }
  if (status === 410) {
    return ERROR_CODES.UPLOAD_SESSION_EXPIRED;
  }
  if (status === 429) {
    return ERROR_CODES.QUOTA_EXCEEDED;
  }
  if (status === 501) {
    return ERROR_CODES.OIDC_NOT_CONFIGURED;
  }
  return ERROR_CODES.INTERNAL_ERROR;
}

export function normalizeChromaSnapError(error: unknown): ChromaSnapError {
  if (error instanceof ChromaSnapError) {
    return error;
  }
  if (error instanceof Error) {
    return new ChromaSnapError({ code: ERROR_CODES.INTERNAL_ERROR, status: 500, message: error.message });
  }
  return new ChromaSnapError({ code: ERROR_CODES.INTERNAL_ERROR, status: 500, message: String(error) });
}

export function serializeChromaSnapError(error: unknown, requestId?: string): SerializedChromaSnapError {
  const normalized = normalizeChromaSnapError(error);
  return {
    error: normalized.message,
    code: normalized.code,
    status: normalized.status,
    requestId,
    ...(normalized.details ? { details: normalized.details } : {}),
  };
}
