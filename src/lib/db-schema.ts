/**
 * Kysely database schema types.
 *
 * These are hand-maintained in Phase 0. Once the schema is stable we introduce
 * `kysely-codegen` to derive them from migrations automatically — earlier and
 * we're regenerating types every migration for tables that keep changing.
 *
 * Convention: table interfaces are named after the table. `Insertable` and
 * `Selectable` variants are derived by Kysely from the column marker types.
 */

import type { ColumnType, Generated, GeneratedAlways } from "kysely";
import type { Bilingual, ISODateTime } from "../shared/types.js";

// --- businesses -------------------------------------------------------------
export interface BusinessesTable {
  id: GeneratedAlways<number>;
  name: ColumnType<Bilingual, Bilingual, Bilingual>;
  trade_licence_number: string | null;
  tax_registration_number: string | null;
  country_code: string;
  currency: string;
  default_locale: string;
  timezone: string;
  plan: "trial" | "starter" | "growth" | "enterprise";
  trial_ends_at: ColumnType<ISODateTime | null, string | null, string | null>;
  status: "active" | "suspended" | "cancelled";
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
}

// --- users ------------------------------------------------------------------
export interface UsersTable {
  id: GeneratedAlways<number>;
  email: string;
  phone: string | null;
  password_hash: string;
  email_verified_at: ColumnType<ISODateTime | null, string | null, string | null>;
  phone_verified_at: ColumnType<ISODateTime | null, string | null, string | null>;
  full_name: string;
  preferred_locale: string;
  mfa_secret: string | null;
  mfa_enabled_at: ColumnType<ISODateTime | null, string | null, string | null>;
  last_login_at: ColumnType<ISODateTime | null, string | null, string | null>;
  failed_login_count: Generated<number>;
  locked_until: ColumnType<ISODateTime | null, string | null, string | null>;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
}

// --- roles ------------------------------------------------------------------
export interface RolesTable {
  id: GeneratedAlways<number>;
  business_id: number;
  key: string;
  name: ColumnType<Bilingual, Bilingual, Bilingual>;
  permissions: string[];
  is_system: Generated<boolean>;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
}

// --- memberships ------------------------------------------------------------
export interface MembershipsTable {
  id: GeneratedAlways<number>;
  user_id: number;
  business_id: number;
  role_id: number;
  branch_ids: number[]; // empty [] means "all branches"
  is_active: Generated<boolean>;
  invited_by_user_id: number | null;
  invited_at: ColumnType<ISODateTime | null, string | null, string | null>;
  accepted_at: ColumnType<ISODateTime | null, string | null, string | null>;
  revoked_at: ColumnType<ISODateTime | null, string | null, string | null>;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
}

// --- branches ---------------------------------------------------------------
export interface BranchesTable {
  id: GeneratedAlways<number>;
  business_id: number;
  name: ColumnType<Bilingual, Bilingual, Bilingual>;
  code: string;
  address: ColumnType<Bilingual, Bilingual, Bilingual>;
  phone: string | null;
  email: string | null;
  maps_url: string | null;
  latitude: ColumnType<string | null, number | null, number | null>;
  longitude: ColumnType<string | null, number | null, number | null>;
  working_hours: unknown | null;
  logo_url: string | null;
  manager_user_id: number | null;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
  deleted_by_user_id: number | null;
}

// --- refresh_tokens ---------------------------------------------------------
export interface RefreshTokensTable {
  id: GeneratedAlways<number>;
  user_id: number;
  token_hash: Buffer;
  family_id: string; // uuid
  parent_id: number | null;
  business_id: number | null; // null until user picks a business
  expires_at: ColumnType<ISODateTime, string, string>;
  revoked_at: ColumnType<ISODateTime | null, string | null, string | null>;
  revoked_reason: string | null;
  user_agent: string | null;
  ip_address: string | null;
  created_at: Generated<ISODateTime>;
}

// --- activity_logs ----------------------------------------------------------
export interface ActivityLogsTable {
  id: GeneratedAlways<number>;
  business_id: number;
  branch_id: number | null;
  user_id: number | null;
  role_key: string | null;
  action: string;
  resource_type: string;
  resource_id: number | null;
  before: unknown | null;
  after: unknown | null;
  ip_address: string | null;
  user_agent: string | null;
  occurred_at: Generated<ISODateTime>;
}


// --- customers --------------------------------------------------------------
export interface CustomersTable {
  id: GeneratedAlways<number>;
  business_id: number;
  preferred_branch_id: number | null;
  name: ColumnType<Bilingual, Bilingual, Bilingual>;
  address: ColumnType<Bilingual | null, Bilingual | null, Bilingual | null>;
  phone: string;
  whatsapp: string | null;
  email: string | null;
  photo_url: string | null;
  maps_url: string | null;
  emirates_id: string | null;
  tax_number: string | null;
  status: "active" | "inactive" | "blocked";
  status_reason: string | null;
  status_changed_at: ColumnType<ISODateTime | null, string | null, string | null>;
  vip: Generated<boolean>;
  tags: string[];
  favourite_services: string[];
  pickup_preference: "morning" | "midday" | "evening" | "none";
  preferred_locale: "en" | "ar" | null;
  marketing_opt_in: Generated<boolean>;
  owner_employee_id: number | null;
  since: ColumnType<ISODate, string | undefined, string>;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
  deleted_by_user_id: number | null;
  // Generated column — read-only, never written by the application.
  search_vector: GeneratedAlways<string>;
}

// --- customer_notes ---------------------------------------------------------
export interface CustomerNotesTable {
  id: GeneratedAlways<number>;
  business_id: number;
  customer_id: number;
  body: string;
  pinned: Generated<boolean>;
  created_by_user_id: number | null;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
}

// --- customer_stats (view) --------------------------------------------------
export interface CustomerStatsView {
  customer_id: number;
  business_id: number;
  orders_count: number;
  completed_count: number;
  cancelled_count: number;
  pieces: number;
  lifetime_spend: string;   // numeric arrives as string from pg
  lifetime_paid: string;
  outstanding: string;
  loyalty_points: number;
  last_visit_at: ISODateTime | null;
  first_order_at: ISODateTime | null;
}


// --- services ---------------------------------------------------------------
export interface ServicesTable {
  id: GeneratedAlways<number>;
  business_id: number;
  name: ColumnType<Bilingual, Bilingual, Bilingual>;
  category: string;
  service_type: "wash" | "press" | "washpress" | "drycl";
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
}

export interface ServiceVariantsTable {
  id: GeneratedAlways<number>;
  business_id: number;
  service_id: number;
  size: string | null;
  unit_price: ColumnType<string, number | string, number | string>;
  express_multiplier: ColumnType<string, number | string, number | string>;
  is_active: Generated<boolean>;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
}

// --- orders -----------------------------------------------------------------
export interface OrdersTable {
  id: GeneratedAlways<number>;
  business_id: number;
  intake_branch_id: number;
  processing_branch_id: number | null;
  collection_branch_id: number | null;
  order_number: string;
  invoice_number: string | null;
  customer_id: number | null;
  customer_name_snapshot: ColumnType<Bilingual, Bilingual, Bilingual>;
  customer_phone_snapshot: string;
  status: string;
  pieces: Generated<number>;
  subtotal: ColumnType<string, number | string, number | string>;
  express: Generated<boolean>;
  express_pct: ColumnType<string, number | string, number | string>;
  express_amount: ColumnType<string, number | string, number | string>;
  delivery: Generated<boolean>;
  delivery_amount: ColumnType<string, number | string, number | string>;
  discount_pct: ColumnType<string, number | string, number | string>;
  discount_amount: ColumnType<string, number | string, number | string>;
  discount_reason: string | null;
  vat_pct: ColumnType<string, number | string, number | string>;
  vat_amount: ColumnType<string, number | string, number | string>;
  total: ColumnType<string, number | string, number | string>;
  paid_amount: ColumnType<string, number | string, number | string>;
  notes: string | null;
  stain_notes: string | null;
  damage_notes: string | null;
  taken_by_employee_id: number | null;
  taken_by_user_id: number | null;
  due_at: ColumnType<ISODateTime | null, string | null, string | null>;
  delivered_at: ColumnType<ISODateTime | null, string | null, string | null>;
  cancelled_at: ColumnType<ISODateTime | null, string | null, string | null>;
  cancel_reason: string | null;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
}

export interface OrderLinesTable {
  id: GeneratedAlways<number>;
  business_id: number;
  order_id: number;
  service_variant_id: number | null;
  service_name_snapshot: ColumnType<Bilingual, Bilingual, Bilingual>;
  service_type: string;
  size: string | null;
  qty: number;
  unit_price: ColumnType<string, number | string, number | string>;
  line_total: ColumnType<string, number | string, number | string>;
  created_at: Generated<ISODateTime>;
}

export interface PaymentsTable {
  id: GeneratedAlways<number>;
  business_id: number;
  branch_id: number | null;
  order_id: number | null;
  customer_id: number | null;
  amount: ColumnType<string, number | string, number | string>;
  method: string;
  reference: string | null;
  refunded_from_payment_id: number | null;
  refund_reason: string | null;
  received_by_user_id: number | null;
  received_at: Generated<ISODateTime>;
  created_at: Generated<ISODateTime>;
}

export interface OrderStatusHistoryTable {
  id: GeneratedAlways<number>;
  business_id: number;
  order_id: number;
  from_status: string | null;
  to_status: string;
  branch_id: number | null;
  changed_by_user_id: number | null;
  changed_by_role: string | null;
  note: string | null;
  changed_at: Generated<ISODateTime>;
}

export interface OrderPhotosTable {
  id: GeneratedAlways<number>;
  business_id: number;
  order_id: number;
  url: string;
  kind: "intake" | "stain" | "damage" | "complete";
  taken_by_user_id: number | null;
  created_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
}

export interface OrderNumberCountersTable {
  business_id: number;
  branch_id: number;
  local_date: string;
  last_seq: number;
}

export interface InvoiceNumberCountersTable {
  business_id: number;
  year: number;
  last_seq: number;
}

// --- inventory_items ---------------------------------------------------------
export interface InventoryItemsTable {
  id: GeneratedAlways<number>;
  business_id: number;
  name: ColumnType<Bilingual, Bilingual, Bilingual>;
  category: string;
  unit: "L" | "kg" | "piece" | "roll" | "box";
  sku: string | null;
  barcode: string | null;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
  deleted_by_user_id: number | null;
  // Generated column — read-only, never written by the application.
  search_vector: GeneratedAlways<string>;
}

// --- inventory_movements ------------------------------------------------------
export type InventoryMovementType = "receive" | "waste" | "adjust" | "transfer_out" | "transfer_in";

export interface InventoryMovementsTable {
  id: GeneratedAlways<number>;
  business_id: number;
  branch_id: number;
  item_id: number;
  movement_type: InventoryMovementType;
  quantity_delta: ColumnType<string, number, number>;
  unit_cost: ColumnType<string | null, number | null, number | null>;
  reason: string | null;
  note: string | null;
  transfer_group_id: string | null;
  created_by_user_id: number | null;
  occurred_at: Generated<ISODateTime>;
}

// --- inventory_stock_levels (view) --------------------------------------------
export interface InventoryStockLevelsView {
  business_id: number;
  branch_id: number;
  item_id: number;
  quantity: string;
}

// --- business_settings -------------------------------------------------------
export interface BusinessSettingsTable {
  id: GeneratedAlways<number>;
  business_id: number;
  legal_name: ColumnType<Bilingual | null, Bilingual | null, Bilingual | null>;
  vat_enabled: Generated<boolean>;
  vat_pct: ColumnType<string, number, number>;
  express_pct: ColumnType<string, number, number>;
  delivery_fee: ColumnType<string, number, number>;
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  theme: Generated<"light" | "dark">;
  receipt_header: ColumnType<Bilingual | null, Bilingual | null, Bilingual | null>;
  receipt_footer: ColumnType<Bilingual | null, Bilingual | null, Bilingual | null>;
  address: ColumnType<Bilingual | null, Bilingual | null, Bilingual | null>;
  phone: string | null;
  email: string | null;
  website: string | null;
  social_links: ColumnType<SocialLinks | null, SocialLinks | null, SocialLinks | null>;
  updated_by_user_id: number | null;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
}

export interface SocialLinks {
  instagram?: string;
  facebook?: string;
  twitter?: string;
  tiktok?: string;
  whatsapp?: string;
  snapchat?: string;
}

// --- drivers -----------------------------------------------------------------
export type DriverStatus = "available" | "busy" | "offline";
export type VehicleType = "bike" | "car" | "van";

export interface DriversTable {
  id: GeneratedAlways<number>;
  business_id: number;
  user_id: number;
  vehicle_type: VehicleType | null;
  plate_number: string | null;
  notes: string | null;
  status: Generated<DriverStatus>;
  is_active: Generated<boolean>;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
  deleted_by_user_id: number | null;
}

// --- delivery_jobs -------------------------------------------------------------
export type DeliveryJobType = "pickup" | "delivery";
// NOTE: job status is deliberately NOT a strict union here — mirrors
// OrdersTable.status exactly (plain `string`), since delivery/transitions.ts
// already owns the canonical `JobStatus` union and its forward-only graph.
// Duplicating that union here would be the exact anti-pattern Orders avoids
// by never re-declaring OrderStatus in this file.

export interface DeliveryJobsTable {
  id: GeneratedAlways<number>;
  business_id: number;
  branch_id: number;
  order_id: number;
  driver_id: number | null;
  job_type: DeliveryJobType;
  status: string;
  address: ColumnType<Bilingual, Bilingual, Bilingual>;
  scheduled_window_start: ColumnType<ISODateTime | null, string | null, string | null>;
  scheduled_window_end: ColumnType<ISODateTime | null, string | null, string | null>;
  fee: ColumnType<string, number, number>;
  collect_amount: ColumnType<string | null, number | null, number | null>;
  collected_amount: ColumnType<string | null, number | null, number | null>;
  proof_photo_url: string | null;
  proof_signature_url: string | null;
  proof_latitude: ColumnType<string | null, number | null, number | null>;
  proof_longitude: ColumnType<string | null, number | null, number | null>;
  fail_reason: string | null;
  assigned_at: ColumnType<ISODateTime | null, string | null, string | null>;
  started_at: ColumnType<ISODateTime | null, string | null, string | null>;
  arrived_at: ColumnType<ISODateTime | null, string | null, string | null>;
  completed_at: ColumnType<ISODateTime | null, string | null, string | null>;
  cancelled_at: ColumnType<ISODateTime | null, string | null, string | null>;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: Generated<ISODateTime>;
  updated_at: Generated<ISODateTime>;
  deleted_at: ColumnType<ISODateTime | null, string | null, string | null>;
  deleted_by_user_id: number | null;
}

// --- delivery_job_status_history (append-only) ----------------------------------
export interface DeliveryJobStatusHistoryTable {
  id: GeneratedAlways<number>;
  business_id: number;
  job_id: number;
  branch_id: number;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  changed_by_user_id: number | null;
  occurred_at: Generated<ISODateTime>;
}

export interface Database {
  businesses: BusinessesTable;
  users: UsersTable;
  roles: RolesTable;
  memberships: MembershipsTable;
  branches: BranchesTable;
  refresh_tokens: RefreshTokensTable;
  activity_logs: ActivityLogsTable;
  customers: CustomersTable;
  customer_notes: CustomerNotesTable;
  customer_stats: CustomerStatsView;
  services: ServicesTable;
  service_variants: ServiceVariantsTable;
  orders: OrdersTable;
  order_lines: OrderLinesTable;
  payments: PaymentsTable;
  order_status_history: OrderStatusHistoryTable;
  order_photos: OrderPhotosTable;
  order_number_counters: OrderNumberCountersTable;
  invoice_number_counters: InvoiceNumberCountersTable;
  password_resets: PasswordResetsTable;
  email_verifications: EmailVerificationsTable;
  inventory_items: InventoryItemsTable;
  inventory_movements: InventoryMovementsTable;
  inventory_stock_levels: InventoryStockLevelsView;
  business_settings: BusinessSettingsTable;
  drivers: DriversTable;
  delivery_jobs: DeliveryJobsTable;
  delivery_job_status_history: DeliveryJobStatusHistoryTable;
}

// --- password_resets --------------------------------------------------------
export interface PasswordResetsTable {
  id: GeneratedAlways<number>;
  user_id: number;
  token_hash: Buffer;
  expires_at: ColumnType<ISODateTime, string, string>;
  used_at: ColumnType<ISODateTime | null, string | null, string | null>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<ISODateTime>;
}

// --- email_verifications ----------------------------------------------------
export interface EmailVerificationsTable {
  id: GeneratedAlways<number>;
  user_id: number;
  token_hash: Buffer;
  expires_at: ColumnType<ISODateTime, string, string>;
  consumed_at: ColumnType<ISODateTime | null, string | null, string | null>;
  email_at_issue: string;
  created_at: Generated<ISODateTime>;
}
