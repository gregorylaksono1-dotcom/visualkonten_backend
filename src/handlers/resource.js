const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { response, getClaims, normalizeUserEmail, parseBody, parseImageBase64, extFromContentType, normalizeVideoQuality, normalizeAspectRatio } = require("../utils");
const { docClient, s3Client, TransactWriteCommand, GetObjectCommand, uploadToS3, getSignedUrl, resolvePricingRow, enqueueJob, invokeComfyUI, callOpenAILLM, PutCommand } = require("../services");

const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;
const USER_REQUEST_TABLE_NAME = process.env.USER_REQUEST_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const GENERATION_BACKEND = process.env.GENERATION_BACKEND || "redis";

exports.handlePostResource = async (event) => {
  const claims = getClaims(event);
  const userEmail = normalizeUserEmail(claims.email || claims.username);
  const userId = claims.sub;
  if (!userEmail || !userId) return response(401, { error: "Unauthorized." });

  const body = parseBody(event);
  const prompt = String(body.prompt || "").trim();
  const imageBase64_1 = body.image_base64_1 || body.image_base_64_1 || body.image_base64 || "";
  const imageBase64_2 = body.image_base64_2 || body.image_base_64_2 || "";
  const hasImage = Boolean(imageBase64_1.trim() || imageBase64_2.trim());
  const resourceFamily = String(body.resource_family || "image").toLowerCase() === "video" ? "video" : "image";

  let requestType = body.request_type;
  let pricingKey;

  const videoQuality = normalizeVideoQuality(body.video_quality);
  const aspectRatio = normalizeAspectRatio(body.aspect_ratio);
  const videoOptions = resourceFamily === "video" ? { video_quality: videoQuality, aspect_ratio: aspectRatio } : {};

  if (resourceFamily === "video") {
    if (!requestType) requestType = hasImage ? "image-to-video" : "text-to-video";
    if (requestType === "multi-shot-video") {
      pricingKey = body.ugc_mode === "toko" ? "UGC-S" : "UGC-P";
      requestType = pricingKey;
    } else {
      pricingKey = `${hasImage ? "IMAGE-TO-VIDEO" : "TEXT-TO-VIDEO"}-${videoQuality.replace("p", "")}`;
    }
  } else {
    if (!requestType) requestType = imageBase64_2.trim() ? "image-to-image2" : (imageBase64_1.trim() ? "image-to-image1" : "text-to-image");
    pricingKey = hasImage ? "IMAGE-TO-IMAGE" : "TEXT-TO-IMAGE";
  }

  if (!prompt) return response(400, { error: "prompt is required." });

  const pricing = await resolvePricingRow(pricingKey);
  if (!pricing) return response(404, { error: `Pricing not found for ${pricingKey}.` });

  let finalAmount = pricing.amount;
  if ((requestType === "UGC-P" || requestType === "UGC-S") && pricing.item.attr) {
    let parsedAttr = null;
    try {
      parsedAttr = typeof pricing.item.attr === "string" ? JSON.parse(pricing.item.attr) : pricing.item.attr;
    } catch (e) {}
    if (parsedAttr) {
      const qNum = videoQuality.replace("p", "");
      const attrKey = `${qNum}`;
      if (parsedAttr[attrKey] !== undefined) {
        finalAmount = Number(parsedAttr[attrKey]);
      }
    }
  }

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
            ExpressionAttributeValues: { ":z": 0, ":c": finalAmount, ":now": now },
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
    } catch (err) { 
      console.error("S3 upload error:", err);
      return response(502, { error: `S3 upload failed: ${err.message}` }); 
    }
  }

  const putItem = {
    uuid: requestId, user_email: userEmail, user_id: userId, prompt, request_type: requestType,
    resource_family: resourceFamily, status: "PENDING", credit_amount: finalAmount,
    created_at: now, updated_at: now, s3_keys: s3Keys, ...videoOptions,
    ugc_mode: body.ugc_mode || null,
    store_type: body.store_type || null,
  };

  const errRes = await runResourceTransact(putItem);
  if (errRes) return errRes;

  // The heavy lifting (OpenAI LLM & Vertex AI) is now moved to the Worker (WorkerB or ComfyUIWorker)
  // to make this API call "fire and forget" for the dashboard.
  
  const jobPayload = { 
    jobId: requestId, 
    userEmail, 
    requestType, 
    prompt, // Pass the original prompt, the worker will handle LLM if needed
    videoQuality, 
    aspectRatio, 
    s3ImageUrls,
    s3_keys: s3Keys,
    userId,
    ugc_mode: body.ugc_mode || null
  };
  
  if (GENERATION_BACKEND === "comfyui") await invokeComfyUI(requestId, jobPayload);
  else await enqueueJob(requestId, { ...jobPayload, user_id: userId, user_email: userEmail });

  return response(200, { data: { ...putItem } });
};
exports.handleGetPresigned = async (event) => {
  const claims = getClaims(event);
  if (!claims.sub) return response(401, { error: "Unauthorized." });

  const qs = event.queryStringParameters || {};
  const key = qs.key;
  if (!key) return response(400, { error: "key is required." });

  try {
    const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
    const url = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
    return response(200, { data: { url } });
  } catch (err) {
    console.error("handleGetPresigned error", err);
    return response(500, { error: "Failed to generate presigned URL." });
  }
};
