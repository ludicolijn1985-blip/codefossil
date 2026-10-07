CREATE TABLE `parsed_blobs` (
	`repository_id` integer NOT NULL,
	`oid` text NOT NULL,
	`grammar` text NOT NULL,
	`version` text NOT NULL,
	`result_json` text NOT NULL,
	PRIMARY KEY(`repository_id`, `oid`, `grammar`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
