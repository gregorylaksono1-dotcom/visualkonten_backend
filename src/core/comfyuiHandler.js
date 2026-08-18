const { QueryCommand, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("../utils");
const { getSignedUrl } = require("../services");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Downloads a static FFmpeg binary for Linux x86_64 at runtime, caches it in /tmp/ffmpeg, and makes it executable.
 */
async function ensureFfmpegBinary() {
  const localFfmpegPath = "/tmp/ffmpeg";
  if (fs.existsSync(localFfmpegPath)) {
    return localFfmpegPath;
  }
  console.log(`[FFmpeg] FFmpeg binary not found in /tmp. Downloading static build...`);
  const url = "https://github.com/eugeneware/ffmpeg-static-binaries/releases/download/b4.2.2/ffmpeg-linux-x64";
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download static FFmpeg: ${resp.status}`);
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

    const outputPath = path.join(tmpDir, `output_${job.uuid}.mp4`);

    const ffmpegCmd = await ensureFfmpegBinary();
    const cmd = `${ffmpegCmd} -y -f concat -safe 0 -i ${listPath} -c copy -movflags +faststart ${outputPath}`;
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

    inputPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
    try { fs.unlinkSync(listPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}

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
 * Handles the completion of a Kie.ai job (Image or Video)
 */
async function processKieAiCompletion(params) {
  const {
    taskId, resultUrl, mediaType, dynamo, s3,
    USER_REQUEST_TABLE, S3_RESOURCE_BUCKET,
    IMAGE_PROMPT_ID_INDEX, VIDEO_PROMPT_ID_INDEX,
    queryStringParameters
  } = params;

  console.log(`[Kie.ai Completion] Processing ${mediaType} completion for taskId ${taskId}`);

  let job = null;
  let jobId = null;
  let userEmail = null;

  // 1. Resolve Job using query parameters (faster, no scan/index query)
  if (queryStringParameters?.jobId && queryStringParameters?.userEmail) {
    jobId = queryStringParameters.jobId;
    userEmail = queryStringParameters.userEmail;
    console.log(`[Kie.ai Completion] Directly retrieving job ${jobId} via query params`);
    try {
      const getRes = await dynamo.send(new GetCommand({
        TableName: USER_REQUEST_TABLE,
        Key: { uuid: jobId, user_email: userEmail }
      }));
      job = getRes.Item;
    } catch (e) {
      console.error(`[Kie.ai Completion] GetItem failed, falling back to index query`, e.message);
    }
  }

  // Fallback to Index Queries if not resolved
  if (!job) {
    let queryRes = await dynamo.send(new QueryCommand({
      TableName: USER_REQUEST_TABLE,
      IndexName: IMAGE_PROMPT_ID_INDEX || "ImagePromptIdIndex",
      KeyConditionExpression: "image_prompt_id = :ip",
      ExpressionAttributeValues: { ":ip": taskId }
    }));
    job = queryRes.Items?.[0];
  }

  if (!job) {
    let queryRes = await dynamo.send(new QueryCommand({
      TableName: USER_REQUEST_TABLE,
      IndexName: VIDEO_PROMPT_ID_INDEX || "ComfyPromptIdIndex",
      KeyConditionExpression: "comfy_prompt_id = :vp",
      ExpressionAttributeValues: { ":vp": taskId }
    }));
    job = queryRes.Items?.[0];
  }

  // Fallback to Scan video_scenes as a last resort
  if (!job) {
    console.log(`[Kie.ai Completion] Scanning table to find taskId ${taskId} inside video_scenes...`);
    const { ScanCommand } = require("@aws-sdk/lib-dynamodb");
    const scanRes = await dynamo.send(new ScanCommand({
      TableName: USER_REQUEST_TABLE,
      FilterExpression: "contains(video_scenes, :tid)",
      ExpressionAttributeValues: { ":tid": taskId }
    }));
    job = scanRes.Items?.[0];
  }

  if (!job) {
    throw new Error(`Job with taskId ${taskId} not found in DynamoDB.`);
  }

  jobId = job.uuid;
  userEmail = job.user_email;
  const userId = job.user_id || "anonymous";

  // ─── Case A: Multi-Scene Generation ───
  if (Array.isArray(job.video_scenes) && job.video_scenes.length > 0) {
    const vsItemIdx = job.video_scenes.findIndex(item => {
      const key = Object.keys(item).find(k => k.startsWith("scene_"));
      return key && item[key] === taskId;
    });

    if (vsItemIdx !== -1) {
      const sceneKey = Object.keys(job.video_scenes[vsItemIdx]).find(k => k.startsWith("scene_"));
      const sceneId = sceneKey.split("_")[1];
      console.log(`[Kie.ai Completion] Found matching multi-scene task: Scene ${sceneId} (idx: ${vsItemIdx})`);

      // Download scene video
      const res = await fetch(resultUrl);
      if (!res.ok) throw new Error(`Failed to download scene result: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const s3Key = `generated_videos/${userId}/scenes/${jobId}_scene_${sceneId}.mp4`;

      await s3.send(new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: "video/mp4"
      }));

      const imgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: s3Key });
      const signedUrl = await getSignedUrl(s3, imgCmd, { expiresIn: 86400 * 7 }); // 7 days

      job.video_scenes[vsItemIdx].isFinish = true;
      job.video_scenes[vsItemIdx].s3_key = s3Key;
      job.video_scenes[vsItemIdx].url = signedUrl;

      // Update video_scenes in DB
      await dynamo.send(new UpdateCommand({
        TableName: USER_REQUEST_TABLE,
        Key: { uuid: jobId, user_email: userEmail },
        UpdateExpression: "SET video_scenes = :vs, updated_at = :now",
        ExpressionAttributeValues: {
          ":vs": job.video_scenes,
          ":now": getJakartaISOString()
        }
      }));

      console.log(`[Kie.ai Completion] Updated scene ${sceneId} status to finished.`);

      const allFinished = job.video_scenes.every(item => item.isFinish === true);
      if (allFinished) {
        console.log(`[Kie.ai Completion] All scenes finished! Merging...`);
        await mergeVideoScenes(job, job.video_scenes, dynamo, s3, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET);
      }
      return { success: true };
    }
  }

  // ─── Case B: Standard Single Image/Video ───
  const res = await fetch(resultUrl);
  if (!res.ok) throw new Error(`Failed to download Kie.ai result: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const isVideo = ["videos", "video", "gifs"].includes(mediaType) ||
    resultUrl.toLowerCase().includes('.mp4') ||
    resultUrl.toLowerCase().includes('.webm');
  const folder = isVideo ? "generated_videos" : "generated_image";
  const ext = isVideo ? "mp4" : "png";
  const contentType = isVideo ? "video/mp4" : "image/png";
  const s3Key = `${folder}/${userId}/${jobId}.${ext}`;

  console.log(`[Kie.ai Completion] Uploading single result to S3: ${s3Key}`);
  await s3.send(new PutObjectCommand({
    Bucket: S3_RESOURCE_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: contentType
  }));

  let updateExpr = isVideo
    ? "SET result_url = :res, s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys), #s = :status, updated_at = :now"
    : "SET generated_image = :res, s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys), updated_at = :now";

  const attrValues = {
    ":res": s3Key,
    ":empty_list": [],
    ":newKeys": [s3Key],
    ":now": getJakartaISOString()
  };

  const attrNames = {};
  if (isVideo) {
    attrValues[":status"] = "COMPLETED";
    attrNames["#s"] = "status";

    const videoGenStart = job.video_gen_start_at || job.created_at;
    if (videoGenStart) {
      const durationSec = Math.round((Date.now() - Date.parse(videoGenStart)) / 1000);
      updateExpr += ", video_generation_duration = :vgd";
      attrValues[":vgd"] = durationSec;
    }
  }

  await dynamo.send(new UpdateCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: userEmail },
    UpdateExpression: updateExpr,
    ExpressionAttributeValues: attrValues,
    ExpressionAttributeNames: Object.keys(attrNames).length > 0 ? attrNames : undefined
  }));

  if (isVideo) {
    try {
      const { sendJobStatusNotification } = require("../lib/telegram");
      sendJobStatusNotification(jobId, "COMPLETED", { userEmail, resultUrl: s3Key });
    } catch (teleErr) {
      console.error("[Telegram alert failed]", teleErr.message);
    }
  }

  return { success: true, s3Key };
}

/**
 * Kept for backward compatibility but mapped to processKieAiCompletion
 */
async function processComfyUICompletion(params) {
  const { body, isImage, jobId, queryParams, dynamo, s3, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET } = params;
  
  const { findMediaUrlInKieData } = require("../lib/kie-ai");
  const resultUrl = findMediaUrlInKieData(body);
  const taskToken = queryParams?.taskToken;

  if (!resultUrl) {
    console.error(`[ComfyUI Webhook] No media URL found in Kie.ai callback: ${JSON.stringify(body)}`);
    if (taskToken) {
      console.log(`[ComfyUI Webhook] Kie.ai task failed. Sending SendTaskFailureCommand to Step Functions.`);
      const { SFNClient, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");
      const sfnClient = new SFNClient({ region: process.env.AWS_REGION || "ap-southeast-1" });
      
      const errorMsg = body.msg || "Kie.ai generation failed";
      const errorCode = String(body.code || "KieAiError");
      
      try {
        await sfnClient.send(new SendTaskFailureCommand({
          taskToken,
          error: errorCode,
          cause: errorMsg
        }));
      } catch (sfnErr) {
        console.error(`[ComfyUI Webhook] Failed to send task failure:`, sfnErr.message);
      }

      // Update DynamoDB job status to RETRYING (video/image) to avoid poller/recovery double retry
      const retryingStatus = isImage ? "RETRYING (image)" : "RETRYING (video)";
      console.log(`[ComfyUI Webhook] Updating job ${jobId} status to ${retryingStatus}`);
      try {
        const { UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
        let userEmail = queryParams?.userEmail;
        if (!userEmail) {
          const qRes = await dynamo.send(new QueryCommand({
            TableName: USER_REQUEST_TABLE,
            KeyConditionExpression: "#uuid = :u",
            ExpressionAttributeNames: { "#uuid": "uuid" },
            ExpressionAttributeValues: { ":u": jobId }
          }));
          userEmail = qRes.Items?.[0]?.user_email;
        }
        if (userEmail) {
          await dynamo.send(new UpdateCommand({
            TableName: USER_REQUEST_TABLE,
            Key: { uuid: jobId, user_email: userEmail },
            UpdateExpression: "SET #s = :s, updated_at = :u",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":s": retryingStatus, ":u": getJakartaISOString() }
          }));
        }
      } catch (dbErr) {
        console.error(`[ComfyUI Webhook] Failed to update job status to ${retryingStatus}:`, dbErr.message);
      }
    }
    return { success: false, message: "No media URL in callback" };
  }

  if (taskToken) {
    console.log(`[ComfyUI Webhook] Found taskToken, handling callback via Step Functions Task Token`);
    const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");
    const sfnClient = new SFNClient({ region: process.env.AWS_REGION || "ap-southeast-1" });

    try {
      // Find job user details to resolve S3 key subfolder
      const getRes = await dynamo.send(new GetCommand({
        TableName: USER_REQUEST_TABLE,
        Key: { uuid: jobId, user_email: queryParams.userEmail || "test@example.com" }
      }));
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
      const userId = jobData?.user_id || "anonymous";

      // Download and upload to S3
      console.log(`[ComfyUI Webhook SFN Callback] Downloading result from ${resultUrl}`);
      const res = await fetch(resultUrl);
      if (!res.ok) throw new Error(`Failed to download result: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      let s3Key;
      let outputObj = {};

      const requestType = queryParams?.["request-type"];
      if (requestType === "MOTION_GRAPHIC") {
        console.log(`[ComfyUI Webhook SFN Callback] Handling MOTION_GRAPHIC specifically...`);
        const type = queryParams.type || "lifestyle";
        const id = queryParams.id || Date.now().toString();
        s3Key = `generated_image/${userId}/motion_graphic/${jobId}_${id}.png`;
        outputObj = { s3key: s3Key, id, type };
        
        // If there's any specific DynamoDB update needed for Motion Graphic, it goes here
        // Currently we just return the s3key via SFN Task Token
      } else if (isImage) {
        const type = queryParams.type || "lock";
        const id = queryParams.id || "main";
        const subfolder = type === "lock" ? "locks" : "scenes";
        s3Key = `generated_image/${userId}/${subfolder}/${jobId}_${id}.png`;
        outputObj = { s3key: s3Key, id, type };

        if (type === "imagesScene" && jobData) {
          console.log(`[ComfyUI Webhook SFN Callback] Saving scene ${id} to DynamoDB generated_scenes via list_append`);
          await dynamo.send(new UpdateCommand({
            TableName: USER_REQUEST_TABLE,
            Key: { uuid: jobId, user_email: jobData.user_email },
            UpdateExpression: "SET generated_scenes = list_append(if_not_exists(generated_scenes, :empty_list), :new_scene), updated_at = :now",
            ExpressionAttributeValues: {
              ":empty_list": [],
              ":new_scene": [{ scene_id: Number(id), s3_key: s3Key }],
              ":now": getJakartaISOString()
            }
          }));
        }
      } else {
        const sceneId = queryParams.sceneId || 1;
        s3Key = `generated_videos/${userId}/scenes/${jobId}_scene_${sceneId}.mp4`;
        outputObj = { s3key: s3Key, id: String(sceneId) };
      }

      console.log(`[ComfyUI Webhook SFN Callback] Uploading to S3 bucket ${S3_RESOURCE_BUCKET}, key: ${s3Key}`);
      await s3.send(new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: isImage ? "image/png" : "video/mp4"
      }));

      // Send task success to SFN
      console.log(`[ComfyUI Webhook SFN Callback] Resuming Step Functions task token...`);
      await sfnClient.send(new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify(outputObj)
      }));

      return { success: true, s3Key };
    } catch (err) {
      console.error(`[ComfyUI Webhook SFN Callback] Error and sending task failure:`, err.message);
      try {
        await sfnClient.send(new SendTaskFailureCommand({
          taskToken,
          error: "WebhookProcessingError",
          cause: err.message
        }));
      } catch (sfnErr) {
        console.error(`[ComfyUI Webhook SFN Callback] Failed to send task failure:`, sfnErr.message);
      }
      throw err;
    }
  }

  const requestType = queryParams?.["request-type"];
  const isStandalone = ["MOTION_CONTROL", "FREE-TRIAL"].includes(requestType);
  if (isStandalone) {
    console.log(`[ComfyUI Webhook] Standalone job detected via request-type=${requestType}. Falling back to processKieAiCompletion.`);
    
    let userEmail = queryParams?.userEmail;
    if (!userEmail) {
      const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
      try {
        const qRes = await dynamo.send(new QueryCommand({
          TableName: USER_REQUEST_TABLE,
          KeyConditionExpression: "#uuid = :u",
          ExpressionAttributeNames: { "#uuid": "uuid" },
          ExpressionAttributeValues: { ":u": jobId }
        }));
        userEmail = qRes.Items?.[0]?.user_email;
      } catch (err) {
        console.error(`[ComfyUI Webhook] Failed to resolve userEmail for standalone job ${jobId}:`, err.message);
      }
    }

    return processKieAiCompletion({
      taskId: body.task_id || body.id || jobId,
      resultUrl,
      mediaType: isImage ? "images" : "videos",
      dynamo,
      s3,
      USER_REQUEST_TABLE,
      S3_RESOURCE_BUCKET,
      IMAGE_PROMPT_ID_INDEX: process.env.IMAGE_PROMPT_ID_INDEX,
      VIDEO_PROMPT_ID_INDEX: process.env.VIDEO_PROMPT_ID_INDEX,
      queryStringParameters: { ...queryParams, jobId, userEmail }
    });
  }

  const { handleImageCallback, handleVideoCallback } = require("./stateMachine");

  if (isImage) {
    const type = queryParams?.type || "lock";
    const id = queryParams?.id || "main";
    await handleImageCallback({
      jobId,
      type,
      id,
      resultUrl,
      dynamo,
      s3,
      USER_REQUEST_TABLE,
      S3_RESOURCE_BUCKET
    });
  } else {
    const sceneId = queryParams?.sceneId || 1;
    await handleVideoCallback({
      jobId,
      sceneId,
      resultUrl,
      dynamo,
      s3,
      USER_REQUEST_TABLE,
      S3_RESOURCE_BUCKET
    });
  }

  return { success: true };
}

module.exports = {
  processKieAiCompletion,
  processComfyUICompletion
};
