/**
 * Kie.ai / Worker (AWS Lambda)
 *
 * Alur kerja:
 *  A. SUBMISSION:
 *     1. Upload satu atau lebih input image ke Kie.ai.
 *     2. Submit task (Image/Video) ke Kie.ai.
 *     3. Simpan taskId ke DynamoDB (status: PROCESSING).
 *
 *  B. POLLING (via EventBridge Schedule):
 *     1. Cari semua job di DynamoDB dengan status "PROCESSING".
 *     2. Cek status di Kie.ai, update jika COMPLETED/FAILED.
 */

"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("./utils");
const {
  callOpenAILLM, callGeminiAudio, uploadToS3,
  s3Client
} = require("./services");
const { generateImageOpenAI } = require("./core/imageGenerationOpenAI");
const { generateTTS } = require("./core/tts");
const { sendTelegramMessage } = require("./lib/telegram");
const { generateUgcLlmResponse } = require("./core/ugcLlm");
const { generateMultiScenePipeline } = require("./core/ugcWorkflowGeneration");
const { generateProductCinematicPipeline } = require("./core/productCinematikWorkflow");
const { buildTtsGlobalConfig, syncGenderFields } = require("./lib/resolve-voice");

const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const STATUS_INDEX = process.env.STATUS_CREATED_INDEX_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const REGION = process.env.AWS_REGION || "ap-southeast-1";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const updateDynamoStatus = async (jobId, userEmail, status, { resultUrl, comfyPromptId, videoGenerationDuration, error_message, llm_reason } = {}) => {
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
  if (videoGenerationDuration !== undefined && videoGenerationDuration !== null) {
    updates.push("video_generation_duration = :vgd");
    values[":vgd"] = videoGenerationDuration;
  }
  if (error_message !== undefined && error_message !== null) {
    updates.push("error_message = :err");
    values[":err"] = error_message;
  }
  if (llm_reason !== undefined && llm_reason !== null) {
    updates.push("llm_reason = :llmr");
    values[":llmr"] = llm_reason;
  }

  try {
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET " + updates.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    if (status === "FAILED" || status === "COMPLETED") {
      try {
        const { sendJobStatusNotification } = require("./lib/telegram");
        sendJobStatusNotification(jobId, status, { userEmail, error_message, resultUrl });
      } catch (teleErr) {
        console.error("[Telegram alert failed]", teleErr.message);
      }
    }
  } catch (err) {
    console.error("[Kie.ai Worker] Dynamo update error:", err.message);
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

const checkSingleJobStatus = async (job) => {
  try {
    const { getKieAiKey } = require("./services");
    const { getKieTaskStatus, findMediaUrlInKieData } = require("./lib/kie-ai");
    const { processKieAiCompletion } = require("./core/comfyuiHandler");

    const kieApiKey = await getKieAiKey();
    if (!kieApiKey) return;

    // Case A: Multi-scene jobs
    if (Array.isArray(job.video_scenes) && job.video_scenes.length > 0) {
      console.log(`[Poller] Job ${job.uuid} has ${job.video_scenes.length} scenes. Checking unfinished ones...`);
      for (const sceneItem of job.video_scenes) {
        if (sceneItem.isFinish === true) continue;
        
        // Find the taskId
        const sceneKey = Object.keys(sceneItem).find(k => k.startsWith("scene_"));
        if (!sceneKey) continue;
        
        const sceneId = sceneKey.split("_")[1];
        const taskId = sceneItem[sceneKey];
        
        console.log(`[Poller] Checking Scene ${sceneId} (Task ID: ${taskId}) for job ${job.uuid}`);
        const isVeo = job.request_type && String(job.request_type).toUpperCase() !== "CHASER_1";
        const resJson = await getKieTaskStatus(taskId, kieApiKey, isVeo);
        if (resJson.code === 200 && resJson.data) {
          const status = String(resJson.data.state || resJson.data.status || "").toLowerCase();
          if (status === "success" || status === "text_success") {
            const resultUrl = findMediaUrlInKieData(resJson.data);
            if (resultUrl) {
              await processKieAiCompletion({
                taskId,
                resultUrl,
                mediaType: "videos",
                dynamo,
                s3: s3Client,
                USER_REQUEST_TABLE,
                S3_RESOURCE_BUCKET,
                queryStringParameters: { jobId: job.uuid, userEmail: job.user_email, sceneId }
              });
            }
          } else if (status === "fail" || status === "create_task_failed" || status === "generate_failed") {
            if (job.sfn_execution_arn) {
              const sceneTokenKey = `video_${sceneId}`;
              const taskToken = job.sfn_task_tokens?.[sceneTokenKey];
              if (taskToken) {
                console.log(`[Poller] Step Functions job detected. Failing task token for ${sceneTokenKey}...`);
                const { SFNClient, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");
                const sfnClient = new SFNClient({ region: process.env.AWS_REGION || "ap-southeast-1" });
                try {
                  await sfnClient.send(new SendTaskFailureCommand({
                    taskToken,
                    error: "KieAiGenerationFailed",
                    cause: resJson.data?.msg || `Kie.ai generation failed for scene ${sceneId}`
                  }));
                } catch (sfnErr) {
                  console.error(`[Poller] Failed to send task failure command:`, sfnErr.message);
                }

                await updateDynamoStatus(job.uuid, job.user_email, "RETRYING (video)", {
                  error_message: resJson.data?.msg || `Kie.ai generation failed for scene ${sceneId}`
                });
                break;
              }
            }

            await updateDynamoStatus(job.uuid, job.user_email, "FAILED", {
              error_message: resJson.data.msg || `Kie.ai generation failed for scene ${sceneId}`
            });
            break; // Stop checking other scenes since the job failed
          }
        }
      }
      return;
    }

    // Case B: Standard Single Image/Video job
    const taskId = job.comfy_prompt_id || job.image_prompt_id;
    if (!taskId) return;
    
    console.log(`[Poller] Checking single task ${taskId} for job ${job.uuid}...`);
    const isVeo = Boolean(job.comfy_prompt_id) && String(job.request_type || "").toUpperCase() !== "CHASER_1";
    const resJson = await getKieTaskStatus(taskId, kieApiKey, isVeo);
    if (resJson.code === 200 && resJson.data) {
      const status = String(resJson.data.state || resJson.data.status || "").toLowerCase();
      if (status === "success" || status === "text_success") {
        const resultUrl = findMediaUrlInKieData(resJson.data);
        if (resultUrl) {
          const mediaType = job.comfy_prompt_id ? "videos" : "images";
          await processKieAiCompletion({
            taskId,
            resultUrl,
            mediaType,
            dynamo,
            s3: s3Client,
            USER_REQUEST_TABLE,
            S3_RESOURCE_BUCKET
          });
        }
      } else if (status === "fail" || status === "create_task_failed" || status === "generate_failed") {
        if (job.request_type === "MOTION_CONTROL") {
          const { handleMotionControlFailure } = require("./prompt/motionControl");
          const retried = await handleMotionControlFailure(job, resJson.data?.msg || "Kie.ai generation failed", dynamo, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET);
          if (retried) return;
        }

        const videoGenStart = job.video_gen_start_at || job.created_at;
        let videoGenerationDuration = null;
        if (videoGenStart) {
          videoGenerationDuration = Math.round((Date.now() - Date.parse(videoGenStart)) / 1000);
        }
        await updateDynamoStatus(job.uuid, job.user_email, "FAILED", {
          videoGenerationDuration,
          error_message: resJson.data.msg || "Kie.ai generation failed"
        });
      }
    }
  } catch (err) {
    console.error(`[Poller] Error checking status for job ${job.uuid}:`, err.message);
  }
};

const handlePolling = async () => {
  const jobs = await getProcessingJobs();
  if (jobs.length > 0) {
    console.log(`[Poller] Found ${jobs.length} jobs in PROCESSING state. Polling statuses...`);
    await Promise.all(jobs.map(job => checkSingleJobStatus(job)));
  } else {
    console.log(`[Poller] No processing jobs to check.`);
  }
};

const handleSubmission = async (event) => {
  const submissionStartTime = Date.now();
  const { jobId, userEmail, requestType, prompt, videoQuality, aspectRatio, s3ImageUrls, preview } = event;

  let finalJobPrompt = prompt;
  let currentS3ImageUrls = Array.isArray(s3ImageUrls) ? s3ImageUrls : (s3ImageUrls ? [s3ImageUrls] : []);

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

  // ─── Key Routing for Custom Handlers ──────────────────────────────────────────
  if (requestType === "MOTION_CONTROL") {
    console.log(`[Worker] Starting MOTION_CONTROL task submission for job ${jobId}`);
    try {
      const { submitMotionControlTask } = require("./prompt/motionControl");
      await submitMotionControlTask({
        jobId,
        userEmail,
        userId: event.userId,
        s3ImageUrls,
        videoRefKey: event.video_ref_key || existingJob.video_ref_key,
        duration: event.duration_seconds || 5,
        dynamo,
        USER_REQUEST_TABLE,
        S3_RESOURCE_BUCKET
      });
      await sendTelegramMessage(`user "${userEmail}" melakukan generasi ${requestType}`).catch(console.error);
      return;
    } catch (err) {
      console.error(`[Worker] Error executing motion control handler for job ${jobId}:`, err);
      await updateDynamoStatus(jobId, userEmail, "FAILED", { error_message: err.message });
      return;
    }
  }

  // Check for dynamic prompt template in database (pricing table)
  const standardTypes = ["UGC-P", "UGC-S", "FREE-TRIAL", "PRODUCT-CINEMATIC", "PRODUCT-CINEMATIK"];
  let templatePrompt = null;
  if (!standardTypes.includes(String(requestType).toUpperCase())) {
    const { loadPromptBuilder } = require("./prompt/genericTemplateHandler");
    templatePrompt = await loadPromptBuilder(requestType);
  }
  const isTemplateDriven = Boolean(templatePrompt);

  if (isTemplateDriven) {
    if (!existingJob.llm_response) {
      console.log(`[Worker] Generating dynamic LLM response for job ${jobId} (Type: ${requestType})`);
      try {
        const { handleGenericTemplate } = require("./prompt/genericTemplateHandler");
        const llmResponse = await handleGenericTemplate({
          jobId,
          userEmail,
          userId: event.userId,
          currentS3ImageUrls,
          prompt,
          videoQuality,
          aspectRatio,
          S3_RESOURCE_BUCKET,
          dynamo,
          s3: s3Client,
          USER_REQUEST_TABLE,
          preview: preview || false,
          existingJob,
          requestType,
          template: templatePrompt
        });
        existingJob.llm_response = llmResponse;
        console.log(`[Worker] Dynamic LLM response generated successfully for type: ${requestType}. Proceeding to state machine.`);
      } catch (err) {
        console.error(`[Worker] Error executing generic template handler for job ${jobId} (Type: ${requestType}):`, err);
        await updateDynamoStatus(jobId, userEmail, "FAILED", { error_message: err.message });
        
        if (existingJob.credit_amount) {
          const { refundUserCredit } = require("./services");
          const isFreeTrialUsed = existingJob.request_type === "FREE-TRIAL";
          await refundUserCredit(event.userId || existingJob.user_id, existingJob.credit_amount, isFreeTrialUsed);
        }
        return;
      }
    } else {
      console.log(`[Worker] Reusing existing llm_response for job ${jobId} (Type: ${requestType})`);
    }
  }


  const isUgcMode = requestType === "UGC-P" || requestType === "UGC-S" || requestType === "UGC-PRESENTER" || String(requestType).toUpperCase().startsWith("UGC-") || isTemplateDriven;
  const isProductCinematic = requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK" || String(requestType).toUpperCase().includes("CINEMATIC") || String(requestType).toUpperCase().includes("CINEMATIK");

  if (isUgcMode || isProductCinematic) {
    try {
      console.log(`[Worker] Processing ${requestType} AI requirements for job ${jobId}`);

      const storeType = event.store_type || "offline";
      const sellingMode = event.selling_mode || "hard";
      const videoDuration = event.video_duration || 15;

      let llmResponse = existingJob.llm_response;
      if (!llmResponse) {
        const signedImageUrls = [];
        for (const urlOrKey of currentS3ImageUrls) {
          if (urlOrKey && typeof urlOrKey === "string" && urlOrKey.trim() !== "") {
            try {
              let key = urlOrKey;
              if (urlOrKey.startsWith("http://") || urlOrKey.startsWith("https://")) {
                const parsed = new URL(urlOrKey);
                const host = parsed.hostname;
                if (host.includes(".s3.")) {
                  key = decodeURIComponent(parsed.pathname.substring(1));
                } else if (host === "s3.amazonaws.com" || host.startsWith("s3-") || host.startsWith("s3.")) {
                  const parts = parsed.pathname.substring(1).split("/");
                  key = decodeURIComponent(parts.slice(1).join("/"));
                }
              }
              const { GetObjectCommand } = require("@aws-sdk/client-s3");
              const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
              const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
              const signed = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
              signedImageUrls.push(signed);
            } catch (signErr) {
              console.error(`[Worker] Failed to sign image URL/key: ${urlOrKey}`, signErr.message);
            }
          }
        }

        console.log(`[Worker] Generating LLM response with ${signedImageUrls.length} attached images`);
        llmResponse = await generateUgcLlmResponse({
          requestType,
          prompt,
          storeType,
          sellingMode,
          videoDuration,
          lipSync: isUgcMode,
          callLLM: callOpenAILLM,
          imageUrls: signedImageUrls
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

      if (llmResponse && (llmResponse.status === "error" || llmResponse.error === true || llmResponse.error === "true")) {
        const reason = llmResponse.reason || "Permintaan tidak valid atau melanggar kebijakan.";
        console.log(`[Worker] LLM rejected the prompt for job ${jobId}. Reason: ${reason}`);
        await updateDynamoStatus(jobId, userEmail, "ERROR_LLM", { 
          error_message: reason,
          llm_reason: reason
        });

        if (existingJob.credit_amount) {
          const { refundUserCredit } = require("./services");
          const isFreeTrialUsed = existingJob.request_type === "FREE-TRIAL";
          await refundUserCredit(event.userId || existingJob.user_id, existingJob.credit_amount, isFreeTrialUsed);
        }
        await sendTelegramMessage(`${userEmail} error_llm ${reason}`).catch(console.error);
        return;
      }

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
        await sendTelegramMessage(`user "${userEmail}" melakukan generasi preview ${requestType}`).catch(console.error);
        return;
      }

      if (llmResponse) {
        try {
          console.log(`[Worker] Starting KIE.ai Step Function for job ${jobId}`);
          await sendTelegramMessage(`user "${userEmail}" melakukan generasi ${requestType}`).catch(console.error);
          const { triggerStateMachine } = require("./core/sfnOrchestrator");
          await triggerStateMachine({
            jobId,
            userEmail,
            userId: event.userId,
            currentS3ImageUrls,
            llmResponse,
            finalJobPrompt,
            aspectRatio,
            requestType,
            audio: existingJob.audio,
            audio_duration: existingJob.audio_duration
          });

        } catch (e) {
          console.error("[Worker] Process error:", e);
          await updateDynamoStatus(jobId, userEmail, "FAILED", { error_message: e.message });
        }
      }
    } catch (err) {
      console.error("[Worker] AI processing error:", err);
      await updateDynamoStatus(jobId, userEmail, "FAILED", { error_message: err.message });
    }
  }
};

exports.handler = async (event) => {
  // 1. Check if this is a Step Functions Task invocation
  if (event.step) {
    const sfnOrchestrator = require("./core/sfnOrchestrator");
    console.log(`[SFN Task] Router received step: ${event.step}`);
    switch (event.step) {
      case "prepareJobData":
        return await sfnOrchestrator.prepareJobData(event);
      case "submitLockImage":
        return await sfnOrchestrator.submitLockImage(event);
      case "submitSceneImage":
        return await sfnOrchestrator.submitSceneImage(event);
      case "submitSceneVideo":
        return await sfnOrchestrator.submitSceneVideo(event);
      case "mergeVideoScenes":
        return await sfnOrchestrator.mergeVideoScenes(event);
      default:
        throw new Error(`Unknown step function step: ${event.step}`);
    }
  }

  // 2. EventBridge Scheduler (legacy polling)
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return await handlePolling();
  }

  // 3. Admin redrive request (manual trigger of failed job)
  if (event.action === "redriveJob" && event.executionArn) {
    const sfnOrchestrator = require("./core/sfnOrchestrator");
    return await sfnOrchestrator.triggerManualRedrive(event.executionArn);
  }

  // 4. Normal job submission
  return await handleSubmission(event);
};
