"use strict";

const { renderMediaOnLambda } = require("@remotion/lambda/client");

const REGION = process.env.REMOTION_AWS_REGION || "ap-southeast-1";
const FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME || "remotion-render-function";
const SERVE_URL = process.env.REMOTION_SERVE_URL || "PLACEHOLDER_SERVE_URL";
const WEBHOOK_URL = process.env.WEBHOOK_URL;

exports.handler = async (event, context) => {
  console.log("[PostProductionWorker] Received event:", JSON.stringify(event, null, 2));

  try {
    const { jobId, userEmail, userId, llm_response, videoUrl, taskToken } = event;

    if (!videoUrl) {
      throw new Error("Missing videoUrl for post-production.");
    }

    if (!taskToken) {
      throw new Error("Missing taskToken for Step Function continuation.");
    }

    const post_production = llm_response?.post_production;
    if (!post_production) {
      console.warn("[PostProductionWorker] No post_production config found in llm_response. Failing task or returning original video.");
      // We must fail or succeed the task if we don't render. We will succeed with original URL.
      const { SFNClient, SendTaskSuccessCommand } = require("@aws-sdk/client-sfn");
      const { getJakartaISOString } = require("./utils");
      const sfnClient = new SFNClient({ region: process.env.AWS_REGION || "ap-southeast-1" });
      
      await sfnClient.send(new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({
          Payload: {
            result_url: videoUrl,
            completedAt: getJakartaISOString()
          }
        })
      }));
      return;
    }

    let finalVideoUrl = videoUrl;
    if (!finalVideoUrl.startsWith("http") && !finalVideoUrl.startsWith("s3://")) {
      const bucket = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
      const region = process.env.AWS_REGION || "ap-southeast-1";
      finalVideoUrl = `https://${bucket}.s3.${region}.amazonaws.com/${finalVideoUrl}`;
      console.log(`[PostProductionWorker] Converted S3 key to URL: ${finalVideoUrl}`);
    }

    let isS3 = false;
    let bucketName, s3Region, key;

    // Detect if videoUrl is an S3 URL (HTTPS or s3:// format)
    const httpsMatch = finalVideoUrl.match(/^https:\/\/([^.]+)\.s3\.([^.]+)\.amazonaws\.com\/(.+)$/);
    const s3ProtocolMatch = finalVideoUrl.match(/^s3:\/\/([^/]+)\/(.+)$/);

    if (httpsMatch || s3ProtocolMatch) {
      isS3 = true;
      console.log(`[PostProductionWorker] Detected S3 URL. Validating and generating presigned URL...`);
      const { S3Client, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
      const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
      
      if (httpsMatch) {
        bucketName = httpsMatch[1];
        s3Region = httpsMatch[2];
        key = decodeURIComponent(httpsMatch[3]);
      } else {
        bucketName = s3ProtocolMatch[1];
        s3Region = process.env.AWS_REGION || "ap-southeast-1";
        key = decodeURIComponent(s3ProtocolMatch[2]);
      }
      
      const s3Client = new S3Client({ region: s3Region });

      // 1. Validate existence using HeadObject (this avoids 403 Signature Does Not Match from using HTTP HEAD on a GET presigned URL)
      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
      } catch (err) {
        throw new Error(`Failed to validate S3 video URL. Make sure the video exists. Error: ${err.name} - ${err.message}`);
      }

      // 2. Generate Presigned URL
      try {
        finalVideoUrl = await getSignedUrl(s3Client, new GetObjectCommand({
          Bucket: bucketName,
          Key: key
        }), { expiresIn: 3600 });
        console.log(`[PostProductionWorker] Successfully generated presigned URL.`);
      } catch (err) {
        console.warn(`[PostProductionWorker] Failed to sign S3 URL. Proceeding with original URL. Error:`, err);
      }
    }

    if (!isS3) {
      console.log(`[PostProductionWorker] Checking if non-S3 videoUrl is accessible before rendering...`);
      try {
        const checkRes = await fetch(finalVideoUrl, { method: "HEAD" });
        if (!checkRes.ok) {
          throw new Error(`Video URL returned HTTP ${checkRes.status} ${checkRes.statusText}`);
        }
      } catch (e) {
        throw new Error(`Failed to validate video URL. Make sure the video exists and is accessible. Error: ${e.message}`);
      }
    }

    console.log(`[PostProductionWorker] Starting render for Job ${jobId}...`);
    const renderResult = await renderMediaOnLambda({
      region: REGION,
      functionName: FUNCTION_NAME,
      serveUrl: SERVE_URL,
      composition: "PostProduction",
      inputProps: {
        videoUrl: finalVideoUrl,
        post_production
      },
      codec: "h264",
      imageFormat: "jpeg",
      maxRetries: 1,
      privacy: "public",
      webhook: WEBHOOK_URL ? {
        url: WEBHOOK_URL,
        customData: {
          taskToken,
          jobId,
          originalBucket: bucketName,
          originalKey: key,
          originalUrl: event.videoUrl
        }
      } : undefined
    });

    console.log(`\n======================================================`);
    console.log(`[PostProductionWorker] RENDER JOB INITIATED SUCCESSFULLY!`);
    console.log(`======================================================`);
    console.log(`Render ID     : ${renderResult.renderId}`);
    console.log(`Bucket Name   : ${renderResult.bucketName}`);
    console.log(`Webhook URL   : ${WEBHOOK_URL ? 'CONFIGURED & READY' : 'NOT CONFIGURED'}`);
    console.log(`\n---> Pantau PROGRESS RENDER & ENCODING di S3:`);
    console.log(renderResult.progressJsonInConsole);
    console.log(`\n---> Pantau LOGS RENDER SECARA REAL-TIME di CloudWatch:`);
    console.log(renderResult.cloudWatchLogs);
    console.log(`======================================================\n`);

    // We do NOT poll anymore. The Step Function is paused waiting for taskToken.
    // The Remotion Webhook will resume it when the render finishes.
    return { success: true, renderId: renderResult.renderId };
  } catch (error) {
    console.error("[PostProductionWorker] Error in post production:", error);
    // If it fails immediately, we should probably fail the step function task
    const { SFNClient, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");
    const sfnClient = new SFNClient({ region: process.env.AWS_REGION || "ap-southeast-1" });
    if (event.taskToken) {
      await sfnClient.send(new SendTaskFailureCommand({
        taskToken: event.taskToken,
        error: "PostProductionTriggerFailed",
        cause: error.message
      })).catch(e => console.error("Failed to send TaskFailure:", e));
    }
    throw error;
  }
};
