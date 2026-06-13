const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { response, getClaims, normalizeUserEmail, parseBody, parseImageBase64, extFromContentType, normalizeVideoQuality, normalizeAspectRatio, getJakartaISOString } = require("../utils");
const { s3Client, GetObjectCommand, uploadToS3, getSignedUrl, resolvePricingRow, invokeFreeTrialWorker, invokeComfyUI, getCustomerProfile, executeResourceRequestTransaction } = require("../services");

const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const GENERATION_BACKEND = process.env.GENERATION_BACKEND || "comfyui";

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
  const isFreeTrialRequested = body.free_trial === true || String(body.free_trial).toLowerCase() === "true" || body.request_type === "FREE-TRIAL";

  let requestType = body.request_type;
  let pricingKey;

  const videoQuality = normalizeVideoQuality(body.video_quality);
  const aspectRatio = normalizeAspectRatio(body.aspect_ratio);
  const videoOptions = resourceFamily === "video" ? { video_quality: videoQuality, aspect_ratio: aspectRatio } : {};

  if (resourceFamily === "video") {
    if (isFreeTrialRequested) {
      requestType = "FREE-TRIAL";
      pricingKey = "FREE-TRIAL";
    } else if (!requestType) requestType = hasImage ? "image-to-video" : "text-to-video";
    if (!isFreeTrialRequested && requestType === "multi-shot-video") {
      pricingKey = body.ugc_mode === "toko" ? "UGC-S" : "UGC-P";
      requestType = pricingKey;
    } else if (!isFreeTrialRequested && (requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK")) {
      pricingKey = "PRODUCT-CINEMATIC";
    } else if (!isFreeTrialRequested) {
      pricingKey = `${hasImage ? "IMAGE-TO-VIDEO" : "TEXT-TO-VIDEO"}-${videoQuality.replace("p", "")}`;
    }
  } else {
    if (!requestType) requestType = imageBase64_2.trim() ? "image-to-image2" : (imageBase64_1.trim() ? "image-to-image1" : "text-to-image");
    pricingKey = hasImage ? "IMAGE-TO-IMAGE" : "TEXT-TO-IMAGE";
  }

  if (!prompt) return response(400, { error: "prompt is required." });
  if (requestType === "FREE-TRIAL" && !hasImage) {
    return response(400, { error: "FREE-TRIAL memerlukan minimal 1 gambar input." });
  }

  const pricing = await resolvePricingRow(pricingKey);
  if (!pricing) return response(404, { error: `Pricing not found for ${pricingKey}.` });

  let finalAmount = pricing.amount;
  if ((requestType === "UGC-P" || requestType === "UGC-S" || requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK") && pricing.item.attr) {
    let parsedAttr = null;
    try {
      parsedAttr = typeof pricing.item.attr === "string" ? JSON.parse(pricing.item.attr) : pricing.item.attr;
    } catch (e) { }
    if (parsedAttr) {
      const qNum = videoQuality.replace("p", "");
      const attrKey = `${qNum}`;
      if (parsedAttr[attrKey] !== undefined) {
        finalAmount = Number(parsedAttr[attrKey]);
      }
    }
  }

  const requestId = randomUUID();
  const now = getJakartaISOString();

  const profileItem = await getCustomerProfile(userId);
  const profileCreditBalance = Number(profileItem.credit_balance || 0);
  if (!(profileCreditBalance >= finalAmount)) {
    return response(402, {
      error: "Kredit tidak mencukupi. Silakan top up kredit.",
      error_code: "INSUFFICIENT_CREDIT",
      required_credit: finalAmount,
      current_credit: profileCreditBalance,
    });
  }
  if (requestType === "FREE-TRIAL") {
    const freeTrial = Number(profileItem.free_trial || 0);
    if (!(freeTrial > 0)) {
      return response(402, { error: "Akses Tester sudah terpakai", error_code: "FREE_TRIAL_UNAVAILABLE" });
    }
  }

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
    resource_family: resourceFamily, status: "SUBMITTING", credit_amount: finalAmount,
    created_at: now, updated_at: now, s3_keys: s3Keys, ...videoOptions,
    ugc_mode: body.ugc_mode || null,
    store_type: body.store_type || null,
    free_trial: requestType === "FREE-TRIAL" ? 1 : 0,
  };

  const errRes = await executeResourceRequestTransaction({
    putItem,
    finalAmount,
    userId,
    requestType,
    now
  });
  if (errRes) return errRes;

  const jobPayload = {
    jobId: requestId,
    userEmail,
    requestType,
    prompt,
    videoQuality,
    aspectRatio,
    s3ImageUrls,
    s3_keys: s3Keys,
    userId,
    ugc_mode: body.ugc_mode || null,
    store_type: body.store_type || null,
    lip_sync: requestType === "FREE-TRIAL" ? false : true,
  };

  try {
    if (requestType === "FREE-TRIAL") {
      await invokeFreeTrialWorker(requestId, jobPayload);
    } else if (GENERATION_BACKEND === "comfyui") {
      await invokeComfyUI(requestId, jobPayload);
    } else {
      return response(500, {
        error: "Generation backend tidak didukung. Gunakan comfyui atau FREE-TRIAL.",
      });
    }
  } catch (err) {
    console.error("POST /resource dispatch error:", err);
    return response(502, { error: "Gagal memulai proses generate." });
  }

  return response(200, { data: { ...putItem } });
};
exports.handleGetPresigned = async (event) => {
  const claims = getClaims(event);
  if (!claims.sub) return response(401, { error: "Unauthorized." });

  const qs = event.queryStringParameters || {};
  const key = qs.key;
  if (!key) return response(400, { error: "key is required." });

  try {
    const s3Params = { Bucket: S3_RESOURCE_BUCKET, Key: key };
    if (qs.download === "true") {
      const filename = qs.filename || key.split("/").pop() || "video.mp4";
      s3Params.ResponseContentDisposition = `attachment; filename="${filename}"`;
    }
    const cmd = new GetObjectCommand(s3Params);
    const url = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
    return response(200, { data: { url } });
  } catch (err) {
    console.error("handleGetPresigned error", err);
    return response(500, { error: "Failed to generate presigned URL." });
  }
};
