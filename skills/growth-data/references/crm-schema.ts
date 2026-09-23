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
//   7. Money and points are LEDGERS (append-only rows, balance = sum), each row keyed so a
//      replayed webhook / retried job can never double-credit (partner-program, loyalty-engine).
//   8. Models write scores back as rows (crm_scores) — segments, commission tiers and offers
//      read them like any other column (growth-optimizer).
// =============================================================================
import {
  pgTable, text, timestamp, jsonb, boolean, integer, bigint, uuid, index, uniqueIndex, pgEnum, real, primaryKey,
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
  timezone: text("timezone"),                      // IANA; drives send-time
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

// Delivery facts per address: hard bounces, complaints, carrier rejections, inbound STOP, manual.
// Pure data — the kit blocks nothing. Each campaign picks which reasons to skip (send.exclude).
export const crmSuppressions = pgTable("crm_suppressions", {
  channel: channelEnum("channel").notNull(),
  value: text("value").notNull(),           // lower(email) or E.164
  reason: text("reason").notNull(),         // hard_bounce | carrier_reject | complaint | opted_out | unsubscribed | manual
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
  parentId: text("parent_id"),                          // refund/contraction → the order it reverses (drives clawbacks)
}, (t) => [index("crm_revenue_contact_time_idx").on(t.contactId, t.occurredAt), index("crm_revenue_parent_idx").on(t.parentId)]);

// =============================================================================
// PARTNER PROGRAM — creators, influencers, affiliates, ambassadors, customer referrers.
// One engine for all of them: a partner is a contact with a plan, codes and a payout method.
// =============================================================================
export const crmCommissionPlans = pgTable("crm_commission_plans", {
  id: text("id").primaryKey(),                            // "creator-std", "vip-creator", "customer-referral"
  name: text("name").notNull(),
  rateBps: integer("rate_bps").notNull().default(0),      // % of NET order value (after discount, before tax/ship)
  flatCents: integer("flat_cents").notNull().default(0),  // per attributed order (CPA) — hybrid = both
  newCustomersOnly: boolean("new_customers_only").notNull().default(false),
  recurringMonths: integer("recurring_months").notNull().default(0), // 0 = first order only; N = repeat orders for N months
  customerDiscountBps: integer("customer_discount_bps").notNull().default(0), // what the partner's code gives their audience
  cookieDays: integer("cookie_days").notNull().default(30),   // link attribution window
  holdDays: integer("hold_days").notNull().default(30),       // pending → approved after the refund window
  tiers: jsonb("tiers").$type<{ minMonthlyNetCents: number; rateBps: number }[]>().notNull().default([]), // performance ladder
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const crmPartners = pgTable("crm_partners", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),                 // creator | affiliate | ambassador | customer
  status: text("status").notNull().default("active"), // applied | active | paused | removed
  displayName: text("display_name"),
  planId: text("plan_id").notNull().references(() => crmCommissionPlans.id),
  tier: text("tier"),                           // set by the tier ladder / growth-optimizer, not by hand
  platforms: jsonb("platforms").$type<Record<string, { handle: string; followers?: number; engagementBps?: number }>>().notNull().default({}),
  payoutMethod: text("payout_method").notNull().default("store_credit"), // paypal | venmo | cashapp | zelle | store_credit
  payoutHandle: text("payout_handle"),          // PayPal email · Venmo US mobile · $cashtag · Zelle email/phone
  prospectId: uuid("prospect_id"),              // the crm_creator_prospects row they were signed from
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("crm_partners_contact_uq").on(t.contactId), index("crm_partners_status_idx").on(t.status)]);

// Codes and links are the same object: a code is typed at checkout, a link carries ?ref=<code>.
export const crmPartnerCodes = pgTable("crm_partner_codes", {
  code: text("code").primaryKey(),              // stored lower-case; matching is case-insensitive
  partnerId: uuid("partner_id").notNull().references(() => crmPartners.id, { onDelete: "cascade" }),
  discountBps: integer("discount_bps"),         // override of the plan's customer discount
  destination: text("destination"),             // landing page for the short link
  campaign: text("campaign"),                   // optional: which content/drop it belongs to
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("crm_partner_codes_partner_idx").on(t.partnerId)]);

// One row per order that a partner earned. Written at order.paid by partner-tracking.ts.
export const crmAttributions = pgTable("crm_attributions", {
  orderId: text("order_id").primaryKey(),       // == crm_revenue.id (the app's own order id)
  partnerId: uuid("partner_id").notNull().references(() => crmPartners.id),
  code: text("code"),
  method: text("method").notNull(),             // code | link | code+link   (typed code beats a cookie)
  contactId: uuid("contact_id").references(() => crmContacts.id),
  newCustomer: boolean("new_customer").notNull(),
  netCents: bigint("net_cents", { mode: "number" }).notNull(),
  touchAt: timestamp("touch_at", { withTimezone: true }),   // when the ref link was clicked (link method)
  attributedAt: timestamp("attributed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("crm_attributions_partner_idx").on(t.partnerId, t.attributedAt)]);

export const crmCommissions = pgTable("crm_commissions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  partnerId: uuid("partner_id").notNull().references(() => crmPartners.id),
  orderId: text("order_id"),
  kind: text("kind").notNull(),                 // sale | bonus | clawback | adjustment
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(), // negative for clawback
  rateBps: integer("rate_bps"),                 // the rate actually applied (tier at the time)
  status: text("status").notNull().default("pending"), // pending | approved | paid | void
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(), // end of hold → approvable
  payoutId: uuid("payout_id"),
  idemKey: text("idem_key").notNull(),          // "sale:{order}" · "clawback:{refund}" · "bonus:{partner}:{period}"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("crm_commissions_idem_uq").on(t.idemKey), index("crm_commissions_partner_status_idx").on(t.partnerId, t.status)]);

// One row per partner per payout run. PayPal/Venmo: sent by API. Cash App/Zelle: no public payout
// API exists, so the row is the instruction and someone marks it paid with the reference.
export const crmPayouts = pgTable("crm_payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  partnerId: uuid("partner_id").notNull().references(() => crmPartners.id),
  method: text("method").notNull(),             // paypal | venmo | cashapp | zelle | store_credit
  handle: text("handle"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("draft"), // draft | sent | paid | failed | returned
  provider: text("provider").notNull(),          // paypal | manual | ledger
  senderBatchId: text("sender_batch_id"),        // PayPal idempotency (30-day window)
  providerBatchId: text("provider_batch_id"),
  providerItemId: text("provider_item_id"),
  paidRef: text("paid_ref"),                     // manual: Cash App / Zelle confirmation
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (t) => [index("crm_payouts_status_idx").on(t.status, t.method)]);

// Discovery pipeline: official APIs (YouTube Data, Instagram business_discovery, TikTok One)
// + inbound applications. Scored by growth-optimizer; signed prospects become crm_partners.
export const crmCreatorProspects = pgTable("crm_creator_prospects", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: text("platform").notNull(),          // youtube | instagram | tiktok
  externalId: text("external_id").notNull(),     // channel id / ig user id / tiktok creator id
  handle: text("handle").notNull(),
  followers: integer("followers"),
  avgViews: integer("avg_views"),
  engagementBps: integer("engagement_bps"),      // (likes+comments)/views or /followers, in bps
  niches: text("niches").array().notNull().default(sql`'{}'::text[]`),
  email: text("email"),
  source: text("source").notNull(),              // youtube_api | ig_business_discovery | tiktok_one | application | manual
  stage: text("stage").notNull().default("found"), // found | contacted | replied | negotiating | signed | declined
  fitScore: real("fit_score"),                   // growth-optimizer: predicted value of signing
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("crm_creator_prospects_uq").on(t.platform, t.externalId), index("crm_creator_prospects_stage_idx").on(t.stage, t.fitScore)]);

// =============================================================================
// LOYALTY + STORE CREDIT — two ledgers. Points buy rewards; store credit is money.
// =============================================================================
export const crmLoyaltyTiers = pgTable("crm_loyalty_tiers", {
  id: text("id").primaryKey(),                   // "member", "silver", "gold", "vip"
  rank: integer("rank").notNull(),
  minSpend12mCents: bigint("min_spend_12m_cents", { mode: "number" }).notNull(), // rolling 12-month net spend
  earnMultiplierBps: integer("earn_multiplier_bps").notNull().default(10000),    // 10000 = 1×
  perks: jsonb("perks").$type<Record<string, unknown>>().notNull().default({}),
});

export const crmLoyaltyLedger = pgTable("crm_loyalty_ledger", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  contactId: uuid("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  points: integer("points").notNull(),           // + earn, − redeem/expire/clawback
  kind: text("kind").notNull(),                  // earn_order | earn_referral | earn_action | bonus | redeem | expire | clawback | adjust
  ref: text("ref").notNull(),                    // order id, reward redemption id, action key…
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("crm_loyalty_ledger_uq").on(t.contactId, t.kind, t.ref), index("crm_loyalty_ledger_contact_idx").on(t.contactId, t.createdAt)]);

export const crmLoyaltyRewards = pgTable("crm_loyalty_rewards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  costPoints: integer("cost_points").notNull(),
  creditCents: integer("credit_cents"),          // store credit granted (or use perk for non-cash rewards)
  perk: jsonb("perk").$type<Record<string, unknown>>(),
  minTierRank: integer("min_tier_rank").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export const crmStoreCredit = pgTable("crm_store_credit", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  contactId: uuid("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(), // + grant, − spend
  kind: text("kind").notNull(),                  // commission_payout | reward | order_spend | refund | adjust
  ref: text("ref").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("crm_store_credit_uq").on(t.kind, t.ref), index("crm_store_credit_contact_idx").on(t.contactId)]);

// =============================================================================
// LEARNING — bandits choose between live options; models score people and partners.
// =============================================================================
// An experiment is any repeated choice: which commission plan to offer a new creator, which
// loyalty offer to show, which subject line, which reward. Arms keep Beta posteriors.
export const crmArms = pgTable("crm_arms", {
  experimentId: text("experiment_id").notNull(),
  armId: text("arm_id").notNull(),
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull().default({}), // what the arm IS
  pulls: integer("pulls").notNull().default(0),
  successes: integer("successes").notNull().default(0),
  rewardCents: bigint("reward_cents", { mode: "number" }).notNull().default(0), // value-weighted reward
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.experimentId, t.armId] })]);

export const crmArmPulls = pgTable("crm_arm_pulls", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  experimentId: text("experiment_id").notNull(),
  armId: text("arm_id").notNull(),
  subjectId: text("subject_id").notNull(),       // contact or partner id
  rewarded: boolean("rewarded").notNull().default(false),
  rewardCents: bigint("reward_cents", { mode: "number" }).notNull().default(0),
  pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull().defaultNow(),
  rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
}, (t) => [uniqueIndex("crm_arm_pulls_uq").on(t.experimentId, t.subjectId), index("crm_arm_pulls_arm_idx").on(t.experimentId, t.armId)]);

export const crmScores = pgTable("crm_scores", {
  subjectKind: text("subject_kind").notNull(),   // contact | partner | prospect
  subjectId: text("subject_id").notNull(),
  model: text("model").notNull(),                // clv_12m | churn_90d | next_offer | partner_quality | prospect_fit
  value: real("value").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  modelVersion: text("model_version").notNull(),
  scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.subjectKind, t.subjectId, t.model] }), index("crm_scores_model_value_idx").on(t.model, t.value)]);

export const crmModelRuns = pgTable("crm_model_runs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  model: text("model").notNull(),
  version: text("version").notNull(),
  trigger: text("trigger").notNull(),            // orders_threshold | manual | first_run
  nRows: integer("n_rows").notNull(),
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}), // holdout AUC/MAE, calibration
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
});
