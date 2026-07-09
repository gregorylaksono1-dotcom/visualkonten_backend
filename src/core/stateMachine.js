"use strict";

const { getRedis, getKieAiKey, s3Client, docClient } = require("../services");
const { uploadToKie, createKieTask } = require("../lib/kie-ai");
const { getConfig } = require("../lib/config");
const { GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("../services");
const { QueryCommand, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("../utils");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Helper to extract raw S3 Key from absolute S3 URLs (virtual-hosted or path-style).
 */
function extractS3Key(urlOrKey) {
  if (!urlOrKey) return "";
  const trimmed = urlOrKey.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname;
      if (host.includes(".s3.")) {
        return decodeURIComponent(parsed.pathname.substring(1));
      } else if (host === "s3.amazonaws.com" || host.startsWith("s3-") || host.startsWith("s3.")) {
        const parts = parsed.pathname.substring(1).split("/");
        return decodeURIComponent(parts.slice(1).join("/"));
      }
    } catch (e) {
      console.warn(`[State Machine] Failed to parse S3 URL: ${trimmed}`, e.message);
    }
  }
  return decodeURIComponent(trimmed);
}


/**
 * Downloads a static FFmpeg binary for Linux x86_64 at runtime, caches it in /tmp/ffmpeg, and makes it executable.
 */
async function ensureFfmpegBinary() {
  const localFfmpegPath = "/tmp/ffmpeg";
  if (fs.existsSync(localFfmpegPath)) {
    return localFfmpegPath;
  }
  console.log(`[FFmpeg] FFmpeg binary not found in /tmp. Downloading from user S3 bucket...`);
  const url = "https://gambr-public.s3.ap-southeast-1.amazonaws.com/library/ffmpeg-linux-x64";
  let resp = await fetch(url);
  if (!resp.ok) {
    const regionalUrl = "https://s3.ap-southeast-1.amazonaws.com/gambr-public/library/ffmpeg-linux-x64";
    console.log(`[FFmpeg] S3 virtual-hosted download failed with status ${resp.status}. Retrying with path-style URL: ${regionalUrl}`);
    resp = await fetch(regionalUrl);
  }
  if (!resp.ok) {
    throw new Error(`Failed to download static FFmpeg from S3: ${resp.status}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(localFfmpegPath, buffer);
  fs.chmodSync(localFfmpegPath, "755");
  console.log(`[FFmpeg] Static FFmpeg downloaded and made executable.`);
  return localFfmpegPath;
}

/**
 * Concatenates all finished scenes using FFmpeg concat demuxer and uploads the result to S3.
 */
async function mergeVideoScenes(job, videoScenes, dynamo, s3, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET) {
  console.log(`[FFmpeg Merge] Merging videos for job ${job.uuid}`);
  const tmpDir = "/tmp";
  const inputPaths = [];
  try {
    for (let i = 0; i < videoScenes.length; i++) {
      const vs = videoScenes[i];
      const sceneNum = i + 1;
      const url = vs.url;
      if (!url) throw new Error(`Missing URL for scene ${sceneNum}`);

      const localPath = path.join(tmpDir, `scene_${sceneNum}.mp4`);
      console.log(`[FFmpeg Merge] Downloading scene ${sceneNum} from ${url}`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to download scene ${sceneNum}: ${resp.status}`);
      fs.writeFileSync(localPath, Buffer.from(await resp.arrayBuffer()));
      inputPaths.push(localPath);
    }

    const listPath = path.join(tmpDir, `concat_list_${job.uuid}.txt`);
    const listContent = inputPaths.map(p => `file '${path.basename(p)}'`).join("\n");
    fs.writeFileSync(listPath, listContent);
    console.log(`[FFmpeg Merge] Concat list file written to ${listPath}`);

    // Generate and download TTS if not UGC
    let localAudioPath = null;
    let finalAudioS3Key = null;

    const requestType = job.request_type || "";
    const isUgcMode = requestType === "UGC-P" || requestType === "UGC-S" || requestType === "UGC-PRESENTER" || String(requestType).toUpperCase().startsWith("UGC-") || requestType === "TESTIMONY_TULUS";

    if (!isUgcMode) {
      const llmResponse = job.llm_response || {};
      const ttsScript = llmResponse.voiceover_script?.script || llmResponse.tts_script;
      if (ttsScript) {
        console.log(`[FFmpeg Merge] Non-UGC job: Generating TTS audio for script: "${ttsScript.slice(0, 100)}..."`);
        try {
          const { generateTTS } = require("./tts");
          const { callGeminiAudio, uploadToS3 } = require("../services");
          const { buildTtsGlobalConfig } = require("../lib/resolve-voice");

          const ttsGlobalConfig = llmResponse.tts_global_config || buildTtsGlobalConfig(llmResponse, {});
          const ttsResult = await generateTTS({
            jobId: job.uuid,
            userEmail: job.user_email,
            userId: job.user_id,
            llmResponse: {
              ...llmResponse,
              tts_script: ttsScript,
              tts_global_config: ttsGlobalConfig
            },
            S3_RESOURCE_BUCKET,
            dynamo,
            USER_REQUEST_TABLE,
            callGeminiAudio,
            uploadToS3
          });
          if (ttsResult && ttsResult.audioS3Key) {
            finalAudioS3Key = ttsResult.audioS3Key;
          }
        } catch (ttsErr) {
          console.error(`[FFmpeg Merge] TTS generation failed, continuing merge without TTS overlay:`, ttsErr.message);
        }
      }
    }

    if (finalAudioS3Key) {
      try {
        const { GetObjectCommand } = require("@aws-sdk/client-s3");
        const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: finalAudioS3Key });
        const signedAudio = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
        localAudioPath = path.join(tmpDir, `audio_${job.uuid}.wav`);
        console.log(`[FFmpeg Merge] Downloading S3 TTS audio: ${signedAudio}`);
        const audioResp = await fetch(signedAudio);
        if (audioResp.ok) {
          fs.writeFileSync(localAudioPath, Buffer.from(await audioResp.arrayBuffer()));
          console.log(`[FFmpeg Merge] TTS audio downloaded successfully to ${localAudioPath}`);
        } else {
          localAudioPath = null;
          console.error(`[FFmpeg Merge] Failed to download S3 audio: ${audioResp.status}`);
        }
      } catch (audioDlErr) {
        console.error(`[FFmpeg Merge] Error downloading TTS audio:`, audioDlErr.message);
        localAudioPath = null;
      }
    }

    const outputPath = path.join(tmpDir, `output_${job.uuid}.mp4`);
    const ffmpegCmd = await ensureFfmpegBinary();

    let cmd = `${ffmpegCmd} -y -f concat -safe 0 -i ${listPath} -c copy ${outputPath}`;
    if (localAudioPath) {
      cmd = `${ffmpegCmd} -y -f concat -safe 0 -i ${listPath} -i ${localAudioPath} -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest ${outputPath}`;
    }

    console.log(`[FFmpeg Merge] Running command: ${cmd}`);

    await new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error(`[FFmpeg Merge] FFmpeg error:`, stderr);
          reject(new Error(`FFmpeg merge execution failed: ${err.message}`));
        } else {
          console.log(`[FFmpeg Merge] FFmpeg success`);
          resolve();
        }
      });
    });

    if (localAudioPath) {
      try { fs.unlinkSync(localAudioPath); } catch { }
    }

    const s3Key = `generated_videos/${job.user_id || "anonymous"}/${job.uuid}.mp4`;
    console.log(`[FFmpeg Merge] Uploading merged video to S3: ${s3Key}`);
    await s3.send(new PutObjectCommand({
      Bucket: S3_RESOURCE_BUCKET,
      Key: s3Key,
      Body: fs.readFileSync(outputPath),
      ContentType: "video/mp4"
    }));

    const videoGenStart = job.video_gen_start_at || job.created_at;
    let videoGenerationDuration = null;
    if (videoGenStart) {
      videoGenerationDuration = Math.round((Date.now() - Date.parse(videoGenStart)) / 1000);
    }

    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: job.uuid, user_email: job.user_email },
      UpdateExpression: "SET result_url = :res, s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys), #s = :status, updated_at = :now, video_generation_duration = :vgd",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":res": s3Key,
        ":empty_list": [],
        ":newKeys": [s3Key],
        ":status": "COMPLETED",
        ":now": getJakartaISOString(),
        ":vgd": videoGenerationDuration
      }
    }));
    console.log(`[FFmpeg Merge] Job ${job.uuid} successfully completed!`);
    try {
      const { sendJobStatusNotification } = require("../lib/telegram");
      sendJobStatusNotification(job.uuid, "COMPLETED", { userEmail: job.user_email, resultUrl: s3Key });
    } catch (teleErr) {
      console.error("[Telegram alert failed]", teleErr.message);
    }

    inputPaths.forEach(p => { try { fs.unlinkSync(p); } catch { } });
    try { fs.unlinkSync(listPath); } catch { }
    try { fs.unlinkSync(outputPath); } catch { }

  } catch (err) {
    console.error(`[FFmpeg Merge] Error merging scenes for job ${job.uuid}:`, err);
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: job.uuid, user_email: job.user_email },
      UpdateExpression: "SET #s = :status, error_message = :err, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":status": "FAILED",
        ":err": `Video merge failed: ${err.message}`,
        ":now": getJakartaISOString()
      }
    }));
    try {
      const { sendJobStatusNotification } = require("../lib/telegram");
      sendJobStatusNotification(job.uuid, "FAILED", { userEmail: job.user_email, error_message: `Video merge failed: ${err.message}` });
    } catch (teleErr) {
      console.error("[Telegram alert failed]", teleErr.message);
    }
  }
}

/**
 * Submits a Flux-2 image generation task to Kie.ai
 */
async function submitKieImageTask({ jobId, id, type, prompt, negativePrompt, referenceUrls, callbackBase, kieApiKey, taskToken, requestType }) {
  const callbackBaseNormalized = callbackBase.endsWith("/") ? callbackBase.slice(0, -1) : callbackBase;
  let callBackUrl = `${callbackBaseNormalized}/images?request-id=${jobId}&type=${type}&id=${id}`;
  if (taskToken) {
    callBackUrl += `&taskToken=${encodeURIComponent(taskToken)}`;
  }

  let resolvedAspectRatio = "9:16";
  const hasImages = Array.isArray(referenceUrls) && referenceUrls.length > 0;
  
  let model;
  if (requestType === "ANIMASI_1" || requestType === "problemsolutionAnimation") {
    model = "nano-banana-2-lite";
  } else {
    model = hasImages ? "gpt-image-2-image-to-image" : "gpt-image-2-text-to-image";
  }
  const input = {
    prompt,
    aspect_ratio: resolvedAspectRatio
  };

  if (hasImages) {
    const kieRefUrls = [];
    for (const refUrl of referenceUrls) {
      if (refUrl) {
        const kieRefUrl = await uploadToKie(refUrl, kieApiKey);
        kieRefUrls.push(kieRefUrl);
      }
    }
    if (kieRefUrls.length > 0) {
      input.imageUrls = kieRefUrls; // Just in case, standard Kie API parameter
      input.image_urls = kieRefUrls; // Used previously by nano-banana-2-lite
      input.input_urls = kieRefUrls; // Used specifically by gpt-image-2-image-to-image
    }
  }

  console.log(`[Kie.ai Image Task] Creating task for type ${type}, id ${id}, model ${model}`);
  const taskId = await createKieTask(model, input, callBackUrl, kieApiKey);
  return taskId;
}

/**
 * Transition to Scene Image Phase
 */
async function transitionToSceneImagePhase(jobId, buildQueue, callbackBase, kieApiKey) {
  console.log(`[State Machine] Transitioning to Scene Image Phase for job ${jobId}`);
  const redis = getRedis();
  const redisKey = `build_queue_${jobId}`;

  const promises = buildQueue.scenes.map(async (scene) => {
    const referenceUrls = [];
    const dependencies = Array.isArray(scene.dependency) ? scene.dependency : [];
    for (const depId of dependencies) {
      const lockItem = buildQueue.lock.find(l => l.id === depId);
      if (lockItem && lockItem.s3key) {
        const key = extractS3Key(lockItem.s3key);
        const cmd = new GetObjectCommand({ Bucket: process.env.S3_RESOURCE_BUCKET || "dapurartisan", Key: key });
        const signed = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
        referenceUrls.push(signed);
      }
    }

    const taskId = await submitKieImageTask({
      jobId,
      id: scene.scene_id,
      type: "imagesScene",
      prompt: scene.prompt_image,
      negativePrompt: scene.negative_prompt_image,
      referenceUrls,
      callbackBase,
      kieApiKey
    });
    scene.imageTaskId = taskId;
  });

  await Promise.all(promises);
  await redis.set(redisKey, JSON.stringify(buildQueue), { ex: 5400 });
  console.log(`[State Machine] Scene Image Phase started successfully.`);
}

/**
 * Transition to Video Phase
 */
async function transitionToVideoPhase(jobId, buildQueue, callbackBase, kieApiKey, jobData) {
  console.log(`[State Machine] Transitioning to Video Phase for job ${jobId}`);
  const redis = getRedis();
  const redisKey = `build_queue_${jobId}`;

  const { generateComfyUIVideo } = require("./videoGeneration");

  const promises = buildQueue.scenes.map(async (scene) => {
    const key = extractS3Key(scene.s3key);
    const cmd = new GetObjectCommand({ Bucket: process.env.S3_RESOURCE_BUCKET || "dapurartisan", Key: key });
    const signedSceneImgUrl = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });

    const talkvid = scene.talkvid !== false;

    const taskId = await generateComfyUIVideo({
      uuid: jobId,
      user_email: jobData.user_email,
      user_id: jobData.user_id,
      request_type: jobData.request_type,
      llm_response: jobData.llm_response,
      audio: jobData.audio,
      audio_duration: jobData.audio_duration,
      aspect_ratio: jobData.aspect_ratio || "9:16",
      imageResultUrl: signedSceneImgUrl,
      dynamo: docClient,
      USER_REQUEST_TABLE: process.env.USER_REQUEST_TABLE_NAME,
      prompt: scene.video_prompt,
      sceneId: scene.scene_id,
      duration: scene.duration_seconds || scene.duration || 5,
      talkvid
    });

    scene.videoTaskId = taskId;
  });

  await Promise.all(promises);
  await redis.set(redisKey, JSON.stringify(buildQueue), { ex: 5400 });
  console.log(`[State Machine] Video Phase started successfully.`);
}

/**
 * Initializes the state machine in Redis and triggers the Lock Phase
 */
async function startStateMachine(params) {
  const { jobId, userEmail, userId, llmResponse, finalJobPrompt, videoQuality, aspectRatio, requestType, S3_RESOURCE_BUCKET, dynamo, USER_REQUEST_TABLE } = params;

  const redis = getRedis();
  if (!redis) {
    throw new Error("Redis client is not configured.");
  }

  // 1. Build locks
  const lock = [];
  const currentUrls = Array.isArray(params.currentS3ImageUrls) ? params.currentS3ImageUrls : [];

  if (llmResponse.locks && typeof llmResponse.locks === "object") {
    for (const [id, lockData] of Object.entries(llmResponse.locks)) {
      if (lockData.type === "provided_reference") {
        const imageRef = lockData.image || "P1";
        const idx = parseInt(imageRef.replace("P", ""), 10) - 1;
        const s3key = currentUrls[idx] || currentUrls[0] || "";
        lock.push({
          id,
          prompt: "",
          negative_prompt: "",
          s3key,
          isImageFinished: true,
          taskId: ""
        });
        console.log(`[State Machine] Mapped provided reference lock: ${id} -> ${s3key}`);
      } else if (lockData.type === "generated_reference") {
        lock.push({
          id,
          prompt: lockData.image_prompt || "",
          negative_prompt: lockData.negative_image_prompt || "",
          s3key: "",
          isImageFinished: false,
          taskId: ""
        });
        console.log(`[State Machine] Added generated reference lock: ${id}`);
      }
    }
  } else {
    // Fallback to legacy structure
    const ig = llmResponse.image_generation || {};
    if (ig.talent_frame?.prompt) lock.push({ id: "talent", prompt: ig.talent_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
    if (ig.product_frame?.prompt) lock.push({ id: "product", prompt: ig.product_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
    if (ig.hero_frame?.prompt) lock.push({ id: "hero", prompt: ig.hero_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
    if (ig.transition_frame?.prompt) lock.push({ id: "transition", prompt: ig.transition_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
    if (ig.reveal_start_frame?.prompt) lock.push({ id: "reveal", prompt: ig.reveal_start_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
  }

  // 2. Build scenes
  let rawScenes = llmResponse.scenes || llmResponse.scene || [];
  if (!Array.isArray(rawScenes)) rawScenes = [];
  const scenes = rawScenes.map((s, i) => {
    const sceneId = s.scene_id || (i + 1);
    const dependency = Array.isArray(s.dependency) ? s.dependency : lock.map(l => l.id);
    return {
      scene_id: sceneId,
      prompt_image: s.image_prompt || s.prompt || finalJobPrompt,
      negative_prompt_image: s.negative_image_prompt || s.negative_prompt || "",
      duration_seconds: Number(s.duration || s.duration_seconds || 5),
      dependency: dependency,
      video_prompt: s.video_prompt || s.ltx_prompt || s.motion_prompt || "Cinematic panning shot.",
      isImageFinished: false,
      isVideoSceneFinished: false,
      imageTaskId: "",
      videoTaskId: "",
      talkvid: s.talkvid !== false
    };
  });

  if (scenes.length === 0) {
    scenes.push({
      scene_id: 1,
      prompt_image: finalJobPrompt,
      negative_prompt_image: "",
      duration_seconds: 5,
      dependency: [],
      video_prompt: finalJobPrompt,
      isImageFinished: false,
      isVideoSceneFinished: false,
      imageTaskId: "",
      videoTaskId: "",
      talkvid: false
    });
  }

  const buildQueue = { lock, scenes };
  const redisKey = `build_queue_${jobId}`;
  await redis.set(redisKey, JSON.stringify(buildQueue), { ex: 5400 });
  console.log(`[State Machine] Initialized build_queue in Redis for job ${jobId}`);

  // Resolve callback base URL
  const config = await getConfig();
  const callbackBase = config.callback_result || `${config.api_gateway_url || "https://xayhmg0s7b.execute-api.ap-southeast-1.amazonaws.com/dev"}/comfyui-webhook`;
  const kieApiKey = await getKieAiKey();

  const unfinishedLocks = lock.filter(l => !l.isImageFinished);
  if (unfinishedLocks.length > 0) {
    console.log(`[State Machine] Starting Lock Phase: Generating ${unfinishedLocks.length} locks...`);
    for (const item of unfinishedLocks) {
      const taskId = await submitKieImageTask({
        jobId,
        id: item.id,
        type: "lock",
        prompt: item.prompt,
        negativePrompt: item.negative_prompt,
        referenceUrls: [],
        callbackBase,
        kieApiKey
      });
      item.taskId = taskId;
    }
    await redis.set(redisKey, JSON.stringify(buildQueue), { ex: 5400 });
  } else {
    console.log(`[State Machine] All locks are finished (or none defined). Transitioning to Scene Image Phase directly.`);
    await transitionToSceneImagePhase(jobId, buildQueue, callbackBase, kieApiKey);
  }
}

/**
 * Handles image generation callbacks (for locks or scene images)
 */
async function handleImageCallback({ jobId, type, id, resultUrl, dynamo, s3, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET }) {
  console.log(`[State Machine Callback] Received image callback for job ${jobId}, type ${type}, id ${id}`);

  const redis = getRedis();
  if (!redis) throw new Error("Redis client not configured.");
  const redisKey = `build_queue_${jobId}`;

  const buildQueueStr = await redis.get(redisKey);
  if (!buildQueueStr) {
    console.error(`[State Machine Callback] build_queue not found in Redis for job ${jobId}`);
    return;
  }

  const buildQueue = typeof buildQueueStr === "string" ? JSON.parse(buildQueueStr) : buildQueueStr;

  // Retrieve Job Details from DB
  const getRes = await dynamo.send(new GetCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: "test@example.com" } // We will query by uuid instead using GSI/Query
  }));
  // Or query by uuid partition key to get accurate range key
  let jobData = getRes.Item;
  if (!jobData) {
    const qRes = await dynamo.send(new QueryCommand({
      TableName: USER_REQUEST_TABLE,
      KeyConditionExpression: "#uuid = :u",
      ExpressionAttributeNames: { "#uuid": "uuid" },
      ExpressionAttributeValues: { ":u": jobId }
    }));
    jobData = qRes.Items?.[0];
  }
  if (!jobData) {
    throw new Error(`Job ${jobId} not found in DynamoDB.`);
  }

  const userId = jobData.user_id || "anonymous";

  // Download and upload S3
  const res = await fetch(resultUrl);
  if (!res.ok) throw new Error(`Failed to download image result: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const subfolderName = type === "lock" ? "locks" : "scenes";
  const s3Key = `generated_image/${userId}/${subfolderName}/${jobId}_${id}.png`;

  console.log(`[State Machine Callback] Uploading image to S3: ${s3Key}`);
  await s3.send(new PutObjectCommand({
    Bucket: S3_RESOURCE_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: "image/png"
  }));

  // Update Redis Queue State
  if (type === "lock") {
    const item = buildQueue.lock.find(l => l.id === id);
    if (item) {
      item.isImageFinished = true;
      item.s3key = s3Key;
    }
  } else {
    const item = buildQueue.scenes.find(s => String(s.scene_id) === String(id));
    if (item) {
      item.isImageFinished = true;
      item.s3key = s3Key;
    }
    
    // Also save to DynamoDB's generated_scenes for frontend storyboard display
    let dbScenes = Array.isArray(jobData.generated_scenes) ? [...jobData.generated_scenes] : [];
    const existingIdx = dbScenes.findIndex(s => String(s.scene_id) === String(id));
    if (existingIdx !== -1) {
      dbScenes[existingIdx].s3_key = s3Key;
      delete dbScenes[existingIdx].url; // Clear temporary url if any
    } else {
      dbScenes.push({
        scene_id: Number(id),
        s3_key: s3Key
      });
    }
    console.log(`[State Machine Callback] Saving scene ${id} to DynamoDB generated_scenes`);
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: jobData.user_email },
      UpdateExpression: "SET generated_scenes = :gs, updated_at = :now",
      ExpressionAttributeValues: {
        ":gs": dbScenes,
        ":now": getJakartaISOString()
      }
    }));
  }

  await redis.set(redisKey, JSON.stringify(buildQueue), { ex: 5400 });

  // Resolve config and credentials
  const config = await getConfig();
  const callbackBase = config.callback_result || `${config.api_gateway_url || "https://xayhmg0s7b.execute-api.ap-southeast-1.amazonaws.com/dev"}/comfyui-webhook`;
  const kieApiKey = await getKieAiKey();

  // Evaluate transitions
  const allLocksFinished = buildQueue.lock.every(l => l.isImageFinished === true);
  const allSceneImagesFinished = buildQueue.scenes.every(s => s.isImageFinished === true);

  if (type === "lock") {
    if (allLocksFinished) {
      console.log(`[State Machine Callback] All locks finished. Transitioning to Scene Image Phase.`);
      await transitionToSceneImagePhase(jobId, buildQueue, callbackBase, kieApiKey);
    } else {
      console.log(`[State Machine Callback] Awaiting remaining locks...`);
    }
  } else {
    if (allLocksFinished && allSceneImagesFinished) {
      console.log(`[State Machine Callback] All lock and scene images finished. Transitioning to Video Phase.`);
      await transitionToVideoPhase(jobId, buildQueue, callbackBase, kieApiKey, jobData);
    } else {
      console.log(`[State Machine Callback] Awaiting remaining scene images...`);
    }
  }
}

/**
 * Handles video generation callbacks per scene
 */
async function handleVideoCallback({ jobId, sceneId, resultUrl, dynamo, s3, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET }) {
  console.log(`[State Machine Callback] Received video callback for job ${jobId}, sceneId ${sceneId}`);

  const redis = getRedis();
  if (!redis) throw new Error("Redis client not configured.");
  const redisKey = `build_queue_${jobId}`;

  const buildQueueStr = await redis.get(redisKey);
  if (!buildQueueStr) {
    console.error(`[State Machine Callback] build_queue not found in Redis for job ${jobId}`);
    return;
  }

  const buildQueue = typeof buildQueueStr === "string" ? JSON.parse(buildQueueStr) : buildQueueStr;

  // Retrieve Job Details from DB
  let jobData = null;
  const qRes = await dynamo.send(new QueryCommand({
    TableName: USER_REQUEST_TABLE,
    KeyConditionExpression: "#uuid = :u",
    ExpressionAttributeNames: { "#uuid": "uuid" },
    ExpressionAttributeValues: { ":u": jobId }
  }));
  jobData = qRes.Items?.[0];
  if (!jobData) {
    throw new Error(`Job ${jobId} not found in DynamoDB.`);
  }

  const userId = jobData.user_id || "anonymous";

  // Download scene video and upload to S3
  const res = await fetch(resultUrl);
  if (!res.ok) throw new Error(`Failed to download scene video result: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const s3Key = `generated_videos/${userId}/scenes/${jobId}_scene_${sceneId}.mp4`;

  console.log(`[State Machine Callback] Uploading scene video to S3: ${s3Key}`);
  await s3.send(new PutObjectCommand({
    Bucket: S3_RESOURCE_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: "video/mp4"
  }));

  const imgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: s3Key });
  const signedUrl = await getSignedUrl(s3, imgCmd, { expiresIn: 86400 * 7 }); // 7 days

  // Update Redis Queue State
  const item = buildQueue.scenes.find(s => String(s.scene_id) === String(sceneId));
  if (item) {
    item.isVideoSceneFinished = true;
    item.url = signedUrl;
    item.s3key = s3Key;
  }

  await redis.set(redisKey, JSON.stringify(buildQueue), { ex: 5400 });

  // Update DynamoDB video_scenes field for progress tracking
  const videoScenes = buildQueue.scenes.map(s => {
    const sceneKey = `scene_${s.scene_id}`;
    return {
      [sceneKey]: s.videoTaskId || s.imageTaskId,
      isFinish: s.isVideoSceneFinished,
      s3_key: s.s3key,
      url: s.url
    };
  });

  await dynamo.send(new UpdateCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: jobData.user_email },
    UpdateExpression: "SET video_scenes = :vs, build_queue = :bq, updated_at = :now",
    ExpressionAttributeValues: {
      ":vs": videoScenes,
      ":bq": buildQueue,
      ":now": getJakartaISOString()
    }
  }));

  const allFinished = buildQueue.scenes.every(s => s.isVideoSceneFinished === true);
  if (allFinished) {
    console.log(`[State Machine Callback] All scene videos finished. Starting video merge...`);
    await mergeVideoScenes(jobData, videoScenes, dynamo, s3, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET);

    // Clear Redis Cache
    await redis.del(redisKey);
    console.log(`[State Machine Callback] State cleared in Redis.`);
  } else {
    console.log(`[State Machine Callback] Awaiting remaining scene videos...`);
  }
}

module.exports = {
  startStateMachine,
  handleImageCallback,
  handleVideoCallback,
  submitKieImageTask
};
