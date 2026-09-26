PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_file_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`commit_id` integer NOT NULL,
	`file_id` integer NOT NULL,
	`status` text NOT NULL,
	`previous_path` text,
	`additions` integer,
	`deletions` integer,
	`patch_hash` text,
	FOREIGN KEY (`commit_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_file_changes`("id", "commit_id", "file_id", "status", "previous_path", "additions", "deletions", "patch_hash") SELECT "id", "commit_id", "file_id", "status", "previous_path", "additions", "deletions", "patch_hash" FROM `file_changes`;--> statement-breakpoint
DROP TABLE `file_changes`;--> statement-breakpoint
ALTER TABLE `__new_file_changes` RENAME TO `file_changes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `file_changes_file_commit_idx` ON `file_changes` (`file_id`,`commit_id`);--> statement-breakpoint
CREATE INDEX `file_changes_commit_idx` ON `file_changes` (`commit_id`);