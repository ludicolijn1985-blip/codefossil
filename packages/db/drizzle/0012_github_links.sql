CREATE TABLE `foreign_lookups` (
	`repository_id` integer NOT NULL,
	`reference` text NOT NULL,
	`found` integer NOT NULL,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`repository_id`, `reference`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `issues_external_idx`;--> statement-breakpoint
ALTER TABLE `issues` ADD `source_repo` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `issues_external_repo_idx` ON `issues` (`repository_id`,`provider`,`source_repo`,`external_id`);--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `closing_refs_json` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `closing_refs_synced_at` text;