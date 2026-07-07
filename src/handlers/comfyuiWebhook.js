"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { S3Client } = require("@aws-sdk/client-s3");
const { processComfyUICompletion } = require("../core/comfyuiHandler");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET;
const IMAGE_PROMPT_ID_INDEX = process.env.IMAGE_PROMPT_ID_INDEX;
const VIDEO_PROMPT_ID_INDEX = process.env.VIDEO_PROMPT_ID_INDEX;

const S3_REGION = process.env.S3_RESOURCE_BUCKET_REGION || (S3_RESOURCE_BUCKET === "visualkonten" ? "us-east-2" : REGION);

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: S3_REGION });

/**
 * Handler for catching ComfyUI Cloud result/webhook.
 * This function is now a lightweight wrapper around core logic.
 */
exports.handler = async (event) => {
    console.log("[ComfyUI Webhook] Request received");

    let body;
    try {
        body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {
        console.error("[ComfyUI Webhook] Failed to parse body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ message: "Invalid JSON body" }) };
    }

    const path = event.path || "";
    const queryParams = event.queryStringParameters || {};
    const isImage = path.endsWith("/images") || path.includes("/images");
    
    let jobId = queryParams['request-id'] || queryParams.jobId;
    if (!jobId) {
      const pathParts = path.split("/").filter(Boolean);
      const pathJobId = pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;
      if (pathJobId && pathJobId !== "comfyui-webhook" && pathJobId !== "images" && pathJobId !== "video") {
        jobId = pathJobId;
      }
    }

    console.log(`[ComfyUI Webhook] Routing callback - isImage: ${isImage}, jobId: ${jobId}`);

    try {
        const result = await processComfyUICompletion({
            body,
            isImage,
            jobId,
            queryParams,
            dynamo,
            s3,
            USER_REQUEST_TABLE,
            S3_RESOURCE_BUCKET,
            IMAGE_PROMPT_ID_INDEX,
            VIDEO_PROMPT_ID_INDEX
        });

        return {
            statusCode: 200,
            body: JSON.stringify(result)
        };

    } catch (err) {
        console.error("[ComfyUI Webhook] Error processing webhook:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal server error", error: err.message })
        };
    }
};
