variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "rse-diary"
}

variable "cognito_domain_prefix" {
  description = "Globally unique prefix for the Cognito sign-in domain, e.g. \"oxrse-diary\"."
  type        = string
}

variable "domain_name" {
  description = "Optional custom domain (e.g. diary.example.ac.uk). Empty = use the CloudFront domain."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate in us-east-1 for domain_name. Required when domain_name is set."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
