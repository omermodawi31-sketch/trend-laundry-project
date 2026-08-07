/**
 * Delivery job status state machine.
 *
 * Pure. Same shape as orders/transitions.ts, deliberately — a job's status
 * flow is the same kind of forward-only accountability record an order's
 * status flow is, and this codebase's standing rule is to reuse a proven
 * shape rather than invent a new one for a structurally identical problem.
 *
 * WHY NO BACKWARD TRANSITIONS
 * ---------------------------
 * A driver marked `arrived` cannot go back to `en_route` — if that was a
 * mistake, it's a new fact (re-dispatch, or fail with a reason), not a
 * correction of an old one. Same reasoning as orders: allowing reversals
 * makes the status history unreadable and lets on-time-delivery metrics be
 * gamed.
 */

export const JOB_STATUSES = [
  "scheduled", "assigned", "en_route", "arrived",
  "completed", "failed", "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled"];

const FORWARD: Record<JobStatus, readonly JobStatus[]> = {
  scheduled: ["assigned"],
  assigned:  ["en_route"],
  en_route:  ["arrived"],
  arrived:   ["completed"],
  completed: [],
  failed:    [],
  cancelled: [],
};

/** Failure is reachable from any non-terminal state (a job can fail before or after arrival). */
const FAIL_TARGET: JobStatus = "failed";
/** Cancellation is dispatcher-only (Business Rule 7) but reachable from any non-terminal state. */
const CANCEL_TARGET: JobStatus = "cancelled";

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
  requiresReason: boolean;
}

export function checkTransition(from: JobStatus, to: JobStatus): TransitionCheck {
  const base = { requiresReason: false };

  if (from === to) {
    return { ...base, allowed: false, reason: "The job is already in that status." };
  }

  if (TERMINAL_STATUSES.includes(from)) {
    return { ...base, allowed: false, reason: `A job that is ${from} cannot change status.` };
  }

  if (to === FAIL_TARGET) {
    return { ...base, allowed: true, requiresReason: true };
  }

  if (to === CANCEL_TARGET) {
    return { ...base, allowed: true, requiresReason: false };
  }

  const allowedNext = FORWARD[from];
  if (!allowedNext.includes(to)) {
    return { ...base, allowed: false, reason: `Cannot move from ${from} to ${to}.` };
  }

  return { ...base, allowed: true };
}

/** Whether a job may still have its pre-assignment details (address, window, COD amount) edited. */
export function isEditable(status: JobStatus): boolean {
  return status === "scheduled" || status === "assigned";
}
