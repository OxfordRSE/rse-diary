terraform {
  required_version = ">= 1.6"
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

provider "aws" {
  region = var.region
  # Tags every taggable resource (CloudFront functions/policies, OAC, Cognito clients and function URLs can't take tags).
  default_tags { tags = merge(var.tags, { "project-name" = "oxrse", project = "rse-diary" }) }
}

data "aws_caller_identity" "me" {}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

locals {
  client_id_param = "/${var.name}/client-id"
  app_url         = var.domain_name != "" ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.this.domain_name}"
}

# ---------------------------------------------------------------------------
# Persistent: data bucket and user pool. prevent_destroy keeps app redeploys
# (and accidental `terraform destroy`) from touching anyone's diary.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "data" {
  bucket = "${var.name}-data-${random_id.suffix.hex}"
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
  bucket        = "${var.name}-assets-${random_id.suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

locals {
  static_dir = "${path.module}/../dist/static"
  mime       = { css = "text/css; charset=utf-8", js = "text/javascript; charset=utf-8" }
}

resource "aws_s3_object" "static" {
  for_each     = fileset(local.static_dir, "*")
  bucket       = aws_s3_bucket.assets.id
  key          = "static/${each.value}"
  source       = "${local.static_dir}/${each.value}"
  etag         = filemd5("${local.static_dir}/${each.value}")
  content_type = lookup(local.mime, reverse(split(".", each.value))[0], "application/octet-stream")
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

# Short TTL so a redeploy's CSS/JS shows up within minutes without invalidations.
resource "aws_cloudfront_cache_policy" "static" {
  name        = "${var.name}-static"
  min_ttl     = 0
  default_ttl = 300
  max_ttl     = 3600
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
  }
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
  aliases         = var.domain_name != "" ? [var.domain_name] : []
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
    cache_policy_id        = aws_cloudfront_cache_policy.static.id
    compress               = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.domain_name == ""
    acm_certificate_arn            = var.domain_name != "" ? var.acm_certificate_arn : null
    ssl_support_method             = var.domain_name != "" ? "sni-only" : null
    minimum_protocol_version       = var.domain_name != "" ? "TLSv1.2_2021" : null
  }
}
