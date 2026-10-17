-- Read-cost index only; no data or schema contract changes, so no meta version bump or readiness check.
-- Retry-record cleanup (cleanup.ts) deletes one owner's expired d1_mutations rows. With only the
-- (owner_id,request_key) key and the created_at index, it read every record of that owner or every
-- expired record of all owners; this index reads just the expired rows of that owner.
CREATE INDEX d1_mutations_owner_age ON d1_mutations(owner_id,created_at);
