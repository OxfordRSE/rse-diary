# One-off setup for CI deploys: a Terraform state bucket and an IAM role that
# GitHub Actions on `main` can assume via OIDC. Run once from a laptop:
#   cd infra/bootstrap && terraform init && terraform apply -var github_repo=<owner>/<repo>

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { "project-name" = "oxrse", project = "rse-diary" } }
}

variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "name" {
  description = "Must match the app stack's `name`; the deploy role is scoped to resources with this prefix."
  type        = string
  default     = "rse-diary"
}

variable "github_repo" {
  description = "GitHub repository allowed to deploy, as owner/repo."
  type        = string
}

variable "create_oidc_provider" {
  description = "Set false if the account already has the token.actions.githubusercontent.com OIDC provider."
  type        = bool
  default     = true
}

data "aws_caller_identity" "me" {}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "state" {
  bucket = "${var.name}-tfstate-${random_id.suffix.hex}"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  oidc_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:aws:iam::${data.aws_caller_identity.me.account_id}:oidc-provider/token.actions.githubusercontent.com"
  acct     = data.aws_caller_identity.me.account_id
}

resource "aws_iam_role" "deploy" {
  name = "${var.name}-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

# Enough to run `terraform apply` on infra/. Scoped to the name prefix where the
# service allows it; Cognito and CloudFront create resources with generated ids, so they get "*".
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:*", Resource = ["arn:aws:s3:::${var.name}-*", "arn:aws:s3:::${var.name}-*/*"] },
      { Effect = "Allow", Action = "lambda:*", Resource = "arn:aws:lambda:${var.region}:${local.acct}:function:${var.name}*" },
      { Effect = "Allow", Action = "iam:*", Resource = "arn:aws:iam::${local.acct}:role/${var.name}-*" },
      { Effect = "Allow", Action = "ssm:*", Resource = "arn:aws:ssm:${var.region}:${local.acct}:parameter/${var.name}/*" },
      { Effect = "Allow", Action = "logs:*", Resource = "arn:aws:logs:${var.region}:${local.acct}:log-group:/aws/lambda/${var.name}*" },
      { Effect = "Allow", Action = ["ssm:DescribeParameters", "logs:DescribeLogGroups", "cognito-idp:*", "cloudfront:*", "acm:DescribeCertificate", "sts:GetCallerIdentity"], Resource = "*" },
      # The role matches the prefix above; stop it widening its own permissions.
      { Effect = "Deny", Action = "iam:*", Resource = "arn:aws:iam::${local.acct}:role/${var.name}-deploy" },
    ]
  })
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
