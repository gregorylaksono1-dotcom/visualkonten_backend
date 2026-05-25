"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("./utils");
const { processComfyUICompletion } = require("./core/comfyuiHandler");
const { getOutputUrl, s3Client } = require("./services");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET;
const IMAGE_PROMPT_ID_INDEX = process.env.IMAGE_PROMPT_ID_INDEX || "ImagePromptIdIndex";
const VIDEO_PROMPT_ID_INDEX = process.env.VIDEO_PROMPT_ID_INDEX || "ComfyPromptIdIndex";
const COMFY_BASE_URL = "https://cloud.comfy.org";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

exports.handler = async (event) => {
  console.log("[Recovery Cron] Started");
  try {
    // We need to scan/query for items where status <> COMPLETED
    // Since we don't have a specific index for "not completed", and the dataset might be large,
    // a Scan with FilterExpression is needed. Alternatively, we could query the StatusCreatedIndex 
    // for PENDING and PROCESSING statuses.
    
    const statuses = ["PENDING", "PROCESSING"];
    const nowMs = Date.now();
    const oneHourMs = 60 * 60 * 1000;
    
    for (const status of statuses) {
      console.log(`[Recovery Cron] Checking status: ${status}`);
      let lastEvaluatedKey = undefined;
      
      do {
        const res = await dynamo.send(new ScanCommand({
          TableName: USER_REQUEST_TABLE,
          FilterExpression: "#s = :st",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":st": status },
          ExclusiveStartKey: lastEvaluatedKey
        }));
        
        lastEvaluatedKey = res.LastEvaluatedKey;
        const items = res.Items || [];
        
        for (const job of items) {
          const createdAtStr = job.created_at;
          if (!createdAtStr) continue;
          
          const createdDate = new Date(createdAtStr);
          // Check if older than 1 hour
          if (nowMs - createdDate.getTime() >= oneHourMs) {
            console.log(`[Recovery Cron] Found stalled job: ${job.uuid} (created_at: ${createdAtStr})`);
            
            const promptId = job.comfy_prompt_id || job.image_prompt_id;
            const apiKey = job.used_api_key;
            
            if (promptId && apiKey) {
              try {
                // Check status from Comfy Cloud
                const statusRes = await fetch(`${COMFY_BASE_URL}/api/job/${promptId}/status`, {
                  headers: { "X-API-Key": apiKey },
                });
                if (statusRes.ok) {
                  const statusData = await statusRes.json();
                  if (statusData.status === "completed") {
                    console.log(`[Recovery Cron] Job ${job.uuid} is completed on Comfy Cloud. Recovering...`);
                    const resultUrl = await getOutputUrl(promptId, apiKey);
                    if (resultUrl) {
                      const body = {
                        status: "completed",
                        prompt_id: promptId,
                        downloads: [
                          {
                            url: resultUrl,
                            media_type: job.comfy_prompt_id ? "videos" : "images",
                            filename: job.comfy_prompt_id ? "result.mp4" : "result.png"
                          }
                        ]
                      };
                      
                      await processComfyUICompletion({
                        body,
                        dynamo,
                        s3: s3Client,
                        USER_REQUEST_TABLE,
                        S3_RESOURCE_BUCKET,
                        IMAGE_PROMPT_ID_INDEX,
                        VIDEO_PROMPT_ID_INDEX
                      });
                      console.log(`[Recovery Cron] Successfully recovered job ${job.uuid}`);
                    }
                  } else if (statusData.status === "failed" || statusData.status === "cancelled") {
                     // Update to FAILED
                     await dynamo.send(new UpdateCommand({
                        TableName: USER_REQUEST_TABLE,
                        Key: { uuid: job.uuid, user_email: job.user_email },
                        UpdateExpression: "SET #s = :failed, updated_at = :now",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: { 
                          ":failed": "FAILED", 
                          ":now": getJakartaISOString()
                     }));
                     console.log(`[Recovery Cron] Job ${job.uuid} was failed/cancelled on Comfy Cloud. Updated DynamoDB.`);
                  }
                }
              } catch (e) {
                console.error(`[Recovery Cron] Failed to recover job ${job.uuid}:`, e);
              }
            } else {
              console.log(`[Recovery Cron] Job ${job.uuid} has no comfy_prompt_id or used_api_key. Cannot recover from Comfy Cloud.`);
            }
          }
        }
      } while (lastEvaluatedKey);
    }
    
    console.log("[Recovery Cron] Finished successfully");
    return { statusCode: 200, body: "Success" };
  } catch (err) {
    console.error("[Recovery Cron] Error:", err);
    return { statusCode: 500, body: err.message };
  }
};
