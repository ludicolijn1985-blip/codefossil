-- Symbol versions are now diffed against the same file in the commit's first parent. Before, they
-- were diffed against the version indexed last, which on repositories with parallel release lines
-- alternated between branches and recorded changes nobody made. Forget the symbol history so the
-- next `codefossil index` rebuilds it from the commits already indexed.
DELETE FROM `relations` WHERE `source_type` = 'symbol' OR `target_type` = 'symbol';--> statement-breakpoint
DELETE FROM `symbol_versions`;--> statement-breakpoint
DELETE FROM `symbols`;--> statement-breakpoint
DELETE FROM `evidence` WHERE `type` = 'ast_node';--> statement-breakpoint
UPDATE `file_changes` SET `symbols_indexed_at` = NULL;
