const fs = require("fs");
const path = require("path");
const https = require("https");
const { randomUUID } = require("crypto");
const { response, getClaims, normalizeUserEmail, parseBody, parseImageBase64, extFromContentType, normalizeVideoQuality, normalizeAspectRatio, getJakartaISOString } = require("../utils");
const { s3Client, GetObjectCommand, uploadToS3, getSignedUrl, resolvePricingRow, invokeFreeTrialWorker, invokeComfyUI, getCustomerProfile, invokeMotionGraphicsStateMachine,  executeResourceRequestTransaction, docClient, GetCommand, UpdateCommand } = require("../services");
const { sendTelegramMessage } = require("../lib/telegram");

const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const GENERATION_BACKEND = process.env.GENERATION_BACKEND || "comfyui";
const GENERATION_MANUAL = process.env.GENERATION_MANUAL || "false";

exports.handlePostResource = async (event) => {
  const claims = getClaims(event);
  const userEmail = normalizeUserEmail(claims.email || claims.username);
  const userId = claims.sub;
  if (!userEmail || !userId) return response(401, { error: "Unauthorized." });

  const body = parseBody(event);
  console.log("action", body.action);
  
  if (body.action === "log_search") {
    console.log(`mencari ${body.query || ""}`);
    return response(200, { message: "logged" });
  }

  if (body.action === "request_template") {
    const requestedTemplate = body.template || "";
    if (requestedTemplate) {
      await sendTelegramMessage(`Dari ${userEmail}. Template : ${requestedTemplate}`);
    }
    return response(200, { message: "Template request sent" });
  }
  if (body.action === "request_regenerate") {
    const uuid = body.uuid;
    if (uuid) {
      try {
        const updateResult = await docClient.send(new UpdateCommand({
          TableName: process.env.USER_REQUEST_TABLE_NAME,
          Key: { uuid: uuid, user_email: userEmail },
          UpdateExpression: "SET is_regenerate_requested = :true_val",
          ExpressionAttributeValues: {
            ":true_val": true
          },
          ReturnValues: "ALL_NEW"
        }));

        const item = updateResult.Attributes || {};
        const isFreeTrial = item.request_type === "FREE_STORY" ? "Ya" : "Tidak";
        const creditSpent = item.credit_amount || 0;

        await sendTelegramMessage(`User ${userEmail} request ${uuid} generasi ulang.\nFree Trial: ${isFreeTrial}\nCredit Dihabiskan: ${creditSpent}`);
      } catch (err) {
        console.error("Error updating user_request for regenerate:", err);
        await sendTelegramMessage(`user ${userEmail} request ${uuid} generasi ulang (Gagal mengambil rincian credit)`);
      }
    }
    return response(200, { message: "Request generasi ulang terkirim" });
  }


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

      const profileItem = await getCustomerProfile(userId);
      const isFreeTrial = Number(profileItem.free_trial || 0) > 0;
      let isFreeTrialUsed = false;

      const pricing = await resolvePricingRow(requestItem.request_type);
      if (!pricing) return response(404, { error: `Pricing not found for request type ${requestItem.request_type}.` });

      let finalAmount = pricing.amount;
      const videoQuality = requestItem.video_quality || "720p";
      const aspectRatio = requestItem.aspect_ratio || "9:16";

      const requestTypeUpper = String(requestItem.request_type || "").toUpperCase();
      if (pricing.item.attr) {
        let parsedAttr = null;
        try {
          parsedAttr = typeof pricing.item.attr === "string" ? JSON.parse(pricing.item.attr) : pricing.item.attr;
        } catch (e) { }
        if (parsedAttr) {
          if (requestTypeUpper === "FREE_STORY" || requestTypeUpper === "MOTION_CONTROL") {
            const dur = String(requestItem.duration_seconds || requestItem.duration || (requestTypeUpper === "MOTION_CONTROL" ? 10 : 30));
            let durAttr = parsedAttr[dur];
            const isBaseDur = (requestTypeUpper === "MOTION_CONTROL" && dur === "10") || (requestTypeUpper === "FREE_STORY" && dur === "30");
            if (isFreeTrial && requestItem.free_trial === 1 && parsedAttr.freetrial !== undefined && isBaseDur) {
              durAttr = parsedAttr.freetrial;
              isFreeTrialUsed = true;
            }
            if (durAttr !== undefined) {
              finalAmount = typeof durAttr === 'object' ? Number(durAttr.price || 0) : Number(durAttr);
            }
          } else {
            let valToUse;
            if (isFreeTrial && requestItem.free_trial === 1 && parsedAttr["freetrial"] !== undefined) {
              valToUse = parsedAttr["freetrial"];
              isFreeTrialUsed = true;
            } else {
              const qNum = videoQuality.replace("p", "");
              valToUse = parsedAttr[`${qNum}`];
            }
            if (valToUse !== undefined) {
              finalAmount = typeof valToUse === 'object' ? Number(valToUse.price || 0) : Number(valToUse);
            }
          }
        }
      }

      finalAmount = Number(finalAmount) || 0;
      let profileCreditBalance = Number(profileItem.credit_balance) || 0;

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
        ...(GENERATION_MANUAL === "true" ? { generation_manual: true } : {})
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

        // Safely merge only the fields the frontend is allowed to edit (TTS/voiceover)
        const existingLlm = requestItem.llm_response || {};
        const newLlm = body.llm_response;
        
        if (newLlm.tts_script !== undefined) existingLlm.tts_script = newLlm.tts_script;
        if (newLlm.voiceover_script !== undefined) existingLlm.voiceover_script = newLlm.voiceover_script;
        
        const existingScenes = existingLlm.scene || existingLlm.scenes || [];
        const newScenes = newLlm.scene || newLlm.scenes || [];
        
        for (let i = 0; i < existingScenes.length; i++) {
          if (newScenes[i]) {
             if (newScenes[i].tts_script !== undefined) existingScenes[i].tts_script = newScenes[i].tts_script;
             if (newScenes[i].voiceover_script !== undefined) existingScenes[i].voiceover_script = newScenes[i].voiceover_script;
             if (newScenes[i].voiceover !== undefined) existingScenes[i].voiceover = newScenes[i].voiceover;
             if (newScenes[i].tts !== undefined) existingScenes[i].tts = newScenes[i].tts;
          }
        }
        putItem.llm_response = existingLlm;
      }

      const errRes = await executeResourceRequestTransaction({
        putItem,
        finalAmount,
        userId,
        requestType: requestItem.request_type,
        now,
        isFreeTrialUsed
      });
      if (errRes) return errRes;

      const jobPayload = {
        jobId: uuid,
        userEmail,
        requestType: requestItem.request_type,
        pricing_type: pricing.item.type,
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

      if (GENERATION_MANUAL === "true") {
        return response(200, {
          message: "Penyimpanan berhasil. Proses generasi menyesuaikan jam operasional max 8 jam. Cek di menu Histori Kreasi",
          data: { ...putItem }
        });
      }

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

  let prompt = String(body.prompt || "").trim();
  const imageBase64_1 = body.image_base64_1 || body.image_base_64_1 || body.image_base64 || "";
  const imageBase64_2 = body.image_base64_2 || body.image_base_64_2 || "";
  const hasImage = Boolean(imageBase64_1.trim() || imageBase64_2.trim());
  const resourceFamily = String(body.resource_family || "image").toLowerCase() === "video" ? "video" : "image";
  const isFreeTrialRequested = body.free_trial === true || String(body.free_trial).toLowerCase() === "true" || body.request_type === "FREE-TRIAL";
  let isPreview = body.preview === true || String(body.preview).toLowerCase() === "true";
  let requestType = body.request_type;

  if (requestType === "MOTION_CONTROL") {
    isPreview = false;
  }

  let pricingKey;

  const videoQuality = normalizeVideoQuality(body.video_quality);
  const aspectRatio = normalizeAspectRatio(body.aspect_ratio);
  const videoOptions = resourceFamily === "video" ? { video_quality: videoQuality, aspect_ratio: aspectRatio } : {};

  if (resourceFamily === "video") {
    if (isFreeTrialRequested) {
      requestType = "FREE-TRIAL";
      pricingKey = "FREE-TRIAL";
    } else if (!requestType) {
      requestType = hasImage ? "image-to-video" : "text-to-video";
    }

    const upperType = String(requestType).toUpperCase();
    if (!isFreeTrialRequested && (upperType === "UGC-P" || upperType === "UGC-S" || upperType === "UGC-PRESENTER" || upperType.startsWith("UGC-") || upperType === "PRODUCT-CINEMATIC" || upperType === "PRODUCT-CINEMATIK")) {
      requestType = upperType;
      pricingKey = (upperType === "PRODUCT-CINEMATIK") ? "PRODUCT-CINEMATIC" : upperType;
    } else if (!isFreeTrialRequested && requestType === "multi-shot-video") {
      pricingKey = body.ugc_mode === "toko" ? "UGC-S" : "UGC-P";
      requestType = pricingKey;
    } else if (!isFreeTrialRequested && (requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK")) {
      pricingKey = "PRODUCT-CINEMATIC";
    } else if (!isFreeTrialRequested) {
      const isGeneric = upperType === "IMAGE-TO-VIDEO" || upperType === "TEXT-TO-VIDEO";
      if (!isGeneric) {
        requestType = upperType;
        pricingKey = upperType;
      } else {
        pricingKey = `${hasImage ? "IMAGE-TO-VIDEO" : "TEXT-TO-VIDEO"}-${videoQuality.replace("p", "")}`;
      }
    }
  } else {
    if (!requestType) requestType = imageBase64_2.trim() ? "image-to-image2" : (imageBase64_1.trim() ? "image-to-image1" : "text-to-image");
    pricingKey = hasImage ? "IMAGE-TO-IMAGE" : "TEXT-TO-IMAGE";
  }

  if (isPreview) {
    const rTypeUpper = String(requestType || "").toUpperCase();
    // No longer override pricingKey to "PREVIEW" here, we want the template's normal pricing row 
    // to determine if preview has a cost (like FREE_STORY has a 3 credit preview price), 
    // or default to 0 if not specified.
  }

  if (!prompt && requestType === "MOTION_CONTROL") {
    prompt = "MOTION_CONTROL";
  }

  if (!prompt) return response(400, { error: "prompt is required." });
  if (requestType === "FREE-TRIAL" && !hasImage) {
    return response(400, { error: "FREE-TRIAL memerlukan minimal 1 gambar input." });
  }

  if (requestType === "MOTION_CONTROL") {
    const refVideoDuration = Number(body.ref_video_duration || 0);
    const chosenDuration = Number(body.duration_seconds || 10);
    if (refVideoDuration < chosenDuration) {
      return response(400, {
        error: "Durasi video referensi lebih kecil dibanding durasi yang dipilih.",
        error_code: "VIDEO_DURATION_TOO_SHORT"
      });
    }
  }

  const pricing = await resolvePricingRow(pricingKey);
  if (!pricing) return response(404, { error: `Pricing not found for ${pricingKey}.` });

  if (pricing.item.coming_soon === true || pricing.item.coming_soon === "true") {
    return response(400, { error: "Template ini belum siap untuk diproses (Coming Soon)." });
  }

  const profileItem = await getCustomerProfile(userId);
  const isFreeTrial = Number(profileItem.free_trial || 0) > 0;
  let isFreeTrialUsed = false;
  let appliedFreeTrialPricing = false;

  let finalAmount = pricing.amount;
  const requestTypeUpperVal = String(requestType || "").toUpperCase();
  if (requestTypeUpperVal === "MOTION_CONTROL" || requestTypeUpperVal === "FREE_STORY") {
    let parsedAttr = null;
    try {
      parsedAttr = typeof pricing.item.attr === "string" ? JSON.parse(pricing.item.attr) : pricing.item.attr;
    } catch (e) { }
    const chosenDur = String(body.duration_seconds || body.duration || (requestTypeUpperVal === "MOTION_CONTROL" ? 10 : 30));
    
    if (parsedAttr) {
      const freeTrialVal = parsedAttr["freetrial"];
      const normalVal = parsedAttr[chosenDur];

      const isBaseDur = (requestTypeUpperVal === "MOTION_CONTROL" && chosenDur === "10") || (requestTypeUpperVal === "FREE_STORY" && chosenDur === "30");

      if (isFreeTrial && freeTrialVal !== undefined && isBaseDur) {
        const freePreviewQuota = Number(profileItem.free_preview_quota ?? 2);
        if (isPreview && freePreviewQuota <= 0 && Number(profileItem.credit_balance) > 0) {
          // Fallback to normal pricing
          if (normalVal === undefined) {
            return response(400, {
              error: "Kredit dan durasi tidak sesuai",
              error_code: "INVALID_DURATION_PRICING"
            });
          }
          if (typeof normalVal === 'object') {
            finalAmount = isPreview ? Number(normalVal.preview || 0) : Number(normalVal.price || 0);
          } else {
            finalAmount = Number(normalVal);
          }
        } else {
          appliedFreeTrialPricing = true;
          if (typeof freeTrialVal === 'object') {
            finalAmount = isPreview ? Number(freeTrialVal.preview || 0) : Number(freeTrialVal.price || 0);
          } else {
            finalAmount = Number(freeTrialVal);
          }
          if (!isPreview) {
            isFreeTrialUsed = true;
          }
        }
      } else {
        if (normalVal === undefined) {
          return response(400, {
            error: "Kredit dan durasi tidak sesuai",
            error_code: "INVALID_DURATION_PRICING"
          });
        }
        if (typeof normalVal === 'object') {
          finalAmount = isPreview ? Number(normalVal.preview || 0) : Number(normalVal.price || 0);
        } else {
          finalAmount = Number(normalVal);
        }
      }
    }

  } else if (pricing.item.type === "motion_graphic" || requestTypeUpperVal === "MOTION_GRAPHICS" || requestTypeUpperVal === "MOTION-GRAPHICS") {
    let parsedAttr = null;
    try {
      parsedAttr = typeof pricing.item.attr === "string" ? JSON.parse(pricing.item.attr) : pricing.item.attr;
    } catch (e) { }
    if (parsedAttr) {
      if (isFreeTrial && parsedAttr["freetrial"] !== undefined) {
         finalAmount = Number(parsedAttr["freetrial"]);
         appliedFreeTrialPricing = true;
         isFreeTrialUsed = true;
      } else if (parsedAttr["main"] !== undefined) {
         finalAmount = Number(parsedAttr["main"]);
      }
    }
  } else if (pricing.item.attr) {
    let parsedAttr = null;
    try {
      parsedAttr = typeof pricing.item.attr === "string" ? JSON.parse(pricing.item.attr) : pricing.item.attr;
    } catch (e) { }
    if (parsedAttr) {
      let valToUse;
      if (isFreeTrial && parsedAttr["freetrial"] !== undefined) {
        const freePreviewQuota = Number(profileItem.free_preview_quota ?? 2);
        if (isPreview && freePreviewQuota <= 0 && Number(profileItem.credit_balance) > 0) {
          const qNum = videoQuality.replace("p", "");
          valToUse = parsedAttr[`${qNum}`];
        } else {
          valToUse = parsedAttr["freetrial"];
          appliedFreeTrialPricing = true;
          if (!isPreview) isFreeTrialUsed = true;
        }
      } else {
        const qNum = videoQuality.replace("p", "");
        valToUse = parsedAttr[`${qNum}`];
      }
      
      if (valToUse !== undefined) {
        if (typeof valToUse === 'object') {
          finalAmount = isPreview ? Number(valToUse.preview || 0) : Number(valToUse.price || 0);
        } else {
          finalAmount = isPreview ? 0 : Number(valToUse);
        }
      } else if (isPreview) {
        finalAmount = 0;
      }
    } else if (isPreview) {
      finalAmount = 0;
    }
  } else if (isPreview) {
    finalAmount = 0;
  }

  const requestId = randomUUID();
  const now = getJakartaISOString();

  finalAmount = Number(finalAmount) || 0;
  let profileCreditBalance = Number(profileItem.credit_balance) || 0;

  const isFreePreviewUsed = isPreview && (appliedFreeTrialPricing || requestType === "FREE-TRIAL");
  if (isFreePreviewUsed) {
    const freePreviewQuota = Number(profileItem.free_preview_quota ?? 2);
    if (freePreviewQuota <= 0) {
      return response(402, {
        error: "Batas pembuatan preview gratis telah habis. Silakan gunakan fitur 'Buat Sekarang' atau Top Up kredit Anda.",
        error_code: "FREE_PREVIEW_LIMIT_REACHED"
      });
    }
  }

  if (!(profileCreditBalance >= finalAmount)) {
    return response(402, {
      error: "Kredit tidak mencukupi. Silakan top up kredit.",
      error_code: "INSUFFICIENT_CREDIT",
      required_credit: finalAmount,
      current_credit: profileCreditBalance,
    });
  }

    if (requestType === "MOTION_GRAPHICS" || requestType === "MOTION-GRAPHICS" || body.itemType === "motion-graphics") {
      await invokeMotionGraphicsStateMachine(requestId, jobPayload);
    } else if (requestType === "FREE-TRIAL") {
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

  // Parse and upload reference video if present (for MOTION_CONTROL)
  const videoBase64 = body.video_base_64 || "";
  let videoRefKey = null;
  if (videoBase64.trim()) {
    const parsed = parseImageBase64(videoBase64);
    if (parsed) {
      videoRefKey = `user_request/${userId}/${requestId}_video.${extFromContentType(parsed.contentType)}`;
      try {
        await uploadToS3(S3_RESOURCE_BUCKET, videoRefKey, parsed.buffer, parsed.contentType);
        s3Keys.push(videoRefKey);
      } catch (err) {
        console.error("S3 video upload error:", err);
        return response(502, { error: `S3 video upload failed: ${err.message}` });
      }
    }
  }

  const putItem = {
    uuid: requestId, user_email: userEmail, user_id: userId, prompt, request_type: requestType,
    resource_family: resourceFamily, status: "SUBMITTING", credit_amount: finalAmount,
    created_at: now, updated_at: now, s3_keys: s3Keys, ...videoOptions,
    ugc_mode: body.ugc_mode || null,
    store_type: body.store_type || null,
    story_type: body.story_type || null,
    duration_seconds: body.duration_seconds || body.duration || null,
    free_trial: (appliedFreeTrialPricing || requestType === "FREE-TRIAL") ? 1 : 0,
    preview: isPreview ? 1 : 0,
    video_gen_start_at: isPreview ? null : now,
    ...(videoRefKey ? { video_ref_key: videoRefKey } : {}),
    ...(GENERATION_MANUAL === "true" ? { generation_manual: true } : {})
  };

  const errRes = await executeResourceRequestTransaction({
    putItem,
    finalAmount,
    userId,
    requestType,
    now,
    isFreeTrialUsed,
    isFreePreviewUsed
  });
  if (errRes) return errRes;

  const jobPayload = {
    jobId: requestId,
    userEmail,
    requestType,
    pricing_type: pricing.item.type,
    pricing_prompt: pricing.item.prompt,
    prompt,
    videoQuality,
    aspectRatio,
    s3ImageUrls,
    s3_keys: s3Keys,
    userId,
    ugc_mode: body.ugc_mode || null,
    store_type: body.store_type || null,
    story_type: body.story_type || null,
    selling_mode: body.selling_mode || null,
    video_duration: body.video_duration || null,
    voice_selection_mode: body.voice_selection_mode || null,
    preferred_voice: body.preferred_voice || null,
    lip_sync: requestType === "FREE-TRIAL" ? false : true,
    preview: isPreview,
    video_ref_key: videoRefKey,
    duration_seconds: body.duration_seconds || 5
  };

  if (GENERATION_MANUAL === "true") {
    return response(200, {
      message: "Penyimpanan berhasil. Proses generasi menyesuaikan jam operasional max 8 jam. Cek di menu Histori Kreasi",
      data: { ...putItem }
    });
  }

  try {

    if (pricing.item.type === "motion_graphic" || requestType === "MOTION_GRAPHICS" || requestType === "MOTION-GRAPHICS" || body.itemType === "motion-graphics") {
      console.log("=== ROUTING TO MOTION GRAPHICS STATE MACHINE ===", JSON.stringify(jobPayload, null, 2));
      await invokeMotionGraphicsStateMachine(requestId, jobPayload);
    } else if (requestType === "FREE-TRIAL") {
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


