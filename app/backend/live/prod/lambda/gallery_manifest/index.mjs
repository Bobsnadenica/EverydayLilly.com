import { HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const s3 = new S3Client({});

const bucketName = process.env.GALLERY_BUCKET;
const defaultPrefix = normalizePrefix(process.env.GALLERY_DEFAULT_PREFIX || "months");
const testPrefix = normalizePrefix(process.env.GALLERY_TEST_PREFIX || "test");
const publicBaseUrl = (process.env.GALLERY_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const signerKeyPairId = process.env.GALLERY_SIGNER_KEY_PAIR_ID || "";
const defaultCacheVersion = normalizeCacheVersion(process.env.GALLERY_CACHE_VERSION || "v1");
const minimumSignedUrlTtlSeconds = 365 * 24 * 60 * 60;
const configuredSignedUrlTtlSeconds = Number.parseInt(process.env.GALLERY_SIGNED_URL_TTL || "31536000", 10);
const signedUrlTtlSeconds = Number.isFinite(configuredSignedUrlTtlSeconds)
  ? Math.max(configuredSignedUrlTtlSeconds, minimumSignedUrlTtlSeconds)
  : minimumSignedUrlTtlSeconds;
const mediaExtensionPattern = /\.(avif|gif|jpe?g|m4v|mov|mp4|png|webm|webp)$/i;
const heroExtensionPattern = /\.(avif|gif|jpe?g|png|webp)$/i;
const configuredUploadUrlTtlSeconds = Number.parseInt(process.env.GALLERY_UPLOAD_URL_TTL || "900", 10);
const uploadUrlTtlSeconds = Number.isFinite(configuredUploadUrlTtlSeconds)
  ? Math.max(60, Math.min(configuredUploadUrlTtlSeconds, 900))
  : 900;
const uploadPath = process.env.GALLERY_UPLOAD_PATH || "/api/gallery/upload-url";
const galleryMonthCount = 60;
const adminGroupNames = new Set(["admin", "admins"]);
const viewerGroupNames = new Set(["viewer", "viewers"]);
const mediaContentTypesByExtension = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".m4v", "video/x-m4v"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
]);

let cachedPrivateKey = null;

function getPrivateKey() {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }
  try {
    cachedPrivateKey = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, "gallery_private_key.pem"), "utf8"));
    return cachedPrivateKey;
  } catch (error) {
    console.error("Unable to read local private key.", error);
    throw new Error("Gallery manifest signing key is missing.");
  }
}

function normalizePrefix(prefix) {
  return String(prefix || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

function normalizeCacheVersion(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 64);

  return normalized || "v1";
}

function sanitizeOptionalCacheVersion(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 64);

  return normalized || "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}

function normalizeClaimValues(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    ) {
      try {
        return normalizeClaimValues(JSON.parse(trimmed));
      } catch (error) {
        console.warn("Unable to parse structured claim string.", error);
      }
    }

    return value
      .split(/[\s,;|]+/)
      .map((entry) => entry.trim().toLowerCase().replace(/^[\[\]"']+|[\[\]"']+$/g, ""))
      .filter(Boolean);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value).trim().toLowerCase()];
  }

  return [];
}

function getGroups(claims) {
  return normalizeClaimValues(claims?.["cognito:groups"]);
}

function isGalleryAdmin(claims) {
  return getGroups(claims).some((group) => adminGroupNames.has(group));
}

function isGalleryViewer(claims) {
  return getGroups(claims).some((group) => viewerGroupNames.has(group) || adminGroupNames.has(group));
}

function hasGalleryAccess(claims) {
  return isGalleryViewer(claims) || isTestAccount(claims);
}

function getMediaKind(key) {
  if (/\.gif$/i.test(key)) {
    return "gif";
  }

  if (/\.(m4v|mov|mp4|webm)$/i.test(key)) {
    return "movie";
  }

  return "picture";
}

function isTestAccount(claims) {
  const target = "test";
  const groups = normalizeClaimValues(claims?.["cognito:groups"]);

  if (groups.includes(target)) {
    return true;
  }

  const tagKeys = ["custom:tag", "custom:tags", "tag", "tags"];
  const tags = tagKeys.flatMap((key) => normalizeClaimValues(claims?.[key]));

  if (tags.includes(target)) {
    return true;
  }

  return ["custom:test", "test"].some((key) => {
    const values = normalizeClaimValues(claims?.[key]);
    return values.includes("true") || values.includes(target);
  });
}

function encodePathSegments(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function buildCannedPolicy(resourceUrl, expiresAtEpochSeconds) {
  return JSON.stringify({
    Statement: [
      {
        Resource: resourceUrl,
        Condition: {
          DateLessThan: {
            "AWS:EpochTime": expiresAtEpochSeconds,
          },
        },
      },
    ],
  });
}

function signPolicy(policy) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(policy);
  const signature = signer.sign(getPrivateKey(), "base64");
  return signature.replace(/\+/g, "-").replace(/\//g, "~").replace(/=/g, "_");
}

async function listGalleryItems(prefix) {
  const items = [];
  let continuationToken;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `${prefix}/`,
        ContinuationToken: continuationToken,
      })
    );

    for (const item of response.Contents || []) {
      if (item.Key && !item.Key.endsWith("/") && mediaExtensionPattern.test(item.Key)) {
        items.push({
          key: item.Key,
          lastModified: item.LastModified ? item.LastModified.toISOString() : null,
          size: item.Size ?? null,
          etag: String(item.ETag || "").replaceAll('"', ""),
        });
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return items.sort(compareGalleryItems);
}

function compareGalleryItems(left, right) {
  const leftTime = Date.parse(left.lastModified || "");
  const rightTime = Date.parse(right.lastModified || "");
  const leftHasTime = Number.isFinite(leftTime);
  const rightHasTime = Number.isFinite(rightTime);

  if (leftHasTime && rightHasTime && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  if (leftHasTime !== rightHasTime) {
    return leftHasTime ? -1 : 1;
  }

  return compareGalleryKeys(left.key, right.key);
}

function compareGalleryKeys(left, right) {
  const leftName = left.split("/").pop() || left;
  const rightName = right.split("/").pop() || right;
  const leftNumber = Number.parseInt(leftName, 10);
  const rightNumber = Number.parseInt(rightName, 10);
  const leftIsNumber = Number.isFinite(leftNumber);
  const rightIsNumber = Number.isFinite(rightNumber);

  if (leftIsNumber && rightIsNumber && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: "base" });
}

function buildLabel(key) {
  const filename = key.split("/").pop() || key;
  return filename.replace(/\.[^.]+$/, "");
}

export function thumbnailKey(item, prefix) {
  const digest = crypto.createHash("sha256").update(`${item.key}\n${item.etag}`).digest("hex");
  return `previews/${prefix}/${digest}.jpg`;
}

async function buildSignedMedia(item, expiresAtEpochSeconds, cacheVersion) {
  const key = typeof item === "string" ? item : item.key;
  const signedUrl = new URL(`${publicBaseUrl}/${encodePathSegments(key)}`);

  if (cacheVersion) {
    signedUrl.searchParams.set("v", cacheVersion);
  }

  const policy = buildCannedPolicy(signedUrl.toString(), expiresAtEpochSeconds);
  const signature = signPolicy(policy);

  signedUrl.searchParams.set("Expires", String(expiresAtEpochSeconds));
  signedUrl.searchParams.set("Signature", signature);
  signedUrl.searchParams.set("Key-Pair-Id", signerKeyPairId);
  signedUrl.searchParams.set("Hash-Algorithm", "SHA256");

  return {
    key,
    label: buildLabel(key),
    kind: getMediaKind(key),
    lastModified: typeof item === "string" ? null : item.lastModified,
    size: typeof item === "string" ? null : item.size,
    url: signedUrl.toString(),
  };
}

function getStableExpiryEpochSeconds() {
  const now = Math.floor(Date.now() / 1000);
  return Math.ceil(now / signedUrlTtlSeconds) * signedUrlTtlSeconds;
}

function getRequestMethod(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || "GET";
}

function getRequestPath(event) {
  return event?.rawPath || event?.path || "";
}

function parseJsonBody(event) {
  const rawBody = event?.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : "{}";

  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

function normalizeUploadMonth(value) {
  const month = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isInteger(month) || month < 0 || month >= galleryMonthCount) {
    throw Object.assign(new Error(`Choose a month between 0 and ${galleryMonthCount - 1}.`), { statusCode: 400 });
  }

  return month;
}

function normalizeUploadKind(value) {
  return String(value || "photo").trim().toLowerCase() === "hero" ? "hero" : "photo";
}

function sanitizeFilename(value) {
  const baseName = String(value || "")
    .split(/[\\/]/)
    .pop()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 140);

  if (!baseName || !mediaExtensionPattern.test(baseName)) {
    throw Object.assign(new Error("Upload a supported photo, GIF, or movie file."), { statusCode: 400 });
  }

  return baseName;
}

function getFileExtension(filename) {
  return (filename.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
}

function normalizeContentType(value, filename) {
  const fallback = mediaContentTypesByExtension.get(getFileExtension(filename)) || "application/octet-stream";
  const normalized = String(value || fallback).trim().toLowerCase();

  if (
    normalized.startsWith("image/") ||
    normalized === "video/mp4" ||
    normalized === "video/quicktime" ||
    normalized === "video/webm" ||
    normalized === "video/x-m4v"
  ) {
    return normalized === "image/jpg" ? "image/jpeg" : normalized;
  }

  return fallback;
}

function getUploadKey(uploadKind, month, filename) {
  if (uploadKind === "hero") {
    return `${defaultPrefix}/hero/${month}/${filename}`;
  }

  return `${defaultPrefix}/${month}/${filename}`;
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch (error) {
    const statusCode = error?.$metadata?.httpStatusCode;

    if (statusCode === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") {
      return false;
    }

    throw error;
  }
}

function hmac(key, data, encoding) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest(encoding);
}

function getSigningKey(secretAccessKey, dateStamp, region) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function buildCanonicalQuery(parameters) {
  return Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

function createPresignedPutUrl(key, contentType) {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-central-1";

  if (!accessKeyId || !secretAccessKey) {
    throw Object.assign(new Error("Lambda credentials are unavailable for upload signing."), { statusCode: 500 });
  }

  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const host = `${bucketName}.s3.${region}.amazonaws.com`;
  const canonicalUri = `/${encodePathSegments(key)}`;
  const signedHeaders = "content-type;host;if-none-match;x-amz-content-sha256";
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const queryParameters = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(uploadUrlTtlSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };

  if (sessionToken) {
    queryParameters["X-Amz-Security-Token"] = sessionToken;
  }

  const canonicalQuery = buildCanonicalQuery(queryParameters);
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    "if-none-match:*",
    "x-amz-content-sha256:UNSIGNED-PAYLOAD",
    "",
  ].join("\n");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signature = hmac(getSigningKey(secretAccessKey, dateStamp, region), stringToSign, "hex");

  queryParameters["X-Amz-Signature"] = signature;

  return {
    expiresInSeconds: uploadUrlTtlSeconds,
    headers: {
      "Content-Type": contentType,
      "If-None-Match": "*",
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    },
    url: `https://${host}${canonicalUri}?${buildCanonicalQuery(queryParameters)}`,
  };
}

async function handleUploadUrl(event, claims) {
  if (!isGalleryAdmin(claims)) {
    return json(403, {
      error: "Only gallery admins can upload photos.",
    });
  }

  const payload = parseJsonBody(event);
  const month = normalizeUploadMonth(payload.month);
  const uploadKind = normalizeUploadKind(payload.uploadKind || payload.kind || payload.target);
  const filename = sanitizeFilename(payload.filename);
  const contentType = normalizeContentType(payload.contentType, filename);

  if (uploadKind === "hero" && !heroExtensionPattern.test(filename)) {
    return json(400, {
      error: "Hero uploads must be image files.",
    });
  }

  const key = getUploadKey(uploadKind, month, filename);

  if (await objectExists(key)) {
    return json(409, {
      error: "A file with this name already exists for that month.",
      key,
    });
  }

  const upload = createPresignedPutUrl(key, contentType);

  return json(200, {
    key,
    uploadKind,
    contentType,
    ...upload,
  });
}

async function handleManifest(event, claims) {
  if (!publicBaseUrl || !signerKeyPairId) {
    return json(500, {
      error: "Gallery manifest backend is missing required configuration.",
    });
  }

  if (!hasGalleryAccess(claims)) {
    return json(403, {
      error: "This account is not assigned to a gallery role.",
    });
  }

  const refreshToken = sanitizeOptionalCacheVersion(event?.queryStringParameters?.refresh || "");
  const cacheVersion = refreshToken
    ? `${defaultCacheVersion}.${refreshToken}`
    : defaultCacheVersion;

  const isTest = isTestAccount(claims);
  const prefix = isTest ? testPrefix : defaultPrefix;
  const heroPrefix = `${prefix}/hero`;
  const items = await listGalleryItems(prefix);
  const previews = new Set((await listGalleryItems(`previews/${prefix}`)).map(item => item.key));
  const expiresAtEpochSeconds = getStableExpiryEpochSeconds();
  const photos = [];
  const heroPhotos = [];

  for (const item of items) {
    const signedMedia = await buildSignedMedia(item, expiresAtEpochSeconds, cacheVersion);
    const previewKey = thumbnailKey(item, prefix);
    if (previews.has(previewKey)) {
      signedMedia.thumbnailUrl = (await buildSignedMedia(previewKey, expiresAtEpochSeconds, cacheVersion)).url;
    }
    if (item.key.startsWith(heroPrefix)) {
      heroPhotos.push(signedMedia);
    } else {
      photos.push(signedMedia);
    }
  }

  return json(200, {
    collection: isTest ? "test" : "months",
    prefix,
    expiresAt: expiresAtEpochSeconds,
    cacheTtlSeconds: signedUrlTtlSeconds,
    cacheVersion,
    user: {
      email: claims.email || null,
      roles: getGroups(claims),
      canUpload: isGalleryAdmin(claims),
    },
    photos,
    heroPhotos,
  });
}

export const handler = async (event) => {
  try {
    if (!bucketName) {
      return json(500, {
        error: "Gallery backend is missing required bucket configuration.",
      });
    }

    const claims = event?.requestContext?.authorizer?.jwt?.claims || {};

    if (claims.token_use !== "id") {
      return json(403, {
        error: "Gallery requests must use a Cognito ID token.",
      });
    }

    const method = getRequestMethod(event).toUpperCase();
    const path = getRequestPath(event);

    if (method === "POST" && path === uploadPath) {
      return await handleUploadUrl(event, claims);
    }

    return await handleManifest(event, claims);
  } catch (error) {
    console.error("Unable to handle gallery request.", error);
    return json(error.statusCode || 500, {
      error: error.statusCode ? error.message : "Unable to load the private gallery right now.",
    });
  }
};
