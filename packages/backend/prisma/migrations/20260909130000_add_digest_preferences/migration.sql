-- Per-user weekly-digest preferences. Governs which gap-signal categories a
-- user cares about and whether the digest is also delivered to them by email
-- (opt-in). email/name are snapshotted from the user's token at write time so
-- the digest sender needn't join back to the directory. Unique per (org, user).
CREATE TABLE "digest_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "frequency" TEXT NOT NULL DEFAULT 'weekly',
    "categories" JSONB NOT NULL DEFAULT '[]',
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "digest_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "digest_preferences_orgId_userId_key" ON "digest_preferences"("orgId", "userId");
CREATE INDEX "digest_preferences_orgId_idx" ON "digest_preferences"("orgId");
