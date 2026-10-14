CREATE TABLE `bridge_runtime` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_event_outbox_due` ON `event_outbox` (`status`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `event_records` (
	`id` text PRIMARY KEY NOT NULL,
	`data_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`name` text NOT NULL,
	`arguments_json` text NOT NULL,
	`delivery_sealed` text NOT NULL,
	`expires_at` integer NOT NULL,
	`verified_until` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_event_subscriptions_active` ON `event_subscriptions` (`active`,`expires_at`);--> statement-breakpoint
CREATE TABLE `ingress_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`body_hash` text NOT NULL,
	`expires_at` integer NOT NULL
);
