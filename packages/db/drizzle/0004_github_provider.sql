CREATE TABLE `provider_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`provider` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`api_url` text NOT NULL,
	`cursor` text,
	`last_synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connections_repo_idx` ON `provider_connections` (`repository_id`,`provider`);--> statement-breakpoint
CREATE TABLE `pull_request_commits` (
	`pull_request_id` integer NOT NULL,
	`sha` text NOT NULL,
	PRIMARY KEY(`pull_request_id`, `sha`),
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_commits_sha_idx` ON `pull_request_commits` (`sha`);--> statement-breakpoint
ALTER TABLE `issues` ADD `author` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `labels_json` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `author` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `labels_json` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `closed_at` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_commit_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `head_branch` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `details_synced_at` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `state` text;--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_external_idx` ON `reviews` (`pull_request_id`,`external_id`);