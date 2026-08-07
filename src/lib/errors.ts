/**
 * Structured errors.
 *
 * Every user-facing error is an AppError with:
 *   - code: kebab-case machine-readable string
 *   - message: human-readable
 *   - status: HTTP status
 *   - details: optional context
 *
 * The response body shape stays consistent across every endpoint, which is
 * what makes error handling in the frontend tractable. Never leak stack
 * traces, SQL, or provider errors to the client — those go to logs only.
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    // Preserve prototype chain so `instanceof AppError` works.
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// Common shapes — used from many places, so worth naming.
export const Errors = {
  invalidCredentials: () => new AppError(401, "invalid-credentials", "Email or password is incorrect."),
  unauthenticated: () => new AppError(401, "unauthenticated", "Sign in to continue."),
  unauthorized: (required?: string[]) =>
    new AppError(403, "insufficient-permissions", "You don't have permission for this action.", required ? { required } : undefined),
  notFound: (what: string) => new AppError(404, "not-found", `${what} not found.`),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(409, code, message, details),
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError(422, "validation-failed", message, details),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, "rate-limited", "Too many requests.", { retry_after: retryAfterSeconds }),
  internal: (message = "Something went wrong.") => new AppError(500, "internal-error", message),
};
