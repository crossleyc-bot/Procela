-- Reporting polish: run history + scheduled delivery on saved reports.
--   lastRunAt — denormalised timestamp of the most recent run (cheap sorting).
--   runLog    — capped JSON array of recent runs ({ranAt,rowCount,byUserId,kind}).
--   schedule  — optional { frequency: 'off'|'weekly', recipients: [] } for
--               scheduled email delivery of the report.
ALTER TABLE "reports"
  ADD COLUMN "lastRunAt" TIMESTAMP(3),
  ADD COLUMN "runLog" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "schedule" JSONB;
