"use strict";

const { S3Client, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSecrets } = require("../lib/config");
const getKieAiKey = async () => (await getSecrets()).kie_ai || null;
const getOpenAiKey = async () => (await getSecrets()).openai_api_key || (await getSecrets()).gemini_api_key || null;
const { createKieTask, createVeoTask, getKieTaskStatus, findMediaUrlInKieData } = require("../lib/kie-ai");

const region = process.env.AWS_REGION || "ap-southeast-1";
const s3Client = new S3Client({ region });

/**
 * Polls Kie.ai task until completion
 */
async function waitForKieTask(taskId, kieApiKey, maxWaitSec = 300, isVeo = false) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitSec * 1000) {
    const res = await getKieTaskStatus(taskId, kieApiKey, isVeo);
    if (res && (res.code === 200 || res.code === 0 || res.data)) {
      const data = res.data || res;
      const state = String(data.state || data.status || "").toLowerCase();

      if (state === "success" || state === "text_success" || state === "completed") {
        return data;
      }
      if (state === "fail" || state === "failed" || state === "create_task_failed" || state === "generate_failed") {
        const errorDetail = data.failMsg || data.errorMessage || data.msg || data.message || "Unknown error";
        throw new Error(`Kie.ai generation task failed: ${errorDetail}`);
      }
    }
    await sleep(2500);
  }
  throw new Error(`Kie.ai generation task timed out after ${maxWaitSec}s (TaskId: ${taskId})`);
}

/**
 * Download a remote URL to a Buffer
 */
async function downloadToBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download media from ${url} (status: ${resp.status})`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Lambda handler for Image Generation Task in Auto Motion pipeline
 * Input:
 * {
 *   videoId: "...",
 *   task: { id: "...", type: "image", imagePrompt: "...", aspectRatio: "9:16", ... },
 *   outputBucket: "...",
 *   outputPrefix: "auto-motion/.../generated-raw/"
 * }
 * Output:
 * {
 *   assetKey: "auto-motion/.../generated-raw/{taskId}.png"
 * }
 */
exports.generateImageHandler = async (event) => {
  console.log("[AutoMotion ImageGen] Received event:", JSON.stringify(event));

  const { videoId, task, outputBucket, outputPrefix } = event;
  if (!task || !task.imagePrompt) {
    throw new Error("Missing task or imagePrompt in image generation event");
  }

  const assetKey = `${outputPrefix}${task.id}.png`;
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: outputBucket, Key: assetKey }));
    if (head && head.ContentLength > 1000) {
      console.log(`[AutoMotion ImageGen] Asset already exists: ${assetKey}, reusing.`);
      return { assetKey };
    }
  } catch (e) {}

  const kieApiKey = await getKieAiKey();
  if (!kieApiKey) {
    throw new Error("Kie.ai API key is not configured");
  }

  const model = process.env.AUTOMOTION_IMAGE_MODEL || "nano-banana-2-lite";
  const input = {
    prompt: task.imagePrompt,
    aspect_ratio: task.aspectRatio || "9:16"
  };

  console.log(`[AutoMotion ImageGen] Creating image task with model ${model}, prompt: "${task.imagePrompt}"`);
  const taskId = await createKieTask(model, input, null, kieApiKey);

  console.log(`[AutoMotion ImageGen] Waiting for image task ${taskId}...`);
  const taskData = await waitForKieTask(taskId, kieApiKey, 180, false);
  const mediaUrl = findMediaUrlInKieData(taskData);

  if (!mediaUrl) {
    throw new Error(`Could not locate generated image URL in Kie.ai response: ${JSON.stringify(taskData)}`);
  }

  console.log(`[AutoMotion ImageGen] Downloading generated image from ${mediaUrl}...`);
  const imageBuffer = await downloadToBuffer(mediaUrl);


  console.log(`[AutoMotion ImageGen] Uploading to S3: s3://${outputBucket}/${assetKey}`);
  await s3Client.send(new PutObjectCommand({
    Bucket: outputBucket,
    Key: assetKey,
    Body: imageBuffer,
    ContentType: "image/png"
  }));

  console.log(`[AutoMotion ImageGen] Successfully uploaded assetKey: ${assetKey}`);
  return { assetKey };
};

/**
 * Lambda handler for Video Generation Task in Auto Motion pipeline
 * Input:
 * {
 *   videoId: "...",
 *   task: { id: "...", type: "video", videoPrompt: "...", startSeconds: 8, endSeconds: 12, aspectRatio: "9:16", ... },
 *   outputBucket: "...",
 *   outputPrefix: "auto-motion/.../generated-raw/"
 * }
 * Output:
 * {
 *   assetKey: "auto-motion/.../generated-raw/{taskId}.mp4"
 * }
 */
exports.generateVideoHandler = async (event) => {
  console.log("[AutoMotion VideoGen] Received event:", JSON.stringify(event));

  const { videoId, task, outputBucket, outputPrefix } = event;
  if (!task || !task.videoPrompt) {
    throw new Error("Missing task or videoPrompt in video generation event");
  }

  const assetKey = `${outputPrefix}${task.id}.mp4`;
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: outputBucket, Key: assetKey }));
    if (head && head.ContentLength > 1000) {
      console.log(`[AutoMotion VideoGen] Asset already exists: ${assetKey}, reusing.`);
      return { assetKey };
    }
  } catch (e) {}

  const kieApiKey = await getKieAiKey();
  if (!kieApiKey) {
    throw new Error("Kie.ai API key is not configured");
  }

  const rawDuration = Math.round((task.endSeconds || 5) - (task.startSeconds || 0));
  const configuredModel = process.env.AUTOMOTION_VIDEO_MODEL || "bytedance/seedance-1.5-pro";

  // Normalize Grok model name if legacy preview name was passed in env
  let primaryModel = configuredModel;
  if (primaryModel === "grok-imagine-video-1-5-preview") {
    primaryModel = "grok-imagine/text-to-video";
  }

  const createInputForModel = (m) => {
    if (m.includes("grok")) {
      // Grok text-to-video only accepts allowed durations: 6, 8, 10
      const grokDuration = rawDuration <= 6 ? 6 : rawDuration <= 8 ? 8 : 10;
      return {
        prompt: task.videoPrompt,
        aspect_ratio: task.aspectRatio || "9:16",
        duration: grokDuration
      };
    } else if (m.includes("seedance") || m.includes("bytedance")) {
      return {
        prompt: task.videoPrompt,
        aspect_ratio: task.aspectRatio || "9:16",
        duration: Math.max(3, Math.min(10, rawDuration)),
        generate_audio: false
      };
    } else {
      return {
        prompt: task.videoPrompt,
        aspect_ratio: task.aspectRatio || "9:16",
        duration: Math.max(3, Math.min(10, rawDuration))
      };
    }
  };

  const tryGenerateWithModel = async (modelToUse) => {
    const input = createInputForModel(modelToUse);
    console.log(`[AutoMotion VideoGen] Attempting video task with model ${modelToUse}, prompt: "${task.videoPrompt}", input:`, JSON.stringify(input));

    const isVeo = modelToUse.includes("veo");
    const taskId = (!isVeo && (modelToUse.includes("grok") || modelToUse.includes("seedance") || modelToUse.includes("bytedance") || modelToUse.includes("wan")))
      ? await createKieTask(modelToUse, input, null, kieApiKey)
      : await createVeoTask(modelToUse, input, null, kieApiKey);

    console.log(`[AutoMotion VideoGen] Waiting for video task ${taskId} (model: ${modelToUse})...`);
    const taskData = await waitForKieTask(taskId, kieApiKey, 420, isVeo);
    const mediaUrl = findMediaUrlInKieData(taskData);
    if (!mediaUrl) {
      throw new Error(`Could not locate generated video URL in Kie.ai response: ${JSON.stringify(taskData)}`);
    }
    return mediaUrl;
  };

  let mediaUrl;
  try {
    mediaUrl = await tryGenerateWithModel(primaryModel);
  } catch (primaryErr) {
    if (primaryModel !== "grok-imagine/text-to-video") {
      const fallbackModel = "grok-imagine/text-to-video";
      console.warn(`[AutoMotion VideoGen] Primary model ${primaryModel} failed: ${primaryErr.message}. Attempting fallback with ${fallbackModel}...`);
      try {
        mediaUrl = await tryGenerateWithModel(fallbackModel);
      } catch (fallbackErr) {
        console.error(`[AutoMotion VideoGen] Fallback model ${fallbackModel} also failed: ${fallbackErr.message}`);
        throw new Error(`AutoMotion video generation failed on both ${primaryModel} (${primaryErr.message}) and ${fallbackModel} (${fallbackErr.message})`);
      }
    } else {
      throw primaryErr;
    }
  }

  console.log(`[AutoMotion VideoGen] Downloading generated video from ${mediaUrl}...`);
  const videoBuffer = await downloadToBuffer(mediaUrl);


  console.log(`[AutoMotion VideoGen] Uploading to S3: s3://${outputBucket}/${assetKey}`);
  await s3Client.send(new PutObjectCommand({
    Bucket: outputBucket,
    Key: assetKey,
    Body: videoBuffer,
    ContentType: "video/mp4"
  }));

  console.log(`[AutoMotion VideoGen] Successfully uploaded assetKey: ${assetKey}`);
  return { assetKey };
};
