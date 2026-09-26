CREATE TABLE `commit_parents` (
	`commit_id` integer NOT NULL,
	`parent_sha` text NOT NULL,
	`ordinal` integer NOT NULL,
	PRIMARY KEY(`commit_id`, `ordinal`),
	FOREIGN KEY (`commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commit_parents_parent_sha_idx` ON `commit_parents` (`parent_sha`);--> statement-breakpoint
CREATE TABLE `commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`sha` text NOT NULL,
	`author_name` text NOT NULL,
	`author_email` text NOT NULL,
	`authored_at` text NOT NULL,
	`committed_at` text NOT NULL,
	`subject` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commits_repository_sha_idx` ON `commits` (`repository_id`,`sha`);--> statement-breakpoint
CREATE TABLE `dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`ecosystem` text NOT NULL,
	`name` text NOT NULL,
	`version` text,
	`manifest_file` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependencies_manifest_name_idx` ON `dependencies` (`repository_id`,`manifest_file`,`ecosystem`,`name`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`type` text NOT NULL,
	`locator` text NOT NULL,
	`excerpt` text,
	`metadata_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_repository_locator_idx` ON `evidence` (`repository_id`,`type`,`locator`);--> statement-breakpoint
CREATE TABLE `file_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`commit_id` integer NOT NULL,
	`file_id` integer NOT NULL,
	`status` text NOT NULL,
	`previous_path` text,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`patch_hash` text,
	FOREIGN KEY (`commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_changes_file_commit_idx` ON `file_changes` (`file_id`,`commit_id`);--> statement-breakpoint
CREATE INDEX `file_changes_commit_idx` ON `file_changes` (`commit_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`path` text NOT NULL,
	`language` text,
	`first_seen_commit_id` integer,
	`last_seen_commit_id` integer,
	`deleted_at` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_seen_commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_seen_commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_repository_path_idx` ON `files` (`repository_id`,`path`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`severity` text,
	`occurred_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_external_idx` ON `incidents` (`repository_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `investigations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`query` text NOT NULL,
	`answer` text NOT NULL,
	`confidence` real NOT NULL,
	`classification` text NOT NULL,
	`evidence_ids_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "investigations_confidence_range" CHECK("investigations"."confidence" >= 0 AND "investigations"."confidence" <= 1),
	CONSTRAINT "investigations_classification_valid" CHECK("investigations"."classification" IN ('FACT', 'DERIVED', 'INFERRED'))
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`state` text NOT NULL,
	`url` text,
	`created_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_external_idx` ON `issues` (`repository_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`state` text NOT NULL,
	`url` text,
	`created_at` text NOT NULL,
	`merged_at` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_external_idx` ON `pull_requests` (`repository_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`relation` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`confidence` real NOT NULL,
	`evidence_type` text NOT NULL,
	`provenance_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "relations_confidence_range" CHECK("relations"."confidence" >= 0 AND "relations"."confidence" <= 1),
	CONSTRAINT "relations_evidence_type_valid" CHECK("relations"."evidence_type" IN ('FACT', 'DERIVED', 'INFERRED')),
	CONSTRAINT "relations_fact_is_certain" CHECK("relations"."evidence_type" <> 'FACT' OR "relations"."confidence" = 1)
);
--> statement-breakpoint
CREATE INDEX `relations_source_idx` ON `relations` (`repository_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `relations_target_idx` ON `relations` (`repository_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `relations_edge_idx` ON `relations` (`repository_id`,`source_type`,`source_id`,`relation`,`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`remote_url` text,
	`default_branch` text,
	`indexed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_path_unique` ON `repositories` (`path`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pull_request_id` integer NOT NULL,
	`author` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`submitted_at` text NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `symbol_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol_id` integer NOT NULL,
	`commit_id` integer NOT NULL,
	`content_hash` text NOT NULL,
	`signature` text,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbol_versions_symbol_commit_idx` ON `symbol_versions` (`symbol_id`,`commit_id`);--> statement-breakpoint
CREATE TABLE `symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`stable_key` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`signature` text,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`current` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbols_file_stable_key_idx` ON `symbols` (`file_id`,`stable_key`);--> statement-breakpoint
CREATE INDEX `symbols_name_idx` ON `symbols` (`name`);--> statement-breakpoint
CREATE TABLE `tests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol_id` integer,
	`file_id` integer NOT NULL,
	`framework` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
