# RSE diary

A personal dev diary for Research Software Engineers. For each day you log which projects you worked on, roughly how much (a fraction of an FTE day, or a "touch" if you don't know), and short notes. The main way entries arrive is an AI agent logging for you with a personal token. The web UI is for reviewing, editing, presenting and exporting.

- Overview: a GitHub-style calendar heatmap of your working pattern with a coloured dot per project, the selected day's entries, and per-project sparklines with progress against estimates.
- Project page: a calendar across the project's whole span (start to deadline), a summary, a scrollable diary, and `.log` / `.json` exports.
- Summary export (CSV/JSON, no notes) for anyone who asks how much FTE a project has taken.
- Everything works with JavaScript and CSS turned off.

Design: [`docs/superpowers/specs/2026-11-05-rse-diary-design.md`](docs/superpowers/specs/2026-11-05-rse-diary-design.md).

## Architecture

```
Browser / agent ── CloudFront ──┬─ /static/*  → S3 (assets)
                                └─ everything → Lambda (TypeScript, server-rendered HTML + /api)
                                                   ├─ Cognito (sign-in for humans)
                                                   └─ S3 data bucket: users/{cognito sub}/…
```

Data is plain JSON in S3, one file per user per month:

```
users/{sub}/config.json            projects
users/{sub}/entries/YYYY-MM.json   entries
users/{sub}/tokens.json            token index
tokens/{sha256}.json               token lookup (only hashes are stored)
```

Writes use S3 conditional puts (`If-Match`) with retry, so several agent sessions can log at once without losing entries. Bucket versioning gives you undo.

## Develop

```sh
npm ci
npm test            # vitest
npm run typecheck
npm run dev         # http://localhost:8787, in-memory store with demo data, no sign-in
npm run build       # dist/lambda + dist/static
```

## Deploy

Pushes to `main` deploy through GitHub Actions (`.github/workflows/deploy.yml`): tests, build, then `terraform apply`. Usually that only updates the Lambda code and the static files. Every resource that takes tags gets `project-name = oxrse` and `project = rse-diary`.

All Terraform state lives in an S3 bucket in your account's own namespace (`rse-diary-tfstate-<account>-<region>-an`), locked with S3 lock files. The state bucket and the app's buckets are tagged like everything else.

**One-off setup** (needs admin-level AWS credentials, the AWS CLI and Terraform ≥ 1.6). The setup stack makes the state bucket, so its first run uses local state and then moves it into that bucket:

```sh
cd infra/bootstrap
STATE_BUCKET="rse-diary-tfstate-$(aws sts get-caller-identity --query Account --output text)-eu-west-2-an"

# 1. First run on local state (the override file switches the S3 backend off).
printf 'terraform {\n  backend "local" {}\n}\n' > first_run_override.tf
terraform init
terraform apply -var github_repo=<owner>/<repo>   # add -var create_oidc_provider=true if the account has no GitHub OIDC provider yet

# 2. Move this stack's state into the bucket it just made.
rm first_run_override.tf
terraform init -migrate-state -force-copy -backend-config="bucket=$STATE_BUCKET"
rm -f terraform.tfstate terraform.tfstate.backup
```

Later changes to the setup stack: `terraform init -backend-config="bucket=$STATE_BUCKET"` then `terraform apply -var github_repo=<owner>/<repo>`.

It creates:

- the state bucket (versioned, encrypted, private);
- `rse-diary-deploy`, an IAM role only `main` of that repo can assume. It can change this project's buckets, Lambda, log group and parameters by name, and Cognito pools and CloudFront distributions only if they carry `project = rse-diary`. The one account-wide right left is CloudFront origin access controls, which AWS lets you neither tag nor name;
- `rse-diary-lambda-boundary`, a permissions boundary the app's Lambda role must carry, so the deploy role can't hand the Lambda more than access to the diary data, its parameter and its logs.

Then set these GitHub repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `terraform output -raw deploy_role_arn` |
| `TF_STATE_BUCKET` | `terraform output -raw state_bucket` |
| `COGNITO_DOMAIN_PREFIX` | a globally unique prefix for the sign-in page |
| `DOMAIN_NAME`, `ACM_CERTIFICATE_ARN` | optional custom domain (certificate in us-east-1); point a CNAME at `terraform output cloudfront_domain` |

Push to `main`, and the workflow summary shows the site address.

**Deploying by hand** uses the same state:

```sh
npm ci && npm run build
cd infra
terraform init -backend-config="bucket=$STATE_BUCKET"
terraform apply -var cognito_domain_prefix=<prefix>
```

The data bucket and user pool have `prevent_destroy`, so app changes never touch your data.

### Create an account

Self-signup is off. An admin creates each user:

```sh
aws cognito-idp admin-create-user \
  --user-pool-id "$(terraform -chdir=infra output -raw user_pool_id)" \
  --username someone@example.ac.uk \
  --user-attributes Name=email,Value=someone@example.ac.uk Name=email_verified,Value=true
```

Cognito emails them a temporary password.

### Connect an agent

1. Sign in, open **Tokens**, and create one per machine (e.g. "laptop"). Copy the two `export` lines into your shell profile.
2. Tell the agent where the instructions are. For Claude Code, add this to `~/.claude/CLAUDE.md`:

   ```markdown
   ## RSE diary
   When I ask you to log work to my diary, read `$RSE_DIARY_URL/api/instructions`
   (curl with `Authorization: Bearer $RSE_DIARY_TOKEN`) and follow it.
   ```

3. Then just say: *"Log this to my diary: new project RSE diary, about a quarter day, a few bullets on what we did. Also 0.1 on Glow answering emails about the security model."*

## Notes

- **Cost:** a few dollars a month at most for a team: Lambda, S3 and CloudFront at tiny volume. Cognito is free for up to 50k monthly active users.
- **Security:** the Lambda function URL is public, but it refuses any request without the secret header that CloudFront adds. The secret is kept in Terraform state. Web sessions use `HttpOnly; Secure; SameSite=Lax` cookies, and cross-site form posts are rejected.
- **SAML SSO later:** add the identity provider to the same user pool. Federated users get a new `sub`, so move their `users/{old}/` prefix to `users/{new}/` once.
