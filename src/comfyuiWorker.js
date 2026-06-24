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
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand, PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("./utils");
const { buildWorkflow } = require("./workflows");
const {
  callOpenAILLM, callGeminiAudio, uploadToS3, getRedis, pickComfyApiKey,
  uploadInputImage, submitWorkflow, getOutputUrl, resolveSignedUrl,
  s3Client, PutObjectCommand
} = require("./services");
const { generateComfyUIImage } = require("./core/imageGeneration");
const { generateImageOpenAI } = require("./core/imageGenerationOpenAI");
const { generateTTS } = require("./core/tts");
const { generateUgcLlmResponse } = require("./core/ugcLlm");
const { generateMultiScenePipeline } = require("./core/ugcWorkflowGeneration");
const { generateProductCinematicPipeline } = require("./core/productCinematikWorkflow");
const { buildTtsGlobalConfig, syncGenderFields } = require("./lib/resolve-voice");

// ─── Config ──────────────────────────────────────────────────────────────────
// const COMFY_BASE_URL = "http://35.194.132.28:8188";
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

const updateDynamoStatus = async (jobId, userEmail, status, { resultUrl, comfyPromptId, videoGenerationDuration, usedApiKey } = {}) => {
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
  if (usedApiKey) {
    updates.push("used_api_key = :uak");
    values[":uak"] = usedApiKey;
  }
  if (videoGenerationDuration !== undefined && videoGenerationDuration !== null) {
    updates.push("video_generation_duration = :vgd");
    values[":vgd"] = videoGenerationDuration;
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

const saveWorkflowAndFailConcurrency = async (jobId, userEmail, workflow, errorMsg) => {
  console.log(`[Worker] Concurrency limit exceeded for job ${jobId}. Handling FAILED_CONCCURENCY.`);
  if (workflow) {
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: `workflow/${jobId}.json`,
        Body: JSON.stringify(workflow),
        ContentType: "application/json"
      }));
      console.log(`[Worker] Saved failed workflow to S3: workflow/${jobId}.json`);
    } catch (s3Err) {
      console.error(`[Worker] Failed to save workflow to S3:`, s3Err.message);
    }
  }
  try {
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET #s = :s, error_message = :e, updated_at = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "FAILED_CONCCURENCY",
        ":e": errorMsg || "Concurrency limit exceeded",
        ":u": getJakartaISOString(),
      },
    }));
    console.log(`[Worker] Updated DynamoDB status to FAILED_CONCCURENCY for job ${jobId}`);
  } catch (dbErr) {
    console.error(`[Worker] Failed to update DynamoDB status to FAILED_CONCCURENCY:`, dbErr.message);
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
      const videoGenStart = job.video_gen_start_at || job.created_at;
      let videoGenerationDuration = null;
      if (videoGenStart) {
        videoGenerationDuration = Math.round((Date.now() - Date.parse(videoGenStart)) / 1000);
      }

      if (status === "completed") {
        const resultUrl = await getOutputUrl(promptId, apiKey);
        await updateDynamoStatus(job.uuid, job.user_email, "COMPLETED", { resultUrl, videoGenerationDuration });
      } else {
        await updateDynamoStatus(job.uuid, job.user_email, "FAILED", { videoGenerationDuration });
      }

      // Release the Redis API key counter
      if (redis) {
        try {
          const redisKey = `comfyui_job_${apiKey}`;
          await redis.decr(redisKey);
          console.log(`[Poller] [Redis] Decremented ${redisKey} for job ${job.uuid} (${status})`);
        } catch (rErr) {
          console.error("[Poller] [Redis] Error decrementing:", rErr.message);
        }
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
  const submissionStartTime = Date.now();
  const { jobId, userEmail, requestType, prompt, videoQuality, aspectRatio, s3ImageUrls, preview } = event;

  let finalJobPrompt = prompt;
  let currentS3ImageUrls = Array.isArray(s3ImageUrls) ? s3ImageUrls : (s3ImageUrls ? [s3ImageUrls] : []);

  // 1. Dev Dummy Check (Skip ComfyUI Cloud in Dev for Video Gen)
  const isDev = process.env.USER_REQUEST_TABLE_NAME && process.env.USER_REQUEST_TABLE_NAME.endsWith("-dev");

  // 2. Define redis and comfyApiKey (will be picked later in generators)
  const redis = getRedis();
  const comfyApiKey = undefined;

  // Retrieve existing job details from DB to see if LLM or TTS can be reused
  let existingJob = {};
  try {
    const jobGet = await dynamo.send(new GetCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail }
    }));
    existingJob = jobGet.Item || {};
  } catch (err) {
    console.error("[Worker] Error fetching existing request:", err.message);
  }

  // 3. Process Heavy AI Requirements (LLM & Gemini)
  const isUgcMode = requestType === "UGC-P" || requestType === "UGC-S";
  const isProductCinematic = requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK";

  if (isUgcMode || isProductCinematic) {
    try {
      console.log(`[Worker] Processing ${requestType} AI requirements for job ${jobId}`);

      const storeType = event.store_type || "offline";
      const sellingMode = event.selling_mode || "hard";
      const videoDuration = event.video_duration || 15;

      let llmResponse = existingJob.llm_response;
      if (!llmResponse) {
        llmResponse = await generateUgcLlmResponse({
          requestType,
          prompt,
          storeType,
          sellingMode,
          videoDuration,
          lipSync: isUgcMode,
          callLLM: callOpenAILLM,
        });

        if (llmResponse) {
          try {
            if (isUgcMode) {
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
            }

            finalJobPrompt = llmResponse.ltx_prompt || JSON.stringify(llmResponse);

            // Update DynamoDB with LLM response
            const now = getJakartaISOString();
            await dynamo.send(new UpdateCommand({
              TableName: USER_REQUEST_TABLE,
              Key: { uuid: jobId, user_email: userEmail },
              UpdateExpression: "SET llm_response = :lr, updated_at = :now",
              ExpressionAttributeValues: { ":lr": llmResponse, ":now": now }
            }));
          } catch (e) {
            console.error("[Worker] Error processing LLM response fields:", e);
          }
        }
      } else {
        console.log(`[Worker] Reusing existing llm_response for job ${jobId}`);
        finalJobPrompt = llmResponse.ltx_prompt || JSON.stringify(llmResponse);
      }

      // Preview mode: generate all preview assets using the new helper, then exit
      if (preview) {
        console.log(`[Worker] Running in Preview mode. Generating all scene and talent images...`);
        const { generatePreviewAssets } = require("./core/previewImageHelper");
        await generatePreviewAssets({
          jobId,
          userEmail,
          userId: event.userId,
          currentS3ImageUrls,
          llmResponse,
          finalJobPrompt,
          aspectRatio,
          S3_RESOURCE_BUCKET,
          dynamo,
          s3: s3Client,
          USER_REQUEST_TABLE,
          requestType,
          startTime: submissionStartTime
        });
        return; // Return early, skipping video workflow and TTS audio generation
      }

      // Video Generation (Upgrade) mode guard: check if preview assets already exist
      if (isUgcMode || isProductCinematic) {
        const hasGeneratedScenes = Array.isArray(existingJob.generated_scenes) && existingJob.generated_scenes.length > 0;
        const hasTalent = (requestType === "UGC-P") ? !!existingJob.generated_image_talent : true;
        if (!hasGeneratedScenes || !hasTalent) {
          const errMsg = "Missing generated preview assets (scenes/talent image). Generation aborted to prevent additional cost.";
          console.error(`[Worker] Error: ${errMsg}`);
          await dynamo.send(new UpdateCommand({
            TableName: USER_REQUEST_TABLE,
            Key: { uuid: jobId, user_email: userEmail },
            UpdateExpression: "SET #s = :status, error_message = :err, updated_at = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":status": "FAILED",
              ":err": errMsg,
              ":now": getJakartaISOString()
            }
          }));
          return;
        }
      }

      if (llmResponse) {
        try {
          // Trigger Gemini TTS (UGC only)
          let ttsResult = null;
          if (isUgcMode) {
            if (existingJob.audio) {
              console.log(`[Worker] Reusing existing TTS audio for job ${jobId}: ${existingJob.audio}`);
              ttsResult = { audioS3Key: existingJob.audio, duration: existingJob.audio_duration };
            } else {
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
          }

          // Flag to switch between OpenAI and Flux Image Generation
          const USE_OPENAI_IMAGE_GEN = true;

          if (currentS3ImageUrls.length > 0) {
            if (isUgcMode && Array.isArray(llmResponse.scenes) && llmResponse.scenes.length > 0) {
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
                requestType,
                preview: preview || false,
                existingJob
              });
            } else if (isProductCinematic && Array.isArray(llmResponse.scene || llmResponse.scenes) && (llmResponse.scene || llmResponse.scenes).length > 0) {
              // Trigger product cinematic pipeline
              await generateProductCinematicPipeline({
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
                requestType,
                preview: preview || false,
                existingJob
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
          if (e.statusCode === 420) {
            await saveWorkflowAndFailConcurrency(jobId, userEmail, e.workflow, e.message);
          } else {
            console.error("[Worker] LLM JSON parse error:", e);
            await updateDynamoStatus(jobId, userEmail, "FAILED");
          }
          if (redis && comfyApiKey) {
            try {
              const redisKey = `comfyui_job_${comfyApiKey}`;
              await redis.decr(redisKey);
              console.log(`[Redis] Decremented ${redisKey} for job ${jobId} (Error handled: ${e.message})`);
            } catch (rErr) {
              console.error("[Redis] Error decrementing:", rErr.message);
            }
          }
        }
      }
    } catch (err) {
      if (err.statusCode === 420) {
        await saveWorkflowAndFailConcurrency(jobId, userEmail, err.workflow, err.message);
      } else {
        console.error("[Worker] AI processing error:", err);
        await updateDynamoStatus(jobId, userEmail, "FAILED");
      }
      if (redis && comfyApiKey) {
        try {
          const redisKey = `comfyui_job_${comfyApiKey}`;
          await redis.decr(redisKey);
          console.log(`[Redis] Decremented ${redisKey} for job ${jobId} (Error handled: ${err.message})`);
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
