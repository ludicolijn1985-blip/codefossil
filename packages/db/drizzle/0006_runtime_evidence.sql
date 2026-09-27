-- Manifests now also yield declared runtime support (engines.node, requires-python, …).
-- Forget the indexed graph snapshot so the next `fossil index` rebuilds it and records it.
UPDATE `repositories` SET `graph_indexed_sha` = NULL;
