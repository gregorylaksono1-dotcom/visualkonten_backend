const { response, getClaims, usageEmailCandidates, mapUserRequestUsageRow, getJakartaISOString } = require("../utils");
const { scanUserRequestsForUsage, queryUserRequestsByEmail, s3Client, GetObjectCommand, getSignedUrl } = require("../services");

const USER_REQUEST_TABLE_NAME = process.env.USER_REQUEST_TABLE_NAME;
const USER_REQUEST_USER_EMAIL_INDEX = process.env.USER_REQUEST_USER_EMAIL_INDEX;

exports.handleGetUsage = async (event) => {
  const claims = getClaims(event);
  const email = claims.email || claims.username;
  if (!email) return response(401, { error: "Unauthorized: missing email." });

  const qsp = event.queryStringParameters || {};
  const sinceDays = Number(qsp.since_days || 30);
  const limit = Math.min(Number(qsp.limit || 100), 200);
  const nextToken = qsp.next_token;

  const sinceIso = getJakartaISOString(new Date(Date.now() - sinceDays * 24 * 3600 * 1000));
  const candidates = usageEmailCandidates(email);
  const byUuid = new Map();
  let lastEvaluatedKey = null;

  if (USER_REQUEST_USER_EMAIL_INDEX) {
    for (const em of candidates) {
      try {
        const result = await queryUserRequestsByEmail(em, sinceIso, limit, nextToken);
        for (const it of result.items) byUuid.set(it.uuid, it);
        if (result.lastEvaluatedKey) {
          lastEvaluatedKey = Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString("base64");
        }
      } catch (err) {
        console.error("GET /usage GSI error", err.message);
      }
    }
  }

  const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";

  const items = [...byUuid.values()];
  if (!items.length && !nextToken) {
    const scanned = await scanUserRequestsForUsage(USER_REQUEST_TABLE_NAME, candidates, sinceIso, limit);
    for (const s of scanned) byUuid.set(s.uuid, s);
  }

  const finalItems = [...byUuid.values()];
  finalItems.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  const processed = await Promise.all(finalItems.slice(0, limit).map(async (it) => {
    const row = mapUserRequestUsageRow(it);
    
    // Sign result_url if exists
    if (row.result_url && !row.result_url.startsWith("http")) {
      try {
        row.result_url = await getSignedUrl(s3Client, new GetObjectCommand({ 
          Bucket: S3_RESOURCE_BUCKET, 
          Key: row.result_url 
        }), { expiresIn: 3600 });
      } catch (e) {}
    }

    // Sign generated_image as thumbnail_url
    if (row.generated_image) {
      try {
        row.thumbnail_url = await getSignedUrl(s3Client, new GetObjectCommand({ 
          Bucket: S3_RESOURCE_BUCKET, 
          Key: row.generated_image 
        }), { expiresIn: 3600 });
      } catch (e) {}
    }

    // Sign s3_keys if exists
    if (row.s3_keys && Array.isArray(row.s3_keys)) {
      row.s3_keys = await Promise.all(row.s3_keys.map(async (key) => {
        if (key && !key.startsWith("http")) {
          try {
            return await getSignedUrl(s3Client, new GetObjectCommand({ 
              Bucket: S3_RESOURCE_BUCKET, 
              Key: key 
            }), { expiresIn: 3600 });
          } catch (e) {
            return key;
          }
        }
        return key;
      }));
    }

    return row;
  }));

  return response(200, {
    data: processed,
    next_token: lastEvaluatedKey,
  });
};
