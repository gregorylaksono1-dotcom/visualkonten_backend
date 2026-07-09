"use strict";

const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("../utils");
const { getSignedUrl, resolvePricingRow, callOpenAILLM, findPricingItem, s3Client } = require("../services");
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
    console.error("[ugcProblemSolution] Dynamo status update error:", err.message);
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
        console.log(`[ugcProblemSolution] Direct fetch for custom URL: ${url}`);
        const resp = await fetch(url);
        if (resp.ok) return await resp.text();
        throw new Error(`Direct fetch failed with status ${resp.status}`);
      }
    } catch (e) {
      console.warn(`[ugcProblemSolution] Error parsing HTTP S3 URL: ${e.message}, falling back to direct fetch`);
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
      console.log(`[ugcProblemSolution] Generating signed URL for our own bucket: ${bucket}, key: ${key}`);
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
      console.log(`[ugcProblemSolution] Bucket ${bucket} is not our app bucket (${appBucket}). Fetching public S3 URL: ${publicUrl}`);
      let resp = await fetch(publicUrl);
      if (!resp.ok) {
        const regionalUrl = `https://${bucket}.s3.ap-southeast-1.amazonaws.com/${key}`;
        console.log(`[ugcProblemSolution] Global S3 URL failed with status ${resp.status}. Retrying with regional S3 URL: ${regionalUrl}`);
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
 */
async function loadPromptBuilder(requestType) {
  try {
    const resolved = await resolvePricingRow(requestType);
    if (resolved && resolved.item && resolved.item.prompt) {
      const url = String(resolved.item.prompt).trim();
      if (url.startsWith("http") || url.startsWith("s3://")) {
        try {
          const content = await fetchS3Text(url);
          console.log(`[ugcProblemSolution] Successfully loaded prompt builder template content (${content.length} chars) from S3 URL: ${url}`);
          return content;
        } catch (e) {
          console.error(`[ugcProblemSolution] Failed to fetch prompt builder:`, e.message);
          return "# Prompt content unavailable (S3 fetch failed)";
        }
      }
      return url;
    }
    // Fallback: try findPricingItem ignoring charge
    const rawItem = await findPricingItem(requestType);
    if (rawItem && (rawItem.prompt || rawItem.prompt?.S)) {
      const promptVal = rawItem.prompt?.S || rawItem.prompt;
      const url2 = String(promptVal).trim();
      if (url2.startsWith("http") || url2.startsWith("s3://")) {
        try {
          return await fetchS3Text(url2);
        } catch (e) {
          console.error(`[ugcProblemSolution] Failed to fetch secondary prompt builder:`, e.message);
          return "# Prompt content unavailable (secondary fetch failed)";
        }
      }
      return url2;
    }
  } catch (err) {
    console.error(`[ugcProblemSolution] Error fetching prompt builder for ${requestType}:`, err.message);
  }
  return null;
}

/**
 * Main UGC Problem Solution handler.
 */
async function handleUgcProblemSolution(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, prompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, preview, existingJob
  } = params;

  const requestType = "UGC_PROBLEM_SOLUTION";
  console.log(`[ugcProblemSolution] Running UGC Problem Solution Pipeline in a single pass for job ${jobId}`);

  try {
    // A. Load Prompt Builder template
    let template = await loadPromptBuilder(requestType);
    // Fallback: try lowercase key if not found
    if (!template) {
      console.warn(`[ugcProblemSolution] Prompt not found for ${requestType}, trying lowercase fallback.`);
      template = await loadPromptBuilder(requestType.toLowerCase());
    }
    // Additional fallback: replace underscores with hyphens
    if (!template) {
      const hyphenKey = requestType.replace(/_/g, "-");
      console.warn(`[ugcProblemSolution] Prompt still not found, trying hyphenated key ${hyphenKey}.`);
      template = await loadPromptBuilder(hyphenKey);
    }
    if (!template) {
      throw new Error(`Prompt builder template not found in pricing table for ${requestType}`);
    }

    // B. Build system and user prompt directly from the template
    const briefPrompt = `1. {product_description}: ${prompt}`;
    const systemPrompt = template;
    const userPrompt = `## PRODUCT BRIEF\n${briefPrompt}`;

    console.log(`[PIPELINE_LOG] [LLM] Calling LLM API for request type: ${requestType}`);
    console.log(`[ugcProblemSolution] Calling LLM with wrapped prompts`);
    const aiResponse = await callOpenAILLM(systemPrompt, userPrompt);

    // C. Parse JSON response
    const llmResponse = parseStandardLlmResponse(aiResponse);
    console.log(`[ugcProblemSolution] Successfully parsed standard LLM JSON structure.`);

    // Map custom scenes layout to standard UGC-P scenes layout for ComfyUI compatibility
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

    return llmResponse;
  } catch (err) {
    console.error(`[ugcProblemSolution] Pipeline execution failed for job ${jobId}:`, err);
    throw err;
  }
}

module.exports = {
  handleUgcProblemSolution,
  loadPromptBuilder
};
