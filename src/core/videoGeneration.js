"use strict";

const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("../utils");
const { getKieAiKey, s3Client } = require("../services");
const { uploadToKie, createKieTask } = require("../lib/kie-ai");
const { getConfig } = require("../lib/config");

/**
 * Triggers a video generation task for a single scene on Kie.ai (ByteDance Seedance 1.5 Pro)
 */
async function generateComfyUIVideo(params) {
  const {
    uuid, user_email, user_id, request_type,
    llm_response, audio, audio_duration,
    video_quality, aspect_ratio,
    imageResultUrl,
    dynamo, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET,
    prompt,
    sceneId,
    duration,
    talkvid // Boolean: whether this scene requires lip sync/talkvid
  } = params;

  const jobId = uuid;
  const userEmail = user_email;

  const activeSceneId = sceneId || 1;
  const isTalkvid = talkvid !== false; // Default to true if not explicitly false

  console.log(`[VideoGen] Submitting Kie.ai ByteDance Seedance 1.5 Pro task for Job: ${jobId}, Scene: ${activeSceneId}, talkvid: ${isTalkvid}`);

  try {
    const kieApiKey = await getKieAiKey();
    if (!kieApiKey) {
      throw new Error("Kie.ai API Key not found in SSM Parameter Store.");
    }

    // Resolve callback URL containing jobId as a path parameter
    const config = await getConfig();
    const callbackBase = config.callback_result || `${config.api_gateway_url || "https://xayhmg0s7b.execute-api.ap-southeast-1.amazonaws.com/dev"}/comfyui-webhook`;
    const callbackBaseNormalized = callbackBase.endsWith("/") ? callbackBase.slice(0, -1) : callbackBase;
    let callBackUrl = `${callbackBaseNormalized}/${jobId}?sceneId=${activeSceneId}`;
    if (params.taskToken) {
      callBackUrl += `&taskToken=${encodeURIComponent(params.taskToken)}`;
    }
    console.log(`[VideoGen] Callback URL: ${callBackUrl}`);

    // Upload starting frame image to Kie.ai
    console.log(`[VideoGen] Uploading starting frame image to Kie.ai: ${imageResultUrl}`);
    const kieImageUrl = await uploadToKie(imageResultUrl, kieApiKey);

    // If talkvid is true and audio is present, generate a signed S3 URL and upload it to Kie.ai
    let uploadedAudioUrl = null;
    if (isTalkvid && audio) {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const { getSignedUrl } = require("../services");
      const bucket = S3_RESOURCE_BUCKET || "dapurartisan";
      console.log(`[VideoGen] Resolving signed audio URL from S3 key: ${audio}`);
      const audioCmd = new GetObjectCommand({ Bucket: bucket, Key: audio });
      const signedAudioUrl = await getSignedUrl(s3Client, audioCmd, { expiresIn: 86400 });
      uploadedAudioUrl = await uploadToKie(signedAudioUrl, kieApiKey);
    }

    const model = "bytedance/seedance-1.5-pro";
    const motionPrompt = prompt || "Cinematic panning shot, clean product presentation.";

    let resolvedAspectRatio = "9:16";
    if (aspect_ratio === "16:9") resolvedAspectRatio = "16:9";
    else if (aspect_ratio === "1:1") resolvedAspectRatio = "1:1";

    const input = {
      prompt: motionPrompt,
      input_urls: [kieImageUrl],
      generate_audio: isTalkvid,
      fixed_lens: false,
      nsfw_checker: false,
      aspect_ratio: resolvedAspectRatio,
      duration: duration || 5
    };

    if (isTalkvid && uploadedAudioUrl) {
      input.audio = uploadedAudioUrl;
    }

    console.log(`[VideoGen] Calling Kie.ai createTask for ${model}...`);
    const taskId = await createKieTask(model, input, callBackUrl, kieApiKey);
    console.log(`[VideoGen] Successfully created task ${taskId} for Scene ${activeSceneId}`);

    return taskId;

  } catch (err) {
    console.error(`[VideoGen] Error triggering video for Job ${jobId}, Scene ${activeSceneId}:`, err);
    throw err;
  }
}

module.exports = {
  generateComfyUIVideo
};
