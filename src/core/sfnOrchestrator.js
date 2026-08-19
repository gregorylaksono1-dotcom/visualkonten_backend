"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { SFNClient, StartExecutionCommand, RedriveExecutionCommand } = require("@aws-sdk/client-sfn");
const { getSecrets, getConfig } = require("../lib/config");
const { getKieAiKey, s3Client, getSignedUrl, findPricingItem } = require("../services");
const { GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("../utils");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sfnClient = new SFNClient({ region: REGION });

/**
 * Triggers the AWS Step Functions State Machine for a given job.
 */
async function triggerStateMachine({
  jobId,
  userEmail,
  userId,
  currentS3ImageUrls,
  llmResponse,
  finalJobPrompt,
  aspectRatio,
  requestType,
  pricing_type,
  audio,
  audio_duration,
  previewAssets,
  preview
}) {
  if (!STATE_MACHINE_ARN) {
    throw new Error("STATE_MACHINE_ARN environment variable is not set.");
  }

  const executionInput = {
    jobId,
    userEmail,
    userId: userId || "anonymous",
    currentS3ImageUrls: Array.isArray(currentS3ImageUrls) ? currentS3ImageUrls : [],
    requestType,
    pricing_type: pricing_type || "",
    llmResponse,
    finalJobPrompt,
    aspectRatio: aspectRatio || "9:16",
    audio: audio || null,
    audio_duration: audio_duration || null,
    previewAssets: previewAssets || {},
    preview: preview || false
  };

  console.log(`[SFN Orchestrator] Starting Step Function execution for Job ${jobId}`);
  const sfnResult = await sfnClient.send(new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: `${jobId}-${Date.now()}`,
    input: JSON.stringify(executionInput)
  }));

  // Store the execution ARN and set status to PROCESSING in DynamoDB
  await dynamo.send(new UpdateCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: userEmail },
    UpdateExpression: "SET #s = :status, sfn_execution_arn = :arn, updated_at = :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":status": "PROCESSING",
      ":arn": sfnResult.executionArn,
      ":now": getJakartaISOString()
    }
  }));

  console.log(`[SFN Orchestrator] Successfully triggered Step Function. ARN: ${sfnResult.executionArn}`);
  return sfnResult.executionArn;
}

/**
 * Trigger manual redrive of a failed Step Function execution.
 */
async function triggerManualRedrive(executionArn) {
  console.log(`[SFN Orchestrator] Pemicuan ulang (Redrive) eksekusi SFN: ${executionArn}`);
  try {
    const res = await sfnClient.send(new RedriveExecutionCommand({
      executionArn: executionArn
    }));
    return { success: true, redriveExecutionArn: res.redriveExecutionArn };
  } catch (err) {
    console.error(`[SFN Orchestrator] Redrive failed:`, err.message);
    throw err;
  }
}

/**
 * Helper to extract S3 Key.
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
      console.warn(`[SFN Orchestrator] Failed to parse S3 URL: ${trimmed}`, e.message);
    }
  }
  return decodeURIComponent(trimmed);
}

/**
 * Task: Prepare Job Data.
 * Parses the locks and scenes structure and returns lists for Map states.
 */
async function prepareJobData(payload) {
  const { jobId, userEmail, userId, currentS3ImageUrls, llmResponse, finalJobPrompt, aspectRatio, requestType, audio, audio_duration } = payload.data;

  console.log(`[SFN Orchestrator] Preparing job data for ${jobId}`);

  let generated_scenes = [];
  let generated_image_talent = null;
  try {
    const dbResult = await dynamo.send(new GetCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail }
    }));
    generated_scenes = dbResult.Item?.generated_scenes || [];
    generated_image_talent = dbResult.Item?.generated_image_talent || null;
  } catch (err) {
    console.error(`[SFN Orchestrator] Failed to fetch existing job for ${jobId}`, err);
  }

  // 1. Build locks
  const locks = [];
  const currentUrls = Array.isArray(currentS3ImageUrls) ? currentS3ImageUrls : [];

  if (llmResponse.locks && typeof llmResponse.locks === "object" && Object.keys(llmResponse.locks).length > 0) {
    for (const [id, lockData] of Object.entries(llmResponse.locks)) {
      if (lockData.type === "provided_reference") {
        const imageRef = lockData.image || "P1";
        const idx = parseInt(imageRef.replace("P", ""), 10) - 1;
        const s3key = currentUrls[idx] || currentUrls[0] || "";
        locks.push({
          id,
          prompt: "",
          negative_prompt: "",
          s3key,
          isImageFinished: true,
          taskId: ""
        });
      } else if (lockData.type === "generated_reference" || lockData.type === "generate_from_description") {
        let isFinished = false;
        let lockS3Key = "";
        if (id === "talent" && generated_image_talent) {
           isFinished = true;
           lockS3Key = generated_image_talent;
           console.log(`[SFN Orchestrator] Reusing talent lock image from preview: ${lockS3Key}`);
        }

        locks.push({
          id,
          prompt: lockData.image_prompt || "",
          negative_prompt: lockData.negative_image_prompt || "",
          s3key: lockS3Key,
          isImageFinished: isFinished,
          taskId: ""
        });
      }
    }
  } else {
    // Check root-level locks first (new structure where "product", "talent", etc. are at the root)
    const rootLocks = ["product", "talent", "hero", "transition", "reveal"];
    let rootLocksFound = false;
    for (const id of rootLocks) {
      if (llmResponse[id] && typeof llmResponse[id] === "object") {
        rootLocksFound = true;
        if (llmResponse[id].image) {
          const imageRef = llmResponse[id].image;
          const idx = parseInt(imageRef.replace("P", ""), 10) - 1;
          const s3key = currentUrls[idx] || currentUrls[0] || "";
          locks.push({
            id,
            prompt: "",
            negative_prompt: "",
            s3key,
            isImageFinished: true,
            taskId: ""
          });
        } else if (llmResponse[id].image_prompt || llmResponse[id].prompt) {
          locks.push({
            id,
            prompt: llmResponse[id].image_prompt || llmResponse[id].prompt,
            negative_prompt: llmResponse[id].negative_image_prompt || llmResponse[id].negative_prompt || "",
            s3key: "",
            isImageFinished: false,
            taskId: ""
          });
        }
      }
    }
    
    // Fallback to legacy structure if no root locks found
    if (!rootLocksFound) {
      const ig = llmResponse.image_generation || {};
      if (ig.talent_frame?.prompt) locks.push({ id: "talent", prompt: ig.talent_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
      if (ig.product_frame?.prompt) locks.push({ id: "product", prompt: ig.product_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
      if (ig.hero_frame?.prompt) locks.push({ id: "hero", prompt: ig.hero_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
      if (ig.transition_frame?.prompt) locks.push({ id: "transition", prompt: ig.transition_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
      if (ig.reveal_start_frame?.prompt) locks.push({ id: "reveal", prompt: ig.reveal_start_frame.prompt, negative_prompt: "", s3key: "", isImageFinished: false, taskId: "" });
    }
  }

  // Always force product lock to use uploaded image if available
  if (currentUrls.length > 0) {
    const existingProduct = locks.find(l => l.id === "product");
    if (existingProduct) {
      existingProduct.s3key = currentUrls[0];
      existingProduct.isImageFinished = true;
      existingProduct.prompt = "";
      existingProduct.negative_prompt = "";
    } else {
      locks.push({
        id: "product",
        prompt: "",
        negative_prompt: "",
        s3key: currentUrls[0],
        isImageFinished: true,
        taskId: ""
      });
    }
  }

  // 2. Build scenes
  let rawScenes = llmResponse.scenes || llmResponse.scene || [];
  if (!Array.isArray(rawScenes)) rawScenes = [];
  const scenes = rawScenes.map((s, i) => {
    const sceneId = s.scene_id || (i + 1);
    const dependency = Array.isArray(s.dependency) ? s.dependency : locks.map(l => l.id);
    const existingGeneratedScene = generated_scenes.find(gs => String(gs.scene_id) === String(sceneId));
    const s3key = existingGeneratedScene && existingGeneratedScene.s3_key ? existingGeneratedScene.s3_key : "";

    return {
      scene_id: sceneId,
      prompt_image: s.image_prompt === null ? null : (s.image_prompt || s.prompt || finalJobPrompt),
      negative_prompt_image: s.negative_image_prompt || s.negative_prompt || "",
      duration_seconds: Number(s.duration || s.duration_seconds || 5),
      dependency: dependency,
      video_prompt: s.video_prompt || s.ltx_prompt || s.motion_prompt || "Cinematic panning shot.",
      continuity: s.continuity || null,
      isImageFinished: !!s3key,
      s3key: s3key,
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
      s3key: "",
      isVideoSceneFinished: false,
      imageTaskId: "",
      videoTaskId: "",
      talkvid: false
    });
  }

  let pricingPostProduction = false;
  if (requestType) {
    try {
      const pricingItem = await findPricingItem(requestType);
      if (pricingItem && pricingItem["post-production"] === true) {
        pricingPostProduction = true;
      }
    } catch (err) {
      console.warn(`[SFN Orchestrator] Failed to fetch pricing for ${requestType}:`, err.message);
    }
  }

  return {
    jobId,
    userEmail,
    userId,
    locks,
    scenes,
    audio: audio || null,
    audio_duration: audio_duration || null,
    aspect_ratio: aspectRatio || "9:16",
    request_type: requestType,
    llm_response: llmResponse,
    pricing_post_production: pricingPostProduction,
    preview: payload.data.preview || false
  };
}

async function submitLockImage(payload) {
  const { jobId, lock, userEmail, userId, taskToken } = payload;
  console.log(`[SFN Orchestrator] submitLockImage for jobId ${jobId}, lock id ${lock.id}`);
  await saveTaskToken(jobId, userEmail, `lock_${lock.id}`, taskToken);

  if (lock.isImageFinished && lock.s3key) {
    console.log(`[SFN Orchestrator] Lock ${lock.id} already finished. Continuing immediately.`);
    // Let's resolve the task success immediately
    const { SendTaskSuccessCommand } = require("@aws-sdk/client-sfn");
    await sfnClient.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ s3key: lock.s3key, id: lock.id, isImageFinished: true })
    }));
    return;
  }

  // Fetch request type from DynamoDB
  const dbResult = await dynamo.send(new GetCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { user_email: userEmail, uuid: jobId }
  }));
  const requestType = dbResult.Item?.request_type;

  // Generate Lock image via Kie.ai
  const { submitKieImageTask } = require("./stateMachine");
  const config = await getConfig();
  const callbackBase = config.callback_result || `${config.api_gateway_url}/comfyui-webhook`;
  const kieApiKey = await getKieAiKey();

  const taskId = await submitKieImageTask({
    jobId,
    id: lock.id,
    type: "lock",
    prompt: lock.prompt,
    negativePrompt: lock.negative_prompt,
    referenceUrls: [],
    callbackBase,
    kieApiKey,
    taskToken,
    requestType
  });

  console.log(`[SFN Orchestrator] Lock Image Task ${taskId} created for lock ${lock.id}`);
}

/**
 * Task: Submit Scene Image.
 */
async function submitSceneImage(payload) {
  const { jobId, scene, userEmail, userId, lockResults, taskToken } = payload;

  console.log(`[SFN Orchestrator] submitSceneImage for jobId ${jobId}, scene id ${scene.scene_id}`);
  await saveTaskToken(jobId, userEmail, `image_${scene.scene_id}`, taskToken);

  if (scene.isImageFinished && scene.s3key) {
    console.log(`[SFN Orchestrator] Scene ${scene.scene_id} already has image (${scene.s3key}). Skipping image generation.`);
    const { SendTaskSuccessCommand } = require("@aws-sdk/client-sfn");
    await sfnClient.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ id: scene.scene_id, s3key: scene.s3key })
    }));
    return;
  }

  if (scene.continuity === "chain_from_previous" && scene.prompt_image === null) {
    console.log(`[SFN Orchestrator] Scene ${scene.scene_id} has continuity: chain_from_previous and prompt_image is null. Skipping image generation.`);
    const { SendTaskSuccessCommand } = require("@aws-sdk/client-sfn");
    await sfnClient.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ id: scene.scene_id, s3key: null, chain_from_previous: true })
    }));
    return;
  }

  // Resolve dependencies signed S3 URLs
  const referenceUrls = [];
  const dependencies = Array.isArray(scene.dependency) ? scene.dependency : [];
  
  // Fetch request type from DynamoDB
  const dbResult = await dynamo.send(new GetCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { user_email: userEmail, uuid: jobId }
  }));
  const requestType = dbResult.Item?.request_type;
  for (const depId of dependencies) {
    const lockResult = Array.isArray(lockResults) ? lockResults.find(r => {
      if (!r) return false;
      const parsed = typeof r === "string" ? JSON.parse(r) : r;
      return parsed.id === depId;
    }) : null;
    if (lockResult) {
      const parsedRes = typeof lockResult === "string" ? JSON.parse(lockResult) : lockResult;
      if (parsedRes.s3key) {
        const key = extractS3Key(parsedRes.s3key);
        const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
        const signed = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
        referenceUrls.push(signed);
      }
    }
  }

  const { submitKieImageTask } = require("./stateMachine");
  const config = await getConfig();
  const callbackBase = config.callback_result || `${config.api_gateway_url}/comfyui-webhook`;
  const kieApiKey = await getKieAiKey();

  const taskId = await submitKieImageTask({
    jobId,
    id: scene.scene_id,
    type: "imagesScene",
    prompt: scene.prompt_image,
    negativePrompt: scene.negative_prompt_image,
    referenceUrls,
    callbackBase,
    kieApiKey,
    taskToken,
    requestType
  });

  console.log(`[SFN Orchestrator] Scene Image Task ${taskId} created for scene ${scene.scene_id}`);
}

/**
 * Task: Submit Scene Video.
 */
async function submitSceneVideo(payload) {
  const { jobId, scene, userEmail, userId, sceneImageResults, audio, audio_duration, aspect_ratio, request_type, llm_response, taskToken } = payload;

  console.log(`[SFN Orchestrator] submitSceneVideo for jobId ${jobId}, scene id ${scene.scene_id}`);
  await saveTaskToken(jobId, userEmail, `video_${scene.scene_id}`, taskToken);

  // Find the generated image result for this scene
  const sceneImgResult = Array.isArray(sceneImageResults) ? sceneImageResults.find(r => {
    if (!r) return false;
    const parsed = typeof r === "string" ? JSON.parse(r) : r;
    return String(parsed.id) === String(scene.scene_id);
  }) : null;
  if (!sceneImgResult) {
    throw new Error(`Starting frame image result not found for scene ${scene.scene_id}`);
  }
  const parsedImgRes = typeof sceneImgResult === "string" ? JSON.parse(sceneImgResult) : sceneImgResult;

  if (parsedImgRes.chain_from_previous && !parsedImgRes.s3key) {
    console.log(`[SFN Orchestrator] Scene ${scene.scene_id} is chain_from_previous. Looking for previous scene image...`);
    const sortedResults = Array.isArray(sceneImageResults) 
      ? sceneImageResults.map(r => typeof r === "string" ? JSON.parse(r) : r).sort((a, b) => Number(a.id) - Number(b.id)) 
      : [];
    
    // Find the last one before current scene that has s3key
    const prevScenes = sortedResults.filter(r => Number(r.id) < Number(scene.scene_id) && r.s3key);
    if (prevScenes.length > 0) {
      parsedImgRes.s3key = prevScenes[prevScenes.length - 1].s3key;
      console.log(`[SFN Orchestrator] Using s3key ${parsedImgRes.s3key} from scene ${prevScenes[prevScenes.length - 1].id} for scene ${scene.scene_id}`);
    } else {
      throw new Error(`Scene ${scene.scene_id} depends on previous scene image, but no previous scene image found.`);
    }
  }

  if (!parsedImgRes || !parsedImgRes.s3key) {
    throw new Error(`Starting frame image result not found for scene ${scene.scene_id}`);
  }

  // Resolve signed S3 URL of the starting frame image
  const key = extractS3Key(parsedImgRes.s3key);
  const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
  const signedSceneImgUrl = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });

  const { generateComfyUIVideo } = require("./videoGeneration");
  const talkvid = scene.talkvid !== false;

  const taskId = await generateComfyUIVideo({
    uuid: jobId,
    user_email: userEmail,
    user_id: userId,
    request_type,
    llm_response,
    audio,
    audio_duration,
    aspect_ratio,
    imageResultUrl: signedSceneImgUrl,
    dynamo,
    USER_REQUEST_TABLE,
    S3_RESOURCE_BUCKET,
    prompt: scene.video_prompt,
    negative_prompt: scene.negative_prompt_video || scene.negative_prompt,
    sceneId: scene.scene_id,
    duration: scene.duration_seconds || scene.duration || 5,
    talkvid,
    taskToken
  });

  console.log(`[SFN Orchestrator] Video Scene Task ${taskId} created for scene ${scene.scene_id}`);
}

/**
 * Helper to ensure static FFmpeg.
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
    resp = await fetch(regionalUrl);
  }
  if (!resp.ok) {
    throw new Error(`Failed to download static FFmpeg from S3: ${resp.status}`);
  }
  fs.writeFileSync(localFfmpegPath, Buffer.from(await resp.arrayBuffer()));
  fs.chmodSync(localFfmpegPath, "755");
  return localFfmpegPath;
}

async function sanitizeAndStandardizeAudio(localVideoPath, ffmpegPath) {
  const { execSync } = require("child_process");
  let hasAudio = false;
  try {
    const probeCmd = `${ffmpegPath} -i ${localVideoPath} 2>&1`;
    const output = execSync(probeCmd).toString();
    if (output.includes("Audio:")) {
      hasAudio = true;
    }
  } catch (e) {
    const output = e.output ? e.output.toString() : e.message;
    if (output.includes("Audio:")) {
      hasAudio = true;
    }
  }

  const sanitizedPath = localVideoPath + ".sanitized.mp4";

  if (!hasAudio) {
    console.log(`[SFN Orchestrator Merge] Video ${localVideoPath} has no audio. Adding silent audio track.`);
    // Add silent stereo 44.1kHz AAC audio track of the exact video duration
    const addSilenceCmd = `${ffmpegPath} -y -i ${localVideoPath} -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v copy -c:a aac -shortest ${sanitizedPath}`;
    execSync(addSilenceCmd);
    fs.renameSync(sanitizedPath, localVideoPath);
  } else {
    console.log(`[SFN Orchestrator Merge] Video ${localVideoPath} has audio. Standardizing audio format.`);
    // Standardize existing audio stream to stereo, 44100Hz, aac to prevent concat shift/drift bugs
    const standardizeCmd = `${ffmpegPath} -y -i ${localVideoPath} -c:v copy -c:a aac -ac 2 -ar 44100 ${sanitizedPath}`;
    try {
      execSync(standardizeCmd);
      fs.renameSync(sanitizedPath, localVideoPath);
    } catch (err) {
      console.warn(`[SFN Orchestrator Merge] Standardizing audio failed for ${localVideoPath}: ${err.message}. Using original.`);
      if (fs.existsSync(sanitizedPath)) {
        try { fs.unlinkSync(sanitizedPath); } catch {}
      }
    }
  }
}

/**
 * Task: Merge Video Scenes.
 */
async function mergeVideoScenes(payload) {
  const { jobId, userEmail, userId, videoSceneResults, audio, llm_response, request_type } = payload;

  console.log(`[SFN Orchestrator] mergeVideoScenes for jobId ${jobId}`);

  // Fetch job metadata for duration logging
  const jobGet = await dynamo.send(new GetCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: userEmail }
  }));
  const job = jobGet.Item || {};

  const tmpDir = "/tmp";
  const inputPaths = [];
  const videoScenes = [];
  const ffmpegCmd = await ensureFfmpegBinary();

  try {
    for (let i = 0; i < videoSceneResults.length; i++) {
      const resultStr = videoSceneResults[i];
      const parsedRes = typeof resultStr === "string" ? JSON.parse(resultStr) : resultStr;
      
      const sceneNum = i + 1;
      const s3key = parsedRes.s3key;
      if (!s3key) throw new Error(`Missing S3 key for scene ${sceneNum}`);

      // Resolve signed URL
      const key = extractS3Key(s3key);
      const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
      const signedUrl = await getSignedUrl(s3Client, cmd, { expiresIn: 86400 * 7 });
      
      videoScenes.push({
        scene_id: parsedRes.id || sceneNum,
        s3_key: s3key,
        url: signedUrl,
        isFinish: true
      });

      const localPath = path.join(tmpDir, `scene_${sceneNum}.mp4`);
      console.log(`[SFN Orchestrator Merge] Downloading scene ${sceneNum} from ${signedUrl}`);
      const resp = await fetch(signedUrl);
      if (!resp.ok) throw new Error(`Failed to download scene ${sceneNum}: ${resp.status}`);
      fs.writeFileSync(localPath, Buffer.from(await resp.arrayBuffer()));
      
      // Sanitize scene audio so that it has stereo AAC 44100Hz track (adding silence if none exists)
      // to avoid FFmpeg concat demuxer audio shifting/muting bugs.
      await sanitizeAndStandardizeAudio(localPath, ffmpegCmd);
      
      inputPaths.push(localPath);
    }

    const listPath = path.join(tmpDir, `concat_list_${jobId}.txt`);
    const listContent = inputPaths.map(p => `file '${path.basename(p)}'`).join("\n");
    fs.writeFileSync(listPath, listContent);

    // Audio overlay path
    let localAudioPath = null;
    let finalAudioS3Key = null;

    const requestType = request_type || "";
    const isUgcMode = requestType === "UGC-P" || requestType === "UGC-S" || requestType === "UGC-PRESENTER" || String(requestType).toUpperCase().startsWith("UGC-") || requestType === "TESTIMONY_TULUS" || requestType === "ANIMASI_1";

    let ttsScript = null;
    let hasTopLevelVoiceover = false;

    if (llm_response) {
      if (llm_response.voiceover_script && (llm_response.voiceover_script.tts_script || llm_response.voiceover_script.script)) {
        hasTopLevelVoiceover = true;
        ttsScript = llm_response.voiceover_script.tts_script || llm_response.voiceover_script.script;
      } else if (!isUgcMode) {
        ttsScript = llm_response.tts_script;
      }
    }

    if (ttsScript) {
      try {
        console.log(`[SFN Orchestrator Merge] Generating TTS for script: "${ttsScript.slice(0, 100)}..."`);
        const { generateTTS } = require("./tts");
        const { buildTtsGlobalConfig } = require("../lib/resolve-voice");
        const ttsGlobalConfig = llm_response.tts_global_config || buildTtsGlobalConfig(llm_response, {});
        const ttsResult = await generateTTS({
          jobId,
          userEmail,
          userId,
          llmResponse: {
            ...llm_response,
            tts_script: ttsScript,
            tts_global_config: ttsGlobalConfig
          },
          S3_RESOURCE_BUCKET,
          dynamo,
          USER_REQUEST_TABLE,
          callGeminiAudio: require("../services").callGeminiAudio,
          uploadToS3: require("../services").uploadToS3
        });
        if (ttsResult && ttsResult.audioS3Key) {
          finalAudioS3Key = ttsResult.audioS3Key;
          console.log(`[SFN Orchestrator Merge] TTS successfully generated: ${finalAudioS3Key}`);
        }
      } catch (ttsErr) {
        console.error(`[SFN Orchestrator Merge] TTS generation failed, continuing merge without TTS:`, ttsErr.message);
      }
    }

    // Audio download if present
    if (finalAudioS3Key) {
      try {
        const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: finalAudioS3Key });
        const signedAudio = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
        localAudioPath = path.join(tmpDir, `audio_${jobId}.wav`);
        const audioResp = await fetch(signedAudio);
        if (audioResp.ok) {
          fs.writeFileSync(localAudioPath, Buffer.from(await audioResp.arrayBuffer()));
        } else {
          localAudioPath = null;
        }
      } catch (audioDlErr) {
        console.error(`[SFN Orchestrator Merge] Error downloading TTS audio:`, audioDlErr.message);
        localAudioPath = null;
      }
    }

    const outputPath = path.join(tmpDir, `output_${jobId}.mp4`);

    let cmd = `${ffmpegCmd} -y -f concat -safe 0 -i ${listPath} -c copy -movflags +faststart ${outputPath}`;
    if (localAudioPath) {
      cmd = `${ffmpegCmd} -y -f concat -safe 0 -i ${listPath} -i ${localAudioPath} -filter_complex "[0:a][1:a]amix=inputs=2:duration=longest[a]" -map 0:v:0 -map "[a]" -c:v copy -c:a aac -movflags +faststart ${outputPath}`;
    }

    console.log(`[SFN Orchestrator Merge] Running FFmpeg: ${cmd}`);
    await new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) reject(new Error(`FFmpeg merge failed: ${err.message}`));
        else resolve();
      });
    });

    if (localAudioPath) {
      try { fs.unlinkSync(localAudioPath); } catch { }
    }

    const s3Key = `generated_videos/${userId || "anonymous"}/${jobId}.mp4`;
    console.log(`[SFN Orchestrator Merge] Uploading to S3: ${s3Key}`);
    await s3Client.send(new PutObjectCommand({
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

    // Clean up local files
    inputPaths.forEach(p => { try { fs.unlinkSync(p); } catch { } });
    try { fs.unlinkSync(listPath); } catch { }
    try { fs.unlinkSync(outputPath); } catch { }

    // Update DynamoDB to include the scenes metadata
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET video_scenes = :vs, updated_at = :now",
      ExpressionAttributeValues: {
        ":vs": videoScenes,
        ":now": getJakartaISOString()
      }
    }));

    return {
      result_url: s3Key,
      completedAt: getJakartaISOString(),
      videoGenerationDuration
    };

  } catch (err) {
    console.error(`[SFN Orchestrator Merge] Error merging scenes:`, err);
    throw err;
  }
}

async function saveTaskToken(jobId, userEmail, key, taskToken) {
  if (!taskToken) return;
  try {
    const { UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
    // 1. Get the current sfn_task_tokens map
    const getRes = await dynamo.send(new GetCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      ProjectionExpression: "sfn_task_tokens"
    }));
    const currentTokens = getRes.Item?.sfn_task_tokens || {};
    currentTokens[key] = taskToken;

    // 2. Save back to DynamoDB and reset status to PROCESSING
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET sfn_task_tokens = :tokens, #s = :status, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":tokens": currentTokens,
        ":status": "PROCESSING",
        ":now": getJakartaISOString()
      }
    }));
    console.log(`[SFN Orchestrator] Saved taskToken for ${key} and set status to PROCESSING`);
  } catch (err) {
    console.error(`[SFN Orchestrator] Failed to save taskToken for ${key}:`, err.message);
  }
}

async function updateStatusPreview(payload) {
  const { data } = payload;
  const { jobId, userEmail, lockResults, sceneImageResults } = data;

  console.log(`[SFN Orchestrator] updateStatusPreview for ${jobId}`);

  let generated_image_talent = null;
  if (Array.isArray(lockResults)) {
    const talentLock = lockResults.find(l => l && l.id === "talent");
    if (talentLock && talentLock.s3key) {
      generated_image_talent = talentLock.s3key;
    }
  }

  const generated_scenes = [];
  if (Array.isArray(sceneImageResults)) {
    for (const res of sceneImageResults) {
      if (res && res.id) {
        generated_scenes.push({
          scene_id: res.id,
          s3_key: res.s3key || null,
          url: res.url || null
        });
      }
    }
  }

  const newImageKeys = [];
  if (generated_image_talent) newImageKeys.push(generated_image_talent);
  generated_scenes.forEach(gs => {
    if (gs.s3_key) newImageKeys.push(gs.s3_key);
  });

  const updateExpr = ["generated_scenes = :genScenes", "#s = :status", "updated_at = :now"];
  const exprValues = {
    ":genScenes": generated_scenes,
    ":status": "PREVIEW",
    ":now": getJakartaISOString()
  };

  if (generated_image_talent) {
    updateExpr.push("generated_image_talent = :genTalent");
    updateExpr.push("generated_image = :genTalent"); // set main thumbnail to talent
    exprValues[":genTalent"] = generated_image_talent;
  } else if (generated_scenes.length > 0 && generated_scenes[0].s3_key) {
    updateExpr.push("generated_image = :genImg");
    exprValues[":genImg"] = generated_scenes[0].s3_key;
  }

  if (newImageKeys.length > 0) {
    updateExpr.push("s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys)");
    exprValues[":empty_list"] = [];
    exprValues[":newKeys"] = newImageKeys;
  }

  await dynamo.send(new UpdateCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: userEmail },
    UpdateExpression: "SET " + updateExpr.join(", "),
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: exprValues
  }));

  return { success: true, status: "PREVIEW" };
}

module.exports = {
  triggerStateMachine,
  triggerManualRedrive,
  prepareJobData,
  submitLockImage,
  submitSceneImage,
  submitSceneVideo,
  mergeVideoScenes,
  saveTaskToken,
  updateStatusPreview
};
