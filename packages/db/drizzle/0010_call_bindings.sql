ALTER TABLE `calls` ADD `local_head` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `calls` ADD `self_receiver` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `bindings_json` text;--> statement-breakpoint
-- Import bindings and call flags are read with the graph: forget the snapshot so every file is read again.
UPDATE `repositories` SET `graph_indexed_sha` = NULL;
