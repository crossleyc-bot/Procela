# Procela — Terraform reference deployment

This module provisions the AWS surface described in `CLAUDE.md`
(section "Infrastructure — AWS Prototype") as a single, reviewable
Terraform stack. It exists so a procurement checklist can be answered
with "here is how it deploys" rather than "here is `docker compose
up`". Out of the box it now deploys a **hardened** stack: the safety and
hardening toggles default **on** (Multi-AZ RDS with deletion protection,
customer-managed KMS keys, a provisioned ElastiCache Redis, VPC endpoints,
per-AZ NAT, WAF, ALB-restricted-to-CloudFront, access logs, and alarms). For a
cheap dev stack, turn the cost-bearing ones off (see the block in
`terraform.tfvars.example`). The account-level security services (CloudTrail /
GuardDuty / Security Hub / Config) remain **opt-in** — they're commonly
org-managed and conflict-prone. See
[Production hardening toggles](#production-hardening-toggles) below.

## What you get

- A dedicated VPC (2 public + 2 private subnets across two AZs, one
  NAT gateway) — `network.tf`.
- RDS Postgres 16 in the private subnets, gp3 storage, 7-day backups,
  master password auto-generated and stored in Secrets Manager —
  `rds.tf`, `secrets.tf`.
- ECS Fargate cluster + service running the backend container. Task
  pulls `DATABASE_URL`, `JWT_*`, and `ANTHROPIC_API_KEY` from Secrets
  Manager as env-refs — `ecs.tf`.
- Application Load Balancer in the public subnets with an HTTPS
  listener bound to your ACM cert, HTTP redirected to HTTPS —
  `alb.tf`.
- S3 bucket (private, OAC-gated) + CloudFront distribution for the
  built React frontend. `/api/*` routes to the ALB, everything else
  to S3 with an `index.html` SPA fallback — `frontend.tf`.
- Task execution + task IAM roles, scoped to only the secrets and log
  group they need — `iam.tf`.
- CloudWatch log group for backend container logs — `ecs.tf`.

## Prereqs

- Terraform **1.6+** (tested with 1.9.x).
- AWS CLI configured with credentials that can create VPCs, ECS
  clusters, RDS instances, ALBs, CloudFront distributions, IAM
  roles, and Secrets Manager entries.
- An **ACM certificate in the same region as the deployment** for
  the ALB listener (see `alb_certificate_arn`).
- An **ACM certificate in `us-east-1`** for the CloudFront
  distribution if you want a custom domain (see
  `cloudfront_certificate_arn`). CloudFront always requires us-east-1
  certs — this is an AWS constraint, not a project choice.
- A **Route 53 hosted zone** (or equivalent DNS) for the domain you
  plan to point at CloudFront. DNS records are created outside this
  module so it stays portable.
- A container image for the backend, pushed to ECR (or any registry
  the ECS task execution role can pull from — public ECR, GHCR with
  a pull-secret, etc.). Build with
  `docker build -t procela-backend packages/backend`.

## Usage

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars      # fill in the ARNs

terraform init
terraform plan  -out plan.tfplan
terraform apply plan.tfplan
```

Apply takes ~20 minutes end to end (CloudFront is most of it).

### After apply

1. **Point DNS at CloudFront.** Take the `cloudfront_domain_name`
   output and create an ALIAS (Route 53) or CNAME (any DNS) from
   `var.domain_name` to it.
2. **Populate the placeholder secrets.** The JWT keys and the
   Anthropic API key are created as empty containers with a
   `REPLACE_ME_*` placeholder value. Fill them in:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id procela-dev/app/anthropic_api_key \
     --secret-string "sk-ant-..."
   aws secretsmanager put-secret-value \
     --secret-id procela-dev/app/jwt_private_key \
     --secret-string "$(cat jwt-private.pem)"
   aws secretsmanager put-secret-value \
     --secret-id procela-dev/app/jwt_public_key \
     --secret-string "$(cat jwt-public.pem)"
   ```
   `jwt_secret` and the DB password are auto-generated — no action
   needed. `DATABASE_URL` is composed from the RDS endpoint + the
   generated password on apply.
3. **Upload the frontend build.** Run the frontend build
   (`npm run build --workspace @procela/frontend`) and sync the
   output to the bucket named by the `frontend_bucket` output:
   ```bash
   aws s3 sync packages/frontend/dist \
     s3://$(terraform output -raw frontend_bucket)/ --delete
   aws cloudfront create-invalidation \
     --distribution-id $(terraform output -raw cloudfront_distribution_id) \
     --paths '/*'
   ```
4. **Restart the ECS service to pick up the new secret values.**
   The task caches secret values on startup, so populating the
   Anthropic / JWT secrets after the first apply requires a task
   restart:
   ```bash
   aws ecs update-service \
     --cluster  $(terraform output -raw ecs_cluster_name) \
     --service  $(terraform output -raw ecs_service_name) \
     --force-new-deployment
   ```

### Deploying a new backend image

Push the new image (retagging `:latest` or using an immutable tag),
then force a new deployment:

```bash
aws ecs update-service \
  --cluster $(terraform output -raw ecs_cluster_name) \
  --service $(terraform output -raw ecs_service_name) \
  --force-new-deployment
```

The task definition ignores changes to `task_definition` and
`desired_count` (`lifecycle.ignore_changes` in `ecs.tf`) so Terraform
and your CI/CD pipeline don't fight over the image tag.

## Remote state

This module intentionally uses **local state**. Real deployments must
pin state to S3 + DynamoDB. Uncomment the backend block in
`versions.tf` and adapt:

```hcl
backend "s3" {
  bucket         = "procela-tfstate-<account-id>"
  key            = "procela/dev/terraform.tfstate"
  region         = "us-east-1"
  dynamodb_table = "procela-tflock"
  encrypt        = true
}
```

The S3 bucket and DynamoDB lock table need to exist before
`terraform init` will succeed with a remote backend; create them with
a small bootstrap module or by hand.

## Production hardening toggles

The production-hardening items from
[`docs/STATUS.md` § Production hardening](../../docs/STATUS.md#production-hardening)
are implemented here as variables, and the stack-level ones now **default
`true`** so a bare apply is production-hardened. To get the small/cheap
reference stack instead, set the cost-bearing ones `false` (there's a
ready-to-paste block in `terraform.tfvars.example`). The **account-level
security services** — CloudTrail, GuardDuty, Security Hub, Config — stay
`false` by default: they're commonly org-managed, and AWS Config in particular
allows only one configuration recorder per region, so defaulting it on would
fail the apply on any account that already has Config.

> Enable them individually or all at once. Several force resource
> replacement or re-encryption (KMS, NAT restructure), so **always
> `terraform plan` and review before applying to a live stack.**

| Concern | Variable(s) | What it does |
|---|---|---|
| **RDS Multi-AZ** | `rds_multi_az` | Synchronous standby in the second AZ with automatic failover. |
| **RDS deletion protection** | `rds_deletion_protection` | Blocks deletes, takes a final snapshot, keeps automated backups. |
| **Performance Insights** | `rds_performance_insights`, `rds_performance_insights_retention_days` | Query-level RDS diagnostics (uses the RDS CMK when KMS is on). |
| **KMS CMKs** | `enable_kms_cmk`, `kms_deletion_window_days` | Customer-managed, auto-rotating keys for RDS storage, Secrets Manager, the log group, and the frontend S3 bucket (`kms.tf`). |
| **VPC endpoints** | `enable_vpc_endpoints` | S3 gateway + ECR/Secrets Manager/CloudWatch Logs interface endpoints so tasks reach AWS privately instead of over NAT (`vpc-endpoints.tf`). |
| **NAT per AZ** | `enable_nat_per_az` | One NAT + EIP + private route table per AZ instead of one shared NAT (`network.tf`). |
| **CloudFront-only ALB** | `restrict_alb_to_cloudfront` | ALB security group ingress restricted to CloudFront's managed prefix list (`network.tf`). |
| **Drop invalid headers** | `alb_drop_invalid_header_fields` | ALB strips malformed HTTP headers before forwarding. |
| **WAF** | `enable_waf`, `waf_rate_limit` | WAFv2 web ACL (CLOUDFRONT scope, us-east-1) with AWS managed rule groups + rate limit, attached to CloudFront (`waf.tf`). |
| **DB secret rotation** | `enable_db_secret_rotation`, `db_rotation_lambda_arn`, `db_rotation_days` | Automatic rotation of the master-password secret via a rotation Lambda (see below). |
| **Access logs** | `enable_access_logs` | Locked-down S3 buckets + access logging on the ALB and CloudFront (`logging.tf`). |
| **Alarms** | `enable_monitoring_alarms`, `alarm_email` | SNS topic + CloudWatch alarms on ALB 5xx/unhealthy hosts, ECS CPU/memory, RDS CPU/storage/connections (`monitoring.tf`). |
| **Threat detection & audit** | `enable_cloudtrail`, `enable_guardduty`, `enable_security_hub`, `enable_config` | Multi-region CloudTrail, GuardDuty, Security Hub, and AWS Config with their buckets/roles (`security.tf`). |

The `outputs.tf` file exposes the new resources (KMS key ARNs, WAF ACL
ARN, log-bucket names, the alarm SNS topic, the CloudTrail bucket) —
all `null` unless the matching toggle is on.

### Secret rotation

`enable_db_secret_rotation` wires an
`aws_secretsmanager_secret_rotation` onto the DB-password secret, but
Secrets Manager needs a rotation **Lambda** to call. Rather than bundle
one, the module takes its ARN as `db_rotation_lambda_arn` so you use
AWS's maintained function. Deploy the serverless app
`SecretsManagerRDSPostgreSQLRotationSingleUser` from the AWS Serverless
Application Repository (give its Lambda a security group allowed into
the RDS SG on 5432), then set:

```hcl
enable_db_secret_rotation = true
db_rotation_lambda_arn    = "arn:aws:lambda:<region>:<account>:function:<rotation-fn>"
```

Manual rotation steps for every secret are in
[`docs/DR_RUNBOOK.md` §3](../../docs/DR_RUNBOOK.md).

### Still out of scope (do it around the module)

A few production concerns are process/pipeline rather than a single
module toggle:

- **Private CloudFront** (signed URLs/cookies + an auth CloudFront
  Function) if the frontend must not be publicly reachable.
- **A fully private ALB** via a CloudFront VPC origin / PrivateLink —
  `restrict_alb_to_cloudfront` locks ingress to CloudFront IPs, which
  covers the common case without the VPC-origin plumbing.
- **Shipping application logs** to OpenSearch/Datadog beyond CloudWatch.
- **Per-environment stacks** (dev / staging / prod) with separate
  state files and separate AWS accounts.

The **CI/CD pipeline** is now included: set `enable_cicd_deploy_role = true`
(and `github_repo`) and this module creates the GitHub OIDC deploy role;
`.github/workflows/deploy.yml` then builds/pushes the image to the ECR repo
(`ecr.tf`), runs migrations, rolls the ECS service, and syncs the frontend on
merge to the default branch. See the workflow header for the repo-variable
setup.

None of these are hard to bolt on — the module is deliberately kept
small so the delta from "reference" to "hardened" is auditable rather
than hidden.
