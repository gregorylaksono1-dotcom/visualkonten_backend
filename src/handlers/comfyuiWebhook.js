"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getRedis } = require("../services");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET;
const IMAGE_PROMPT_ID_INDEX = process.env.IMAGE_PROMPT_ID_INDEX;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

/**
 * Handler untuk menangkap result/webhook dari ComfyUI Cloud.
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

    const { status, prompt_id, downloads } = body;

    if (status !== "completed") {
        console.log(`[ComfyUI Webhook] Job ${prompt_id} status is ${status}, skipping processing.`);
        return { statusCode: 200, body: JSON.stringify({ message: "Status not completed" }) };
    }

    if (!downloads || downloads.length === 0) {
        console.error(`[ComfyUI Webhook] No downloads found for job ${prompt_id}`);
        return { statusCode: 200, body: JSON.stringify({ message: "No downloads" }) };
    }

    try {
        // 1. Ambil item pertama dari downloads (sesuai request user)
        const output = downloads[0];
        
        // Cek media_type (user minta dicek, asumsikan harus images)
        if (output.media_type !== "images") {
            console.log(`[ComfyUI Webhook] media_type is ${output.media_type}, not images. Skipping.`);
            return { statusCode: 200, body: JSON.stringify({ message: "Media type not images" }) };
        }

        const resultUrl = output.url;
        console.log(`[ComfyUI Webhook] Found image URL for prompt_id ${prompt_id}: ${resultUrl}`);

        // 2. Cari job di DynamoDB berdasarkan image_prompt_id
        const queryRes = await dynamo.send(new QueryCommand({
            TableName: USER_REQUEST_TABLE,
            IndexName: IMAGE_PROMPT_ID_INDEX,
            KeyConditionExpression: "image_prompt_id = :ip",
            ExpressionAttributeValues: { ":ip": prompt_id }
        }));

        const job = queryRes.Items?.[0];
        if (!job) {
            console.error(`[ComfyUI Webhook] Job with image_prompt_id ${prompt_id} not found in DynamoDB.`);
            return { statusCode: 404, body: JSON.stringify({ message: "Job not found" }) };
        }

        const jobId = job.uuid;
        const userEmail = job.user_email;
        const userId = job.user_id || "anonymous";

        // 3. Download image
        console.log(`[ComfyUI Webhook] Downloading image from ComfyUI...`);
        const imgRes = await fetch(resultUrl);
        if (!imgRes.ok) throw new Error(`Failed to download image from ComfyUI: ${imgRes.status}`);
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

        // 4. Upload ke S3
        const genS3Key = `generated_image/${userId}/${jobId}.png`;
        console.log(`[ComfyUI Webhook] Uploading to S3: ${genS3Key}`);
        await s3.send(new PutObjectCommand({
            Bucket: S3_RESOURCE_BUCKET,
            Key: genS3Key,
            Body: imgBuffer,
            ContentType: "image/png"
        }));

        // 5. Update DynamoDB record
        console.log(`[ComfyUI Webhook] Updating DynamoDB for job ${jobId}`);
        await dynamo.send(new UpdateCommand({
            TableName: USER_REQUEST_TABLE,
            Key: { uuid: jobId, user_email: userEmail },
            UpdateExpression: "SET generated_image = :gi, updated_at = :now",
            ExpressionAttributeValues: { 
                ":gi": genS3Key, 
                ":now": new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }) 
            }
        }));
        
        // 6. Decrement Redis counter for the used API Key
        const usedApiKey = job.used_api_key;
        if (usedApiKey) {
            const redis = getRedis();
            if (redis) {
                try {
                    const redisKey = `comfyui_job_${usedApiKey}`;
                    await redis.decr(redisKey);
                    console.log(`[Redis] Decremented ${redisKey} in webhook`);
                } catch (redisErr) {
                    console.error("[Redis] Error decrementing in webhook:", redisErr.message);
                }
            }
        }

        console.log(`[ComfyUI Webhook] Successfully processed job ${jobId}`);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Successfully processed", s3Key: genS3Key })
        };

    } catch (err) {
        console.error("[ComfyUI Webhook] Error processing webhook:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal server error", error: err.message })
        };
    }
};
