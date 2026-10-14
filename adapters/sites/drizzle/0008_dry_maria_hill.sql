CREATE TABLE `cloud_line_messages` (
	`event_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`body_sealed` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
