import { sql } from "drizzle-orm";
import { check, pgTable, text } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";

export const MIDEN_EVENT_SOURCES = ["callback", "webhook"] as const;

/**
 * Every Miden event we acted on (migration 014), from the authorization callback or the webhook route. Inserted first
 * in the deciding transaction, so a replayed eventId returns the stored decision instead of moving money twice.
 */
export const midenEvent = pgTable(
  "miden_event",
  {
    eventId: text("event_id").primaryKey(),
    source: text("source", { enum: MIDEN_EVENT_SOURCES }).notNull(),
    requestType: text("request_type"),
    cardId: text("card_id"),
    spendId: text("spend_id"),
    /** The JSON answer we gave (callback), or what we did (webhook). */
    decision: text("decision").notNull(),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [check("miden_event_source_check", sql`${t.source} IN ('callback', 'webhook')`)],
);
