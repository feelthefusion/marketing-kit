// =============================================================================
// Marketing Kit — reference CRM schema (Drizzle ORM, Postgres)
//
// A STARTING POINT, not a drop-in. Before copying anything, read the app's existing
// schema: if a users/customers table already exists, crm_contacts references it
// (user_id) instead of duplicating identity. Add tables through the app's normal
// migration flow (drizzle-kit generate → review SQL → migrate); never DDL through MCP.
//
// Design rules this encodes (growth-data skill explains each):
//   1. One contact row per person; every external ID lives in crm_identities.
//   2. Events are append-only and carry their source — they are the journey.
//   3. Every outbound message is a row BEFORE it is sent (outbox), keyed by an
//      idempotency key, so retries and crashes never double-send.
//   4. Enrollment records variant + holdout, so lift is computable later.
//   5. Revenue comes from the app's OWN order/payment rows, never from click counts.
//   6. All data is first-party: the site writes its own events (journey-analytics →
//      references/first-party-tracking.ts); no third-party analytics or billing IDs.
// =============================================================================
import {
  pgTable, text, timestamp, jsonb, boolean, integer, bigint, uuid, index, uniqueIndex, pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const channelEnum = pgEnum("crm_channel", ["email", "sms"]);
export const messageStatusEnum = pgEnum("crm_message_status", [
  "queued", "sending", "sent", "delivered", "opened", "clicked", "bounced", "failed", "complained", "skipped",
]);

// --- people ------------------------------------------------------------------
export const crmContacts = pgTable("crm_contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id"),                         // FK to the app's users table when one exists
  email: text("email"),
  phoneE164: text("phone_e164"),                   // always E.164; normalize on write
  firstName: text("first_name"),
  lastName: text("last_name"),
  timezone: text("timezone"),                      // IANA; drives quiet hours + send-time
  plan: text("plan").notNull().default("free"),    // mirrored from the app's own billing/orders
  lifecycleStage: text("lifecycle_stage").notNull().default("lead"), // lead|trial|active|at_risk|churned
  traits: jsonb("traits").$type<Record<string, unknown>>().notNull().default({}), // typed via zod at the edge
  emailStatus: text("email_status").notNull().default("ok"),   // ok|bounced|complained|unsubscribed
  smsStatus: text("sms_status").notNull().default("ok"),       // ok|opted_out|invalid|landline
  firstTouch: jsonb("first_touch").$type<Touch>(),             // utm + referrer + landing page, set once
  lastTouch: jsonb("last_touch").$type<Touch>(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("crm_contacts_email_uq").on(sql`lower(${t.email})`),
  uniqueIndex("crm_contacts_phone_uq").on(t.phoneE164),
  index("crm_contacts_last_seen_idx").on(t.lastSeenAt),
  index("crm_contacts_stage_idx").on(t.lifecycleStage),
]);

export type Touch = {
  utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_content?: string; utm_term?: string;
  referrer?: string; landing_page?: string; anon_id?: string; at: string;
};

// Every other identifier for a contact: pre-signup browser id, Resend/Telnyx ids, legacy ids.
// (Umami needs no row: the site calls umami.identify(contact.id), so session.distinct_id IS the id.)
export const crmIdentities = pgTable("crm_identities", {
  contactId: uuid("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),   // anon_id | resend_contact | telnyx_number | legacy_user_id
  value: text("value").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("crm_identities_kind_value_uq").on(t.kind, t.value), index("crm_identities_contact_idx").on(t.contactId)]);

// --- behavior -----------------------------------------------------------------
export const crmEvents = pgTable("crm_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  contactId: uuid("contact_id").references(() => crmContacts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),     // object.action, snake_case: "report.viewed", "usage.limit_90pct"
  source: text("source").notNull(), // web (collector) | app (server code) | resend | telnyx
  anonId: text("anon_id"),          // browser id before login; stitched to contact_id at signup/login
  sessionId: text("session_id"),    // client-rolled, 30-min idle timeout — sessions without a sessions table
  properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  dedupeKey: text("dedupe_key"),    // provider event id; makes webhook replays harmless
}, (t) => [
  index("crm_events_contact_time_idx").on(t.contactId, t.occurredAt),
  index("crm_events_name_time_idx").on(t.name, t.occurredAt),
  index("crm_events_anon_idx").on(t.anonId),
  // High volume? add a BRIN index on occurred_at and partition by month (growth-data SKILL).
  uniqueIndex("crm_events_dedupe_uq").on(t.source, t.dedupeKey),
]);

// --- campaigns ----------------------------------------------------------------
export const crmCampaigns = pgTable("crm_campaigns", {
  id: text("id").primaryKey(),                      // == campaign.json id == utm_campaign
  goal: text("goal").notNull(),                     // acquisition|activation|upsell|retention|reactivation|referral|transactional
  mode: text("mode").notNull(),                     // one-off|scheduled|triggered
  spec: jsonb("spec").notNull(),                    // the preflighted campaign.json, verbatim
  specVersion: integer("spec_version").notNull().default(1),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const crmEnrollments = pgTable("crm_enrollments", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  campaignId: text("campaign_id").notNull().references(() => crmCampaigns.id),
  contactId: uuid("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  variant: text("variant").notNull().default("control"),
  holdout: boolean("holdout").notNull().default(false), // true = eligible, deliberately NOT messaged
  step: integer("step").notNull().default(0),
  state: text("state").notNull().default("active"),     // active|completed|exited|converted
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
}, (t) => [
  index("crm_enrollments_due_idx").on(t.nextRunAt).where(sql`${t.state} = 'active'`),
  index("crm_enrollments_campaign_idx").on(t.campaignId, t.contactId),
]);

// Outbox: a row exists BEFORE the provider call; the worker flips status.
export const crmMessages = pgTable("crm_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull(),  // "{campaign}/{contact}/{step}" — also sent to Resend
  enrollmentId: bigint("enrollment_id", { mode: "number" }).references(() => crmEnrollments.id),
  campaignId: text("campaign_id"),
  contactId: uuid("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  channel: channelEnum("channel").notNull(),
  toAddress: text("to_address").notNull(),
  fromAddress: text("from_address").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),                       // RENDERED body, as sent
  provider: text("provider").notNull(),               // resend | telnyx
  providerMessageId: text("provider_message_id"),
  status: messageStatusEnum("status").notNull().default("queued"),
  error: text("error"),
  segments: integer("segments"),                      // SMS parts billed
  costMicros: bigint("cost_micros", { mode: "number" }),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
  firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("crm_messages_idem_uq").on(t.idempotencyKey),
  uniqueIndex("crm_messages_provider_id_uq").on(t.provider, t.providerMessageId),
  index("crm_messages_queue_idx").on(t.status, t.scheduledFor),
  index("crm_messages_contact_idx").on(t.contactId, t.createdAt),
]);

// Addresses that must not be retried: hard bounces, complaints, carrier rejections, opt-outs.
// Deliverability hygiene — sending to these burns sender reputation and money.
export const crmSuppressions = pgTable("crm_suppressions", {
  channel: channelEnum("channel").notNull(),
  value: text("value").notNull(),           // lower(email) or E.164
  reason: text("reason").notNull(),         // hard_bounce | complaint | carrier_reject | opted_out | manual
  source: text("source").notNull(),         // resend | telnyx | app
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("crm_suppressions_uq").on(t.channel, t.value)]);

// --- revenue ------------------------------------------------------------------
// Revenue facts from the app's OWN orders/payments. Either write rows here from the code that
// records a payment/refund/plan change — or, if the app already has orders/payments tables,
// skip this table and define `crm_revenue` as a SQL VIEW over them with these columns.
export const crmRevenue = pgTable("crm_revenue", {
  id: text("id").primaryKey(),                         // the app's own order/payment id
  contactId: uuid("contact_id").references(() => crmContacts.id),
  kind: text("kind").notNull(),                        // new | expansion | renewal | contraction | refund
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(), // negative for refunds/contraction
  currency: text("currency").notNull(),
  mrrDeltaCents: bigint("mrr_delta_cents", { mode: "number" }).notNull().default(0),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  attributedCampaignId: text("attributed_campaign_id"), // last campaign message within window, see journey-analytics
}, (t) => [index("crm_revenue_contact_time_idx").on(t.contactId, t.occurredAt)]);
