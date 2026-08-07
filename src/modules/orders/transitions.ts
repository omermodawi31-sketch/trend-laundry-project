/**
 * Order status state machine.
 *
 * Pure. Given a current status and a desired one, decide whether the move is
 * legal and what it implies.
 *
 * WHY NO BACKWARD TRANSITIONS
 * ---------------------------
 * Ready → washing is refused. If a garment comes back from the rack for
 * rework, that is a new fact, not a correction of an old one: cancel and
 * re-create, or (Phase 4) raise a rework order that references the original.
 * Allowing arbitrary reversals makes the status history unreadable and lets
 * processing-time metrics be gamed.
 *
 * The graph is deliberately narrow. Widening it later is easy; narrowing it
 * after operators have learned a shortcut is not.
 */

export const ORDER_STATUSES = [
  "received", "sorting", "washing", "drycleaning", "ironing",
  "packing", "ready", "out_for_delivery", "delivered",
  "cancelled", "lost",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ["delivered", "cancelled", "lost"];

/**
 * Forward graph.
 *
 * `washing` and `drycleaning` are alternative treatments, both feeding
 * `ironing`. A garment can also skip straight from sorting to ironing
 * (press-only orders), which is why sorting fans out to three.
 */
const FORWARD: Record<OrderStatus, readonly OrderStatus[]> = {
  received:         ["sorting", "washing", "drycleaning", "ironing"],
  sorting:          ["washing", "drycleaning", "ironing"],
  washing:          ["ironing", "packing"],
  drycleaning:      ["ironing", "packing"],
  ironing:          ["packing"],
  packing:          ["ready"],
  ready:            ["out_for_delivery", "delivered"],
  out_for_delivery: ["delivered"],
  delivered:        [],
  cancelled:        [],
  lost:             [],
};

/** Cancellation is reachable from any non-terminal state. */
const ABORT_TARGETS: readonly OrderStatus[] = ["cancelled", "lost"];

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
  /** True when the move requires a reason string from the caller. */
  requiresReason: boolean;
  /** True when the move should assign an invoice number. */
  assignsInvoice: boolean;
  /** True when the move should trigger inventory consumption (Phase 4). */
  triggersConsumption: boolean;
}

export function checkTransition(from: OrderStatus, to: OrderStatus): TransitionCheck {
  const base = { requiresReason: false, assignsInvoice: false, triggersConsumption: false };

  if (from === to) {
    return { ...base, allowed: false, reason: "The order is already in that status." };
  }

  if (TERMINAL_STATUSES.includes(from)) {
    return {
      ...base,
      allowed: false,
      reason: `An order that is ${from} cannot change status.`,
    };
  }

  if (ABORT_TARGETS.includes(to)) {
    return { ...base, allowed: true, requiresReason: true };
  }

  const allowedNext = FORWARD[from];
  if (!allowedNext.includes(to)) {
    return {
      ...base,
      allowed: false,
      reason: `Cannot move from ${from} to ${to}.`,
    };
  }

  return {
    ...base,
    allowed: true,
    // Delivered is the point of no return commercially: the invoice number is
    // assigned here, not at creation, so a cancelled order never burns one.
    assignsInvoice: to === "delivered",
    // Consumption fires when the work is demonstrably finished. Phase 4 wires
    // the actual deduction; this flag is the contract.
    triggersConsumption: to === "ready",
  };
}

/** Statuses that count as revenue. Cancelled and lost never do. */
export function isRevenueStatus(status: OrderStatus): boolean {
  return status !== "cancelled" && status !== "lost";
}

/** Whether an order may still have its lines edited. */
export function isEditable(status: OrderStatus): boolean {
  // Once cloth is in water the price is committed. Editing after `washing`
  // would let someone alter a total after the customer approved it.
  return status === "received" || status === "sorting";
}
