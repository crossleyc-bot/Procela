# Customer onboarding runbook — standing up a real tenant

This is the day-zero guide for onboarding a **real** organization (real users,
their own IdP, no demo data) onto a Procela deployment. It picks up where the
infrastructure guides leave off:

- **Infrastructure** (VPC, RDS, ECS, ALB, CloudFront, Secrets Manager, the
  production hardening toggles): `docs/STATUS.md` (§ Production hardening) + `deploy/terraform/`.
- **Deploy mechanics** (build/push image, cut over): `docs/DEPLOY_RUNBOOK.md`.

Everything below is the **tenant** layer: schema, the first Super Admin, the
customer's SSO, their users, and their first data connection.

---

## 0. Prerequisites (from the infra guides)

- The Terraform stack applied, `app_image` pointing at a pushed backend image.
- Secrets populated in Secrets Manager: `DATABASE_URL`, the RS256 JWT keypair
  (`JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`), `ANTHROPIC_API_KEY`, `MFA_ENCRYPTION_KEY`,
  and (recommended) `REDIS_URL`, SMTP, and the OIDC/SAML secret for the
  customer's IdP.
- `AUTH_PROVIDER` set to `oidc` (or `saml` / `local`) — **never `dev`**; the
  backend refuses to serve production traffic on the dev provider.

## 1. Apply the database schema

Migrations do **not** run on container boot. Apply them once per environment
against RDS using the one-off Fargate task the Terraform module provides:

```bash
# Prints a ready-to-run command with this stack's subnets + security group:
terraform output -raw migrate_run_task_command | bash
```

It runs `prisma migrate deploy` in the private subnets (reaching RDS the same
way the app does — no bastion needed) and exits. Re-run it on every deploy that
adds a migration. (Locally, `npx prisma migrate deploy` from the repo root uses
the root `.env`.)

A freshly-migrated database has **zero organizations and zero users** — which
is exactly why the next step exists.

## 2. Create the first Super Admin (bootstrap)

Set these on the backend (env / task definition) and restart the service:

```env
BOOTSTRAP_SUPER_ADMIN_EMAIL=admin@customer.com   # a real address at the customer
BOOTSTRAP_SUPER_ADMIN_NAME=Jane Admin
BOOTSTRAP_ORG_NAME=Customer Inc
BOOTSTRAP_ORG_INDUSTRY=utilities                 # optional; seeds the org's industry
```

On boot the backend **idempotently** ensures the primary organization exists
and that this email is a `SUPER_ADMIN` in it. It's safe to leave configured
across restarts (it only creates what's missing, and re-promotes the admin if
their role was ever changed). When `admin@customer.com` first logs in through
SSO, they resolve as `SUPER_ADMIN`.

> This replaces the old manual `INSERT` of a Super Admin row — there is no
> longer any need to touch Postgres by hand to onboard the first user.

## 3. Point the customer at their identity provider

Two ways to register the customer's OIDC IdP (Azure AD / Entra, Okta, …):

- **Env bootstrap (single provider):** `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`.
- **Admin API (multiple providers / per-tenant):** `POST /api/v1/auth/oidc-providers`
  as a Super Admin — persists the provider with the client secret encrypted at
  rest, and supports `allowedEmailDomains` for per-tenant login scoping.

**Register this redirect URI at the IdP:** `{APP_URL}/api/v1/auth/callback`

SAML is analogous — the SP metadata for the IdP is served at
`GET /api/v1/auth/saml/metadata`.

## 4. Route the customer's users into the right tenant + role

By default a new federated user lands in the **primary org** as `VIEWER`. For a
single-customer deployment that's already correct (the primary org *is* the
customer). Tune it with:

```env
SSO_DEFAULT_ROLE=CONTRIBUTOR         # role when the IdP emits no known role claim
# Multi-tenant: route email domains to specific orgs (and optionally a role):
SSO_DOMAIN_ORG_MAP={"customer.com":"<orgId>","partner.io":{"orgId":"<orgId>","role":"CONTRIBUTOR"}}
```

A real IdP role claim still wins: if the IdP maps a group to `EDITOR` /
`ORG_ADMIN` (via the `roles`/`groups` claim), that role is used regardless of
the default. Provision users either by **first OIDC login** (JIT) or by pushing
lifecycle events over **SCIM 2.0** (`/scim/v2`, `SCIM_BEARER_TOKEN`) — both now
honour the same mapping.

## 5. Assign roles

Roles (`lib/permissions.ts`): `SUPER_ADMIN`, `ORG_ADMIN`, `EDITOR`,
`CONTRIBUTOR`, `VIEWER`. (`EDITOR` is the merged Process-Owner / Data-Steward
write role; finer data-domain stewardship is the separate **DAMA role** layer.)
The Super Admin assigns roles in the People UI (or `PUT /api/v1/people/:id`,
CSV import, or per-org `orgRoles` overrides).

## 6. Generate the process hierarchy (AI)

With `ANTHROPIC_API_KEY` set, an admin picks the org's industry and generates a
starter Value-Stream → Process → Activity hierarchy (server-side Claude call,
model from `ANTHROPIC_MODEL`, default `claude-sonnet-5`). Preview → accept /
modify / start from scratch. `GET /api/v1/health/config` reports `aiConfigured`.

## 7. Import the customer's real data

People, Systems, and Data Assets each have a CSV import in the UI. Import the
customer's real records — no demo seed is applied to a real org (the demo
fixtures are Super-Admin-gated and opt-in).

## 8. Connect a live data source

Two paths (see `docs/` + `packages/connector/README.md`):

- **Direct-connect** — for a cloud-reachable DB (RDS, Cloud SQL): create a
  Connection profile + a sync (Postgres / MySQL / SQL Server / Oracle), then run.
- **On-prem connector (agent-push)** — for a firewalled DB: the admin calls
  `POST /api/v1/connectors/pair/start` to mint a pairing code, the customer runs
  the connector container with that code (`pairingCode:` in `connector.yaml`),
  it exchanges the code for a token and then pulls its assigned syncs and pushes
  rows out over outbound HTTPS. No inbound access to the customer network.

---

## Verification checklist

- [ ] `terraform output migrate_run_task_command` ran; `prisma migrate deploy`
      reported success against RDS.
- [ ] ALB target group is **healthy** (health check hits `/api/v1/health`).
- [ ] The bootstrap Super Admin can log in **via the customer's IdP** and sees
      `SUPER_ADMIN`.
- [ ] A second test user from the customer's domain lands in the **customer's
      org** at the expected role (not phantom-org VIEWER).
- [ ] Industry hierarchy generates (AI configured).
- [ ] A first data sync runs (direct-connect or via a paired connector).
- [ ] `AUTH_PROVIDER` is not `dev`; RS256 JWT keys set; `REDIS_URL` set (so
      rate-limiting is shared across tasks).

## Known non-goals (as of this release)

No billing subsystem; placeholder legal copy; external pen-test and DR rehearsal
are operator responsibilities. See `docs/STATUS.md` (§ Production hardening,
§ Deferred / out-of-scope, and § GA tightening audit) for the full posture.
