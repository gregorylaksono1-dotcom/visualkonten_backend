"use strict";

const { getKieAiKey } = require("../services");
const { uploadToKie, createKieTask } = require("../lib/kie-ai");
const { getConfig } = require("../lib/config");

/**
 * Triggers a video generation task for a single scene on Kie.ai (Grok Imagine Video 1.5)
 * API Docs: https://kie.ai/grok-imagine-video-1.5
 * Endpoint: POST https://api.kie.ai/api/v1/jobs/createTask
 * Model: grok-imagine-video-1-5-preview
 *
 * Input schema:
 *   prompt        (string)  - Prompt for video generation
 *   image_urls    (array)   - Reference image URL(s) (max 1)
 *   aspect_ratio  (string)  - auto | 1:1 | 16:9 | 9:16 | 3:2 | 2:3
 *   resolution    (string)  - 480p | 720p
 *   duration      (number)  - Video duration in seconds, range [1, 15], default 8
 *   nsfw_checker  (boolean) - NSFW filter toggle
 */
async function generateGrokVideo(params) {
  const {
    uuid,
    video_quality,
    aspect_ratio,
    imageResultUrl,
    prompt,
    sceneId,
    duration,
  } = params;

  const jobId = uuid;
  const activeSceneId = sceneId || 1;

  console.log(`[VideoGen Grok] Submitting Kie.ai Grok Imagine Video 1.5 task for Job: ${jobId}, Scene: ${activeSceneId}`);

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
    console.log(`[VideoGen Grok] Callback URL: ${callBackUrl}`);

    console.log(`[VideoGen Grok] Uploading starting frame image to Kie.ai: ${imageResultUrl}`);
    const kieImageUrl = await uploadToKie(imageResultUrl, kieApiKey);

    const model = "grok-imagine-video-1-5-preview";
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

    // Grok supports duration 1–15 seconds
    let resolvedDuration = Number(duration || 8);
    if (resolvedDuration < 1) resolvedDuration = 1;
    if (resolvedDuration > 15) resolvedDuration = 15;

    // Grok supports 480p or 720p resolution
    let resolvedResolution = "480p";
    if (video_quality === "720p" || video_quality === "1080p") resolvedResolution = "720p";

    motionPrompt = `${motionPrompt.trim()}. DO NOT ALLOW: ${resolvedNegativePrompt}`;

    // Grok uses snake_case 'image_urls' and requires 'resolution' field
    const input = {
      prompt: motionPrompt,
      image_urls: [kieImageUrl],
      aspect_ratio: resolvedAspectRatio,
      resolution: resolvedResolution,
      duration: resolvedDuration,
      nsfw_checker: true
    };

    console.log(`[VideoGen Grok] Calling Kie.ai createKieTask for ${model}, resolution: ${resolvedResolution}, duration: ${resolvedDuration}s...`);
    const taskId = await createKieTask(model, input, callBackUrl, kieApiKey);
    console.log(`[VideoGen Grok] Successfully created task ${taskId} for Scene ${activeSceneId}`);

    return taskId;
  } catch (err) {
    console.error(`[VideoGen Grok] Error triggering video for Job ${jobId}, Scene ${activeSceneId}:`, err);
    throw err;
  }
}

module.exports = {
  generateGrokVideo
};
