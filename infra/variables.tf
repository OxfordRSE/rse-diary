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
  description = "The site's address. Terraform makes its certificate and DNS records in zone_name."
  type        = string
  default     = "diary.oxrse.uk"
}

variable "zone_name" {
  description = "Existing Route53 hosted zone that domain_name sits in."
  type        = string
  default     = "oxrse.uk"
}

variable "tags" {
  type    = map(string)
  default = {}
}
