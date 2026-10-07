-- Indexing now removes commits that are no longer reachable from HEAD. An index built earlier may
-- still hold some (from a deleted branch, a reset or a rebase) while its graph snapshot matches
-- HEAD, so nothing would trigger a run. Forget the snapshot so the next question re-indexes once.
UPDATE `repositories` SET `graph_indexed_sha` = NULL;
