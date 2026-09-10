# Everyday Lilly

Static website and private family photo vault for [www.everydaylilly.com](https://www.everydaylilly.com/), plus companion microsites and the vault's AWS backend source.

Architecture and live AWS configuration reviewed on **2026-09-10 (Europe/Sofia)**. The backend is deployed, not a future scaffold. The Flutter source described in older documentation is **not present in this checkout**.

## Monthly family album — 2026-09-10

The gallery now opens directly into one month, with a warm ivory/green album layout, a 12-month selector, and a five-year switcher. It restores the last selected month for the current account; a new account starts at the latest populated month (or Month 1 for an empty album). `?month=1` through `?month=60` links override the remembered selection.

- Only the selected month's media is rendered, including existing cover images. Navigating months reuses the authorized manifest in memory and does not call the API again.
- Admins select or drop multiple files, review their filenames/previews and destination month, then confirm the batch. There is no required cover-photo step. The first regular photo can represent the month, and existing dedicated covers remain visible.
- The destination is locked while files are queued/uploading. Completed batches stay in that month; duplicate filenames are skipped, successful files appear after one manifest refresh, and only failed files remain for retry.
- A new page visit checks authorization with the backend. Signed manifests are no longer persisted in browser storage. Auth session changes clear legacy caches, and logout/account-change events remove the open gallery in other tabs. Each API action reacquires a valid session.
- Media URLs stay stable when refreshing metadata or finishing uploads, preserving browser/CloudFront cache hits. Images are lazy-loaded. Video tiles show still-frame previews decoded near the viewport, at most two at a time, without autoplay. The decoder releases its video source after capturing a frame. Up to 40 previews are reused in page memory when switching months and cleared on sign-out/account changes. Preview transfers depend on browser/container behavior; full-size originals are still served, with no thumbnail service, transcoding, or storage-format changes. Unsupported videos retain a labeled play tile.
- HEIC is not supported by the existing backend; the uploader explains which formats it accepts and asks for JPG export. Files are not silently compressed or converted.

[Figma design direction](https://www.figma.com/design/uS7zZItz2W003PrCbyu8G9?node-id=2-2) uses an empty album state and contains no private family photos.

Validation: `node --test tests/gallery.test.cjs` (11 tests), JavaScript syntax checks, and `git diff --check` passed. Local browser checks used synthetic media and a loopback-only API fixture: desktop/mobile layout, selected-month-only images, zero extra manifest calls for month changes, year/month boundaries, selection persistence, batch upload, partial-failure retry, duplicate skip, viewer/denied/test states, and the photo viewer were checked. The mobile check at 390×844 had no horizontal overflow. AWS now reports the owner-supplied account in `admin`; no account details are retained here.

GitHub Pages publishes the repository root from `main`; this release includes the album CSS and updated auth/gallery scripts together. No Terraform apply is required for these frontend changes. Real S3 upload behavior was not re-tested by writing production family media. The backend's long-lived signed-URL/revocation finding below remains unresolved.

Video-preview follow-up: synthetic cross-origin MP4s rendered real still frames on desktop and at 390×844, playback opened correctly, and revisiting a month reused decoded frames. Regression tests cover visibility gating, concurrency, source cleanup, cache isolation, and failure/timeout fallback. Device-specific codecs such as HEVC were not certified.

## Where the backend lives

**Terraform manages a serverless AWS stack in Frankfurt (`eu-central-1`). The website uses Cognito directly; it does not use Amplify.**

| Part | Implementation | Source |
| --- | --- | --- |
| Public website and gallery HTML | Static GitHub Pages hosting | Root HTML/CSS/JS, `CNAME`, `gallery/` |
| Vault sign-in | Amazon Cognito Hosted UI, OAuth authorization code with PKCE | `auth/auth.js`, `auth/callback.html`, root `script.js` |
| Gallery API | API Gateway HTTP API with JWT authorization | `app/backend/live/prod/gallery_api.tf` |
| Backend application code | Node.js 22 Lambda, `everyday-lilly-vault-prod-gallery-manifest` | `app/backend/live/prod/lambda/gallery_manifest/index.mjs` |
| Private media delivery | CloudFront signed URLs and a private S3 gallery bucket | `app/backend/live/prod/main.tf` |
| Long-term originals | Separate private S3 archive bucket with Deep Archive lifecycle | `app/backend/live/prod/main.tf` |
| Infrastructure | Terraform, AWS/archive/random providers | `app/backend/live/prod/` |

Live DNS points `www` at GitHub Pages, and the website responds with `Server: GitHub.com`. AWS reads confirmed the gallery distribution, API routes, Lambda, Cognito configuration, and both buckets. No Everyday Lilly Amplify app was returned in the checked region, and no Amplify integration was found in this repository. This was not an all-region account inventory.

```mermaid
flowchart LR
    Site[Static website on GitHub Pages] --> Login[Cognito Hosted UI]
    Login --> Callback[auth/callback.html]
    Callback --> Gallery[Gallery browser session]
    Gallery -->|ID token| CF[CloudFront /api/*]
    CF --> API[API Gateway JWT authorizer]
    API --> Lambda[Gallery Lambda]
    Lambda -->|List media and sign URLs| S3[Private gallery S3 bucket]
    Gallery -->|Signed media URL| Media[CloudFront media delivery]
    Media --> S3
```

The archive bucket is separate from this gallery path. There is no database resource or persistent application server in this Terraform stack; the gallery manifest is built from S3 objects.

## Vault login and access

1. Open **Sign In** on the [homepage](https://www.everydaylilly.com/). The modal collects an email and opens Cognito in a popup for password entry and recovery.
2. `auth/callback.html` exchanges the authorization code using PKCE. The auth helper saves the session in `sessionStorage`, or `localStorage` when “Keep this device signed in” is selected.
3. The gallery requests `GET /api/gallery/manifest` through CloudFront using a Cognito **ID token**. API Gateway validates the JWT; Lambda checks the account's gallery role and chooses its collection.
4. CloudFront serves media using the signed URLs returned in the manifest. Signing in does not make the S3 bucket public.

| Cognito group | Collection | Upload access |
| --- | --- | --- |
| `admin` | `/gallery/months/` | Yes |
| `viewers` | `/gallery/months/` | No |
| `test` | `/gallery/test/` | No, unless independently an admin |
| No permitted role or test claim | Denied by the backend | No |

The Lambda also recognizes `admins`/`viewer` aliases and supported test claims; see the [backend runbook](app/backend/README.md). A test designation takes precedence for collection routing. An account name containing “admin” grants no permissions. User creation and group assignment are separate operations.

The monthly gallery has 60 slots across five years. Display labels are months 1–60; new upload paths use internal month IDs 0–59. Admin upload tiles are inside month detail views. The test gallery supports media filters.

## Review findings — 2026-09-10

- **Initial review: supplied-account access was blocked (membership subsequently fixed by the owner).** AWS confirmed the reviewed account is enabled and `CONFIRMED`, with no Cognito group memberships. The browser reached the gallery and displayed “This account is not assigned to a gallery role.” A permitted group must be assigned intentionally, followed by a fresh sign-in. Account details and credentials are not stored here. No role changes were made.
- **Fixed locally in the monthly album update: manifest cache crossed account boundaries.** `gallery/app.js` caches manifests for one hour in `localStorage`, keyed only by collection, and can return them before contacting the backend. Logout clears auth storage but leaves this cache. A subsequent account on the same browser can receive the previous account's media URLs and admin UI state. Upload authorization still runs on the backend. Scope cached data to the user, clear it on logout/account changes, and revalidate authorization before displaying it. This finding comes from source inspection; a two-account reproduction was not performed.
- **Media access can outlast a session.** Lambda clamps the signing window to at least one year and rounds expiry to the next window boundary. Remaining URL validity varies within that window; logout does not revoke already-issued URLs. The browser also receives a one-year immutable media cache policy. Shortening URL validity requires changing the Lambda clamp as well as Terraform configuration; already-cached media cannot be recalled.
- **WAF documentation was stale.** Current Terraform contains no WAF resources; the regional AWS WAF ACL listing was empty. Do not claim an active custom CAPTCHA or WAF rate-blocking layer. Cognito username-existence suppression is enabled.
- **Production apply prerequisites are missing locally.** This checkout has no production state, `terraform.tfvars`, initialized `.terraform/` directory, or gallery signing PEM files. Recover and verify the existing state/configuration/key material before planning changes. Do not initialize an empty state and treat an apply as an update to the deployed stack.
- **Fixed locally in the monthly album update: long-open pages could use expired tokens.** The gallery obtains its session once at startup and reuses it for refresh/upload requests. Although `auth/auth.js` supports token refresh, these later actions do not request a fresh session. Reacquire a valid session before API actions. This is a source finding; a one-hour browser soak was not run.

Live checks: signed-out gallery navigation returned to the homepage; unauthenticated manifest **GET returned 401**; unsigned CloudFront media and direct S3 media requests returned **403**. Both buckets have all four S3 public-access-block flags enabled. The Lambda was Active with a Successful last update; both API routes require JWT authorization. The live root HTML, root script, auth helper, and gallery script matched this checkout byte for byte.

Validation: JavaScript syntax checks and Terraform formatting checks passed. No Terraform plan/apply or full validation was run with the missing deployment inputs. A follow-up on 2026-09-10 confirmed password authentication through the configured Cognito client, an authorized production manifest response, and successful signed byte-range reads of four existing image/video objects. S3 still contains the gallery media. End-to-end Hosted UI/browser rendering, production uploads, password reset, and viewer/test-account behavior remain unverified in this review. The subsequent local frontend changes and their validation are recorded above. No AWS infrastructure was changed.

The Figma empty-state concept and synthetic local QA screenshots are design previews, not screenshots of production family photos. Before this release, a follow-up byte comparison confirmed the public gallery HTML, gallery script, and auth script matched the previous committed version. After changing Cognito group membership, sign out and sign in again to obtain current role claims. The owner subsequently confirmed the existing photos were visible.

## Repository map

```text
README.md                       Project overview and current review
.codex/memory.md                Repository handoff notes
index.html / index-bg.html      English/Bulgarian public landing pages
style.css / script.js           Shared public-site styling and behavior
auth/                          Cognito login helper and callback
gallery/                       Router, monthly vault, test gallery, shared UI
gallery/months/album.css        Monthly album styling
tests/gallery.test.cjs          Dependency-free gallery/auth regression tests
images/                        Public website assets
everyday_dandelion/             Companion microsite
everyday_storage/               Companion microsite
everyday_stuff/                 Other app pages and quiz content
app/backend/README.md           AWS operations and deployment prerequisites
app/backend/live/prod/          Terraform and Lambda source
cleanup.sh                     Destructive backend teardown helper
```

## Local development

No package installation or website build step is required.

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [localhost:8000](http://localhost:8000/). Prefer `localhost` to the numeric loopback URL: Cognito allows `http://localhost:8000/auth/callback.html`, and previous browser sessions have shown unrelated cached content at the numeric address. The local gallery uses the real configured AWS backend; it is not a sandbox. Tailwind and Google Fonts currently load from CDNs.

Useful non-deploying checks:

```bash
node --test tests/gallery.test.cjs
node --check script.js
node --check auth/auth.js
node --check gallery/app.js
node --check app/backend/live/prod/lambda/gallery_manifest/index.mjs
terraform fmt -check app/backend/live/prod
git diff --check
```

Keep English/Bulgarian root pages aligned when changing shared login behavior or copy. Keep this README, `.codex/memory.md`, and the [backend runbook](app/backend/README.md) consistent. Do not commit credentials, session tokens, signed media URLs, private media filenames, signing keys, production variables, or Terraform state.

`cleanup.sh` runs **terraform destroy** and then deletes local state and Terraform artifacts. It is not a build cleanup command or a login repair tool.
