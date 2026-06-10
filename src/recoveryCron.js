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
    // A. Query for FAILED_CONCCURENCY jobs - Limit to 1 oldest job
    console.log("[Recovery Cron] Checking for FAILED_CONCCURENCY jobs (Limit: 1, oldest first)");
    const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
    const { GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
    const { pickComfyApiKey, getComfyApiKeys, submitWorkflow, getRedis, uploadInputImage, uploadInputAudio } = require("./services");

    const res = await dynamo.send(new QueryCommand({
      TableName: USER_REQUEST_TABLE,
      IndexName: "StatusCreatedIndex",
      KeyConditionExpression: "#s = :st",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":st": "FAILED_CONCCURENCY" },
      Limit: 1,
      ScanIndexForward: true // Sort ascending by created_at (oldest job first)
    }));

    const items = res.Items || [];
    if (items.length > 0) {
      const job = items[0];
      console.log(`[Recovery Cron] Active: Starting resubmission process for job ${job.uuid} (created_at: ${job.created_at})`);
      
      // 1. Download workflow JSON from S3
      let workflow = null;
      try {
        const s3Res = await s3Client.send(new GetObjectCommand({
          Bucket: S3_RESOURCE_BUCKET,
          Key: `workflow/${job.uuid}.json`
        }));
        const streamToString = (stream) =>
          new Promise((resolve, reject) => {
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("error", reject);
            stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          });
        const bodyStr = await streamToString(s3Res.Body);
        workflow = JSON.parse(bodyStr);
      } catch (s3Err) {
        console.warn(`[Recovery Cron] Workflow file not found in S3 for job ${job.uuid} (aborted early). Re-dispatching to worker...`);
        try {
          const { invokeComfyUI, invokeFreeTrialWorker } = require("./services");
          const jobPayload = {
            jobId: job.uuid,
            userEmail: job.user_email,
            requestType: job.request_type,
            prompt: job.prompt,
            videoQuality: job.video_quality,
            aspectRatio: job.aspect_ratio,
            s3_keys: job.s3_keys || [],
            userId: job.user_id,
            ugc_mode: job.ugc_mode || null,
            store_type: job.store_type || null,
            lip_sync: job.request_type === "FREE-TRIAL" ? false : true,
          };

          // Reset status to SUBMITTING before re-dispatching
          await dynamo.send(new UpdateCommand({
            TableName: USER_REQUEST_TABLE,
            Key: { uuid: job.uuid, user_email: job.user_email },
            UpdateExpression: "SET #s = :status, updated_at = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":status": "SUBMITTING",
              ":now": getJakartaISOString()
            }
          }));

          if (job.request_type === "FREE-TRIAL") {
            await invokeFreeTrialWorker(job.uuid, jobPayload);
          } else {
            await invokeComfyUI(job.uuid, jobPayload);
          }
          console.log(`[Recovery Cron] Re-dispatched job ${job.uuid} successfully.`);
          return { statusCode: 200, body: "Re-dispatched job" };
        } catch (dispatchErr) {
          console.error(`[Recovery Cron] Failed to re-dispatch job ${job.uuid}:`, dispatchErr.message);
          try {
            await dynamo.send(new UpdateCommand({
              TableName: USER_REQUEST_TABLE,
              Key: { uuid: job.uuid, user_email: job.user_email },
              UpdateExpression: "SET #s = :failed, error_message = :err, updated_at = :now",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":failed": "FAILED",
                ":err": `Failed to re-dispatch job: ${dispatchErr.message}`,
                ":now": getJakartaISOString()
              }
            }));
          } catch (dbErr) {
            console.error(`[Recovery Cron] Failed to mark job as FAILED:`, dbErr.message);
          }
        }
      }

      if (workflow) {
        // 2. Pick a Comfy API key
        let comfyApiKey = null;
        try {
          const redis = getRedis();
          const apiKeysString = await getComfyApiKeys();
          comfyApiKey = await pickComfyApiKey(apiKeysString, redis);
        } catch (redisErr) {
          console.error(`[Recovery Cron] Redis / API Key error:`, redisErr.message);
        }

        if (!comfyApiKey) {
          console.log(`[Recovery Cron] No ComfyUI API keys available. Will retry job ${job.uuid} next time.`);
        } else {
          // 3. Re-upload assets (Images and Audio)
          console.log(`[Recovery Cron] Active: Re-uploading assets for job ${job.uuid} to comfy.org`);
          try {
            // Re-upload User's Original Uploaded Images
            const userS3Keys = job.s3_keys || [];
            if (userS3Keys.length > 0) {
              for (let idx = 0; idx < userS3Keys.length; idx++) {
                const key = userS3Keys[idx];
                if (key && typeof key === "string" && key.trim()) {
                  const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
                  const signedUrl = await require("./services").getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
                  const filename = idx === 0 ? `${job.uuid}_ref.png` : `${job.uuid}_input_${idx}.png`;
                  const returnedName = await uploadInputImage(signedUrl, filename, comfyApiKey);
                  console.log(`[Recovery Cron] Uploaded user image ${key} as ${filename} -> ${returnedName}`);
                  
                  // Update Node 440 (main image loader) in videoGeneration workflow if it exists
                  if (idx === 0 && workflow["440"] && workflow["440"].inputs) {
                    workflow["440"].inputs.image = returnedName;
                  }
                }
              }
            }

            // Re-upload Talent Image
            if (job.generated_image_talent) {
              const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: job.generated_image_talent });
              const signedUrl = await require("./services").getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
              const returnedName = await uploadInputImage(signedUrl, `${job.uuid}_talent.png`, comfyApiKey);
              console.log(`[Recovery Cron] Uploaded talent image ${job.generated_image_talent} -> ${returnedName}`);
              
              if (workflow["441"] && workflow["441"].inputs) {
                workflow["441"].inputs.image = returnedName;
              }
            }

            // Re-upload Scene Images
            const genScenes = job.generated_scenes || [];
            for (const scene of genScenes) {
              let s3Key = scene.s3_key;
              if (!s3Key && userS3Keys[0]) {
                s3Key = userS3Keys[0];
              }
              if (s3Key) {
                const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: s3Key });
                const signedUrl = await require("./services").getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
                const filename = `${job.uuid}_scene_${scene.scene_id}.png`;
                const returnedName = await uploadInputImage(signedUrl, filename, comfyApiKey);
                console.log(`[Recovery Cron] Uploaded scene ${scene.scene_id} image as ${filename} -> ${returnedName}`);
                
                // Update Node 2000 + (scene_id - 1) in multi-scene workflow
                const nodeId = String(2000 + (scene.scene_id - 1));
                if (workflow[nodeId] && workflow[nodeId].inputs) {
                  workflow[nodeId].inputs.image = returnedName;
                  console.log(`[Recovery Cron] Updated Node ${nodeId} input image to: ${returnedName}`);
                }
              }
            }

            // Re-upload Audio
            if (job.audio) {
              const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: job.audio });
              const signedUrl = await require("./services").getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
              const returnedName = await uploadInputAudio(signedUrl, `${job.uuid}_tts.wav`, comfyApiKey);
              console.log(`[Recovery Cron] Uploaded audio ${job.audio} as ${job.uuid}_tts.wav -> ${returnedName}`);
              
              // Update Node 611 in workflow
              if (workflow["611"] && workflow["611"].inputs) {
                workflow["611"].inputs.audio = returnedName;
                console.log(`[Recovery Cron] Updated Node 611 input audio to: ${returnedName}`);
              }
            }
          } catch (assetErr) {
            console.error(`[Recovery Cron] Asset re-upload failed:`, assetErr);
            throw assetErr;
          }

          // 4. Submit to comfy.org
          try {
            console.log(`[Recovery Cron] Active: Resubmitting workflow to comfy.org for job ${job.uuid}...`);
            const promptId = await submitWorkflow(workflow, comfyApiKey);
            console.log(`[Recovery Cron] Resubmitted successfully. Prompt ID: ${promptId}`);

            const updates = ["#s = :status", "updated_at = :now", "used_api_key = :uak"];
            const exprValues = {
              ":status": "PROCESSING",
              ":now": getJakartaISOString(),
              ":uak": comfyApiKey
            };
            if (job.comfy_prompt_id !== undefined || job.request_type === "FREE-TRIAL" || job.request_type === "UGC-P" || job.request_type === "UGC-S") {
              updates.push("comfy_prompt_id = :pid");
              exprValues[":pid"] = promptId;
            } else {
              updates.push("image_prompt_id = :pid");
              exprValues[":pid"] = promptId;
            }

            await dynamo.send(new UpdateCommand({
              TableName: USER_REQUEST_TABLE,
              Key: { uuid: job.uuid, user_email: job.user_email },
              UpdateExpression: "SET " + updates.join(", "),
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: exprValues
            }));

            // 5. Delete workflow JSON from S3
            try {
              await s3Client.send(new DeleteObjectCommand({
                Bucket: S3_RESOURCE_BUCKET,
                Key: `workflow/${job.uuid}.json`
              }));
              console.log(`[Recovery Cron] Deleted workflow file from S3 for job ${job.uuid}`);
            } catch (delErr) {
              console.error(`[Recovery Cron] Failed to delete S3 workflow file:`, delErr.message);
            }

          } catch (subErr) {
            console.error(`[Recovery Cron] Resubmit workflow failed:`, subErr.message);
            // Decrement Redis since the resubmission failed
            if (comfyApiKey) {
              try {
                const redisKey = `comfyui_job_${comfyApiKey}`;
                await redis.decr(redisKey);
                console.log(`[Recovery Cron] [Redis] Decremented ${redisKey} due to resubmit failure`);
              } catch (rErr) {
                console.error("[Recovery Cron] [Redis] Error decrementing:", rErr.message);
              }
            }
            // If it fails with 420 again, keep it as FAILED_CONCCURENCY so next cron run can retry it
            if (subErr.statusCode !== 420) {
              // Update to FAILED
              await dynamo.send(new UpdateCommand({
                TableName: USER_REQUEST_TABLE,
                Key: { uuid: job.uuid, user_email: job.user_email },
                UpdateExpression: "SET #s = :failed, error_message = :err, updated_at = :now",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":failed": "FAILED",
                  ":err": subErr.message,
                  ":now": getJakartaISOString()
                }
              }));
              console.log(`[Recovery Cron] Set job ${job.uuid} to FAILED due to submission error`);
            } else {
              console.log(`[Recovery Cron] Job ${job.uuid} failed again with 420. Keeping as FAILED_CONCCURENCY.`);
            }
          }
        }
      }
    } else {
      console.log("[Recovery Cron] No FAILED_CONCCURENCY jobs found to process");
    }

    // B. Continue with standard hourly/pending checks
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
                         }
                      }));
                      console.log(`[Recovery Cron] Job ${job.uuid} was failed/cancelled on Comfy Cloud. Updated DynamoDB.`);
                      
                      // Release Redis counter if job fails/cancelled
                      if (apiKey) {
                        try {
                          const redisKey = `comfyui_job_${apiKey}`;
                          const redis = getRedis();
                          if (redis) {
                            await redis.decr(redisKey);
                            console.log(`[Recovery Cron] [Redis] Decremented ${redisKey} for failed/cancelled job ${job.uuid}`);
                          }
                        } catch (rErr) {
                          console.error("[Recovery Cron] [Redis] Error decrementing:", rErr.message);
                        }
                      }
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
