variable "aws_region" {
  description = "Primary AWS region for Cognito and S3."
  type        = string
  default     = "eu-central-1"
}

variable "project_slug" {
  description = "Short slug used in resource names."
  type        = string
  default     = "everyday-lilly-vault"
}

variable "environment" {
  description = "Environment suffix for resource naming."
  type        = string
  default     = "prod"
}

variable "auth_callback_urls" {
  description = "Allowed Cognito callback URLs."
  type        = list(string)
}

variable "auth_logout_urls" {
  description = "Allowed Cognito logout URLs."
  type        = list(string)
}

variable "cognito_domain_prefix" {
  description = "Unique Cognito hosted UI domain prefix."
  type        = string
}

variable "archive_transition_days" {
  description = "Days before archive uploads transition to DEEP_ARCHIVE."
  type        = number
  default     = 7
}

variable "gallery_month_prefix" {
  description = "Prefix inside the gallery bucket for the flat numeric gallery files."
  type        = string
  default     = "months"
}

variable "gallery_test_prefix" {
  description = "Prefix inside the gallery bucket for the test-only gallery files."
  type        = string
  default     = "test"
}

variable "gallery_public_base_url" {
  description = "Public base URL that viewers use for the CloudFront gallery distribution."
  type        = string
}

variable "gallery_cache_version" {
  description = "Stable cache version string for gallery media URLs. Change it only when you intentionally want every client to fetch fresh originals again."
  type        = string
  default     = "v1"
}

variable "gallery_signed_url_ttl_seconds" {
  description = "Lifetime in seconds for the signed gallery media URLs returned by the backend. Defaults to one year so gallery URLs stay stable until you manually refresh or bump the cache version."
  type        = number
  default     = 31536000
}

variable "gallery_api_allowed_origins" {
  description = "Browser origins allowed to call the private gallery manifest API through CloudFront."
  type        = list(string)
  default = [
    "https://www.everydaylilly.com",
    "http://localhost:8000"
  ]
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition = contains(
      ["PriceClass_All", "PriceClass_200", "PriceClass_100"],
      var.price_class
    )
    error_message = "price_class must be one of PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

variable "tags" {
  description = "Extra tags to add to all resources."
  type        = map(string)
  default     = {}
}

variable "gallery_timeline_start_date" {
  description = "Private ISO start date for the monthly album. Set in controlled production variables, never commit the actual date."
  type        = string
  sensitive   = true
  default     = ""
}
