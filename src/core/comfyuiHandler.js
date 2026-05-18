const { QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getRedis } = require("../services");
const { generateComfyUIVideo } = require("./videoGeneration");

/**
 * Handles the completion of a ComfyUI job (Image or Video)
 */
async function processComfyUICompletion(params) {
  const { 
    body, dynamo, s3, 
    USER_REQUEST_TABLE, S3_RESOURCE_BUCKET, 
    IMAGE_PROMPT_ID_INDEX, VIDEO_PROMPT_ID_INDEX 
  } = params;

  const { status, prompt_id, downloads } = body;

  if (status !== "completed") {
    console.log(`[ComfyUI] Job ${prompt_id} status is ${status}, skipping.`);
    return { success: false, message: "Status not completed" };
  }

  if (!downloads || downloads.length === 0) {
    throw new Error(`No downloads found for job ${prompt_id}`);
  }

  const output = downloads[0];
  const resultUrl = output.url;
  const mediaType = output.media_type; // "images" or "videos"

  console.log(`[ComfyUI] Processing ${mediaType} completion for prompt_id ${prompt_id}`);

  // 1. Find the job in DynamoDB
  // We check both indexes: image_prompt_id and comfy_prompt_id (video)
  let queryRes = await dynamo.send(new QueryCommand({
    TableName: USER_REQUEST_TABLE,
    IndexName: IMAGE_PROMPT_ID_INDEX,
    KeyConditionExpression: "image_prompt_id = :ip",
    ExpressionAttributeValues: { ":ip": prompt_id }
  }));

  let job = queryRes.Items?.[0];
  let isImageJob = !!job;

  if (!job) {
    // Try video index
    queryRes = await dynamo.send(new QueryCommand({
      TableName: USER_REQUEST_TABLE,
      IndexName: VIDEO_PROMPT_ID_INDEX,
      KeyConditionExpression: "comfy_prompt_id = :vp",
      ExpressionAttributeValues: { ":vp": prompt_id }
    }));
    job = queryRes.Items?.[0];
  }

  if (!job) {
    throw new Error(`Job with prompt_id ${prompt_id} not found in DynamoDB.`);
  }

  const jobId = job.uuid;
  const userEmail = job.user_email;
  const userId = job.user_id || "anonymous";

  // 2. Download result
  const res = await fetch(resultUrl);
  if (!res.ok) throw new Error(`Failed to download result: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  // 3. Upload to S3
  const isVideo = ["videos", "video", "gifs"].includes(mediaType) || 
                  (output.filename && output.filename.toLowerCase().endsWith('.mp4')) || 
                  (output.filename && output.filename.toLowerCase().endsWith('.webm'));
  const folder = isVideo ? "generated_videos" : "generated_image";
  const ext = isVideo ? "mp4" : "png";
  const contentType = isVideo ? "video/mp4" : "image/png";
  const s3Key = `${folder}/${userId}/${jobId}.${ext}`;

  console.log(`[ComfyUI] Uploading to S3: ${s3Key}`);
  await s3.send(new PutObjectCommand({
    Bucket: S3_RESOURCE_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: contentType
  }));

  // 4. Update DynamoDB
  // For image jobs, we just set generated_image.
  // For video jobs, we set result_url and status = COMPLETED.
  const updateExpr = isVideo 
    ? "SET result_url = :res, #s = :status, updated_at = :now"
    : "SET generated_image = :res, updated_at = :now";
    
  const attrValues = { 
    ":res": s3Key, 
    ":now": new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }) 
  };
  
  const attrNames = {};
  if (isVideo) {
    attrValues[":status"] = "COMPLETED";
    attrNames["#s"] = "status";
  }

  await dynamo.send(new UpdateCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: userEmail },
    UpdateExpression: updateExpr,
    ExpressionAttributeValues: attrValues,
    ExpressionAttributeNames: Object.keys(attrNames).length > 0 ? attrNames : undefined
  }));

  // 5. Pipeline Logic
  // Flag to trigger video generation from webhook (deactivated as we now trigger it directly after OpenAI image gen)
  const TRIGGER_VIDEO_FROM_WEBHOOK = false;

  if (TRIGGER_VIDEO_FROM_WEBHOOK && isImageJob && !isVideo && job.request_type === "UGC-P") {
    await generateComfyUIVideo({
      ...job,
      imageResultUrl: resultUrl,
      dynamo,
      s3,
      USER_REQUEST_TABLE,
      S3_RESOURCE_BUCKET
    });
  } else {
    // End of pipeline for this job (either it was a video completion, 
    // or an image completion that doesn't need video), decrement Redis.
    const usedApiKey = job.used_api_key;
    if (usedApiKey) {
      const redis = getRedis();
      if (redis) {
        try {
          const redisKey = `comfyui_job_${usedApiKey}`;
          await redis.decr(redisKey);
          console.log(`[Redis] Decremented ${redisKey} for job ${jobId} (Pipeline end)`);
        } catch (e) {
          console.error("[Redis] Error decrementing:", e.message);
        }
      }
    }
  }

  return { success: true, s3Key };
}

module.exports = {
  processComfyUICompletion
};
