CREATE TABLE `actions` (
	`action_key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`recipient_id` text,
	`status` text DEFAULT 'reserved' NOT NULL,
	`result_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_actions_kind_time` ON `actions` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `dm_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`blocked` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbox` (
	`message_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_inbox_channel_status` ON `inbox` (`channel_id`,`status`);