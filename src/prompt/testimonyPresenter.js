"use strict";

const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("../utils");
const { getFalAiKey, getSignedUrl, resolvePricingRow, callOpenAILLM, findPricingItem, s3Client } = require("../services");
const { callOpenAIImageEdit } = require("../core/imageGenerationOpenAI");
const { parseStandardLlmResponse } = require("../core/llmParser");

/**
 * Helper to update DynamoDB status and optional error message.
 */
async function updateJobStatus(dynamo, tableName, jobId, userEmail, status, errorMsg = null) {
  const updates = ["#s = :s", "updated_at = :u"];
  const names = { "#s": "status" };
  const values = { ":s": status, ":u": getJakartaISOString() };
  if (errorMsg) {
    updates.push("error_message = :err");
    values[":err"] = errorMsg;
  }
  try {
    await dynamo.send(new UpdateCommand({
      TableName: tableName,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET " + updates.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    console.error("[testimonyPresenter] Dynamo status update error:", err.message);
  }
}

/**
 * Helper to parse S3 URL (s3:// or https://) and fetch its content using S3 presigned URL.
 */
async function fetchS3Text(urlStr) {
  const url = String(urlStr).trim();
  let bucket = "";
  let key = "";

  if (url.startsWith("s3://")) {
    const withoutScheme = url.substring(5);
    const slashIdx = withoutScheme.indexOf("/");
    if (slashIdx !== -1) {
      bucket = withoutScheme.substring(0, slashIdx);
      key = withoutScheme.substring(slashIdx + 1);
    } else {
      bucket = withoutScheme;
    }
  } else if (url.startsWith("http")) {
    try {
      const urlObj = new URL(url);
      const host = urlObj.hostname;
      if (host.includes(".s3.")) {
        bucket = host.split(".s3.")[0];
        key = urlObj.pathname.substring(1);
      } else if (host === "s3.amazonaws.com" || host.startsWith("s3-") || host.startsWith("s3.")) {
        const parts = urlObj.pathname.substring(1).split("/");
        bucket = parts[0];
        key = parts.slice(1).join("/");
      } else {
        console.log(`[testimonyPresenter] Direct fetch for custom URL: ${url}`);
        const resp = await fetch(url);
        if (resp.ok) return await resp.text();
        throw new Error(`Direct fetch failed with status ${resp.status}`);
      }
    } catch (e) {
      console.warn(`[testimonyPresenter] Error parsing HTTP S3 URL: ${e.message}, falling back to direct fetch`);
      const resp = await fetch(url);
      if (resp.ok) return await resp.text();
      throw e;
    }
  } else {
    return url;
  }

  if (bucket && key) {
    const appBucket = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
    if (bucket.toLowerCase() === appBucket.toLowerCase()) {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      console.log(`[testimonyPresenter] Generating signed URL for our own bucket: ${bucket}, key: ${key}`);
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: decodeURIComponent(key) });
      const signed = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
      const resp = await fetch(signed);
      if (resp.ok) {
        return await resp.text();
      }
      throw new Error(`S3 fetch failed with status ${resp.status}`);
    } else {
      const publicUrl = url.startsWith("s3://")
        ? `https://${bucket}.s3.amazonaws.com/${key}`
        : url;
      console.log(`[testimonyPresenter] Bucket ${bucket} is not our app bucket (${appBucket}). Fetching public S3 URL without signature: ${publicUrl}`);
      const resp = await fetch(publicUrl);
      if (resp.ok) {
        return await resp.text();
      }
      throw new Error(`Public S3 fetch failed with status ${resp.status}`);
    }
  }

  return url;
}

/**
 * Fetch the prompt builder template from the pricing table's prompt field.
 */
async function loadPromptBuilder(requestType) {
  try {
    const resolved = await resolvePricingRow(requestType);
    if (resolved && resolved.item && resolved.item.prompt) {
      console.log("dapet nih:", resolved);
      const url = String(resolved.item.prompt).trim();
      if (url.startsWith("http") || url.startsWith("s3://")) {
        try {
          return await fetchS3Text(url);
        } catch (e) {
          console.error(`[testimonyPresenter] Failed to fetch prompt builder:`, e.message);
          return "# Prompt content unavailable (S3 fetch failed)";
        }
      }
      return url;
    }
    // Fallback: try findPricingItem ignoring charge
    const rawItem = await findPricingItem(requestType);
    console.log("Apakah ketemu raw item:", rawItem);
    if (rawItem && (rawItem.prompt || rawItem.prompt?.S)) {
      const promptVal = rawItem.prompt?.S || rawItem.prompt;
      const url2 = String(promptVal).trim();
      if (url2.startsWith("http") || url2.startsWith("s3://")) {
        try {
          return await fetchS3Text(url2);
        } catch (e) {
          console.error(`[testimonyPresenter] Failed to fetch secondary prompt builder:`, e.message);
          return "# Prompt content unavailable (secondary fetch failed)";
        }
      }
      return url2;
    }

  } catch (err) {
    console.error(`[testimonyPresenter] Error fetching prompt builder for ${requestType}:`, err.message);
  }
  return null;
}

/**
 * Main testimony handler.
 */
async function handleTestimonyTulus(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, prompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, preview, existingJob
  } = params;

  const requestType = "TESTIMONY_TULUS";
  console.log(`[testimonyPresenter] Running Testimony Presenter Pipeline in a single pass for job ${jobId}`);
  const startTime = Date.now();

  try {
    // A. Load Prompt Builder template
    let template = await loadPromptBuilder(requestType);
    // Fallback: try lowercase key if not found
    if (!template) {
      console.warn(`[testimonyPresenter] Prompt not found for ${requestType}, trying lowercase fallback.`);
      template = await loadPromptBuilder(requestType.toLowerCase());
    }
    // Additional fallback: replace underscores with hyphens
    if (!template) {
      const hyphenKey = requestType.replace(/_/g, "-");
      console.warn(`[testimonyPresenter] Prompt still not found, trying hyphenated key ${hyphenKey}.`);
      template = await loadPromptBuilder(hyphenKey);
    }
    if (!template) {
      throw new Error(`Prompt builder template not found in pricing table for ${requestType}`);
    }

    // B. Build user prompt and call OpenAI/LLM
    const userPrompt = `1. {product_description}: ${prompt}`;
    console.log(`[PIPELINE_LOG] [LLM] Calling LLM API for request type: ${requestType}`);
    console.log(`[testimonyPresenter] Calling LLM with user prompt: "${userPrompt}"`);
    const aiResponse = await callOpenAILLM(template, userPrompt);

    // C. Parse JSON response
    const llmResponse = parseStandardLlmResponse(aiResponse);
    console.log(`[testimonyPresenter] Successfully parsed standard LLM JSON structure.`);

    // Map custom testimony scenes layout to standard UGC-P scenes layout for ComfyUI compatibility
    if (llmResponse.scenes && Array.isArray(llmResponse.scenes)) {
      llmResponse.scenes = llmResponse.scenes.map(s => ({
        ...s,
        ltx_prompt: s.video_prompt || s.image_prompt || "",
        ltx_negative_prompt: s.negative_video_prompt || s.negative_image_prompt || "",
        duration_seconds: s.duration || 4
      }));
    }

    // Update DynamoDB with llm_response immediately
    const now = getJakartaISOString();
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET llm_response = :lr, updated_at = :now",
      ExpressionAttributeValues: { ":lr": llmResponse, ":now": now }
    }));

    // D. Pick Fal.ai API Key
    const apiKey = await getFalAiKey();
    if (!apiKey) {
      throw new Error("Fal.ai API Key not found in consolidated secrets.");
    }

    // E. Resolve image size
    let size = "1024x1536"; // default 9:16
    if (aspectRatio === "16:9") {
      size = "1536x1024";
    } else if (aspectRatio === "1:1") {
      size = "1024x1024";
    }

    const folder = "generated_image";
    const generatedLocks = {};
    const newImageKeys = [];

    // F. Generate lock images (e.g. talent, character_a)
    const locks = llmResponse.locks || {};
    for (const lockKey of Object.keys(locks)) {
      const lockObj = locks[lockKey];
      if (!lockObj || !lockObj.image_prompt) continue;

      let finalLockPrompt = lockObj.image_prompt;
      if (lockObj.negative_image_prompt) {
        finalLockPrompt = `${lockObj.image_prompt} avoid:${lockObj.negative_image_prompt}`;
      }

      console.log(`[PIPELINE_LOG] [IMAGE_LOCK] Generating lock image for: ${lockKey}`);
      console.log(`[testimonyPresenter] Generating lock image for '${lockKey}' with prompt: "${finalLockPrompt.slice(0, 100)}..."`);

      const { buffer, fallbackUrl } = await callOpenAIImageEdit({
        apiKey,
        prompt: finalLockPrompt,
        size,
        referenceUrls: []
      });

      const lockS3Key = `${folder}/${userId || "anonymous"}/${jobId}_lock_${lockKey}.png`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: lockS3Key,
        Body: buffer,
        ContentType: "image/png"
      }));

      const signedUrl = fallbackUrl || (await getSignedUrl(s3, new GetObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: lockS3Key
      }), { expiresIn: 3600 * 24 }));

      generatedLocks[lockKey] = {
        s3Key: lockS3Key,
        url: signedUrl
      };
      newImageKeys.push(lockS3Key);
      console.log(`[testimonyPresenter] Generated lock '${lockKey}' successfully.`);
    }

    // G. Generate scene images
    const scenes = llmResponse.scenes || [];
    const generatedScenes = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneId = scene.scene_id || (i + 1);

      let finalScenePrompt = scene.image_prompt || "";
      if (scene.negative_image_prompt) {
        finalScenePrompt = `${scene.image_prompt} avoid:${scene.negative_image_prompt}`;
      }

      // Collect reference images based on scene dependencies
      const dependencies = scene.dependency || [];
      let referenceUrls = [];

      for (const dep of dependencies) {
        if (generatedLocks[dep]) {
          referenceUrls.push(generatedLocks[dep].url);
        } else if (dep === "product") {
          referenceUrls.push(...currentS3ImageUrls);
        }
      }

      console.log(`[testimonyPresenter] Generating scene ${sceneId} image. Dependencies: ${JSON.stringify(dependencies)}. Prompt: "${finalScenePrompt.slice(0, 100)}..."`);

      const { buffer, fallbackUrl } = await callOpenAIImageEdit({
        apiKey,
        prompt: finalScenePrompt,
        size,
        referenceUrls: referenceUrls.filter(Boolean)
      });

      const sceneS3Key = `${folder}/${userId || "anonymous"}/${jobId}_scene_${sceneId}.png`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: sceneS3Key,
        Body: buffer,
        ContentType: "image/png"
      }));

      const signedUrl = fallbackUrl || (await getSignedUrl(s3, new GetObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: sceneS3Key
      }), { expiresIn: 3600 * 24 }));

      generatedScenes.push({
        scene_id: sceneId,
        s3_key: sceneS3Key,
        url: signedUrl
      });
      newImageKeys.push(sceneS3Key);
      console.log(`[testimonyPresenter] Generated scene ${sceneId} successfully.`);
    }

    // H. Finalize preview assets inside DynamoDB
    const previewDuration = Math.round((Date.now() - startTime) / 1000);
    const primaryS3Key = generatedScenes.find(gs => gs.s3_key)?.s3_key || null;

    const updateExpr = [
      "generated_image = :genImg",
      "generated_scenes = :genScenes",
      "updated_at = :now",
      "preview_duration = :prevDur"
    ];
    const exprValues = {
      ":genImg": primaryS3Key,
      ":genScenes": generatedScenes.map(gs => ({
        scene_id: gs.scene_id,
        s3_key: gs.s3_key,
        url: gs.url
      })),
      ":now": getJakartaISOString(),
      ":prevDur": previewDuration
    };

    if (newImageKeys.length > 0) {
      updateExpr.push("s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys)");
      exprValues[":empty_list"] = [];
      exprValues[":newKeys"] = newImageKeys;
    }

    // UGC compatibility updates
    if (generatedLocks.talent) {
      updateExpr.push("generated_image_talent = :genTalent");
      exprValues[":genTalent"] = generatedLocks.talent.s3Key;
    }

    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET " + updateExpr.join(", "),
      ExpressionAttributeValues: exprValues
    }));

    console.log(`[testimonyPresenter] Assets generated successfully. Preparing to trigger video generation workflow.`);

    // I. Construct updated existingJob object in-memory for the video pipeline
    const updatedExistingJob = {
      ...existingJob,
      llm_response: llmResponse,
      generated_image_talent: generatedLocks.talent ? generatedLocks.talent.s3Key : null,
      generated_scenes: generatedScenes.map(gs => ({
        scene_id: gs.scene_id,
        s3_key: gs.s3_key,
        url: gs.url
      }))
    };

    // J. Trigger the ComfyUI video pipeline
    const { generateMultiScenePipeline } = require("../core/ugcWorkflowGeneration");
    await generateMultiScenePipeline({
      jobId,
      userEmail,
      userId,
      currentS3ImageUrls,
      llmResponse,
      finalJobPrompt: prompt,
      videoQuality,
      aspectRatio,
      S3_RESOURCE_BUCKET,
      dynamo,
      s3,
      USER_REQUEST_TABLE,
      audio: null, // Testimony has no TTS audio
      audioDuration: null,
      requestType: "TESTIMONY_TULUS", // compatibility for workflow selection
      preview: false,
      existingJob: updatedExistingJob
    });

    console.log(`[testimonyPresenter] Video generation trigger successful.`);

  } catch (err) {
    console.error(`[testimonyPresenter] Pipeline execution failed for job ${jobId}:`, err);
    await updateJobStatus(dynamo, USER_REQUEST_TABLE, jobId, userEmail, "FAILED", err.message);
    throw err;
  }
}

module.exports = {
  handleTestimonyTulus,
  loadPromptBuilder
};
