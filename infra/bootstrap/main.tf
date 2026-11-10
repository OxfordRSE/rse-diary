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
  # Same tags as the app stack.
  tags          = { "project-name" = "oxrse", project = "rse-diary", "managed-by" = "terraform" }
  bucket_suffix = "${local.acct}-${var.region}-an"
  oidc_arn      = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:aws:iam::${local.acct}:oidc-provider/token.actions.githubusercontent.com"
  assets_bucket = "arn:aws:s3:::${var.name}-assets-${local.bucket_suffix}"
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

# The most the app's Lambda role can ever do, whatever is attached to it.
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

# Only enough to ship app code: new Lambda code and the static files.
# Infrastructure changes are applied by hand with admin credentials.
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LambdaCode", Effect = "Allow", Action = ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"], Resource = "arn:aws:lambda:${var.region}:${local.acct}:function:${var.name}" },
      { Sid = "AssetsList", Effect = "Allow", Action = "s3:ListBucket", Resource = local.assets_bucket },
      { Sid = "AssetsWrite", Effect = "Allow", Action = ["s3:PutObject", "s3:DeleteObject"], Resource = "${local.assets_bucket}/static/*" },
    ]
  })
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
