terraform {
  required_version = ">= 1.7"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # State lives in the bucket made by bootstrap/. Bucket name is passed at init:
  #   terraform init -backend-config="bucket=<state bucket>"
  backend "s3" {
    key          = "rse-diary/terraform.tfstate"
    region       = "eu-west-2"
    use_lockfile = true
  }
}

locals {
  tags = merge(var.tags, {
    "project-name" = "oxrse"
    project        = "rse-diary"
    "managed-by"   = "terraform"
    "app-url"      = "https://${var.domain_name}"
    # package.json version at the last `terraform apply` (CI ships code without retagging).
    version = jsondecode(file("${path.module}/../package.json")).version
  })
}

provider "aws" {
  region = var.region
  # Tags every taggable resource (CloudFront functions/policies, OAC, Cognito clients and function URLs can't take tags).
  default_tags { tags = local.tags }
}

# CloudFront only accepts certificates from us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags { tags = local.tags }
}

data "aws_caller_identity" "me" {}

resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

locals {
  # Account-regional namespace: names only this account can own, so no random suffix is needed.
  bucket_suffix   = "${data.aws_caller_identity.me.account_id}-${var.region}-an"
  client_id_param = "/${var.name}/client-id"
  app_url         = "https://${var.domain_name}"
}

# ---------------------------------------------------------------------------
# Persistent: data bucket and user pool. prevent_destroy keeps app redeploys
# (and accidental `terraform destroy`) from touching anyone's diary.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "data" {
  bucket           = "${var.name}-data-${local.bucket_suffix}"
  bucket_namespace = "account-regional"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 365 }
  }
}

resource "aws_cognito_user_pool" "this" {
  name                     = var.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = "ACTIVE"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  lifecycle { prevent_destroy = true }
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${var.name}-web"
  user_pool_id                         = aws_cognito_user_pool.this.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.app_url}/auth/callback"]
  logout_urls                          = ["${local.app_url}/"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]
  refresh_token_validity               = 30
  token_validity_units {
    refresh_token = "days"
    id_token      = "hours"
    access_token  = "hours"
  }
}

resource "aws_ssm_parameter" "client_id" {
  name  = local.client_id_param
  type  = "String"
  value = aws_cognito_user_pool_client.web.id
}

# ---------------------------------------------------------------------------
# App: Lambda, static assets, CloudFront. Safe to redeploy any time.
# ---------------------------------------------------------------------------

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../dist/lambda"
  output_path = "${path.module}/.build/lambda.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${var.name}-lambda"
  # Made by bootstrap/; caps this role whatever policies are attached below.
  permissions_boundary = "arn:aws:iam::${data.aws_caller_identity.me.account_id}:policy/${var.name}-lambda-boundary"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda" {
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.data.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.data.arn }, # so missing keys return 404, not 403
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter${local.client_id_param}" },
    ]
  })
}

resource "aws_lambda_function" "app" {
  function_name    = var.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 512
  timeout          = 10
  # CI ships code with update-function-code; Terraform only uploads it on first create.
  lifecycle { ignore_changes = [filename, source_code_hash] }
  environment {
    variables = {
      DATA_BUCKET     = aws_s3_bucket.data.id
      USER_POOL_ID    = aws_cognito_user_pool.this.id
      COGNITO_DOMAIN  = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${var.region}.amazoncognito.com"
      CLIENT_ID_PARAM = local.client_id_param
      ORIGIN_SECRET   = random_password.origin_secret.result
    }
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/lambda/${aws_lambda_function.app.function_name}"
  retention_in_days = 30
}

# Public URL; the handler rejects anything without CloudFront's x-origin-secret header.
# (CloudFront OAC can't be used: it needs a client-computed body hash on POST, which HTML forms can't send.)
resource "aws_lambda_function_url" "app" {
  function_name      = aws_lambda_function.app.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "url" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.app.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_invoke" {
  statement_id             = "FunctionURLAllowInvokeAction"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.app.function_name
  principal                = "*"
  invoked_via_function_url = true # only via the URL, never a direct Invoke API call
}

resource "aws_s3_bucket" "assets" {
  bucket           = "${var.name}-assets-${local.bucket_suffix}"
  bucket_namespace = "account-regional"
  force_destroy    = true
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Static files are uploaded by CI (.github/workflows/deploy.yml), not Terraform.
# This keeps the objects Terraform used to manage instead of deleting them.
removed {
  from = aws_s3_object.static
  lifecycle { destroy = false }
}

resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "${var.name}-assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.assets.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.this.arn } }
    }]
  })
}

# The Lambda origin sees its own Host, so pass the viewer's on.
resource "aws_cloudfront_function" "forwarded_host" {
  name    = "${var.name}-forwarded-host"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var req = event.request;
      req.headers["x-forwarded-host"] = { value: req.headers.host.value };
      return req;
    }
  EOT
}

# Honours each object's Cache-Control (max-age=300). A managed policy, so the deploy role needs no cache-policy rights.
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"
  aliases         = [var.domain_name]
  comment         = var.name

  origin {
    origin_id   = "app"
    domain_name = split("/", aws_lambda_function_url.app.function_url)[2]
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "x-origin-secret"
      value = random_password.origin_secret.result
    }
  }

  origin {
    origin_id                = "assets"
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  default_cache_behavior {
    target_origin_id         = "app"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_except_host.id
    compress                 = true
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.forwarded_host.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/static/*"
    target_origin_id       = "assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.this.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# ---------------------------------------------------------------------------
# Domain: certificate (DNS-validated) and alias records in the existing zone.
# ---------------------------------------------------------------------------

data "aws_route53_zone" "this" {
  name = var.zone_name
}

resource "aws_acm_certificate" "this" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cert_validation" {
  for_each        = { for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => o }
  zone_id         = data.aws_route53_zone.this.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "site" {
  for_each = toset(["A", "AAAA"])
  zone_id  = data.aws_route53_zone.this.zone_id
  name     = var.domain_name
  type     = each.value
  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
