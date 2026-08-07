/**
 * Permission catalogue.
 *
 * Every backend permission ever is listed here. The list is the source of
 * truth; changes require a migration to update role.permissions for existing
 * businesses (see db/migrations for the pattern).
 *
 * Convention: `<domain>.<action>`. Nested actions use dots too:
 * `reports.financial.read`.
 *
 * Seed roles in db/migrations/*_seed_roles.sql must be kept in sync with the
 * seedRoles() helper below.
 */

export const ALL_PERMISSIONS = [
  // Customers
  "customers.read",
  "customers.create",
  "customers.update",
  "customers.delete",
  "customers.merge",
  "customers.export",

  // Orders
  "orders.read",
  "orders.create",
  "orders.update",
  "orders.status_change",
  "orders.payment_record",
  "orders.refund",
  "orders.delete",

  // Delivery
  "delivery.read",
  "delivery.dispatch",
  "delivery.assign_driver",
  "delivery.execute",
  "delivery.complete",
  "delivery.fail",

  // Inventory
  "inventory.read",
  "inventory.adjust",
  "inventory.receive",
  "inventory.waste_record",
  "inventory.audit",
  "inventory.recipe_edit",

  // Purchasing
  "purchasing.read",
  "purchasing.create",
  "purchasing.approve",
  "purchasing.receive",
  "purchasing.pay",

  // Suppliers
  "suppliers.read",
  "suppliers.create",
  "suppliers.update",

  // Expenses
  "expenses.read",
  "expenses.create",
  "expenses.delete",

  // Employees
  "employees.read",
  "employees.create",
  "employees.update",
  "employees.terminate",

  // Reports
  "reports.dashboard.read",
  "reports.operational.read",
  "reports.financial.read",
  "reports.export",

  // Settings
  "settings.read",
  "settings.business.edit",
  "settings.branches.edit",
  "settings.roles.edit",
  "settings.integrations.edit",

  // Notifications
  "notifications.read",
  "notifications.configure",

  // Audit
  "activity_log.read",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const PERM_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(x: string): x is Permission {
  return PERM_SET.has(x);
}

/**
 * Seed roles that are auto-created for every new business.
 *
 * `is_system: true` roles cannot be deleted (a business must always have
 * at least one Owner). All can have their permissions edited except that
 * the Owner role always retains at least `settings.business.edit`.
 */
export const SYSTEM_ROLES: Array<{
  key: string;
  name: { en: string; ar: string };
  permissions: readonly Permission[];
}> = [
  {
    key: "owner",
    name: { en: "Owner", ar: "المالك" },
    // Owner: everything.
    permissions: ALL_PERMISSIONS,
  },
  {
    key: "manager",
    name: { en: "Manager", ar: "المدير" },
    permissions: [
      "customers.read", "customers.create", "customers.update", "customers.merge", "customers.export",
      "orders.read", "orders.create", "orders.update", "orders.status_change", "orders.payment_record", "orders.refund",
      "delivery.read", "delivery.dispatch", "delivery.assign_driver",
      "inventory.read", "inventory.adjust", "inventory.receive", "inventory.waste_record", "inventory.audit", "inventory.recipe_edit",
      "purchasing.read", "purchasing.create", "purchasing.approve", "purchasing.receive", "purchasing.pay",
      "suppliers.read", "suppliers.create", "suppliers.update",
      "expenses.read", "expenses.create",
      "employees.read", "employees.create", "employees.update",
      "reports.dashboard.read", "reports.operational.read", "reports.financial.read", "reports.export",
      "settings.read", "settings.branches.edit",
      "notifications.read", "notifications.configure",
      "activity_log.read",
    ],
  },
  {
    key: "cashier",
    name: { en: "Cashier", ar: "الكاشير" },
    permissions: [
      "customers.read", "customers.create", "customers.update",
      "orders.read", "orders.create", "orders.update", "orders.payment_record",
      "delivery.read",
      "inventory.read",
      "reports.dashboard.read",
    ],
  },
  {
    key: "employee",
    name: { en: "Employee", ar: "الموظف" },
    permissions: [
      "orders.read", "orders.status_change",
      "inventory.read", "inventory.adjust", "inventory.waste_record",
    ],
  },
  {
    key: "driver",
    name: { en: "Driver", ar: "السائق" },
    permissions: [
      "delivery.read", "delivery.execute", "delivery.complete", "delivery.fail",
      "orders.read",
    ],
  },
];
