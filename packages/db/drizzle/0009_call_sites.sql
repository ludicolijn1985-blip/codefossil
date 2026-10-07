CREATE TABLE `calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`caller_key` text,
	`callee` text NOT NULL,
	`line` integer NOT NULL,
	`sha` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calls_file_idx` ON `calls` (`file_id`);--> statement-breakpoint
-- Call sites are read with imports: forget the graph snapshot so the next index reads every file.
UPDATE `repositories` SET `graph_indexed_sha` = NULL;
