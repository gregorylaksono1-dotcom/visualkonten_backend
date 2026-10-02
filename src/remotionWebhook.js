"use strict";

const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");
const { S3Client, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("./utils");

const sfnClient = new SFNClient({ region: process.env.AWS_REGION || "ap-southeast-1" });

exports.handler = async (event) => {
  console.log("[RemotionWebhook] Received event:", JSON.stringify(event, null, 2));

  try {
    const body = event.body ? JSON.parse(event.body) : event;
    const { type, outputFile, errors, customData } = body;
    
    if (!customData || !customData.taskToken) {
      console.error("[RemotionWebhook] Missing taskToken in customData.");
      return { statusCode: 400, body: JSON.stringify({ error: "Missing taskToken" }) };
    }

    const { taskToken, jobId } = customData;
    console.log(`[RemotionWebhook] Processing webhook for Job ${jobId}, Type: ${type}`);

    if (type === "success") {
      let finalResultUrl = outputFile;
      
      const outKey = body.outKey || (body.renderId ? `renders/${body.renderId}/out.mp4` : null);

      const targetBucket = customData.bucket || customData.originalBucket;
      const targetKey = customData.key || customData.originalKey;

      if (targetBucket && targetKey && body.bucketName && outKey) {
        const baseKey = targetKey.replace(/(_postprod.*|\.mp4$)/, "");
        const postProdKey = `${baseKey}_postprod_${Date.now()}.mp4`;

        console.log(`[RemotionWebhook] Copying output from ${body.bucketName}/${outKey} to ${targetBucket}/${postProdKey}`);
        try {
          const s3Client = new S3Client({ region: process.env.AWS_REGION || "ap-southeast-1" });
          await s3Client.send(new CopyObjectCommand({
            Bucket: targetBucket,
            Key: postProdKey,
            CopySource: `${body.bucketName}/${encodeURI(outKey)}`
          }));
          console.log(`[RemotionWebhook] Successfully saved post-production video at ${targetBucket}/${postProdKey}`);
          finalResultUrl = postProdKey;
        } catch (copyErr) {
          console.error("[RemotionWebhook] Failed to copy S3 object:", copyErr);
          // Fallback to the remotion output URL if copy fails
        }
      }

      await sfnClient.send(new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({
          Payload: {
            result_url: finalResultUrl,
            completedAt: getJakartaISOString()
          }
        })
      }));
      console.log(`[RemotionWebhook] Successfully resumed Step Function for Job ${jobId}`);
    } else {
      console.error(`[RemotionWebhook] Render failed/timed out:`, errors);
      await sfnClient.send(new SendTaskFailureCommand({
        taskToken,
        error: "RemotionRenderFailed",
        cause: JSON.stringify(errors || "Unknown Remotion Error")
      }));
      console.log(`[RemotionWebhook] Sent failure to Step Function for Job ${jobId}`);
    }

    return { statusCode: 200, body: JSON.stringify({ message: "Webhook processed" }) };
  } catch (error) {
    console.error("[RemotionWebhook] Error processing webhook:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
