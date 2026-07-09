"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("./utils");
const { getKieAiKey, s3Client } = require("./services");
const { getKieTaskStatus, findMediaUrlInKieData } = require("./lib/kie-ai");
const { processKieAiCompletion } = require("./core/comfyuiHandler");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const STATUS_INDEX = process.env.STATUS_CREATED_INDEX_NAME || "StatusCreatedIndex";
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const updateDynamoStatus = async (jobId, userEmail, status, { videoGenerationDuration, error_message } = {}) => {
  const updates = ["#s = :s", "updated_at = :u"];
  const names = { "#s": "status" };
  const values = { ":s": status, ":u": getJakartaISOString() };

  if (videoGenerationDuration !== undefined && videoGenerationDuration !== null) {
    updates.push("video_generation_duration = :vgd");
    values[":vgd"] = videoGenerationDuration;
  }
  if (error_message !== undefined && error_message !== null) {
    updates.push("error_message = :err");
    values[":err"] = error_message;
  }

  try {
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET " + updates.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    if (status === "FAILED" || status === "COMPLETED") {
      try {
        const { sendJobStatusNotification } = require("./lib/telegram");
        sendJobStatusNotification(jobId, status, { userEmail, error_message });
      } catch (teleErr) {
        console.error("[Telegram alert failed]", teleErr.message);
      }
    }
  } catch (err) {
    console.error("[Recovery Cron] Dynamo update error:", err.message);
  }
};

exports.handler = async (event) => {
  console.log("[Recovery Cron] Started Kie.ai stalled jobs check");
  try {
    const kieApiKey = await getKieAiKey();
    if (!kieApiKey) {
      console.error("[Recovery Cron] Kie.ai API Key not found. Aborting.");
      return { statusCode: 500, body: "Kie.ai API Key not found" };
    }

    // 1. Fetch all PROCESSING jobs
    const res = await dynamo.send(new QueryCommand({
      TableName: USER_REQUEST_TABLE,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: "#s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "PROCESSING" },
    }));

    const jobs = res.Items || [];
    console.log(`[Recovery Cron] Found ${jobs.length} jobs in PROCESSING state.`);

    for (const job of jobs) {
      try {
        // Case A: Multi-scene jobs
        if (Array.isArray(job.video_scenes) && job.video_scenes.length > 0) {
          console.log(`[Recovery Cron] Job ${job.uuid} has ${job.video_scenes.length} scenes. Checking unfinished ones...`);
          for (const sceneItem of job.video_scenes) {
            if (sceneItem.isFinish === true) continue;
            
            // Find the taskId
            const sceneKey = Object.keys(sceneItem).find(k => k.startsWith("scene_"));
            if (!sceneKey) continue;
            
            const sceneId = sceneKey.split("_")[1];
            const taskId = sceneItem[sceneKey];
            
            console.log(`[Recovery Cron] Checking Scene ${sceneId} (Task ID: ${taskId}) for job ${job.uuid}`);
            const resJson = await getKieTaskStatus(taskId, kieApiKey);
            if (resJson.code === 200 && resJson.data) {
              const status = String(resJson.data.state || resJson.data.status || "").toLowerCase();
              if (status === "success" || status === "text_success") {
                const resultUrl = findMediaUrlInKieData(resJson.data);
                if (resultUrl) {
                  await processKieAiCompletion({
                    taskId,
                    resultUrl,
                    mediaType: "videos",
                    dynamo,
                    s3: s3Client,
                    USER_REQUEST_TABLE,
                    S3_RESOURCE_BUCKET,
                    queryStringParameters: { jobId: job.uuid, userEmail: job.user_email, sceneId }
                  });
                }
              } else if (status === "fail" || status === "create_task_failed" || status === "generate_failed") {
                if (job.sfn_execution_arn) {
                  const sceneTokenKey = `video_${sceneId}`;
                  const taskToken = job.sfn_task_tokens?.[sceneTokenKey];
                  if (taskToken) {
                    console.log(`[Recovery Cron] Step Functions job detected. Failing task token for ${sceneTokenKey}...`);
                    const { SFNClient, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");
                    const sfnClient = new SFNClient({ region: process.env.AWS_REGION || "ap-southeast-1" });
                    try {
                      await sfnClient.send(new SendTaskFailureCommand({
                        taskToken,
                        error: "KieAiGenerationFailed",
                        cause: resJson.data?.msg || `Kie.ai generation failed for scene ${sceneId}`
                      }));
                    } catch (sfnErr) {
                      console.error(`[Recovery Cron] Failed to send task failure command:`, sfnErr.message);
                    }

                    await updateDynamoStatus(job.uuid, job.user_email, "RETRYING (video)", {
                      error_message: resJson.data?.msg || `Kie.ai generation failed for scene ${sceneId}`
                    });
                    break;
                  }
                }

                await updateDynamoStatus(job.uuid, job.user_email, "FAILED", {
                  error_message: resJson.data.msg || `Kie.ai generation failed for scene ${sceneId}`
                });
                break; // Stop checking other scenes
              }
            }
          }
          continue;
        }

        // Case B: Standard Single Image/Video job
        const taskId = job.comfy_prompt_id || job.image_prompt_id;
        if (!taskId) continue;

        console.log(`[Recovery Cron] Checking single task ${taskId} for job ${job.uuid}...`);
        const resJson = await getKieTaskStatus(taskId, kieApiKey);

        if (resJson.code === 200 && resJson.data) {
          const status = String(resJson.data.state || resJson.data.status || "").toLowerCase();
          console.log(`[Recovery Cron] Task ${taskId} status: ${status}`);

          if (status === "success" || status === "text_success") {
            const resultUrl = findMediaUrlInKieData(resJson.data);
            if (resultUrl) {
              const mediaType = job.comfy_prompt_id ? "videos" : "images";
              await processKieAiCompletion({
                taskId,
                resultUrl,
                mediaType,
                dynamo,
                s3: s3Client,
                USER_REQUEST_TABLE,
                S3_RESOURCE_BUCKET
              });
              console.log(`[Recovery Cron] Successfully recovered completed job ${job.uuid}`);
            }
          } else if (status === "fail" || status === "create_task_failed" || status === "generate_failed") {
            if (job.request_type === "MOTION_CONTROL") {
              const { handleMotionControlFailure } = require("./prompt/motionControl");
              const retried = await handleMotionControlFailure(job, resJson.data?.msg || "Kie.ai generation failed", dynamo, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET);
              if (retried) {
                console.log(`[Recovery Cron] Job ${job.uuid} failed. Triggered retry.`);
                continue;
              }
            }

            const videoGenStart = job.video_gen_start_at || job.created_at;
            let videoGenerationDuration = null;
            if (videoGenStart) {
              videoGenerationDuration = Math.round((Date.now() - Date.parse(videoGenStart)) / 1000);
            }
            await updateDynamoStatus(job.uuid, job.user_email, "FAILED", {
              videoGenerationDuration,
              error_message: resJson.data.msg || "Kie.ai generation failed"
        });
            console.log(`[Recovery Cron] Job ${job.uuid} failed on Kie.ai. Marked as FAILED.`);
          }
        }
      } catch (jobErr) {
        console.error(`[Recovery Cron] Error processing job ${job.uuid}:`, jobErr.message);
      }
    }

    console.log("[Recovery Cron] Finished successfully");
    return { statusCode: 200, body: "Success" };
  } catch (err) {
    console.error("[Recovery Cron] Fatal Error:", err);
    return { statusCode: 500, body: err.message };
  }
};
