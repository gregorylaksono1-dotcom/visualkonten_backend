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
      const { getJakartaISOString } = require("../utils");
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

    console.log(`[PostProductionWorker] Starting render for Job ${jobId}...`);
    const { renderId, bucketName } = await renderMediaOnLambda({
      region: REGION,
      functionName: FUNCTION_NAME,
      serveUrl: SERVE_URL,
      composition: "PostProduction",
      inputProps: {
        videoUrl,
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
          jobId
        }
      } : undefined
    });

    console.log(`[PostProductionWorker] Render started. renderId: ${renderId}, bucketName: ${bucketName}. Webhook configured: ${!!WEBHOOK_URL}`);

    // We do NOT poll anymore. The Step Function is paused waiting for taskToken.
    // The Remotion Webhook will resume it when the render finishes.
    return { success: true, renderId };
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
