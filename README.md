# Procela

A platform that connects business processes to the data and systems that support them. Process owners define how the work runs, data stewards register the assets behind each step, and Procela handles the governance — ownership, RACI, gap detection, audit trail, and federated SSO.

> **State.** The auth, MFA, SCIM, SAML, GDPR, audit, and at-rest encryption stacks are all real. Persistence runs on **PostgreSQL** (via Prisma) when `DATABASE_URL` is set — the cutover is complete — and falls back to JSON files under `.procela-data/` as the zero-config default for local development and demos. See [`SECURITY.md`](./SECURITY.md) for the security model and `CLAUDE.md` for the full architecture intent.

## Architecture overview

Monorepo with three packages:

- **`packages/backend`** — Express + TypeScript REST API. Handles authentication (Dev / Local / OIDC / SAML), authorisation, business logic, audit logging, SCIM provisioning, AI calls.
- **`packages/frontend`** — React + TypeScript + Vite SPA. Consumes the REST API; no direct database access.
- **`packages/connector`** — `@procela/connector`, the optional on-prem edge agent (Node 20). Pairs with the backend, scans customer databases (PostgreSQL, MySQL, SQL Server, Oracle, dbt manifest), and reports discovered tables and columns back as Bronze data assets — audit-only, no data values cross the wire. Containerised and shipped via a GHCR release workflow.

## Tech stack

| Layer       | Technology                                                     |
|-------------|----------------------------------------------------------------|
| Backend     | Node.js, Express, TypeScript                                   |
| Frontend    | React, TypeScript, Vite, Zustand                               |
| Storage     | PostgreSQL via Prisma (`DATABASE_URL`); JSON files as the zero-config local default |
| Cache       | Redis (optional; falls back to in-memory rate limiter)         |
| AI          | Anthropic Claude API (`claude-sonnet-5`)                       |
| Auth        | Argon2id, JWT, OIDC (PKCE), SAML 2.0, SCIM 2.0                 |
| MFA         | TOTP (`otplib`), WebAuthn / FIDO2 (`@simplewebauthn`)          |
| Crypto      | AES-256-GCM (local) + AWS KMS / Azure Key Vault / GCP KMS      |
| Email       | nodemailer (SMTP)                                              |

## Prerequisites

- Node.js 20+
- npm 9+
- Anthropic API key (optional — AI features degrade gracefully without)

## Quick start

```bash
git clone <repo-url> && cd Procela
cp .env.example .env
npm install
npm run dev
```

The frontend opens at `http://localhost:5173` and the API at `http://localhost:3001`. With no `DATABASE_URL` set, the first run drops a `.procela-data/` directory next to the backend — that's where every entity (people, orgs, processes, data assets, audit log) lives on the JSON default. Set `DATABASE_URL` to run against PostgreSQL instead (see [`docs/POSTGRES.md`](./docs/POSTGRES.md)).

### Running against Postgres

The JSON default needs nothing. To run the real Postgres stack instead:

```bash
# 1. Uncomment DATABASE_URL in .env (leave it commented for JSON mode):
#    DATABASE_URL=postgresql://procela:procela@127.0.0.1:5432/procela

# 2. Start Postgres (Docker Desktop / daemon must be running):
docker compose up -d postgres          # confirm: docker compose ps → healthy on 5432

# 3. Generate the Prisma client + apply the schema (one-time, or after schema changes):
npm run db:generate -w packages/backend
npm run db:migrate  -w packages/backend

# 4. Run the app (reads DATABASE_URL from .env):
npm run dev
```

> **Windows / PowerShell:** the Prisma CLI reads `.env` from its own working
> directory, not the repo root — if `db:migrate` reports "Environment
> variable not found: DATABASE_URL", set it for the session first:
> `$env:DATABASE_URL="postgresql://procela:procela@127.0.0.1:5432/procela"`.
> Use `127.0.0.1`, not `localhost`: on Windows `localhost` resolves to IPv6
> (`::1`) first, where Docker's 5432 forward may not answer — the backend
> then fails with "Can't reach database server at localhost:5432" even though
> the container is healthy.

Miss step 1 and the app silently runs in JSON mode; miss steps 2–3 and it
boots with `Cannot read properties of undefined (reading 'findUnique')`.

To enable AI-driven features (industry template generation, data suggestions, the in-app assistant) drop your Anthropic key into `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

To turn the AI features **off** entirely — for an on-prem or FedRAMP deployment that must not call an external model — set `AI_FEATURES_ENABLED=false`. The backend then refuses the AI endpoints and the frontend hides every AI entry point (the assistant, "Suggest" actions, template wizard, AI settings, and the "Perform with agent" trigger); the rest of the platform works unchanged.

### Email in local dev

`docker compose up` bundles a [Mailpit](https://mailpit.axllent.org/) catcher, so transactional email — password resets and **Report a problem** submissions — actually delivers instead of falling back to the audit log. Read captured messages in the web inbox at **http://localhost:8025**; nothing leaves your machine. Running the backend on the host with `npm run dev`? Start just the catcher with `docker compose up mailpit` and uncomment the Mailpit block in `.env`.

To send through a **real relay** (e.g. Resend — uncomment its block in `.env`), verify the wiring with one command: `npm run verify:email` sends a live test message through your configured SMTP relay and reports whether it was accepted.

### Seed demo data

Two sample tenants ship with the repo — **Momentum Industries** (defence /
shipbuilding, the default) and **Tidewater Utilities** (electric + water).
The CLI seeders go through the REST API, so **the app must already be
running** (`npm run dev` in another terminal) — and they work in either
JSON or Postgres mode:

```bash
npm run db:seed          -w packages/backend   # Tidewater Utilities
npm run db:seed:momentum -w packages/backend   # Momentum Industries
```

Both target `http://127.0.0.1:3001/api/v1` by default; pass a different base
as an argument (`node scripts/seed-tidewater.js <baseUrl>`) for other setups.

Alternatively, sign in and use the in-app **Get Started** button (calls
`POST /api/v1/admin/demo-seed`; requires a `SUPER_ADMIN`) — note this path
seeds through the JSON stores, so for a **Postgres** environment prefer the
CLI seeders above. Broader CSV fixtures and their import order live in
[`test-data/utility/`](./test-data/utility/README.md) and
[`test-data/shipbuilder/`](./test-data/shipbuilder/README.md).

## Available scripts

| Script          | Description                                      |
|-----------------|--------------------------------------------------|
| `npm run dev`   | Start backend (3001) and frontend (5173)         |
| `npm run build` | Build both packages for production               |
| `npm test`      | Run tests across all packages                    |
| `npm run lint`  | Lint all packages                                |
| `npm run verify:email` | Send one real test email through your configured SMTP relay (Resend by default) to confirm delivery is wired |

## Authentication providers

Procela ships with four sign-in flows; pick one per deployment via `AUTH_PROVIDER`:

- **`dev`** — Email + optional name, no credential check. Local development only.
- **`local`** — Email + password stored as Argon2id hashes. Includes forgot-password by email, admin-set passwords with forced-change-on-first-login, and a one-click migration that generates temporary passwords for every existing user.
- **`oidc`** — Microsoft Entra ID, Okta, or any OIDC IdP. Multi-IdP per install. Authorization Code + PKCE, JWKS verification, RP-initiated logout.
- **`saml`** — SAML 2.0 SP-initiated SSO for ADFS, Shibboleth, PingFederate. SP metadata XML at `GET /api/v1/auth/saml/metadata`. SP- and IdP-initiated SLO supported.

All four can coexist on the login page (Local + one or more federated buttons). Switch between them at runtime via `Settings → Authentication`.

### MFA

- **TOTP** via Google Authenticator / 1Password / Authy / etc., with 10 single-use backup codes.
- **WebAuthn / FIDO2** for YubiKey, Touch ID, Windows Hello, and discoverable-credential (passwordless) sign-in.

Either factor satisfies the MFA gate; users can register both. Secrets are encrypted at rest via `MFA_ENCRYPTION_KEY` (local AES-256-GCM) or `KMS_PROVIDER=aws-kms|azure-kv|gcp-kms`.

### SCIM 2.0

IdP-driven user lifecycle (create on hire, deactivate on offboard, role updates) under `/scim/v2/`. Bearer-token authenticated via `SCIM_BEARER_TOKEN`. `/Users`, `/Groups`, full filter / PATCH / soft-delete semantics.

## Security at a glance

  - Argon2id password hashing, AES-256-GCM at-rest encryption for TOTP secrets / OIDC client secrets / SMTP passwords (or cloud KMS).
  - Three-layer brute-force defence: IP rate limiter → per-account lockout → CAPTCHA challenge.
  - Refresh-token rotation + IP-subnet binding; revoked sessions surfaced in the Active Sessions UI.
  - Helmet-driven CSP, HSTS, frame-deny; CORS allowlist.
  - Idle-session timeout (default 30 min; configurable).
  - Audit log with SHA-256 hash chain and on-demand verification.
  - GDPR Article 17 cascade (`/people/:id/forget`) with typed-phrase confirmation.

See [`SECURITY.md`](./SECURITY.md) for the full threat model, crypto choices, and reporting channel.

## Project structure

```
Procela/
├── packages/
│   ├── backend/           # Express API
│   │   ├── src/
│   │   │   ├── routes/         # HTTP handlers, one per entity
│   │   │   ├── services/       # auth, MFA, SCIM, SAML, GDPR, crypto, audit
│   │   │   ├── middleware/     # authenticateToken, authorize, rate-limit
│   │   │   └── lib/            # persistence, logger
│   │   └── package.json
│   ├── frontend/          # React SPA
│   │   ├── src/
│   │   │   ├── pages/          # one per top-level route
│   │   │   ├── components/     # shared UI
│   │   │   ├── stores/         # Zustand: auth, org context, role drawer
│   │   │   └── api/            # typed fetch client
│   │   └── package.json
│   └── connector/         # @procela/connector — on-prem edge agent
│       ├── src/               # discovery, per-engine adapters, pair/heartbeat/report
│       ├── Dockerfile
│       └── package.json
├── .procela-data/         # JSON store (created on first run)
├── .env.example           # Environment variable template
├── CLAUDE.md              # Architecture intent + handoff doc
├── SECURITY.md            # Security policy + threat model
└── README.md
```

## Documentation

  - **[`CLAUDE.md`](./CLAUDE.md)** — full architecture intent, deployment plans, AI behaviour guidelines.
  - **[`SECURITY.md`](./SECURITY.md)** — security model, controls, vulnerability reporting.
  - **In-app Help Guide** (`Settings → Help` or `/help`) — feature walkthrough for end users covering processes, data, governance, security, and the keyboard shortcuts.

## License

**Proprietary — © 2026 Datalign Technology, Inc. All rights reserved.**

Procela is closed-source commercial software. It is **not** open source,
and no permission is granted to use, copy, modify, or distribute it except
under a separate written agreement. See [`LICENSE`](./LICENSE).
