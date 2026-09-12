# Procela — Disaster Recovery Runbook

Operational procedures for the three scenarios called out in the
[go-live checklist](./STATUS.md#go-live-checklist)
item #23 — **restore from backup**, **roll back a migration**, and
**rotate a compromised secret** — plus a full-rebuild path and a
post-incident verification checklist.

This is a living document. Fill in the `〈…〉` placeholders (account id,
region, resource names, RTO/RPO targets, on-call contacts) for your
environment and keep it next to the Terraform state.

---

## 0. Facts you need before an incident

| Thing | Where it lives | Notes |
|---|---|---|
| Database | Amazon RDS PostgreSQL **16.4** | `deploy/terraform/rds.tf` |
| Automated backups / PITR | RDS automated backups, window `03:00–04:00 UTC`, retention = `var.db_backup_retention_days` | **PITR requires `backup_retention_period > 0`** — set it before you rely on this |
| Secrets | AWS Secrets Manager, prefix `〈name_prefix〉/…` | see table in §3 |
| App runtime | ECS Fargate service `〈name_prefix〉-backend` | `deploy/terraform/ecs.tf` |
| Infra as code | `deploy/terraform/` | `terraform apply` rebuilds everything |
| Health check | `GET /api/v1/health` → `{"status":"ok"}` | also `/api/v1/health/config` → `{"aiConfigured":bool}` |
| Migrations | Prisma, `packages/backend/prisma/migrations/` | applied with `prisma migrate deploy` |
| Audit integrity | SHA-256 hash chain in `audit_logs` | **self-verifying on boot** — see §5 |

**Prerequisites for the operator:** AWS CLI authenticated to the target
account, Terraform ≥ the version in `deploy/terraform/versions.tf`,
Node + `npx prisma` (from `packages/backend/`), and permission to read
`〈name_prefix〉/*` secrets and modify the RDS instance + ECS service.

**Targets (fill in):** RTO 〈e.g. 2 h〉 · RPO 〈e.g. 5 min with PITR〉.

---

## 1. Restore the database from backup

Pick the sub-procedure that matches the failure. In all cases you
**restore into a new RDS instance** and repoint the app — never restore
in place over a running instance.

### 1a. Point-in-time recovery (data corruption / bad bulk write, instance healthy)

Cleanest option — recovers to any second within the retention window.

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier 〈name_prefix〉-postgres \
  --target-db-instance-identifier 〈name_prefix〉-postgres-restore \
  --restore-time 2026-01-01T00:00:00Z \
  --region 〈region〉
```

### 1b. Restore from a snapshot (instance lost)

```bash
aws rds describe-db-snapshots --db-instance-identifier 〈name_prefix〉-postgres \
  --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:5].[DBSnapshotIdentifier,SnapshotCreateTime]' --output table
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier 〈name_prefix〉-postgres-restore \
  --db-snapshot-identifier 〈snapshot-id〉 --region 〈region〉
```

> ⚠️ `deploy/terraform/rds.tf` currently sets `skip_final_snapshot = true`
> and `deletion_protection = false` (reference config). **Flip both for
> prod** (§7) or a deleted instance leaves no final snapshot to restore
> from.

### 1c. Repoint the app at the restored instance

1. Get the restored endpoint:
   `aws rds describe-db-instances --db-instance-identifier 〈name_prefix〉-postgres-restore --query 'DBInstances[0].Endpoint.Address' --output text`
2. Update the connection string secret:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id 〈name_prefix〉/app/database_url \
     --secret-string 'postgresql://〈user〉:〈pass〉@〈new-endpoint〉:5432/procela?schema=public'
   ```
3. Force a new deployment so tasks pick up the secret:
   `aws ecs update-service --cluster 〈name_prefix〉-cluster --service 〈name_prefix〉-backend --force-new-deployment`
4. Confirm schema is current: from `packages/backend/`,
   `DATABASE_URL=… npx prisma migrate status` (should say "up to date").
5. Run the **post-restore verification** in §5.

### 1d. JSON-persistence fallback

If the environment still runs the JSON path (`DATABASE_URL` unset), the
datastore is `.procela-data/*.json`. Restore those files from your file
backup and restart the backend. To move that restored data into
Postgres, run the idempotent importer:

```bash
cd packages/backend
DATABASE_URL=… npm run db:migrate-json -- --dry-run   # preview
DATABASE_URL=… npm run db:migrate-json                # apply (idempotent)
```

---

## 2. Roll back a database migration

Prisma does **not** generate down-migrations, so there is no
`migrate down`. In order of preference:

1. **Restore to just before the migration (preferred).** Use PITR (§1a)
   with `--restore-time` set to a moment before `migrate deploy` ran.
   This is the only option that cleanly reverses a *data* change.
   Always take a manual snapshot **before** any prod `migrate deploy` so
   this window is guaranteed.

2. **Roll forward with a corrective migration.** For a schema mistake
   that hasn't corrupted data, writing a new migration that fixes the
   schema is usually safer than reversing. Add it under
   `prisma/migrations/`, `migrate deploy`, verify.

3. **Manual reverse SQL + mark resolved.** Only when the migration is
   schema-only and trivially reversible and options 1–2 don't fit:
   ```bash
   psql "$DATABASE_URL" -f reverse_〈migration〉.sql       # your hand-written inverse
   npx prisma migrate resolve --rolled-back 〈migration_dir_name〉
   ```
   `migrate resolve --applied 〈name〉` is the companion for marking a
   migration you fixed forward by hand. Get these wrong and Prisma's
   `_prisma_migrations` ledger will disagree with the schema — so
   snapshot first (option 1) as a safety net.

> CI runs `prisma migrate deploy` per environment; migrations are
> forward-only and version-controlled. Treat a bad migration as an
> incident: snapshot, decide roll-back vs roll-forward, then act.

---

## 3. Rotate a compromised secret / API key

All app secrets are AWS Secrets Manager entries injected into the ECS
task (`deploy/terraform/ecs.tf` `secrets = […]`). The general loop is
**put-secret-value → force-new-deployment → verify → confirm the old
credential is dead**. Per-secret specifics below.

| Secret id (`〈name_prefix〉/…`) | Env var | Blast radius of rotation |
|---|---|---|
| `app/anthropic_api_key` | `ANTHROPIC_API_KEY` | AI features briefly unavailable during redeploy |
| `app/jwt_private_key` / `app/jwt_public_key` | `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | **all sessions invalidated** — users re-login |
| `app/jwt_secret` | `JWT_SECRET` | HS256 fallback secret — same as above |
| `app/database_url` | `DATABASE_URL` | brief connection blip on redeploy |
| `db/password` | (feeds `database_url`) | rotate at RDS + in both secrets |

### 3a. Anthropic API key

1. **Revoke** the leaked key in the Anthropic Console and mint a new one.
2. `aws secretsmanager put-secret-value --secret-id 〈name_prefix〉/app/anthropic_api_key --secret-string 'sk-ant-…'`
3. `aws ecs update-service --cluster 〈name_prefix〉-cluster --service 〈name_prefix〉-backend --force-new-deployment`
4. Verify: `curl https://〈host〉/api/v1/health/config` → `{"aiConfigured":true}`, then exercise one AI endpoint.
5. Review usage on the old key for anomalous spend during the exposure window.

### 3b. JWT signing key

1. Generate a fresh RSA keypair:
   `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt_priv.pem && openssl rsa -in jwt_priv.pem -pubout -out jwt_pub.pem`
2. `put-secret-value` both `app/jwt_private_key` and `app/jwt_public_key` (PEM contents). Bump `JWT_KID` if you use key-id rotation.
3. Force redeploy. **Every existing token is now invalid** — all users must re-authenticate; expect a login spike. Communicate the forced-logout.
4. Verify a fresh login issues a working token.

### 3c. Database credential

1. Rotate the RDS master password:
   `aws rds modify-db-instance --db-instance-identifier 〈name_prefix〉-postgres --master-user-password '〈new〉' --apply-immediately`
2. Update **both** `db/password` and `app/database_url` (the URL embeds the password).
3. Force redeploy; confirm `/api/v1/health` is 200 and a write path works.

### 3d. MFA encryption key — handle with care

`MFA_ENCRYPTION_KEY` (or a `KMS_PROVIDER`) is what `crypto.service.ts`
uses to encrypt stored TOTP secrets. **Rotating it makes every existing
encrypted TOTP secret undecryptable** — enrolled users must re-enroll
their authenticator. Only rotate on actual key compromise, and when you
do: schedule a re-enrollment window, notify users, then
`put-secret-value` and redeploy. Users hit "re-enroll MFA" on next login.

> Note: `MFA_ENCRYPTION_KEY` / `KMS_PROVIDER` are **not yet provisioned
> in `deploy/terraform/secrets.tf`** — add them (§7) so this key is
> managed like the others rather than set ad hoc.

### 3e. After any rotation

Query the `audit_logs` for the exposure window to scope what the
compromised credential could have touched, and force-logout active
sessions if the key was auth-related (3b).

---

## 4. Full environment / region rebuild

1. `cd deploy/terraform && terraform init && terraform apply` against the
   target account/region (see `deploy/terraform/README.md`).
2. **Populate placeholder secrets.** `jwt_private_key`, `jwt_public_key`,
   and `anthropic_api_key` are created with `REPLACE_ME…` placeholders and
   `ignore_changes = [secret_string]`, so Terraform won't clobber real
   values — set them with `put-secret-value` (§3).
3. Apply schema: `DATABASE_URL=… npx prisma migrate deploy` from `packages/backend/`.
4. Restore data (§1) or seed (`npm run db:seed`) / import CSVs.
5. Point DNS at the new ALB/CloudFront and run §5.

---

## 5. Post-restore / post-incident verification

Run all of these before declaring recovery complete:

- [ ] **Health:** `curl https://〈host〉/api/v1/health` returns `200 {"status":"ok"}`.
- [ ] **Schema:** `npx prisma migrate status` → "Database schema is up to date".
- [ ] **Audit-chain integrity (built-in).** On boot the backend
      re-seeds the hash-chain tail from Postgres and validates it. If
      rows were lost or altered, `bootstrapHashChain()` detects the
      break and **refuses to auto-bootstrap in production**, logging
      `Audit chain has N un-hashed / broken entries starting at index …`.
      - A **clean boot with no such log** = the audit ledger restored
        intact.
      - If it *does* fire, do **not** blindly set `AUDIT_ALLOW_BOOTSTRAP=1`
        — investigate the gap first (it means the restore lost or
        changed audited rows), then acknowledge the boundary deliberately.
- [ ] **Functional smoke:** log in, perform one write (e.g. create a
      process node), confirm it persists and produces an `audit_logs` row.
- [ ] **AI path:** `/api/v1/health/config` shows `aiConfigured:true` and one AI call succeeds.
- [ ] **Monitoring:** uptime check green, error rate normal, no secret-missing warnings in the boot log.

---

## 6. Quick command reference

```bash
# PITR restore
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier 〈name_prefix〉-postgres \
  --target-db-instance-identifier 〈name_prefix〉-postgres-restore \
  --restore-time 〈RFC3339〉 --region 〈region〉

# Rotate a secret + roll the service
aws secretsmanager put-secret-value --secret-id 〈name_prefix〉/app/〈secret〉 --secret-string '〈value〉'
aws ecs update-service --cluster 〈name_prefix〉-cluster --service 〈name_prefix〉-backend --force-new-deployment

# Migrations (from packages/backend/)
DATABASE_URL=… npx prisma migrate status
DATABASE_URL=… npx prisma migrate deploy
DATABASE_URL=… npx prisma migrate resolve --rolled-back 〈migration〉

# JSON → Postgres import (idempotent)
DATABASE_URL=… npm run db:migrate-json -- --dry-run
```

---

## 7. Prevention — prod-hardening prerequisites

These make the procedures above actually work in a real incident. Track
alongside `STATUS.md` (§ Go-live checklist):

- [ ] `rds.tf`: `backup_retention_period > 0` (PITR), `deletion_protection = true`,
      `skip_final_snapshot = false`, `multi_az = true`, storage on a KMS CMK.
- [ ] Take a **manual snapshot before every prod `migrate deploy`**.
- [ ] Add `MFA_ENCRYPTION_KEY` / `KMS_PROVIDER` to `secrets.tf` and wire
      it into the ECS task `secrets` list.
- [ ] Provision `REDIS_URL`, `SMTP_*` and the RS256 JWT keypair (checklist
      #7, #8, #9) — the app falls back / warns without them.
- [ ] Rehearse this runbook against a staging restore at least once, and
      record the actual RTO/RPO you achieve in §0.
