-- Compliance frameworks selectable as activity compliance tags per tenant.
-- Free-form (admin-edited) list; unlike sensitivity regimes there is no fixed
-- enum. Defaults to the built-in set (back-compat with the hardcoded frontend
-- list); the ADD COLUMN DEFAULT backfills existing rows to the full set so the
-- activity Compliance picker keeps offering every framework until an admin
-- narrows it. An explicit empty [] means the tenant has cleared every framework.
ALTER TABLE "organizations" ADD COLUMN "activeComplianceFrameworks" TEXT[] NOT NULL DEFAULT ARRAY['SOX','HIPAA','GDPR','PCI-DSS','CCPA','FERPA','FISMA','NERC CIP','ISO 27001','SOC 2','NIST','GLBA','FERC','EPA','OSHA','ADA','Other']::TEXT[];
