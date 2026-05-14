/**
 * Utility functions for Worker A
 */

"use strict";

const parseBody = (event) => {
  if (!event || !event.body) return {};
  try {
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch (err) {
    console.error("parseBody error", err);
    return {};
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": true,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
  },
  body: JSON.stringify(body),
});

const normalizeUserEmail = (raw) => String(raw || "").trim().toLowerCase();

const usageEmailCandidates = (raw) => {
  const trimmed = String(raw || "").trim();
  const lower = trimmed.toLowerCase();
  const out = [];
  if (trimmed) out.push(trimmed);
  if (lower && lower !== trimmed) out.push(lower);
  return out;
};

const mapUserRequestUsageRow = (item) => ({
  uuid: item.uuid,
  prompt: item.prompt,
  request_type: item.request_type,
  resource_family: item.resource_family,
  credit_amount: item.credit_amount,
  status: item.status,
  created_at: item.created_at,
  s3_keys: item.s3_keys ?? null,
  result_url: item.result_url ?? null,
});

const parseImageBase64 = (raw) => {
  if (raw == null || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^data:([^;]+);base64,(.+)$/i);
  if (m) {
    return { contentType: m[1], buffer: Buffer.from(m[2], "base64") };
  }
  return { contentType: "image/jpeg", buffer: Buffer.from(s, "base64") };
};

const extFromContentType = (ct) => {
  const c = String(ct || "").toLowerCase();
  if (c.includes("png")) return "png";
  if (c.includes("webp")) return "webp";
  if (c.includes("gif")) return "gif";
  return "jpg";
};

const ALLOWED_VIDEO_QUALITY = new Set(["480p", "720p", "1080p"]);
const ALLOWED_ASPECT_RATIO = new Set(["9:16", "16:9", "1:1"]);

const normalizeVideoQuality = (raw) => {
  const q = String(raw || "720p").trim().toLowerCase();
  return ALLOWED_VIDEO_QUALITY.has(q) ? q : "720p";
};

const normalizeAspectRatio = (raw) => {
  const a = String(raw || "16:9").trim();
  return ALLOWED_ASPECT_RATIO.has(a) ? a : "16:9";
};

const pathEndsWithResource = (event, suffix) => {
  const p = event.path || "";
  const rp = event.requestContext?.resourcePath || event.resource || "";
  return p.endsWith(suffix) || rp === suffix;
};

const parseCreditsFromPricingItem = (item) => {
  if (!item) return NaN;
  const raw = item.amount ?? item.credits ?? item.charge;
  if (raw === undefined || raw === null || raw === "") return NaN;
  const n = Math.round(Number(String(raw).trim()));
  return n;
};

const getClaims = (event) => event?.requestContext?.authorizer?.claims || {};

const generateFriendlyOrderId = (userId) => {
  const safeUserId = String(userId || "usr").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const shortUserPrefix = (safeUserId.slice(0, 3) || "usr").padEnd(3, "x");
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const timestamp =
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());

  return `${shortUserPrefix}-${timestamp}`;
};

const formatMidtransStartTime = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second} +0700`;
};

const pickEnabledPaymentsByNominal = (nominal) => {
  if (nominal < 20000) return ["shopeepay", "gopay", "qris"];
  if (nominal > 1000000) return ["credit_card", "bca_va", "bni_va", "mandiri_clickpay"];
  return ["bca_va", "gopay", "qris", "shopeepay", "echannel"];
};

const buildCreditStatusFilterParts = (statusGroup) => {
  const g = String(statusGroup || "all").toLowerCase();
  if (g === "all") return null;
  const names = { "#st": "status" };
  if (g === "success") {
    return {
      FilterExpression: "#st IN (:s0, :s1, :s2, :s3)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ":s0": "SUCCESS", ":s1": "SETTLEMENT", ":s2": "BERHASIL", ":s3": "CAPTURE" },
    };
  }
  if (g === "pending") {
    return {
      FilterExpression: "#st IN (:p0, :p1)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ":p0": "PENDING", ":p1": "MENUNGGU" },
    };
  }
  if (g === "failed") {
    return {
      FilterExpression: "(attribute_not_exists(#st) OR NOT (#st IN (:s0, :s1, :s2, :s3, :p0, :p1)))",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: {
        ":s0": "SUCCESS", ":s1": "SETTLEMENT", ":s2": "BERHASIL", ":s3": "CAPTURE",
        ":p0": "PENDING", ":p1": "MENUNGGU"
      },
    };
  }
  return null;
};

module.exports = {
  parseBody,
  response,
  normalizeUserEmail,
  usageEmailCandidates,
  mapUserRequestUsageRow,
  parseImageBase64,
  extFromContentType,
  normalizeVideoQuality,
  normalizeAspectRatio,
  pathEndsWithResource,
  parseCreditsFromPricingItem,
  getClaims,
  generateFriendlyOrderId,
  formatMidtransStartTime,
  pickEnabledPaymentsByNominal,
  buildCreditStatusFilterParts,
};
