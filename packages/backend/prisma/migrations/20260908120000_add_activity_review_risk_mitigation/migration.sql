-- Two activity-level governance attributes:
--   nextReviewDate — forward-looking scheduled review date (ISO "YYYY-MM-DD"),
--     distinct from reviewedAt (the last review's timestamp). Stored as text.
--   riskMitigation — free-text notes on how the activity's riskLevel is
--     mitigated (controls / compensations that bring the risk down).
ALTER TABLE "process_nodes"
  ADD COLUMN "nextReviewDate" TEXT,
  ADD COLUMN "riskMitigation" TEXT;
