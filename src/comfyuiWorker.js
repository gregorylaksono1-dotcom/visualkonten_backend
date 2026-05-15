/**
 * ComfyUI Worker (AWS Lambda)
 *
 * Alur kerja:
 *  A. SUBMISSION (via Worker A):
 *     1. Upload satu atau lebih input image ke ComfyUI Cloud.
 *     2. Submit workflow (build via workflows.js).
 *     3. Simpan prompt_id ke DynamoDB (status: PROCESSING).
 *
 *  B. POLLING (via EventBridge Schedule):
 *     1. Cari semua job di DynamoDB dengan status "PROCESSING".
 *     2. Cek status di ComfyUI Cloud, update jika COMPLETED/FAILED.
 */

"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { buildWorkflow } = require("./workflows");
const { 
  callOpenAILLM, callGeminiAudio, uploadToS3, getRedis, pickComfyApiKey,
  uploadInputImage, submitWorkflow, getOutputUrl, resolveSignedUrl
} = require("./services");
const { generateComfyUIImage } = require("./core/imageGeneration");
const { generateTTS } = require("./core/tts");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────
const COMFY_BASE_URL = "https://cloud.comfy.org";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const STATUS_INDEX = process.env.STATUS_CREATED_INDEX_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const REGION = process.env.AWS_REGION || "ap-southeast-1";

// ─── DynamoDB ─────────────────────────────────────────────────────────────────
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ─── ComfyUI API helpers ──────────────────────────────────────────────────────
// (Moved to services.js)

// ─── DynamoDB helpers ─────────────────────────────────────────────────────────

const updateDynamoStatus = async (jobId, userEmail, status, { resultUrl, comfyPromptId } = {}) => {
  const updates = ["#s = :s", "updated_at = :u"];
  const names = { "#s": "status" };
  const values = { ":s": status, ":u": new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }) };

  if (resultUrl !== undefined) {
    updates.push("result_url = :r");
    values[":r"] = resultUrl;
  }
  if (comfyPromptId !== undefined) {
    updates.push("comfy_prompt_id = :cp");
    values[":cp"] = comfyPromptId;
  }
  if (arguments[3]?.usedApiKey) {
    updates.push("used_api_key = :uak");
    values[":uak"] = arguments[3].usedApiKey;
  }

  try {
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET " + updates.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    console.error("[ComfyUI] Dynamo update error:", err.message);
  }
};

const getProcessingJobs = async () => {
  const res = await dynamo.send(new QueryCommand({
    TableName: USER_REQUEST_TABLE,
    IndexName: STATUS_INDEX,
    KeyConditionExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "PROCESSING" },
  }));
  return res.Items || [];
};

// ─── Core Logic ──────────────────────────────────────────────────────────────

const checkSingleJobStatus = async (job, redis) => {
  const promptId = job.comfy_prompt_id;
  if (!promptId) return;
  try {
    const apiKey = job.used_api_key;
    if (!apiKey) return;

    const res = await fetch(`${COMFY_BASE_URL}/api/job/${promptId}/status`, {
      headers: { "X-API-Key": apiKey },
    });

    if (!res.ok) return;
    const { status } = await res.json();
    if (status === "completed" || status === "failed" || status === "cancelled") {
      if (status === "completed") {
        const resultUrl = await getOutputUrl(promptId, apiKey);
        await updateDynamoStatus(job.uuid, job.user_email, "COMPLETED", { resultUrl });
      } else {
        await updateDynamoStatus(job.uuid, job.user_email, "FAILED");
      }
    }
  } catch (err) {
    console.error(`[Poller] Error job ${job.uuid}:`, err.message);
  }
};

const handlePolling = async () => {
  const redis = getRedis();
  const jobs = await getProcessingJobs();
  if (jobs.length > 0) {
    await Promise.all(jobs.map(job => checkSingleJobStatus(job, redis)));
  }
};

const handleSubmission = async (event) => {
  const { jobId, userEmail, requestType, prompt, videoQuality, aspectRatio, s3ImageUrls } = event;

  let finalJobPrompt = prompt;
  let currentS3ImageUrls = Array.isArray(s3ImageUrls) ? s3ImageUrls : (s3ImageUrls ? [s3ImageUrls] : []);

  // 1. Dev Dummy Check (Skip ComfyUI Cloud in Dev for Video Gen)
  const isDev = process.env.USER_REQUEST_TABLE_NAME && process.env.USER_REQUEST_TABLE_NAME.endsWith("-dev");

  // 2. Pick ComfyUI API Key early to be used for both Image Gen and Video Gen
  const redis = getRedis();
  const services = require("./services");
  const apiKeysString = await services.getComfyApiKeys();
  const comfyApiKey = await pickComfyApiKey(apiKeysString, redis);

  if (!comfyApiKey) {
    console.log(`[Worker] All ComfyUI API keys are busy. Skipping job ${jobId} for now.`);
    return;
  }

  // 3. Process Heavy AI Requirements (LLM & Gemini)
  if (requestType === "UGC-P") {
    try {
      console.log(`[Worker] Processing UGC-P AI requirements for job ${jobId}`);
      const templatePath = path.join(__dirname, "PROMPT_UGC_PRODUCT");
      const template = fs.readFileSync(templatePath, "utf-8");

      const orientationMap = { "9:16": "portrait", "16:9": "landscape", "1:1": "square" };
      const orientation = orientationMap[aspectRatio] || "portrait";
      const userPrompt = `1. {product_description}: ${prompt}\n2. {video_duration}: 15 detik\n3. {image_orientation}: ${orientation}`;

      const aiResponse = await callOpenAILLM(template, userPrompt);
      if (aiResponse) {
        try {
          const llmResponse = JSON.parse(aiResponse);
          finalJobPrompt = llmResponse.ltx_prompt || aiResponse;

          // Update DynamoDB with LLM response
          await dynamo.send(new UpdateCommand({
            TableName: USER_REQUEST_TABLE,
            Key: { uuid: jobId, user_email: userEmail },
            UpdateExpression: "SET llm_response = :lr, updated_at = :now",
            ExpressionAttributeValues: { ":lr": llmResponse, ":now": new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }) }
          }));

          // Trigger Gemini TTS
          if (llmResponse.tts_script && llmResponse.tts_global_config) {
            await generateTTS({
              jobId,
              userEmail,
              userId: event.userId,
              llmResponse,
              S3_RESOURCE_BUCKET,
              dynamo,
              USER_REQUEST_TABLE,
              callGeminiAudio,
              uploadToS3
            });
          }
          // Trigger ComfyUI Image Generation (Flux.2)
          if (currentS3ImageUrls.length > 0) {
            await generateComfyUIImage({
              jobId,
              userEmail,
              userId: event.userId,
              currentS3ImageUrls,
              llmResponse,
              finalJobPrompt,
              videoQuality,
              aspectRatio,
              S3_RESOURCE_BUCKET,
              dynamo,
              USER_REQUEST_TABLE,
              uploadInputImage,
              submitWorkflow,
              getOutputUrl,
              uploadToS3,
              redis,
              comfyApiKey // Reusing the same key picked above
            });
          }

        } catch (e) {
          console.error("[Worker] LLM JSON parse error:", e);
        }
      }
    } catch (err) {
      console.error("[Worker] AI processing error:", err);
    }
  }

  // 4. Dev Simulation for Video
  if (isDev) {
    console.log(`[Dev Dummy] Simulating LTX Video generation for ${jobId}`);
    await updateDynamoStatus(jobId, userEmail, "PROCESSING", { comfyPromptId: `dummy-${jobId}` });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const dummyUrl = "https://www.w3schools.com/html/mov_bbb.mp4";
    await updateDynamoStatus(jobId, userEmail, "COMPLETED", { resultUrl: dummyUrl });

    // Manual decrement for Video part slot
    try {
      const redisKey = `comfyui_job_${comfyApiKey}`;
      await redis.decr(redisKey);
    } catch (e) { }

    return;
  }

  // 5. Submit Video Generation (LTX)
  try {
    const imageUrls = currentS3ImageUrls;
    const uploadedFiles = {};
    for (let i = 0; i < imageUrls.length; i++) {
      const key = `image${i + 1}`;
      uploadedFiles[key] = await uploadInputImage(imageUrls[i], `${jobId}_${key}.png`, comfyApiKey);
    }

    const workflow = buildWorkflow(requestType, { prompt: finalJobPrompt, videoQuality, aspectRatio, uploadedFiles });
    const promptId = await submitWorkflow(workflow, comfyApiKey);

    await updateDynamoStatus(jobId, userEmail, "PROCESSING", {
      comfyPromptId: promptId,
      usedApiKey: comfyApiKey
    });
  } catch (err) {
    console.error(`[Submitter] Error job ${jobId}:`, err.message);
    await updateDynamoStatus(jobId, userEmail, "FAILED");
    // Decrement on failure
    try {
      const redisKey = `comfyui_job_${comfyApiKey}`;
      await redis.decr(redisKey);
    } catch (e) { }
  }
};

// ─── Main Handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return await handlePolling();
  }
  return await handleSubmission(event);
};
