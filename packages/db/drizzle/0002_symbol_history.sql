ALTER TABLE `file_changes` ADD `symbols_indexed_at` text;--> statement-breakpoint
ALTER TABLE `symbols` ADD `qualified_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `symbols` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `symbols_qualified_name_idx` ON `symbols` (`qualified_name`);