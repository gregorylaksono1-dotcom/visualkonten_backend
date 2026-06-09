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
const { getJakartaISOString } = require("./utils");
const { buildWorkflow } = require("./workflows");
const {
  callOpenAILLM, callGeminiAudio, uploadToS3, getRedis, pickComfyApiKey,
  uploadInputImage, submitWorkflow, getOutputUrl, resolveSignedUrl,
  s3Client
} = require("./services");
const { generateComfyUIImage } = require("./core/imageGeneration");
const { generateImageOpenAI } = require("./core/imageGenerationOpenAI");
const { generateTTS } = require("./core/tts");
const { generateUgcLlmResponse } = require("./core/ugcLlm");
const { generateMultiScenePipeline } = require("./core/multiSceneGeneration");
const { buildTtsGlobalConfig, syncGenderFields } = require("./lib/resolve-voice");

// ─── Config ──────────────────────────────────────────────────────────────────
// const COMFY_BASE_URL = "http://34.81.171.110:8188";
const COMFY_BASE_URL = "http://cloud.comfy.org";
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
  const values = { ":s": status, ":u": getJakartaISOString() };

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
  if (requestType === "UGC-P" || requestType === "UGC-S") {
    try {
      console.log(`[Worker] Processing ${requestType} AI requirements for job ${jobId}`);

      const storeType = event.store_type || "offline";
      const sellingMode = event.selling_mode || "hard";
      const videoDuration = event.video_duration || 15;

      const llmResponse = await generateUgcLlmResponse({
        requestType,
        prompt,
        storeType,
        sellingMode,
        videoDuration,
        lipSync: true,
        callLLM: callOpenAILLM,
      });

      if (llmResponse) {
        try {
          if (llmResponse.voiceover_script && typeof llmResponse.voiceover_script === "object") {
            if (!llmResponse.tts_script) {
              llmResponse.tts_script = llmResponse.voiceover_script.tts_script || llmResponse.voiceover_script.script;
            }
            if (llmResponse.voiceover_script.word_count != null && llmResponse.tts_word_count == null) {
              llmResponse.tts_word_count = llmResponse.voiceover_script.word_count;
            }
          }
          syncGenderFields(llmResponse);
          llmResponse.tts_global_config = buildTtsGlobalConfig(llmResponse, {
            voiceSelectionMode: event.voice_selection_mode || llmResponse.meta?.voice_selection_mode,
            preferredVoice: event.preferred_voice || llmResponse.meta?.preferred_voice,
          });
          if (llmResponse.voiceover_script && llmResponse.tts_global_config?.voice_name) {
            llmResponse.voiceover_script.voice_name = llmResponse.tts_global_config.voice_name;
          }
          console.log(
            `[Worker] TTS voice resolved: gender=${llmResponse.tts_global_config.gender}, voice=${llmResponse.tts_global_config.voice_name}`
          );

          finalJobPrompt = llmResponse.ltx_prompt || JSON.stringify(llmResponse);

          // Update DynamoDB with LLM response
          const now = getJakartaISOString();
          await dynamo.send(new UpdateCommand({
            TableName: USER_REQUEST_TABLE,
            Key: { uuid: jobId, user_email: userEmail },
            UpdateExpression: "SET llm_response = :lr, updated_at = :now",
            ExpressionAttributeValues: { ":lr": llmResponse, ":now": now }
          }));

          // Trigger Gemini TTS
          let ttsResult = null;
          const hasTtsScript = !!llmResponse.tts_script;
          if (hasTtsScript) {
            const ttsGlobalConfig = llmResponse.tts_global_config || buildTtsGlobalConfig(llmResponse, {
              voiceSelectionMode: event.voice_selection_mode,
              preferredVoice: event.preferred_voice,
            });
            ttsResult = await generateTTS({
              jobId,
              userEmail,
              userId: event.userId,
              llmResponse: { ...llmResponse, tts_global_config: ttsGlobalConfig },
              S3_RESOURCE_BUCKET,
              dynamo,
              USER_REQUEST_TABLE,
              callGeminiAudio,
              uploadToS3
            });
          }

          if (!ttsResult || !ttsResult.audioS3Key) {
            console.error(`[Worker] TTS Generation FAILED or script missing for job ${jobId}. Failing request.`);
            await updateDynamoStatus(jobId, userEmail, "FAILED");
            if (redis && comfyApiKey) {
              try {
                const redisKey = `comfyui_job_${comfyApiKey}`;
                await redis.decr(redisKey);
                console.log(`[Redis] Decremented ${redisKey} for job ${jobId} (TTS generation failed)`);
              } catch (rErr) {
                console.error("[Redis] Error decrementing:", rErr.message);
              }
            }
            return;
          } else {
            console.log(`[Worker] TTS Generation SUCCESS for job ${jobId}. Audio S3 Key: ${ttsResult.audioS3Key}`);
          }

          // Flag to switch between OpenAI and Flux Image Generation
          const USE_OPENAI_IMAGE_GEN = true;

          if (currentS3ImageUrls.length > 0) {
            if (requestType === "UGC-P" && Array.isArray(llmResponse.scenes) && llmResponse.scenes.length > 0) {
              // Trigger dynamic multi-scene video generation pipeline
              await generateMultiScenePipeline({
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
                s3: s3Client,
                USER_REQUEST_TABLE,
                comfyApiKey,
                audio: ttsResult?.audioS3Key || null,
                audioDuration: ttsResult?.duration || null,
                requestType
              });
            } else if (USE_OPENAI_IMAGE_GEN) {
              // Trigger OpenAI Image Generation + Video Generation Pipeline
              await generateImageOpenAI({
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
                s3: s3Client,
                USER_REQUEST_TABLE,
                comfyApiKey,
                audio: ttsResult?.audioS3Key || null,
                audioDuration: ttsResult?.duration || null,
                requestType
              });
            } else {
              // Trigger ComfyUI Image Generation (Flux.2)
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
          } else {
            console.error(`[Worker] No input images found for job ${jobId}. Failing request.`);
            await updateDynamoStatus(jobId, userEmail, "FAILED");
            if (redis && comfyApiKey) {
              try {
                const redisKey = `comfyui_job_${comfyApiKey}`;
                await redis.decr(redisKey);
                console.log(`[Redis] Decremented ${redisKey} for job ${jobId} (No input images)`);
              } catch (rErr) {
                console.error("[Redis] Error decrementing:", rErr.message);
              }
            }
          }

        } catch (e) {
          console.error("[Worker] LLM JSON parse error:", e);
          await updateDynamoStatus(jobId, userEmail, "FAILED");
          if (redis && comfyApiKey) {
            try {
              const redisKey = `comfyui_job_${comfyApiKey}`;
              await redis.decr(redisKey);
              console.log(`[Redis] Decremented ${redisKey} for job ${jobId} (LLM JSON parse error: ${e.message})`);
            } catch (rErr) {
              console.error("[Redis] Error decrementing:", rErr.message);
            }
          }
        }
      }
    } catch (err) {
      console.error("[Worker] AI processing error:", err);
      await updateDynamoStatus(jobId, userEmail, "FAILED");
      if (redis && comfyApiKey) {
        try {
          const redisKey = `comfyui_job_${comfyApiKey}`;
          await redis.decr(redisKey);
          console.log(`[Redis] Decremented ${redisKey} for job ${jobId} (AI processing error: ${err.message})`);
        } catch (rErr) {
          console.error("[Redis] Error decrementing:", rErr.message);
        }
      }
    }
  }

};

// ─── Main Handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return await handlePolling();
  }
  return await handleSubmission(event);
};
