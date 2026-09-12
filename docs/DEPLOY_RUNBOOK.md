# Procela — Secrets & Deployment Runbook

**Status: DRAFT for ops review.** This runbook is generated from the
repo's actual config surface (`.env.example`, `deploy/terraform/`,
`deploy/helm/`) and should be validated against a real environment
before a production cutover.

This is the **day-0 provisioning** guide: how to generate each secret,
where to put it (AWS Secrets Manager / a Kubernetes Secret), and how to
verify the app came up configured. It covers go-live checklist items
**#6–#12** (secrets + HTTPS bring-up).

Related docs — do not duplicate them here:

- **Rotating** an already-live secret → [`DR_RUNBOOK.md`](./DR_RUNBOOK.md) §3.
- **Restore / DR / migration roll-back** → [`DR_RUNBOOK.md`](./DR_RUNBOOK.md).
- The full readiness checklist → [`STATUS.md` § Go-live checklist](./STATUS.md#go-live-checklist).
- Terraform specifics → [`deploy/terraform/README.md`](../deploy/terraform/README.md).
- Helm specifics → [`deploy/helm/procela/README.md`](../deploy/helm/procela/README.md).

---

## Deployment models — how many environments do you run?

**Procela is multi-tenant.** Every table carries an `org_id` and that scope
is enforced on every query, so a **single deployment hosts many customers at
once**, each fully isolated. You do **not** stand up a separate environment
per client by default — a client is an *organization* inside a shared
deployment, and within a client you can still model their own company →
division → department tree. Pick the model per customer:

| Model | Who hosts the app | Where the customer's source data lives | When to use |
|---|---|---|---|
| **1. Cloud SaaS (shared)** | You, once (the AWS stack) | In cloud-reachable sources Procela connects to directly | The default. Onboard the customer as an org; nothing to install on their side. |
| **2. Cloud SaaS + on-prem connector** | You, once | Stays behind the customer's firewall | Most common for enterprises. The customer runs one lightweight edge-agent container that ships **only catalog metadata** (table names, row counts, freshness) out over HTTPS — connection strings and row data never leave their network. |
| **3. Fully on-premise / self-hosted** | The customer, their own instance | Entirely within their environment | Only when data-residency, air-gap, or security policy requires it. They run the Helm/Kubernetes chart (or Docker Compose) against their own Postgres, Redis, and IdP. |

**The on-prem *connector* is not an on-prem *environment*.** A cloud-hosted
(SaaS) customer can use the connector to reach firewalled databases *without*
hosting the platform themselves — that's model 2, not model 3. Only model 3
means a customer runs the whole app.

Which part of this runbook applies:

- **Models 1 & 2** — you provision the AWS stack once via
  [`../deploy/terraform/README.md`](../deploy/terraform/README.md) and follow
  [`PILOT_GO_LIVE_WORKSHEET.md`](./PILOT_GO_LIVE_WORKSHEET.md); §3 below is
  your secret-placement path. The connector (model 2) is set up per-customer
  from **Settings → Integrations** in-app, not here.
- **Model 3** — the customer follows the on-prem path,
  [`../deploy/helm/procela/README.md`](../deploy/helm/procela/README.md); §4
  below is their secret-placement path.

Everything else in this runbook (the secret catalog, generation, and
verification) is the same regardless of model.

---

## 0. How Procela reads config

- All config is environment variables (12-factor). The authoritative
  catalog with inline notes is [`.env.example`](../.env.example).
- **Nothing here is required for the app to *boot*.** Every unset
  secret has a safe dev fallback and logs a warning; the *feature*
  degrades rather than the process crashing. The table in §1 names the
  degrade for each. "PROD-REQUIRED" means: leaving it unset ships a real
  security or availability hole, not a crash.
- Two secrets can be stored **envelope-encrypted** rather than in
  cleartext (`OIDC_CLIENT_SECRET`, `SMTP_PASS`) — see §5.
- Frontend `VITE_*` vars are **build-time** (baked into the static
  bundle), not runtime — set them before `vite build`, not in the
  server's environment.

---

## 1. Secret & config catalog

Required column: **P** = PROD-REQUIRED, **C** = conditionally required
(only when the named feature/provider is used), **·** = optional.

| Variable | Req | If unset (the degrade) | AWS: Secrets Manager id | On-prem: Helm value |
|---|:--:|---|---|---|
| `DATABASE_URL` | P | falls back to JSON-file persistence | `〈prefix〉/app/database_url` | `secrets.*` → rendered, or `postgresql.*` |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | P | drops to HS256 with `JWT_SECRET` (+ boot warning) | `〈prefix〉/app/jwt_private_key` · `…/jwt_public_key` | `secrets.jwtPrivateKey` · `secrets.jwtPublicKey` |
| `JWT_SECRET` | P | uses the insecure default → **forgeable sessions** | `〈prefix〉/app/jwt_secret` | `secrets.jwtSecret` |
| `ANTHROPIC_API_KEY` | P | AI features (templates, suggestions, assistant) disabled | `〈prefix〉/app/anthropic_api_key` | `secrets.anthropicApiKey` |
| `MFA_ENCRYPTION_KEY` **or** `KMS_PROVIDER` | P | TOTP secrets stored **plaintext** (prod refuses to start) | `〈prefix〉/app/mfa_encryption_key` (**Terraform-generated**, always injected) | `secrets.mfaEncryptionKey` |
| `REDIS_URL` | P | rate limiter becomes per-instance → brute-force protection broken across replicas | `〈prefix〉/app/redis_url` (placeholder; `enable_redis`) | `redis.*` / `configMap` |
| `APP_URL` | P | password-reset / support email links point nowhere | plain env | `config.*` ConfigMap |
| `CORS_ALLOWED_ORIGINS` | P | dev fallback echoes the request origin (unsafe) | plain env | ConfigMap |
| `SMTP_HOST/PORT/USER/PASS/SECURE`, `MAIL_FROM` | P | password reset + support fall back to audit-log only | `SMTP_PASS` → `〈prefix〉/app/smtp_pass`; rest = `enable_smtp` tfvars | `secrets.smtpPass` + ConfigMap |
| `SUPPORT_EMAIL` | · | defaults to `support@procela.ai`; override to route "Report a problem" elsewhere. Still needs SMTP to email — without it, reports are audit-logged only | plain env | ConfigMap |
| `AUTH_PROVIDER` + provider block | C | unrecognized/`dev` ⇒ dev provider (any email logs in) — **prod refuses to boot** | `auth_provider` tfvar (validated `oidc`\|`saml`\|`local`, default `oidc`) | ConfigMap |
| `OIDC_*` (Cognito federates via OIDC) | C | required when `AUTH_PROVIDER=oidc` | `oidc_issuer`/`oidc_client_id` tfvars (`enable_oidc`); `OIDC_CLIENT_SECRET` → secret | ConfigMap / `secrets.*` |
| `SAML_ENTRY_POINT/ISSUER/IDP_CERT/CALLBACK_URL` | C | required when `AUTH_PROVIDER=saml` | `SAML_IDP_CERT` → secret; rest plain | `secrets.samlIdpCert` + ConfigMap |
| `SCIM_BEARER_TOKEN` | C | SCIM endpoints return 401 (no IdP user provisioning) | secret | `secrets.*` (add) |
| `HCAPTCHA_SITE_KEY` / `HCAPTCHA_SECRET` | · | login CAPTCHA accepts any token (no bot protection) | `HCAPTCHA_SECRET` → secret | ConfigMap / `secrets.*` |
| `S3_BUCKET` / `S3_REGION` (`STORAGE_PROVIDER=s3`) | C | uses local disk (lost on container replace) | plain env | ConfigMap |

> **AWS secret wiring (parity with Helm):** `deploy/terraform/` now
> provisions and injects the full secret set. `MFA_ENCRYPTION_KEY` and
> `SCIM_BEARER_TOKEN` are **Terraform-generated** (secure by default); the
> MFA key is injected unconditionally. `REDIS_URL`, `SMTP_PASS`,
> `OIDC_CLIENT_SECRET`, and `SAML_IDP_CERT` are REPLACE_ME placeholders
> injected only when their toggle is on — `enable_redis` / `enable_smtp` /
> `enable_oidc` / `enable_saml` / `enable_scim` — so an un-populated
> placeholder is never handed to the app. Non-secret SMTP + `APP_URL` /
> `CORS_ALLOWED_ORIGINS` / `SUPPORT_EMAIL` are tfvars. `AUTH_PROVIDER` is the
> validated `auth_provider` tfvar (`oidc` | `saml` | `local`, default `oidc`);
> the non-secret IdP config is now tfvars too — `oidc_issuer` / `oidc_client_id`
> (`enable_oidc`) and `saml_entry_point` / `saml_issuer` / `saml_callback_url`
> (`enable_saml`). **Still operator-set:** provisioning the IdP itself — e.g.
> Cognito federates via OIDC (`auth_provider = "oidc"`, issuer
> `https://cognito-idp.<region>.amazonaws.com/<pool-id>`), but the stack does
> not create the Cognito user pool.

---

## 2. Generate the secrets

Run these once per environment; treat the output as sensitive.

```bash
# JWT_SECRET — HMAC fallback (64 chars, no specials)
openssl rand -base64 48 | tr -d '/+=' | cut -c1-64

# MFA_ENCRYPTION_KEY — 32+ char master key for at-rest TOTP encryption
openssl rand -base64 48 | tr -d '/+=' | cut -c1-44

# SCIM_BEARER_TOKEN — long random string shared with the IdP
openssl rand -hex 32

# JWT RS256 keypair (PREFERRED over HS256) — PEM private + public
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt-private.pem
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

Not generated locally:

- **`ANTHROPIC_API_KEY`** — from the Anthropic Console (`sk-ant-…`).
- **SMTP creds** — from your mail provider (Resend, SES SMTP, SendGrid,
  Postmark, etc.). Any authenticated SMTP relay works — the backend uses a
  standard nodemailer transporter, no provider-specific code. For **Resend**:
  `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`,
  `SMTP_USER=resend`, `SMTP_PASS=<Resend API key>`, and a `MAIL_FROM` on a
  domain verified in Resend (its SPF/DKIM go on a `send.` subdomain, so a
  root MX/SPF pointed at your inbox provider — e.g. Google Workspace — is
  unaffected).
- **IdP config** (`COGNITO_*` / `OIDC_*` / `SAML_*`) — from Entra ID /
  Okta / Cognito. SAML: the IdP consumes Procela's SP metadata at
  `GET /api/v1/auth/saml/metadata`.
- **`hCaptcha`** — site key + secret from the hCaptcha dashboard.

---

## 3. Deploy on AWS (ECS Fargate + Terraform)

Terraform (`deploy/terraform/`) creates the Secrets Manager entries;
the sensitive values are set **out-of-band** so no material lands in
Terraform state.

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in region, db_name, etc.
terraform init && terraform apply               # creates RDS, ECS, ALB, and the secret containers

# The secret ids follow `〈prefix〉/app/…` where 〈prefix〉 is your
# local.name_prefix (e.g. `procela-prod`). put-secret-value also accepts
# an ARN — `terraform output -json secret_arns` lists them.

# Populate the placeholder secrets (created empty by design):
aws secretsmanager put-secret-value --secret-id '〈prefix〉/app/anthropic_api_key' \
  --secret-string 'sk-ant-…'
aws secretsmanager put-secret-value --secret-id '〈prefix〉/app/jwt_private_key' \
  --secret-string "$(cat jwt-private.pem)"
aws secretsmanager put-secret-value --secret-id '〈prefix〉/app/jwt_public_key' \
  --secret-string "$(cat jwt-public.pem)"
# db_password, database_url, and jwt_secret are generated by Terraform —
# no action needed unless you rotate them (see DR_RUNBOOK §3).

# mfa_encryption_key and scim_bearer_token are generated by Terraform —
# read scim out to configure your IdP; no action needed for MFA.

# To turn on Redis / SMTP / OIDC / SAML / SCIM: populate the placeholder
# secret, then set the matching toggle in terraform.tfvars and re-apply.
#   aws secretsmanager put-secret-value \
#     --secret-id "$(terraform output -json secret_arns | jq -r .smtp_pass)" \
#     --secret-string '…'
#   # then: enable_smtp = true  (+ smtp_host/user/... in tfvars) → terraform apply

# Roll the service so tasks pick up new secret values (names from outputs):
aws ecs update-service \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service "$(terraform output -raw ecs_service_name)" \
  --force-new-deployment
```

`ignore_changes = [secret_string]` on the JWT/API-key entries means a
later `put-secret-value` (or a rotation) is **not** reverted by the next
`terraform apply`.

HTTPS terminates at the ALB — attach an ACM cert (checklist #12).

### 3a. Automated deploys (GitHub Actions → ECS)

The manual `docker build/push` + `update-service` above can be handed to CI.
`.github/workflows/deploy.yml` builds and pushes the backend image to ECR, runs
migrations as a one-off task, rolls the ECS service onto the new image, then
syncs the frontend to S3 and invalidates CloudFront — authenticating with a
short-lived **GitHub OIDC** role (no static AWS keys).

One-time setup:

1. Apply Terraform with `enable_cicd_deploy_role = true` and
   `github_repo = "owner/repo"`. The module creates the ECR repo (`ecr.tf`),
   the GitHub OIDC provider (unless you pass an existing
   `github_oidc_provider_arn`), and the scoped deploy role (`cicd.tf`).
2. Point `app_image` at the ECR repo (`terraform output ecr_repository_url`) —
   for the very first apply, any tag works; the service can't pull until the
   pipeline pushes the first image, which is expected.
3. Copy the outputs into GitHub **repository variables** (the `deploy.yml`
   header lists the var ← output map and a `gh variable set` one-liner).

Then every merge to the default branch (or a manual **Run workflow**) deploys.
The job self-skips until `AWS_DEPLOY_ROLE_ARN` is set, and a failed migration
aborts the deploy *before* the service is rolled. `ignore_changes =
[task_definition]` on the service means Terraform and the pipeline don't fight
over the running image.

### 3b. Autoscaling the backend (optional)

Set `enable_autoscaling = true` and the module registers the ECS service with
Application Auto Scaling and scales the task count on load — **target tracking**
on ECS CPU (holds ~`autoscaling_cpu_target`%, default 60) and, optionally, on
ALB requests-per-target. It owns `desired_count` from then on (the service's
`ignore_changes = [desired_count]` keeps Terraform from reverting it), floored
at `autoscaling_min_tasks` (default 2, one per AZ).

**Size `autoscaling_max_tasks` against the database, not just cost.** Each task
opens its own Prisma connection pool, so `max_tasks × pool_size` must stay under
RDS `max_connections` — otherwise scaling *out* under load starts throwing
"too many connections" exactly when you needed the extra tasks. Options: a
conservative pool size, a larger RDS instance (higher `max_connections`), or put
**RDS Proxy** in front for high fan-out. (RDS *storage* autoscales already;
compute doesn't. Redis is fixed nodes.)

---

## 4. Deploy on-prem (Helm / Kubernetes)

The chart (`deploy/helm/procela/`) renders a Kubernetes `Secret` from
`values.secrets.*`, **or** consumes one you create yourself
(`secrets.existingSecret`). Prefer `existingSecret` in production so real
values never sit in a values file.

```bash
# Option A — pre-create the Secret (recommended)
kubectl create secret generic procela-secrets \
  --from-literal=DATABASE_URL='postgresql://procela:…@db:5432/procela?schema=public' \
  --from-literal=JWT_SECRET="$(cat jwt_secret.txt)" \
  --from-file=JWT_PRIVATE_KEY=jwt-private.pem \
  --from-file=JWT_PUBLIC_KEY=jwt-public.pem \
  --from-literal=ANTHROPIC_API_KEY='sk-ant-…' \
  --from-literal=MFA_ENCRYPTION_KEY="$(cat mfa_key.txt)" \
  --from-literal=SMTP_PASS='…'

helm upgrade --install procela deploy/helm/procela \
  --set secrets.existingSecret=procela-secrets \
  --set config.appUrl=https://procela.example.com \
  # …non-secret config via --set config.* / ConfigMap…

# Option B — chart-managed Secret (fine for staging): pass secrets.* via
# a --values file kept OUT of git, never inline on the command line.
```

A `prisma migrate deploy` pre-upgrade hook runs migrations; the backend
image bundles the Prisma CLI so the default image is sufficient. HTTPS
terminates at the Ingress / a fronting Nginx (checklist #12).

---

## 5. Envelope-encrypting a secret (optional, defence-in-depth)

`OIDC_CLIENT_SECRET` and `SMTP_PASS` accept either plaintext or an
`enc:v1:…` envelope encrypted with `MFA_ENCRYPTION_KEY`, so the value at
rest in Secrets Manager / the K8s Secret isn't the live credential.

Requires `MFA_ENCRYPTION_KEY` (or a `KMS_PROVIDER`) set and an
admin token; returns 503 if no encryption backend is configured.

```bash
curl -s -X POST "$API/api/v1/auth/encrypt-secret" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"plaintext":"my-smtp-password"}'
# → { "success": true, "data": { "ciphertext": "enc:v1:…" } }
# Paste that enc:v1:… value in as SMTP_PASS / OIDC_CLIENT_SECRET.
```

---

## 6. Per-environment secret checklist

Maps to the STATUS.md go-live **fast path** (#6, 7, 9, 10; plus 8, 11, 12).

| # | Item | dev | staging | prod |
|---|---|:--:|:--:|:--:|
| — | `AUTH_PROVIDER` ≠ `dev` | dev ok | **yes** | **yes** |
| 7 | RS256 JWT keypair (not HS256 default) | — | yes | **yes** |
| — | `JWT_SECRET` non-default | — | yes | **yes** |
| 11 | `MFA_ENCRYPTION_KEY` / KMS set | — | yes | **yes** |
| 8 | `REDIS_URL` (HA rate limiting) | — | yes | **yes** |
| 6 | `ANTHROPIC_API_KEY` | as needed | yes | **yes** |
| 9 | SMTP block complete | — | yes | **yes** |
| 10 | IdP (`COGNITO_*`/`OIDC_*`/`SAML_*`) | — | yes | **yes** |
| — | `APP_URL` + `CORS_ALLOWED_ORIGINS` real | localhost | yes | **yes** |
| 12 | HTTPS / TLS cert (ALB or Ingress) | — | yes | **yes** |
| — | hCaptcha keys (bot protection) | — | optional | recommended |

---

## 7. Verify the environment came up configured

```bash
# AI wired? (no secret is echoed — just a boolean)
curl -s "$API/api/v1/health/config"        # → { "aiConfigured": true }

# Liveness
curl -s "$API/api/v1/health"               # → { "status": "ok", … }
```

Then check the boot logs for readiness warnings — each missing
PROD-REQUIRED secret logs a specific line (e.g. "SMTP not configured —
outbound mail will fall back to the audit log", "signing with HS256 —
set JWT_PRIVATE_KEY for RS256"). A clean prod boot has **none** of them.

Smoke: sign in via the real IdP, trigger a password reset (confirm the
email arrives, not just an audit entry), and submit a "Report a problem"
(confirm it reaches `SUPPORT_EMAIL`).

---

## 8. Hygiene

- **Never commit real values.** `.env` and `deploy/terraform/*.tfvars`
  are git-ignored; keep Helm secret values files out of git too.
- **Least privilege:** the ECS task role reads only `〈prefix〉/*`
  secrets (see `deploy/terraform/iam.tf`); scope any added secret the
  same way.
- **Recovery window:** Secrets Manager entries use a 7-day recovery
  window — a deleted secret is restorable for a week.
- **Rotation is a separate procedure** — when a secret is compromised or
  on a schedule, follow [`DR_RUNBOOK.md`](./DR_RUNBOOK.md) §3
  (put-secret-value → force-new-deployment → verify → confirm the old
  credential is dead). Do not rotate by editing Terraform.
