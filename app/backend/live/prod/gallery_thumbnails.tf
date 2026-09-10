# Build the ZIP before planning. Import these resources into recovered production
# state before applying; they were introduced as an isolated thumbnail deployment.
resource "aws_iam_role" "gallery_thumbnails" {
  name = "${local.prefix}-gallery-thumbnails-lambda"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "gallery_thumbnails_logs" {
  role       = aws_iam_role.gallery_thumbnails.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "gallery_thumbnails" {
  name = "gallery-previews"
  role = aws_iam_role.gallery_thumbnails.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${aws_s3_bucket.gallery.arn}/${var.gallery_month_prefix}/*", "${aws_s3_bucket.gallery.arn}/previews/${var.gallery_month_prefix}/*"] },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.gallery.arn}/previews/${var.gallery_month_prefix}/*" },
      { Effect = "Allow", Action = "s3:ListBucket", Resource = aws_s3_bucket.gallery.arn, Condition = { StringLike = { "s3:prefix" = "previews/${var.gallery_month_prefix}/*" } } }
    ]
  })
}

resource "aws_lambda_function" "gallery_thumbnails" {
  function_name    = "${local.prefix}-gallery-thumbnails"
  role             = aws_iam_role.gallery_thumbnails.arn
  runtime          = "python3.12"
  architectures    = ["x86_64"]
  handler          = "handler.handler"
  filename         = "${path.module}/lambda/gallery_thumbnails/package.zip"
  source_code_hash = filebase64sha256("${path.module}/lambda/gallery_thumbnails/package.zip")
  memory_size      = 1024
  timeout          = 150
  environment {
    variables = { GALLERY_BUCKET = aws_s3_bucket.gallery.bucket, GALLERY_PREFIX = var.gallery_month_prefix }
  }
  depends_on = [aws_iam_role_policy.gallery_thumbnails, aws_iam_role_policy_attachment.gallery_thumbnails_logs]
}

resource "aws_lambda_permission" "gallery_thumbnails_s3" {
  statement_id   = "AllowGalleryThumbnailEvents"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.gallery_thumbnails.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.gallery.arn
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_s3_bucket_notification" "gallery_thumbnails" {
  bucket = aws_s3_bucket.gallery.id
  lambda_function {
    id                  = "gallery-thumbnails"
    lambda_function_arn = aws_lambda_function.gallery_thumbnails.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "${var.gallery_month_prefix}/"
  }
  depends_on = [aws_lambda_permission.gallery_thumbnails_s3]
}

resource "aws_cloudwatch_log_group" "gallery_thumbnails" {
  name              = "/aws/lambda/${local.prefix}-gallery-thumbnails"
  retention_in_days = 14
}
