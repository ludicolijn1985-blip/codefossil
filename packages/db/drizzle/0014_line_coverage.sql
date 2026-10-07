CREATE TABLE `line_coverage` (
	`file_id` integer PRIMARY KEY NOT NULL,
	`found_json` text NOT NULL,
	`hit_json` text NOT NULL,
	`evidence_id` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE cascade
);
