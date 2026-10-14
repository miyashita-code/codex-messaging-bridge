CREATE TABLE `dm_contacts` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`owner_site_id` text NOT NULL,
	`source_channel_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
