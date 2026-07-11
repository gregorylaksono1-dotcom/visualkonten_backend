"use strict";

const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("../utils");
const { getSignedUrl, resolvePricingRow, callOpenAILLM, findPricingItem, s3Client } = require("../services");
const { parseStandardLlmResponse } = require("../core/llmParser");

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
        console.log(`[genericTemplateHandler] Direct fetch for custom URL: ${url}`);
        const resp = await fetch(url);
        if (resp.ok) return await resp.text();
        throw new Error(`Direct fetch failed with status ${resp.status}`);
      }
    } catch (e) {
      console.warn(`[genericTemplateHandler] Error parsing HTTP S3 URL: ${e.message}, falling back to direct fetch`);
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
      console.log(`[genericTemplateHandler] Generating signed URL for our own S3 bucket: ${bucket}, key: ${key}`);
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
      console.log(`[genericTemplateHandler] Bucket ${bucket} is not our app bucket (${appBucket}). Fetching public S3 URL: ${publicUrl}`);
      let resp = await fetch(publicUrl);
      if (!resp.ok) {
        const regionalUrl = `https://${bucket}.s3.ap-southeast-1.amazonaws.com/${key}`;
        console.log(`[genericTemplateHandler] Global S3 URL failed with status ${resp.status}. Retrying with regional S3 URL: ${regionalUrl}`);
        resp = await fetch(regionalUrl);
      }
      if (resp.ok) {
        return await resp.text();
      }
      const errText = await resp.text();
      throw new Error(`Public S3 fetch failed with status ${resp.status}: ${errText}`);
    }
  }

  return url;
}

/**
 * Fetch the prompt builder template from the pricing table's prompt field.
 * Handles key variations (original, lowercase, underscores-to-hyphens, hyphens-to-underscores).
 */
async function loadPromptBuilder(requestType) {
  if (!requestType) return null;
  const keysToTry = [
    requestType,
    requestType.toLowerCase(),
    requestType.replace(/_/g, "-"),
    requestType.replace(/-/g, "_")
  ];
  const uniqueKeys = [...new Set(keysToTry)];

  for (const key of uniqueKeys) {
    try {
      const resolved = await resolvePricingRow(key);
      if (resolved && resolved.item && resolved.item.prompt) {
        console.log(`[genericTemplateHandler] resolvePricingRow matched template for key: ${key}`);
        const url = String(resolved.item.prompt).trim();
        if (url.startsWith("http") || url.startsWith("s3://")) {
          const content = await fetchS3Text(url);
          console.log(`[genericTemplateHandler] Successfully loaded prompt builder template content (${content.length} chars) from S3 URL for key: ${key}`);
          return content;
        }
        return url;
      }

      // Fallback: try findPricingItem ignoring charge
      const rawItem = await findPricingItem(key);
      if (rawItem && (rawItem.prompt || rawItem.prompt?.S)) {
        console.log(`[genericTemplateHandler] findPricingItem matched template for key: ${key}`);
        const promptVal = rawItem.prompt?.S || rawItem.prompt;
        const url2 = String(promptVal).trim();
        if (url2.startsWith("http") || url2.startsWith("s3://")) {
          const content = await fetchS3Text(url2);
          console.log(`[genericTemplateHandler] Successfully loaded prompt builder template content (${content.length} chars) from secondary S3 URL for key: ${key}`);
          return content;
        }
        return url2;
      }
    } catch (err) {
      console.error(`[genericTemplateHandler] Error checking prompt builder for key ${key}:`, err.message);
    }
  }
  return null;
}

/**
 * Main generic template handler pipeline.
 */
async function handleGenericTemplate(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, prompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, preview, existingJob,
    requestType, template
  } = params;

  console.log(`[genericTemplateHandler] Running Generic Template Pipeline for request type: ${requestType} (Job: ${jobId})`);

  try {
    // 1. Resolve prompt template if not passed
    let templatePrompt = template;
    if (!templatePrompt) {
      templatePrompt = await loadPromptBuilder(requestType);
    }
    if (!templatePrompt) {
      throw new Error(`Prompt builder template not found in pricing table for requestType ${requestType}`);
    }

    // 2. Build system and user prompts (Direct standalone prompt without wrapping)
    console.log(`[genericTemplateHandler] Using unwrapped standalone prompt style`);
    const systemPrompt = templatePrompt;
    const briefPrompt = `1. {product_description}: ${prompt}`;
    const userPrompt = `## PRODUCT BRIEF\n${briefPrompt}`;

    // 3. Call LLM
    console.log(`[genericTemplateHandler] [LLM] Calling LLM API for request type: ${requestType}`);
    const aiResponse = await callOpenAILLM(systemPrompt, userPrompt);

    // 4. Parse response
    const llmResponse = parseStandardLlmResponse(aiResponse);
    console.log(`[genericTemplateHandler] Successfully parsed standard LLM JSON structure.`);

    // 5. Map custom/legacy scenes structure to standard UGC-P scenes layout for ComfyUI compatibility
    let scenes = llmResponse.scenes || llmResponse.scene || [];
    if (!Array.isArray(scenes) && typeof scenes === "object") {
      scenes = Object.values(scenes);
    }
    if (Array.isArray(scenes)) {
      llmResponse.scenes = scenes.map(s => {
        const ltx_prompt = s.ltx_prompt || s.video_prompt || s.image_prompt || s.prompt_video || s.prompt_image || "";
        const ltx_negative_prompt = s.ltx_negative_prompt || s.negative_video_prompt || s.negative_image_prompt || s.negative_prompt || "";
        const duration_seconds = Number(s.duration_seconds || s.duration || s.duration_sec || 4);
        return {
          ...s,
          ltx_prompt,
          ltx_negative_prompt,
          duration_seconds
        };
      });
    }

    // 6. Update DynamoDB with llm_response immediately
    const now = getJakartaISOString();
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET llm_response = :lr, updated_at = :now",
      ExpressionAttributeValues: { ":lr": llmResponse, ":now": now }
    }));

    return llmResponse;
  } catch (err) {
    console.error(`[genericTemplateHandler] Pipeline execution failed for job ${jobId} (Type: ${requestType}):`, err);
    throw err;
  }
}

module.exports = {
  loadPromptBuilder,
  handleGenericTemplate
};
