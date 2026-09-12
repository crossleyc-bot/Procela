# Procela pilot go-live worksheet

A single-page, tick-through checklist for standing up **one pilot
customer** on AWS. It is the *fast path* only — the minimum to run a real
customer in production. Everything here is **ops / config, not code**: the
deploy path is fully wired and verified, so no application changes are
required.

**Use this alongside — don't duplicate:**

- Secret generation + placement, per-variable degrade behaviour →
  [`DEPLOY_RUNBOOK.md`](./DEPLOY_RUNBOOK.md)
- Full readiness checklist (all 27 items, not just the fast path) →
  [`STATUS.md` § Go-live checklist](./STATUS.md#go-live-checklist)
- Restore / rollback / secret rotation → [`DR_RUNBOOK.md`](./DR_RUNBOOK.md)
- Terraform specifics → [`../deploy/terraform/README.md`](../deploy/terraform/README.md)

The fast-path subset is STATUS.md go-live checklist items **1, 2, 4, 6, 7, 9, 10,
12, 13, 15, 22, 23**. Items 4 (array retirement), 22 (dependency audit /
SAST), 23 (DR runbook), and the whole code surface are already **done** —
this worksheet is the remaining operator actions.

---

## Prerequisites (before you touch Terraform)

- [ ] **AWS account + credentials** with permission to create VPC, RDS,
  ECS, ALB, CloudFront, Secrets Manager, IAM.
- [ ] **Backend image pushed to ECR.** Build `packages/backend/` and push;
  note the fully-qualified `…dkr.ecr.<region>.amazonaws.com/…:<tag>` ref
  for `app_image`.
- [ ] **ACM certificates issued** (DNS-validated):
  - one in **`var.region`** covering the API hostname → `alb_certificate_arn`
  - one in **`us-east-1`** covering the app hostname → `cloudfront_certificate_arn`
- [ ] **Identity provider provisioned.** Terraform does **not** create the
  Cognito user pool (or Entra/Okta app). Create it now and record its
  OIDC issuer + client id + client secret. For Cognito the issuer is
  `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>` and
  `auth_provider` stays `oidc` (Cognito federates via OIDC).
- [ ] **`ANTHROPIC_API_KEY`** in hand from the Anthropic Console (`sk-ant-…`).

---

## Step 1 — provision the stack

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# Fill in at least: region, app_image, alb_certificate_arn,
# cloudfront_certificate_arn, domain_name, db_* , app_url, cors_allowed_origins
terraform init && terraform apply
```

- [ ] `terraform apply` succeeds — RDS, ECS, ALB, CloudFront, and every
  Secrets Manager container are created.
- [ ] Migrations applied. CI runs `prisma migrate deploy` per-run; for a
  fresh environment confirm the schema is present (or run it once against
  the new `DATABASE_URL`). *(Checklist #2)*

Terraform generates and injects these automatically — **no action
needed**: `db_password`, `database_url`, `jwt_secret`,
`mfa_encryption_key`, `scim_bearer_token`.

---

## Step 2 — populate the out-of-band secrets

These are created as empty `REPLACE_ME` placeholders by design (no secret
material in Terraform state). `〈prefix〉` is your `name_prefix`, e.g.
`procela-prod` (`terraform output -json secret_arns` lists the ARNs).
Generate each secret per DEPLOY_RUNBOOK §2 and place it with
`put-secret-value` per DEPLOY_RUNBOOK §3 — the exact commands live there,
don't re-derive them here.

- [ ] **`ANTHROPIC_API_KEY`** *(checklist #6)* → `〈prefix〉/app/anthropic_api_key`
- [ ] **RS256 JWT keypair** *(checklist #7 — else the app drops to HS256
  with a boot warning)* → `〈prefix〉/app/jwt_private_key` + `〈prefix〉/app/jwt_public_key`

---

## Step 3 — wire the identity provider *(checklist #10)*

- [ ] Populate `oidc_client_secret`:
  ```bash
  aws secretsmanager put-secret-value \
    --secret-id '〈prefix〉/app/oidc_client_secret' --secret-string '…'
  ```
- [ ] In `terraform.tfvars` set `auth_provider = "oidc"`, `oidc_issuer`,
  `oidc_client_id`, `enable_oidc = true` → `terraform apply`.
- [ ] If provisioning IdP users via SCIM: read the generated token
  (`aws secretsmanager get-secret-value --secret-id '〈prefix〉/app/scim_bearer_token'`),
  paste into the IdP's SCIM config, set `enable_scim = true`, re-apply.

> Using SAML instead of OIDC? Set `auth_provider = "saml"`, populate
> `saml_idp_cert`, set `saml_entry_point` / `saml_issuer` /
> `saml_callback_url`, `enable_saml = true`. The IdP consumes Procela's SP
> metadata at `GET /api/v1/auth/saml/metadata`.

---

## Step 4 — HA + delivery essentials

- [ ] **Redis** *(checklist #8 — without it the rate limiter is per-instance,
  so brute-force protection breaks across replicas)*: populate `redis_url`,
  set `enable_redis = true`, re-apply.
- [ ] **SMTP** *(checklist #9 — without it password-reset / support email
  falls back to audit-log only)*: populate `smtp_pass`, set the
  `smtp_host` / `smtp_port` / `smtp_user` / `smtp_secure` / `mail_from`
  tfvars + `enable_smtp = true`, re-apply. Set `support_email` too.
- [ ] **HTTPS** *(checklist #12)*: already terminated at the ALB via
  `alb_certificate_arn` — confirm the listener is healthy.
- [ ] **DNS**: point the app hostname at the CloudFront distribution and the
  API hostname at the ALB (created outside the Terraform module).

---

## Step 5 — roll and verify

```bash
# Pick up the newly-populated secret values
aws ecs update-service \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service "$(terraform output -raw ecs_service_name)" \
  --force-new-deployment
```

- [ ] **AI wired:** `curl -s "$API/api/v1/health/config"` → `{"aiConfigured": true}`
- [ ] **Liveness:** `curl -s "$API/api/v1/health"` → `{"status":"ok", …}`
- [ ] **Zero readiness warnings** in the boot logs. A clean prod boot logs
  *none* of the PROD-REQUIRED degrade lines (no "signing with HS256", no
  "SMTP not configured", no plaintext-MFA refusal). *(DEPLOY_RUNBOOK §7)*
- [ ] **Smoke test:** sign in through the real IdP; trigger a password
  reset and confirm the email arrives (not just an audit entry); submit a
  "Report a problem" and confirm it reaches `SUPPORT_EMAIL`.

---

## Step 6 — operational baseline

- [ ] **Backups** *(checklist #13)*: RDS automated backups are on;
  `db_backup_retention_days` is set (raise from the reference `7` toward
  14–35 for prod). Confirm point-in-time recovery is enabled.
- [ ] **Uptime monitoring** *(checklist #15)*: schedule a check against
  `/api/v1/health`, alert on non-200.
- [ ] **Rate limits** *(checklist #16)*: set
  `AI_MAX_CALLS_PER_ORG_PER_HOUR` / `_DAY` to match your Anthropic tier.
- [ ] **Seed customer data** *(checklist #17)*: import via the CSV Import
  buttons on the People, Systems, and Data Assets pages.

---

## Still owed before calling it "production" (not blockers for a pilot)

These are tracked in the STATUS.md go-live checklist and are deliberately *not*
on the fast path — flag them to the customer, don't let them silently slip:

- **Pen test** (#22) — SAST (CodeQL) and the dependency audit are done; an
  external pen test is not.
- **DR rehearsal** (#23) — the runbook is written; ops still owes one
  restore rehearsal against staging to record real RTO/RPO.
- **Load-test baseline** (#21) — the harness exists; capture a baseline
  against this Postgres-backed deploy and tighten the budgets.
- **Legal** (#18) — ToS / privacy / DPA text is placeholder.
- **Billing** (#20) — no billing subsystem exists yet.
