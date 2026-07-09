"use strict";

const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("../utils");
const { getKieAiKey, s3Client } = require("../services");
const { uploadToKie, createKieTask } = require("../lib/kie-ai");
const { getConfig } = require("../lib/config");

/**
 * Submits a Motion Control video generation task to Kie.ai.
 */
async function submitMotionControlTask(params) {
  const {
    jobId,
    userEmail,
    userId,
    s3ImageUrls,
    videoRefKey,
    duration,
    dynamo,
    USER_REQUEST_TABLE,
    S3_RESOURCE_BUCKET,
    retryCount = 0
  } = params;

  console.log(`[MotionControl] Submitting task for Job: ${jobId}, User: ${userEmail}, Retry count: ${retryCount}`);

  try {
    const kieApiKey = await getKieAiKey();
    if (!kieApiKey) {
      throw new Error("Kie.ai API Key not found in SSM Parameter Store.");
    }

    // 1. Resolve product image signed URL and upload to Kie.ai
    if (!s3ImageUrls || s3ImageUrls.length === 0) {
      throw new Error("Product image is required for MOTION_CONTROL.");
    }
    const productImageUrl = s3ImageUrls[0];
    console.log(`[MotionControl] Uploading product image to Kie.ai: ${productImageUrl.split("?")[0]}`);
    const kieImageUrl = await uploadToKie(productImageUrl, kieApiKey);

    // 2. Resolve video reference signed URL and upload to Kie.ai
    if (!videoRefKey) {
      throw new Error("Reference video is required for MOTION_CONTROL.");
    }
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("../services");
    console.log(`[MotionControl] Resolving signed reference video URL for key: ${videoRefKey}`);
    const videoCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: videoRefKey });
    const signedVideoUrl = await getSignedUrl(s3Client, videoCmd, { expiresIn: 86400 });
    const kieVideoUrl = await uploadToKie(signedVideoUrl, kieApiKey);

    // 3. Resolve callback URL containing jobId
    const config = await getConfig();
    const callbackBase = config.callback_result || `${config.api_gateway_url || "https://xayhmg0s7b.execute-api.ap-southeast-1.amazonaws.com/dev"}/comfyui-webhook`;
    const callbackBaseNormalized = callbackBase.endsWith("/") ? callbackBase.slice(0, -1) : callbackBase;
    const callBackUrl = `${callbackBaseNormalized}/${jobId}?request-type=MOTION_CONTROL`;
    console.log(`[MotionControl] Callback URL: ${callBackUrl}`);

    const model = "wan/2-2-animate-move";
    const input = {
      video_url: kieVideoUrl,
      image_url: kieImageUrl,
      resolution: "720p",
      duration: Number(duration || 10)
    };

    console.log(`[MotionControl] Calling Kie.ai createKieTask for ${model}...`);
    const taskId = await createKieTask(model, input, callBackUrl, kieApiKey);
    console.log(`[MotionControl] Task created successfully: ${taskId}`);

    // 4. Update DynamoDB status to PROCESSING
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET #s = :status, comfy_prompt_id = :tid, retry_count = :rc, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":status": "PROCESSING",
        ":tid": taskId,
        ":rc": retryCount,
        ":now": getJakartaISOString()
      }
    }));

    return taskId;
  } catch (err) {
    console.error(`[MotionControl] Error in submitMotionControlTask for Job ${jobId}:`, err.message);
    throw err;
  }
}

/**
 * Handles job failure with 3x retry limit.
 */
async function handleMotionControlFailure(job, errorMsg, dynamo, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET) {
  const currentRetry = Number(job.retry_count || 0);
  const jobId = job.uuid;
  const userEmail = job.user_email;

  if (currentRetry < 3) {
    const nextRetry = currentRetry + 1;
    console.log(`[MotionControl Retry] Job ${jobId} failed. Retrying ${nextRetry}/3... Error: ${errorMsg}`);
    
    try {
      // Re-sign S3 image URLs
      const s3ImageUrls = [];
      const s3Keys = job.s3_keys || [];
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const { getSignedUrl } = require("../services");
      
      // The product image key is usually the first key that is not the video key
      const imageKeys = s3Keys.filter(k => k !== job.video_ref_key);
      for (const key of imageKeys) {
        const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
        s3ImageUrls.push(await getSignedUrl(s3Client, cmd, { expiresIn: 3600 }));
      }

      await submitMotionControlTask({
        jobId,
        userEmail,
        userId: job.user_id,
        s3ImageUrls,
        videoRefKey: job.video_ref_key,
        duration: job.duration_seconds || 10,
        dynamo,
        USER_REQUEST_TABLE,
        S3_RESOURCE_BUCKET,
        retryCount: nextRetry
      });
      
      console.log(`[MotionControl Retry] Successfully resubmitted job ${jobId}`);
      return true; // Retried successfully
    } catch (retryErr) {
      console.error(`[MotionControl Retry] Failed to resubmit job ${jobId}:`, retryErr.message);
    }
  }

  // If retries are exhausted or retry resubmission failed
  console.log(`[MotionControl] Retries exhausted for Job ${jobId}. Marking as FAILED.`);
  return false;
}

module.exports = {
  submitMotionControlTask,
  handleMotionControlFailure
};
