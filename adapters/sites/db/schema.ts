import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
// Discord records contain IDs only; LINE bodies are encrypted before storage.
export const cloudLineMessages = sqliteTable('cloud_line_messages', {
  eventId: text('event_id').primaryKey(),
  userId: text('user_id').notNull(),
  bodySealed: text('body_sealed').notNull(),
  occurredAt: integer('occurred_at').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const inbox = sqliteTable('inbox', {
  messageId: text('message_id').primaryKey(),
  channelId: text('channel_id').notNull(),
  guildId: text('guild_id').notNull(),
  status: text('status').notNull().default('pending'),
  observedAt: integer('observed_at').notNull(),
}, t => [index('idx_inbox_channel_status').on(t.channelId, t.status)]);
export const actions = sqliteTable('actions', {
  actionKey: text('action_key').primaryKey(),
  kind: text('kind').notNull(),
  sourceId: text('source_id').notNull(),
  recipientId: text('recipient_id'),
  status: text('status').notNull().default('reserved'),
  resultId: text('result_id'),
  createdAt: integer('created_at').notNull(),
}, t => [index('idx_actions_kind_time').on(t.kind,t.createdAt)]);
export const dmPreferences = sqliteTable('dm_preferences', {
  userId: text('user_id').primaryKey(),
  blocked: integer('blocked').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
});
export const eventSubscriptions = sqliteTable('event_subscriptions', {
  id: text('id').primaryKey(),
  principal: text('principal').notNull(),
  name: text('name').notNull(),
  argumentsJson: text('arguments_json').notNull(),
  deliverySealed: text('delivery_sealed').notNull(),
  operationId: text('operation_id').notNull().default(''),
  startedAt: integer('started_at').notNull().default(0),
  expiresAt: integer('expires_at').notNull(),
  verifiedUntil: integer('verified_until').notNull(),
  active: integer('active').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
}, t=>[index('idx_event_subscriptions_active').on(t.active,t.expiresAt)]);
export const eventRecords = sqliteTable('event_records', {
  id:text('id').primaryKey(),
  dataJson:text('data_json').notNull(),
  occurredAt:text('occurred_at').notNull(),
  createdAt:integer('created_at').notNull(),
});
export const eventOutbox = sqliteTable('event_outbox', {
  id:text('id').primaryKey(),
  subscriptionId:text('subscription_id').notNull(),
  eventId:text('event_id').notNull(),
  status:text('status').notNull().default('pending'),
  attempts:integer('attempts').notNull().default(0),
  nextAttemptAt:integer('next_attempt_at').notNull(),
  leaseUntil:integer('lease_until').notNull().default(0),
  leaseToken:text('lease_token').notNull().default(''),
  updatedAt:integer('updated_at').notNull(),
},t=>[index('idx_event_outbox_due').on(t.status,t.nextAttemptAt,t.leaseUntil)]);
export const ingressReceipts=sqliteTable('ingress_receipts',{
  id:text('id').primaryKey(),bodyHash:text('body_hash').notNull(),expiresAt:integer('expires_at').notNull(),
});
export const bridgeRuntime=sqliteTable('bridge_runtime',{
  key:text('key').primaryKey(),value:text('value').notNull(),updatedAt:integer('updated_at').notNull(),
});
export const dmContacts=sqliteTable('dm_contacts',{
  channelId:text('channel_id').primaryKey(),
  userId:text('user_id').notNull(),
  guildId:text('guild_id').notNull(),
  ownerSiteId:text('owner_site_id').notNull(),
  sourceChannelId:text('source_channel_id').notNull(),
  sourceMessageId:text('source_message_id').notNull(),
  deliveryStatus:text('delivery_status').notNull().default('sent'),
  authorizedAt:integer('authorized_at').notNull().default(0),
  updatedAt:integer('updated_at').notNull(),
});
