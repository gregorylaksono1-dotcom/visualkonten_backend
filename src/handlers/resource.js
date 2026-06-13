const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { response, getClaims, normalizeUserEmail, parseBody, parseImageBase64, extFromContentType, normalizeVideoQuality, normalizeAspectRatio, getJakartaISOString } = require("../utils");
const { s3Client, GetObjectCommand, uploadToS3, getSignedUrl, resolvePricingRow, invokeFreeTrialWorker, invokeComfyUI, getCustomerProfile, executeResourceRequestTransaction, docClient, GetCommand } = require("../services");

const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const GENERATION_BACKEND = process.env.GENERATION_BACKEND || "comfyui";

exports.handlePostResource = async (event) => {
  const claims = getClaims(event);
  const userEmail = normalizeUserEmail(claims.email || claims.username);
  const userId = claims.sub;
  if (!userEmail || !userId) return response(401, { error: "Unauthorized." });

  const body = parseBody(event);

  if (body.action === "generate_video") {
    const uuid = body.uuid;
    if (!uuid) return response(400, { error: "uuid is required for generate_video action." });

    try {
      const getRes = await docClient.send(new GetCommand({
        TableName: process.env.USER_REQUEST_TABLE_NAME,
        Key: { uuid: uuid, user_email: userEmail },
      }));
      const requestItem = getRes.Item;
      if (!requestItem) return response(404, { error: "Request not found." });

      if (requestItem.user_id !== userId) {
        return response(403, { error: "Forbidden: You do not own this request." });
      }

      if (requestItem.preview !== 1 && requestItem.preview !== "1") {
        return response(400, { error: "This request is not a preview or is already a full generation." });
      }

      if (requestItem.status === "COMPLETED" || requestItem.status === "PROCESSING" || requestItem.status === "VIDEO GENERATING" || requestItem.status === "SUBMITTING") {
        return response(400, { error: "Video generasi sedang diproses atau sudah selesai." });
      }

      if (requestItem.status !== "PREVIEW" && requestItem.status !== "FAILED") {
        return response(400, { error: "Request is not in a valid state for generation." });
      }

      const pricing = await resolvePricingRow(requestItem.request_type);
      if (!pricing) return response(404, { error: `Pricing not found for request type ${requestItem.request_type}.` });

      let finalAmount = pricing.amount;
      const videoQuality = requestItem.video_quality || "720p";
      const aspectRatio = requestItem.aspect_ratio || "9:16";

      if ((requestItem.request_type === "UGC-P" || requestItem.request_type === "UGC-S" || requestItem.request_type === "PRODUCT-CINEMATIC" || requestItem.request_type === "PRODUCT-CINEMATIK") && pricing.item.attr) {
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

      const now = getJakartaISOString();
      const putItem = {
        ...requestItem,
        status: "VIDEO GENERATING",
        credit_amount: finalAmount,
        preview: 0,
        updated_at: now,
        video_gen_start_at: now,
      };
      delete putItem.result_url;

      // Handle custom user edits to llm_response (motion prompts, tts scripts)
      if (body.llm_response) {
        console.log(`[resource.js] Received updated llm_response for job ${uuid}`);
        
        // Helper function to compare old and new TTS scripts
        const checkTtsChanged = (oldLlm, newLlm) => {
          if (!oldLlm || !newLlm) return false;
          
          // 1. Compare global tts_script fields
          const oldGlobalTts = oldLlm.tts_script || oldLlm.voiceover_script?.tts_script || "";
          const newGlobalTts = newLlm.tts_script || newLlm.voiceover_script?.tts_script || "";
          if (oldGlobalTts.trim() !== newGlobalTts.trim()) return true;

          // 2. Compare scene-level scripts
          const oldScenes = oldLlm.scene || oldLlm.scenes || [];
          const newScenes = newLlm.scene || newLlm.scenes || [];
          if (oldScenes.length !== newScenes.length) return true;

          for (let i = 0; i < oldScenes.length; i++) {
            const oldS = oldScenes[i] || {};
            const newS = newScenes[i] || {};
            const oldTts = oldS.tts_script || oldS.voiceover_script || oldS.voiceover || oldS.tts || "";
            const newTts = newS.tts_script || newS.voiceover_script || newS.voiceover || newS.tts || "";
            if (oldTts.trim() !== newTts.trim()) return true;
          }
          return false;
        };

        const ttsChanged = checkTtsChanged(requestItem.llm_response, body.llm_response);
        if (ttsChanged) {
          console.log(`[resource.js] TTS script changed for job ${uuid}. Invalidating existing audio file.`);
          delete putItem.audio;
          delete putItem.audio_duration;
        }

        // Save the updated llm_response
        putItem.llm_response = body.llm_response;
      }

      const errRes = await executeResourceRequestTransaction({
        putItem,
        finalAmount,
        userId,
        requestType: requestItem.request_type,
        now
      });
      if (errRes) return errRes;

      const jobPayload = {
        jobId: uuid,
        userEmail,
        requestType: requestItem.request_type,
        prompt: requestItem.prompt,
        videoQuality,
        aspectRatio,
        s3ImageUrls: [],
        s3_keys: requestItem.s3_keys || [],
        userId,
        ugc_mode: requestItem.ugc_mode || null,
        store_type: requestItem.store_type || null,
        lip_sync: requestItem.request_type === "FREE-TRIAL" ? false : true,
        preview: false,
      };

      if (GENERATION_BACKEND === "comfyui") {
        await invokeComfyUI(uuid, jobPayload);
      } else {
        return response(500, {
          error: "Generation backend tidak didukung.",
        });
      }

      return response(200, { data: { ...putItem } });
    } catch (err) {
      console.error("generate_video action error:", err);
      return response(500, { error: err.message });
    }
  }

  const prompt = String(body.prompt || "").trim();
  const imageBase64_1 = body.image_base64_1 || body.image_base_64_1 || body.image_base64 || "";
  const imageBase64_2 = body.image_base64_2 || body.image_base_64_2 || "";
  const hasImage = Boolean(imageBase64_1.trim() || imageBase64_2.trim());
  const resourceFamily = String(body.resource_family || "image").toLowerCase() === "video" ? "video" : "image";
  const isFreeTrialRequested = body.free_trial === true || String(body.free_trial).toLowerCase() === "true" || body.request_type === "FREE-TRIAL";
  const isPreview = body.preview === true || String(body.preview).toLowerCase() === "true";

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

  if (isPreview) {
    pricingKey = "PREVIEW";
  }

  if (!prompt) return response(400, { error: "prompt is required." });
  if (requestType === "FREE-TRIAL" && !hasImage) {
    return response(400, { error: "FREE-TRIAL memerlukan minimal 1 gambar input." });
  }

  const pricing = await resolvePricingRow(pricingKey);
  if (!pricing) return response(404, { error: `Pricing not found for ${pricingKey}.` });

  let finalAmount = pricing.amount;
  if ((isPreview || requestType === "UGC-P" || requestType === "UGC-S" || requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK") && pricing.item.attr) {
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
    preview: isPreview ? 1 : 0,
    video_gen_start_at: isPreview ? null : now,
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
    selling_mode: body.selling_mode || null,
    video_duration: body.video_duration || null,
    voice_selection_mode: body.voice_selection_mode || null,
    preferred_voice: body.preferred_voice || null,
    lip_sync: requestType === "FREE-TRIAL" ? false : true,
    preview: isPreview,
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
