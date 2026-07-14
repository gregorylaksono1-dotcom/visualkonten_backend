"use strict";

const { getKieAiKey, s3Client } = require("../services");
const { uploadToKie, createVeoTask } = require("../lib/kie-ai");
const { getConfig } = require("../lib/config");

/**
 * Triggers a video generation task for a single scene on Kie.ai (Google Veo 3.1)
 */
async function generateVeoVideo(params) {
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
  const activeSceneId = sceneId || 1;
  const isTalkvid = talkvid !== false;

  console.log(`[VideoGen Veo] Submitting Kie.ai Google Veo task for Job: ${jobId}, Scene: ${activeSceneId}, talkvid: ${isTalkvid}`);

  try {
    const kieApiKey = await getKieAiKey();
    if (!kieApiKey) {
      throw new Error("Kie.ai API Key not found in SSM Parameter Store.");
    }

    const config = await getConfig();
    const callbackBase = config.callback_result || `${config.api_gateway_url || "https://xayhmg0s7b.execute-api.ap-southeast-1.amazonaws.com/dev"}/comfyui-webhook`;
    const callbackBaseNormalized = callbackBase.endsWith("/") ? callbackBase.slice(0, -1) : callbackBase;
    let callBackUrl = `${callbackBaseNormalized}/${jobId}?sceneId=${activeSceneId}`;
    if (params.taskToken) {
      callBackUrl += `&taskToken=${encodeURIComponent(params.taskToken)}`;
    }
    console.log(`[VideoGen Veo] Callback URL: ${callBackUrl}`);

    console.log(`[VideoGen Veo] Uploading starting frame image to Kie.ai: ${imageResultUrl}`);
    const kieImageUrl = await uploadToKie(imageResultUrl, kieApiKey);

    let uploadedAudioUrl = null;
    if (isTalkvid && audio) {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const { getSignedUrl } = require("../services");
      const bucket = S3_RESOURCE_BUCKET || "dapurartisan";
      console.log(`[VideoGen Veo] Resolving signed audio URL from S3 key: ${audio}`);
      const audioCmd = new GetObjectCommand({ Bucket: bucket, Key: audio });
      const signedAudioUrl = await getSignedUrl(s3Client, audioCmd, { expiresIn: 86400 });
      uploadedAudioUrl = await uploadToKie(signedAudioUrl, kieApiKey);
    }

    const model = "veo3_lite";
    let motionPrompt = prompt || "Cinematic panning shot, clean product presentation.";

    let resolvedNegativePrompt = params.negative_prompt || "";
    if (resolvedNegativePrompt) {
      if (!resolvedNegativePrompt.includes("subtitle")) resolvedNegativePrompt += ", subtitle";
      if (!resolvedNegativePrompt.includes("caption")) resolvedNegativePrompt += ", caption";
    } else {
      resolvedNegativePrompt = "subtitle, caption";
    }

    let resolvedAspectRatio = "9:16";
    if (aspect_ratio === "16:9") resolvedAspectRatio = "16:9";
    else if (aspect_ratio === "1:1") resolvedAspectRatio = "1:1";

    let resolvedDuration = Number(duration || 4);
    if (resolvedDuration <= 5) resolvedDuration = 4;

    motionPrompt = `${motionPrompt.trim()}. DO NOT ALLOW: ${resolvedNegativePrompt}`;

    const input = {
      prompt: motionPrompt,
      imageUrls: [kieImageUrl],
      aspect_ratio: resolvedAspectRatio,
      duration: resolvedDuration
    };

    console.log(`[VideoGen Veo] Calling Kie.ai createVeoTask for ${model} with duration: ${resolvedDuration}s...`);
    const taskId = await createVeoTask(model, input, callBackUrl, kieApiKey);
    console.log(`[VideoGen Veo] Successfully created task ${taskId} for Scene ${activeSceneId}`);

    return taskId;
  } catch (err) {
    console.error(`[VideoGen Veo] Error triggering video for Job ${jobId}, Scene ${activeSceneId}:`, err);
    throw err;
  }
}

module.exports = {
  generateVeoVideo
};
