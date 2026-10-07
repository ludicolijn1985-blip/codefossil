ALTER TABLE `calls` ADD `via` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `written` text;--> statement-breakpoint
-- Calls are now read through stated types and functions passed by name: forget the graph
-- snapshot so the next run re-reads every file at HEAD once.
UPDATE `repositories` SET `graph_indexed_sha` = NULL;
