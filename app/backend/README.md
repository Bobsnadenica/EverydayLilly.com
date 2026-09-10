# Everyday Lilly vault backend

Verified against repository source and read-only AWS APIs on **2026-09-10 (Europe/Sofia)**.

The vault is a deployed, Terraform-managed AWS serverless backend in **eu-central-1 (Frankfurt)**. The public site is hosted on GitHub Pages and calls Cognito directly. No Amplify integration is used by this repository.

## Frontend follow-up — 2026-09-10

The owner assigned the reviewed account to `admin`; a read-only AWS check confirmed that membership. The gallery now opens a selected month, offers a staged multi-file upload batch, and no longer requires an initial hero upload. It continues to use the existing manifest and upload-url endpoints and zero-based month keys. Existing hero files remain viewable; no media was moved.

The frontend no longer persists signed manifests. It validates authorization on every page load, reuses the in-memory result for month navigation, refreshes the session before API calls, and clears legacy caches on auth changes. Refresh/upload completion refetches metadata without a `refresh` cache-busting parameter, retaining stable photo URLs. Images are lazy-loaded. Video previews decode a still near the viewport, release their video source, and reuse a bounded in-memory frame cache for month revisits. No autoplay, new AWS service, or stored thumbnail objects are involved; preview transfer sizes depend on the browser and original container. This fixes the frontend cache/account and expired-startup-token findings described in the historical review below. The Lambda's one-year signing-window minimum and browser immutable media caching remain unchanged.

These are static-site changes, not a backend deployment. No Terraform apply or new AWS service is needed. Eight dependency-free regression tests and loopback browser fixture checks passed; the owner authorized publishing this release through GitHub Pages from main. Production upload writes were not exercised during this update.

## Source and live resources

| Service | Role | Verified resource |
| --- | --- | --- |
| Cognito | Invite-only user authentication | User pool `eu-central-1_vaA1ovTyr` |
| Cognito app client | Browser OAuth/PKCE, no client secret in Terraform | `680v9kq2oue5323c6r63egrltg` |
| API Gateway | HTTP API with JWT authorizer | `ebz7pirts5` |
| Lambda | Manifest and upload URL handlers | `everyday-lilly-vault-prod-gallery-manifest` |
| CloudFront | API routing and signed media delivery | `d1fxhro74spn7q.cloudfront.net`, distribution `E1CGP9WRXR343M` |
| S3 | Private selected gallery media | `everyday-lilly-vault-prod-gallery-rnk3lm46` |
| S3 | Separate long-term originals archive | `everyday-lilly-vault-prod-archive-rnk3lm46` |

These are configuration identifiers, not credentials. Never add account passwords, tokens, signed URLs, private object names, or PEM contents to documentation.

```text
live/prod/
├── main.tf                     S3, CloudFront, Cognito, gallery groups
├── gallery_api.tf              API Gateway, JWT authorizer, Lambda, IAM, signing key group
├── lambda/gallery_manifest/
│   └── index.mjs               Backend application code
├── locals.tf
├── outputs.tf
├── providers.tf
├── variables.tf
├── versions.tf
└── terraform.tfvars.example    Example only; not production configuration
```

Terraform requires version >= 1.9.0 and the AWS (~> 6.0), archive (~> 2.5), and random (~> 3.6) providers. Lambda runs Node.js 22, with 256 MB memory and a 10-second timeout. At review time it was Active, last update Successful, with a last-modified timestamp of 2026-06-16.

## Login and authorization

Hosted UI base: `https://everyday-lilly-vault-prod-1234.auth.eu-central-1.amazoncognito.com`.

Start normal login from the website's Sign In button so `auth/auth.js` creates the matching OAuth state and PKCE verifier. Opening a bare Hosted UI login URL without this pending state is not a complete website login test.

Verified app-client configuration:

- OAuth flow: authorization code.
- Scopes: `openid`, `email`, `profile`, `aws.cognito.signin.user.admin`.
- Callbacks: `https://www.everydaylilly.com/auth/callback.html` and `http://localhost:8000/auth/callback.html`.
- Logout URLs: `https://www.everydaylilly.com/` and `http://localhost:8000/`.
- Explicit auth flows: refresh token, user auth, password auth, and SRP auth.
- Username-existence suppression: enabled.

The frontend exchanges the code at Cognito's token endpoint and stores the session in session storage, or local storage for remembered sessions. Its helper supports refresh tokens. Terraform configures 60-minute ID/access tokens and 30-day refresh tokens.

The API accepts a Cognito ID token in `Authorization: Bearer …`. API Gateway verifies the issuer/audience; Lambda checks `token_use == id` and role claims. There is no standalone database for gallery permissions.

| Role/claim | Result |
| --- | --- |
| `admin` or `admins` group | Monthly gallery and upload capability |
| `viewers` or `viewer` group | Monthly gallery, read only |
| `test` group or supported test claim | Test collection; takes precedence over monthly routing |
| No permitted role/claim | Manifest returns 403 |

Supported test claims are `custom:tag`, `custom:tags`, `tag`, `tags`, `custom:test`, and `test`. Upload authorization independently requires an admin group. Terraform defines `admin` and `viewers`; the live pool also contains `test`, whose creation is not represented in the current Terraform files.

**2026-09-10 account review:** the owner-supplied account was enabled and confirmed but had no group memberships. The browser showed “This account is not assigned to a gallery role.” An intentionally assigned gallery role and fresh tokens are required; an admin-looking email does not confer access. No memberships were changed during review.

For investigation, use `admin-get-user` with a query limited to Enabled/UserStatus and `admin-list-groups-for-user`. Keep account identifiers and returned attributes out of repository notes. An `invalid_scope` error requires comparing the requested scopes to the live app client; do not blindly apply Terraform as a repair. Scopes matched during this review.

## API and storage flow

CloudFront endpoints:

- `GET https://d1fxhro74spn7q.cloudfront.net/api/gallery/manifest`
- `POST https://d1fxhro74spn7q.cloudfront.net/api/gallery/upload-url`

CloudFront forwards `/api/*` to `ebz7pirts5.execute-api.eu-central-1.amazonaws.com` with caching disabled. Both routes use JWT authorization. The Lambda lists the authorized S3 prefix with pagination and returns metadata plus signed media URLs. The default CloudFront media behavior requires a trusted key group and reaches S3 through Origin Access Control.

Both archive and gallery buckets have all S3 public-access-block settings enabled. The archive's enabled lifecycle rule transitions eligible objects to `DEEP_ARCHIVE` after seven days; S3 lifecycle size eligibility still applies. Archive objects are not served by the gallery Lambda.

New gallery keys use zero-based month IDs:

```text
months/<0-59>/<filename>          Normal media
months/hero/<0-59>/<filename>     Month cover images
test/<filename>                  Test collection
```

The UI labels those month IDs 1–60, grouped into five years. Flat legacy numeric media paths remain supported by the frontend; consult its parser before renaming existing objects. The paths above are examples, not a listing of private files.

Admin upload sequence:

1. Open a month; an empty month offers a hero tile, and a populated month offers a photo upload tile.
2. Request an upload URL with month ID, filename, content type, and upload kind.
3. Lambda checks the admin role, validates the request, and rejects an existing target with 409.
4. The browser PUTs directly to S3 using a URL valid for at most 900 seconds and the returned signed headers, including `If-None-Match: *`.
5. Conditional PUT prevents overwrite races. Refresh the manifest to display the new object.

The current review did not upload or modify production media.

## Cache and session findings from the initial review

- The browser stores manifests in `localStorage` for one hour under a collection-only key. It can reuse them without an API request, and logout does not clear them. This allows account changes in one browser to reuse a previous account's signed URLs and capability UI. Bind caches to the authenticated user and clear/revalidate them on logout or account changes. Backend upload checks remain in force.
- The signer clamps its expiry window to **at least 31,536,000 seconds** and rounds expiry to the next boundary. A URL's remaining validity ranges up to that window, rather than always being one full year from issuance. CloudFront/browser media caching is long-lived and immutable. Logout or removing a group does not revoke previously issued URLs or recall downloaded/browser-cached media.
- `gallery_cache_version` and the UI's refresh parameter change URL/cache versions; they are not access revocation controls. Lowering the Terraform TTL alone does not remove the Lambda's one-year minimum.
- The gallery captures a session once during startup and reuses that token for later refreshes and uploads. Reacquire a refreshed session for each API action to avoid failures after token expiry.

These describe the pre-update source. At the initial review, deployed auth/gallery scripts matched local files byte for byte; the subsequent frontend fixes above are included in this release. Cross-account cache reproduction, long-running token expiry, and issued-media revocation were not exercised against real accounts/media.

## WAF status

Earlier documentation described CAPTCHA and WAF rate blocking that are not present in the current configuration. Current Terraform has no WAF resources and the live `eu-central-1` regional web ACL listing was empty. Cognito username-existence suppression is enabled; MFA is off and user-pool deletion protection is inactive in the inspected live pool. Do not describe a deployed custom WAF/CAPTCHA layer based on the older notes.

## Production state and deployment prerequisites

There is no remote backend block in the Terraform source. The documented workflow relies on externally retained/local state, but the authoritative production state location was **not established** during this review.

The following are **absent in this checkout**:

- `live/prod/terraform.tfstate`
- `live/prod/terraform.tfvars`
- `live/prod/.terraform/`
- `live/prod/lambda/gallery_manifest/gallery_private_key.pem`
- `live/prod/lambda/gallery_manifest/gallery_public_key.pem`

`gallery_api.tf` reads the public PEM and packages the Lambda directory; `index.mjs` loads the private PEM at runtime. These files are ignored by Git. A fresh clone therefore does not contain enough material to reproduce the deployed Lambda package.

Before any production change:

1. Recover the authoritative state and production variables from their controlled storage and verify they describe the existing resources above. Do not assume an empty local state represents the deployed environment.
2. Restore the existing matching signing key files through the controlled secret-handling process. Never print or commit the private key. Rotation is a separate operational change affecting signed media access.
3. Initialize Terraform against the verified state setup, validate, and review a plan for unexpected replacement or destruction before applying an authorized change. Keep state and plans access-controlled.

Do not copy `terraform.tfvars.example` over recovered production values. Its domain and CloudFront values are placeholders. The public GitHub Pages frontend has a separate publication path; Terraform does not publish those static pages. No repository GitHub Actions deployment workflow was present during review.

Safe source checks from the repository root:

```bash
node --check app/backend/live/prod/lambda/gallery_manifest/index.mjs
terraform fmt -check app/backend/live/prod
git diff --check
```

The JavaScript syntax and Terraform formatting checks passed on 2026-09-10. Full Terraform validation/plan/apply was not performed because the deployment inputs were unavailable. No AWS changes were made.

## Live smoke results and limits

- Unauthenticated manifest GET: 401. Use GET; an unsupported HEAD request returns 404 and does not test this route's authorization.
- Unsigned CloudFront media request: 403.
- Direct S3 media request: 403.
- Signed-out gallery URL: redirects to the public homepage.
- Browser gallery attempt: role-denied message; reviewed account has no groups.
- Live Lambda: Active/Successful. API routes: JWT protected. CloudFront distribution: enabled and Deployed.

Private-media rendering, successful upload, full credential entry, password reset, and viewer/test-account isolation were not verified end to end. Do not treat the review as a complete release certification.

## Destructive teardown

The root `cleanup.sh` runs `terraform destroy` and then removes local state, plans, and `.terraform/`. Its `--yes` option skips its confirmation and enables Terraform auto-approval. It is a teardown tool, not routine cleanup or auth troubleshooting. Do not run it to recover a missing local state or fix a login failure.
