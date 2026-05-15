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

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

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

    try {
        const result = await processComfyUICompletion({
            body,
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
