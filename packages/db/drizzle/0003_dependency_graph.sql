CREATE TABLE `imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`specifier` text NOT NULL,
	`kind` text NOT NULL,
	`line` integer NOT NULL,
	`names_json` text,
	`evidence_id` integer,
	`resolution` text,
	`resolution_detail` text,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `imports_file_idx` ON `imports` (`file_id`);--> statement-breakpoint
ALTER TABLE `dependencies` ADD `scope` text DEFAULT 'runtime' NOT NULL;--> statement-breakpoint
ALTER TABLE `dependencies` ADD `current` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `dependencies` ADD `internal` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `graph_indexed_sha` text;