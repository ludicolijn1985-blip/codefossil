ALTER TABLE `investigations` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `investigations` ADD `target_key` text;--> statement-breakpoint
ALTER TABLE `investigations` ADD `result_json` text;--> statement-breakpoint
ALTER TABLE `investigations` ADD `head_sha` text;--> statement-breakpoint
CREATE INDEX `investigations_repository_idx` ON `investigations` (`repository_id`,`created_at`);