/**
 * Worker A: Main API Gateway Handler
 * Handles HTTP requests for resources, credits, and pricing.
 */

"use strict";

const { randomUUID } = require("crypto");
const {
  parseBody,
  response,
  normalizeUserEmail,
  usageEmailCandidates,
  mapUserRequestUsageRow,
  parseImageBase64,
  extFromContentType,
  normalizeVideoQuality,
  normalizeAspectRatio,
  getClaims,
  generateFriendlyOrderId,
  formatMidtransStartTime,
  pickEnabledPaymentsByNominal,
  buildCreditStatusFilterParts,
} = require("./utils");

const {
  docClient,
  s3Client,
  QueryCommand,
  PutCommand,
  TransactWriteCommand,
  enqueueJob,
  invokeComfyUI,
  resolvePricingRow,
  scanUserRequestsForUsage,
  queryCreditHistoryPaged,
  getLatestCreditMetrics,
  createMidtransSnapTransaction,
  uploadToS3,
  getSignedUrl,
  GetObjectCommand,
} = require("./services");

// Environment variables
const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;
const TOPUP_CREDIT_TABLE_NAME = process.env.TOPUP_CREDIT_TABLE_NAME;
const USER_REQUEST_TABLE_NAME = process.env.USER_REQUEST_TABLE_NAME;
const USER_REQUEST_USER_EMAIL_INDEX = process.env.USER_REQUEST_USER_EMAIL_INDEX;
const PRICING_TABLE_NAME = process.env.PRICING_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const MIDTRANS_FINISH_CALLBACK_URL = process.env.MIDTRANS_FINISH_CALLBACK_URL;
const GENERATION_BACKEND = process.env.GENERATION_BACKEND || "redis";

// ─── Handlers ────────────────────────────────────────────────────────────────

const handleGetHello = async () => response(200, { message: "Hello World from BikinAi.com backend!" });

const handleGetUser = async (event) => {
  const userId = getClaims(event).sub;
  if (!userId) return response(401, { error: "Unauthorized: missing user id claim." });

  const result = await docClient.send(new QueryCommand({
    TableName: PROFILE_TABLE_NAME,
    KeyConditionExpression: "user_id = :userId",
    ExpressionAttributeValues: { ":userId": userId },
    Limit: 1,
  }));
  return response(200, { data: result.Items?.[0] || null });
};

const handleGetPricing = async (event, pricingKeyParam) => {
  const decodedKey = decodeURIComponent(String(pricingKeyParam).trim());
  if (!decodedKey) return response(400, { error: "Missing pricing key." });

  const resolved = await resolvePricingRow(decodedKey);
  if (!resolved) return response(404, { error: `Pricing not found for key "${decodedKey}".` });

  return response(200, {
    data: { key: resolved.item.key, charge: resolved.item.charge, amount: resolved.amount },
  });
};

const handleGetTopup = async (event, topupOrderId) => {
  const userEmail = getClaims(event).email;
  if (!userEmail) return response(401, { error: "Unauthorized: missing email claim." });

  const decodedId = decodeURIComponent(String(topupOrderId));
  const res = await docClient.send(new QueryCommand({
    TableName: TOPUP_CREDIT_TABLE_NAME,
    KeyConditionExpression: "uuid = :orderId",
    ExpressionAttributeValues: { ":orderId": decodedId },
  }));
  const item = res.Items?.[0];
  if (!item) return response(404, { error: "Order not found." });
  if (normalizeUserEmail(item.user_email) !== normalizeUserEmail(userEmail)) {
    return response(403, { error: "Access denied." });
  }
  return response(200, { data: item });
};

const handleGetCredit = async (event) => {
  const userEmail = getClaims(event).email;
  if (!userEmail) return response(401, { error: "Unauthorized: missing email." });

  const qsp = event.queryStringParameters || {};
  const statusGroup = qsp.status || "all";
  const limit = Math.min(Number(qsp.limit || 50), 200);
  const nextToken = qsp.next_token;

  let startKey = null;
  if (nextToken) {
    try {
      startKey = JSON.parse(Buffer.from(nextToken, "base64").toString());
    } catch (e) {}
  }

  const metrics = await getLatestCreditMetrics(userEmail);
  const filter = buildCreditStatusFilterParts(statusGroup);
  const paged = await queryCreditHistoryPaged(userEmail, filter, limit, 50, 10, startKey);

  const resNextToken = paged.lastEvaluatedKey 
    ? Buffer.from(JSON.stringify(paged.lastEvaluatedKey)).toString("base64")
    : null;

  return response(200, {
    data: {
      user_email: userEmail,
      credit_balance: metrics.balance,
      credit_usage: metrics.usage,
      history: paged.items,
      next_token: resNextToken,
    },
  });
};

const handleGetUsage = async (event) => {
  const claims = getClaims(event);
  const email = claims.email || claims.username;
  if (!email) return response(401, { error: "Unauthorized: missing email." });

  const qsp = event.queryStringParameters || {};
  const sinceDays = Number(qsp.since_days || 30);
  const limit = Math.min(Number(qsp.limit || 100), 200);
  const nextToken = qsp.next_token;

  const sinceIso = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
  const candidates = usageEmailCandidates(email);
  const byUuid = new Map();
  let lastEvaluatedKey = null;

  if (USER_REQUEST_USER_EMAIL_INDEX) {
    for (const em of candidates) {
      try {
        const queryParams = {
          TableName: USER_REQUEST_TABLE_NAME,
          IndexName: USER_REQUEST_USER_EMAIL_INDEX,
          KeyConditionExpression: "user_email = :e AND created_at >= :c",
          ExpressionAttributeValues: { ":e": em, ":c": sinceIso },
          ScanIndexForward: false,
          Limit: limit,
        };
        if (nextToken) {
          try {
            queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString());
          } catch (e) {}
        }

        const res = await docClient.send(new QueryCommand(queryParams));
        for (const it of res.Items || []) byUuid.set(it.uuid, it);
        if (res.LastEvaluatedKey) {
          lastEvaluatedKey = Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64");
        }
      } catch (err) {
        console.error("GET /usage GSI error", err.message);
      }
    }
  }

  let items = [...byUuid.values()];
  if (!items.length && !nextToken) {
    items = await scanUserRequestsForUsage(USER_REQUEST_TABLE_NAME, candidates, sinceIso, limit);
  } else {
    items.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }

  return response(200, {
    data: items.slice(0, limit).map(mapUserRequestUsageRow),
    next_token: lastEvaluatedKey,
  });
};

const handlePostSnap = async (event) => {
  const claims = getClaims(event);
  const userEmail = claims.email || claims.username;
  const userId = claims.sub;
  if (!userEmail || !userId) return response(401, { error: "Unauthorized." });

  const body = parseBody(event);
  const { total_credit, total_price } = body;
  if (!total_credit || !total_price) return response(400, { error: "Missing required fields." });

  const orderId = generateFriendlyOrderId(userId);
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: TOPUP_CREDIT_TABLE_NAME,
    Item: {
      uuid: orderId, user_email: userEmail, user_id: userId,
      created_at: now, updated_at: now, amount: total_credit, total: total_price, status: "PENDING",
    },
  }));

  const midtransBody = {
    transaction_details: { order_id: orderId, gross_amount: total_price },
    enabled_payments: pickEnabledPaymentsByNominal(total_price),
    customer_details: { first_name: claims.name || "Customer", email: userEmail, user_id: userId },
    expiry: { start_time: formatMidtransStartTime(), unit: "minutes", duration: 60 },
    custom_field1: userId, custom_field2: userEmail, custom_field3: orderId,
  };

  const finishCallback = body.finish_callback_url || MIDTRANS_FINISH_CALLBACK_URL;
  if (finishCallback) midtransBody.callbacks = { finish: finishCallback };

  try {
    const snapData = await createMidtransSnapTransaction(midtransBody);
    return response(200, { data: { ...snapData, order_id: orderId } });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

const handlePostResource = async (event) => {
  const claims = getClaims(event);
  const userEmail = normalizeUserEmail(claims.email || claims.username);
  const userId = claims.sub;
  if (!userEmail || !userId) return response(401, { error: "Unauthorized." });

  const body = parseBody(event);
  const prompt = String(body.prompt || "").trim();
  const imageBase64_1 = body.image_base64_1 || body.image_base64 || "";
  const imageBase64_2 = body.image_base64_2 || "";
  const hasImage = Boolean(imageBase64_1.trim() || imageBase64_2.trim());
  const resourceFamily = String(body.resource_family || "image").toLowerCase() === "video" ? "video" : "image";

  let requestType = body.request_type;
  let pricingKey;

  const videoQuality = normalizeVideoQuality(body.video_quality);
  const aspectRatio = normalizeAspectRatio(body.aspect_ratio);
  const videoOptions = resourceFamily === "video" ? { video_quality: videoQuality, aspect_ratio: aspectRatio } : {};

  if (resourceFamily === "video") {
    if (!requestType) requestType = hasImage ? "image-to-video" : "text-to-video";
    pricingKey = `${hasImage ? "IMAGE-TO-VIDEO" : "TEXT-TO-VIDEO"}-${videoQuality.replace("p", "")}`;
  } else {
    if (!requestType) requestType = imageBase64_2.trim() ? "image-to-image2" : (imageBase64_1.trim() ? "image-to-image1" : "text-to-image");
    pricingKey = hasImage ? "IMAGE-TO-IMAGE" : "TEXT-TO-IMAGE";
  }

  if (!prompt) return response(400, { error: "prompt is required." });

  const pricing = await resolvePricingRow(pricingKey);
  if (!pricing) return response(404, { error: `Pricing not found for ${pricingKey}.` });

  const requestId = randomUUID();
  const now = new Date().toISOString();

  const runResourceTransact = async (putItem) => {
    try {
      await docClient.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: USER_REQUEST_TABLE_NAME, Item: putItem } },
          { Update: {
            TableName: PROFILE_TABLE_NAME,
            Key: { user_id: String(userId), user_type: "CUSTOMER" },
            UpdateExpression: "SET credit_balance = if_not_exists(credit_balance, :z) - :c, credit_usage = if_not_exists(credit_usage, :z) + :c, updated_at = :now",
            ConditionExpression: "attribute_exists(user_id) AND credit_balance >= :c",
            ExpressionAttributeValues: { ":z": 0, ":c": pricing.amount, ":now": now },
          }},
        ],
      }));
      return null;
    } catch (err) {
      console.error("Transact error", err.message);
      return response(err.name === "TransactionCanceledException" ? 402 : 500, { error: err.message });
    }
  };

  const imagesToUpload = [];
  if (imageBase64_1.trim()) imagesToUpload.push({ base64: imageBase64_1, suffix: "1" });
  if (imageBase64_2.trim()) imagesToUpload.push({ base64: imageBase64_2, suffix: "2" });

  const s3Keys = [];
  const s3ImageUrls = [];

  for (const img of imagesToUpload) {
    const parsed = parseImageBase64(img.base64);
    if (!parsed) continue;
    const s3Key = `user_request/${userId}/${requestId}_${img.suffix}.${extFromContentType(parsed.contentType)}`;
    try {
      await uploadToS3(S3_RESOURCE_BUCKET, s3Key, parsed.buffer, parsed.contentType);
      s3Keys.push(s3Key);
      s3ImageUrls.push(await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: s3Key }), { expiresIn: 3600 }));
    } catch (err) { return response(502, { error: "S3 upload failed." }); }
  }

  const putItem = {
    uuid: requestId, user_email: userEmail, user_id: userId, prompt, request_type: requestType,
    resource_family: resourceFamily, status: "PENDING", credit_amount: pricing.amount,
    created_at: now, updated_at: now, s3_key: s3Keys[0] || null, s3_keys: s3Keys, ...videoOptions,
  };

  const errRes = await runResourceTransact(putItem);
  if (errRes) return errRes;

  const jobPayload = { jobId: requestId, userEmail, requestType, prompt, videoQuality, aspectRatio, s3ImageUrls };
  if (GENERATION_BACKEND === "comfyui") await invokeComfyUI(requestId, jobPayload);
  else await enqueueJob(requestId, { ...jobPayload, user_id: userId, user_email: userEmail, s3_key: s3Keys[0] });

  return response(200, { data: { ...putItem } });
};

// ─── Main Handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const { httpMethod, path, pathParameters } = event;
    const route = `${httpMethod} ${path}`;

    if (route === "GET /hello") return handleGetHello();
    if (route === "GET /user") return handleGetUser(event);
    if (route === "GET /credit") return handleGetCredit(event);
    if (route === "GET /usage") return handleGetUsage(event);
    if (route.startsWith("GET /pricing/")) return handleGetPricing(event, pathParameters.key);
    if (route.startsWith("GET /topup/")) return handleGetTopup(event, pathParameters.order_id);
    if (route === "POST /snap") return handlePostSnap(event);
    if (route === "POST /resource") return handlePostResource(event);

    return response(404, { error: `Route ${route} not found.` });
  } catch (err) {
    console.error("Global handler error", err);
    return response(500, { error: err.message });
  }
};
