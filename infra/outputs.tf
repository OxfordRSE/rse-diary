output "app_url" {
  value = local.app_url
}

output "user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "data_bucket" {
  value = aws_s3_bucket.data.id
}

output "cloudfront_domain" {
  description = "Point a CNAME for domain_name here if you use a custom domain."
  value       = aws_cloudfront_distribution.this.domain_name
}
