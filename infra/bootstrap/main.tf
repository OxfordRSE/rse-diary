# One-off setup for CI deploys: the Terraform state bucket, an IAM role that
# GitHub Actions on `main` can assume via OIDC, and the permissions boundary
# that caps what the app's Lambda role can ever be given. See README "Deploy".

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  # This stack's own state lives in the bucket it creates. The first run uses a
  # local override file (see README), then migrates here.
  backend "s3" {
    key          = "bootstrap/terraform.tfstate"
    region       = "eu-west-2"
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = local.tags }
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
  description = "Set true only if the account doesn't yet have the token.actions.githubusercontent.com OIDC provider."
  type        = bool
  default     = false
}

data "aws_caller_identity" "me" {}

locals {
  acct = data.aws_caller_identity.me.account_id
  # Same tags as the app stack. The deploy role may only touch Cognito pools and
  # CloudFront distributions carrying project = rse-diary.
  tags          = { "project-name" = "oxrse", project = "rse-diary" }
  bucket_suffix = "${local.acct}-${var.region}-an"
  oidc_arn      = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:aws:iam::${local.acct}:oidc-provider/token.actions.githubusercontent.com"
  lambda_role   = "arn:aws:iam::${local.acct}:role/${var.name}-lambda"
  is_project    = { StringEquals = { "aws:ResourceTag/project" = local.tags.project } }
  tags_project  = { StringEquals = { "aws:RequestTag/project" = local.tags.project } }
}

resource "aws_s3_bucket" "state" {
  bucket           = "${var.name}-tfstate-${local.bucket_suffix}"
  bucket_namespace = "account-regional"
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

# The most the app's Lambda role can ever do, whatever the deploy role attaches to it.
# Without this, a deploy role that can edit the Lambda role could grant it anything.
resource "aws_iam_policy" "lambda_boundary" {
  name = "${var.name}-lambda-boundary"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"], Resource = ["arn:aws:s3:::${var.name}-data-${local.bucket_suffix}", "arn:aws:s3:::${var.name}-data-${local.bucket_suffix}/*"] },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = "arn:aws:ssm:${var.region}:${local.acct}:parameter/${var.name}/*" },
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.region}:${local.acct}:log-group:/aws/lambda/${var.name}*" },
    ]
  })
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

# Enough to run `terraform apply` on infra/ and nothing outside this project:
# names where the service has named ARNs, the project tag where it has generated ids.
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Buckets", Effect = "Allow", Action = "s3:*", Resource = ["arn:aws:s3:::${var.name}-*-${local.bucket_suffix}", "arn:aws:s3:::${var.name}-*-${local.bucket_suffix}/*"] },
      { Sid = "Lambda", Effect = "Allow", Action = "lambda:*", Resource = "arn:aws:lambda:${var.region}:${local.acct}:function:${var.name}*" },
      { Sid = "Params", Effect = "Allow", Action = "ssm:*", Resource = "arn:aws:ssm:${var.region}:${local.acct}:parameter/${var.name}/*" },
      { Sid = "Logs", Effect = "Allow", Action = "logs:*", Resource = "arn:aws:logs:${var.region}:${local.acct}:log-group:/aws/lambda/${var.name}*" },

      # The Lambda role: only with the boundary above, and only passed to Lambda.
      { Sid = "LambdaRoleWrite", Effect = "Allow", Action = ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary"], Resource = local.lambda_role, Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.lambda_boundary.arn } } },
      { Sid = "LambdaRoleManage", Effect = "Allow", Action = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:DeleteRole"], Resource = local.lambda_role },
      { Sid = "LambdaRolePass", Effect = "Allow", Action = "iam:PassRole", Resource = local.lambda_role, Condition = { StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" } } },

      # Cognito pools have generated ids: create only with the project tag, then touch only tagged pools.
      { Sid = "CognitoCreate", Effect = "Allow", Action = "cognito-idp:CreateUserPool", Resource = "*", Condition = local.tags_project },
      { Sid = "CognitoManage", Effect = "Allow", Action = "cognito-idp:*", Resource = "arn:aws:cognito-idp:${var.region}:${local.acct}:userpool/*", Condition = local.is_project },
      { Sid = "CognitoDomainRead", Effect = "Allow", Action = "cognito-idp:DescribeUserPoolDomain", Resource = "*" },

      # CloudFront: distributions by tag, functions by name.
      { Sid = "CloudFrontCreate", Effect = "Allow", Action = ["cloudfront:CreateDistribution", "cloudfront:CreateDistributionWithTags"], Resource = "arn:aws:cloudfront::${local.acct}:distribution/*", Condition = local.tags_project },
      { Sid = "CloudFrontManage", Effect = "Allow", Action = "cloudfront:*", Resource = "arn:aws:cloudfront::${local.acct}:distribution/*", Condition = local.is_project },
      { Sid = "CloudFrontFunctions", Effect = "Allow", Action = "cloudfront:*", Resource = "arn:aws:cloudfront::${local.acct}:function/${var.name}-*" },
      # Origin access controls can't be tagged or named in ARNs; this is the one account-wide CloudFront write.
      { Sid = "CloudFrontOAC", Effect = "Allow", Action = ["cloudfront:CreateOriginAccessControl", "cloudfront:GetOriginAccessControl", "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl"], Resource = "arn:aws:cloudfront::${local.acct}:origin-access-control/*" },

      { Sid = "ReadOnly", Effect = "Allow", Action = ["cloudfront:ListCachePolicies", "cloudfront:GetCachePolicy", "cloudfront:ListOriginRequestPolicies", "cloudfront:GetOriginRequestPolicy", "cloudfront:ListOriginAccessControls", "ssm:DescribeParameters", "logs:DescribeLogGroups", "acm:DescribeCertificate", "sts:GetCallerIdentity"], Resource = "*" },
      { Sid = "KeepBoundary", Effect = "Deny", Action = "iam:DeleteRolePermissionsBoundary", Resource = local.lambda_role },
    ]
  })
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
