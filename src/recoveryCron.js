"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("./utils");
const { getKieAiKey, s3Client } = require("./services");
const { getKieTaskStatus, findMediaUrlInKieData } = require("./lib/kie-ai");
const { processKieAiCompletion } = require("./core/comfyuiHandler");
const fetch = require("node-fetch"); 

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const STATUS_INDEX = process.env.STATUS_CREATED_INDEX_NAME || "StatusCreatedIndex";
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const updateDynamoStatus = async (jobId, userEmail, status, { videoGenerationDuration, error_message, conditionExpression, conditionValues } = {}) => {
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

  const params = {
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: userEmail },
    UpdateExpression: "SET " + updates.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ...values, ...conditionValues },
  };

  if (conditionExpression) {
    params.ConditionExpression = conditionExpression;
  }

  try {
    await dynamo.send(new UpdateCommand(params));
    if (status === "FAILED" || status === "COMPLETED") {
      try {
        const { sendJobStatusNotification } = require("./lib/telegram");
        sendJobStatusNotification(jobId, status, { userEmail, error_message });
      } catch (teleErr) {
        console.error("[Telegram alert failed]", teleErr.message);
      }
    }
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log(`[Recovery Cron] Conditional check failed for job ${jobId}. Another process might have updated it.`);
      return false;
    }
    console.error("[Recovery Cron] Dynamo update error:", err.message);
    throw err;
  }
};

const sendSfnTaskSuccess = async (taskToken, resultUrl, isImage, s3Key, outputObj = {}) => {
  const { SFNClient, SendTaskSuccessCommand } = require("@aws-sdk/client-sfn");
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const sfnClient = new SFNClient({ region: REGION });

  console.log(`[Recovery Cron SFN Success] Downloading result from ${resultUrl}`);
  const res = await fetch(resultUrl);
  if (!res.ok) throw new Error(`Failed to download result: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  console.log(`[Recovery Cron SFN Success] Uploading to S3 bucket ${S3_RESOURCE_BUCKET}, key: ${s3Key}`);
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_RESOURCE_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: isImage ? "image/png" : "video/mp4"
  }));

  console.log(`[Recovery Cron SFN Success] Resuming Step Functions task token...`);
  await sfnClient.send(new SendTaskSuccessCommand({
    taskToken,
    output: JSON.stringify(outputObj)
  }));
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

    const allJobs = res.Items || [];
    
    // Filter jobs that are older than 30 minutes
    const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
    const jobs = allJobs.filter(job => {
      const updatedTime = Date.parse(job.updated_at || job.created_at || new Date().toISOString());
      return updatedTime < thirtyMinsAgo;
    });

    console.log(`[Recovery Cron] Found ${allJobs.length} total PROCESSING jobs, ${jobs.length} are older than 30 mins.`);

    for (const job of jobs) {
      try {
        // Optimistic Locking: Set to RECOVERING
        const locked = await updateDynamoStatus(job.uuid, job.user_email, "RECOVERING", {
           conditionExpression: "#s = :expectedStatus",
           conditionValues: { ":expectedStatus": "PROCESSING" }
        });

        if (!locked) continue; // Skip if another process took it

        if (job.sfn_execution_arn) {
          const { SFNClient, DescribeExecutionCommand } = require("@aws-sdk/client-sfn");
          const sfnClient = new SFNClient({ region: REGION });
          try {
            const desc = await sfnClient.send(new DescribeExecutionCommand({ executionArn: job.sfn_execution_arn }));
            if (["FAILED", "TIMED_OUT", "ABORTED"].includes(desc.status)) {
              console.log(`[Recovery Cron] Step Function execution ${desc.status} for job ${job.uuid}. Marking as FAILED.`);
              await updateDynamoStatus(job.uuid, job.user_email, "FAILED", {
                error_message: `Video generation workflow ${desc.status.toLowerCase()}.`
              });
              continue; 
            }
          } catch (sfnErr) {
            console.error(`[Recovery Cron] Failed to describe execution for job ${job.uuid}:`, sfnErr.message);
          }
        }

        // Case A: Multi-scene jobs
        if (Array.isArray(job.video_scenes) && job.video_scenes.length > 0) {
          console.log(`[Recovery Cron] Job ${job.uuid} has ${job.video_scenes.length} scenes. Checking unfinished ones...`);
          let sceneHandled = false;
          for (const sceneItem of job.video_scenes) {
            if (sceneItem.isFinish === true) continue;
            
            const sceneKey = Object.keys(sceneItem).find(k => k.startsWith("scene_"));
            if (!sceneKey) continue;
            
            const sceneId = sceneKey.split("_")[1];
            const taskId = sceneItem[sceneKey];
            
            console.log(`[Recovery Cron] Checking Scene ${sceneId} (Task ID: ${taskId}) for job ${job.uuid}`);
            const isVeo = job.request_type && String(job.request_type).toUpperCase() !== "CHASER_1";
            const resJson = await getKieTaskStatus(taskId, kieApiKey, isVeo);
            if (resJson.code === 200 && resJson.data) {
              const status = String(resJson.data.state || resJson.data.status || "").toLowerCase();
              if (status === "success" || status === "text_success") {
                const resultUrl = findMediaUrlInKieData(resJson.data);
                if (resultUrl) {
                  if (job.sfn_execution_arn && job.sfn_task_tokens?.[`video_${sceneId}`]) {
                     const taskToken = job.sfn_task_tokens[`video_${sceneId}`];
                     const userId = job.user_id || "anonymous";
                     const s3Key = `generated_videos/${userId}/scenes/${job.uuid}_scene_${sceneId}.mp4`;
                     
                     await sendSfnTaskSuccess(taskToken, resultUrl, false, s3Key, { s3key: s3Key, id: String(sceneId) });
                     await updateDynamoStatus(job.uuid, job.user_email, "PROCESSING");
                     sceneHandled = true;
                     break;
                  } else {
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
                     await updateDynamoStatus(job.uuid, job.user_email, "PROCESSING");
                     sceneHandled = true;
                     break;
                  }
                }
              } else if (status === "fail" || status === "create_task_failed" || status === "generate_failed") {
                if (job.sfn_execution_arn) {
                  const sceneTokenKey = `video_${sceneId}`;
                  const taskToken = job.sfn_task_tokens?.[sceneTokenKey];
                  if (taskToken) {
                    console.log(`[Recovery Cron] Step Functions job detected. Failing task token for ${sceneTokenKey}...`);
                    const { SFNClient, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");
                    const sfnClient = new SFNClient({ region: REGION });
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
                    sceneHandled = true;
                    break;
                  }
                }
                await updateDynamoStatus(job.uuid, job.user_email, "FAILED", {
                  error_message: resJson.data.msg || `Kie.ai generation failed for scene ${sceneId}`
                });
                sceneHandled = true;
                break; 
              }
            }
          }
          if (!sceneHandled) {
             await updateDynamoStatus(job.uuid, job.user_email, "PROCESSING");
          }
          continue;
        }

        // Case B: Standard Single Image/Video job
        const taskId = job.comfy_prompt_id || job.image_prompt_id;
        if (!taskId) {
           await updateDynamoStatus(job.uuid, job.user_email, "PROCESSING");
           continue;
        }

        console.log(`[Recovery Cron] Checking single task ${taskId} for job ${job.uuid}...`);
        const isVeo = Boolean(job.comfy_prompt_id) && String(job.request_type || "").toUpperCase() !== "CHASER_1";
        const resJson = await getKieTaskStatus(taskId, kieApiKey, isVeo);

        let taskHandled = false;
        if (resJson.code === 200 && resJson.data) {
          const status = String(resJson.data.state || resJson.data.status || "").toLowerCase();
          console.log(`[Recovery Cron] Task ${taskId} status: ${status}`);

          if (status === "success" || status === "text_success") {
            const resultUrl = findMediaUrlInKieData(resJson.data);
            if (resultUrl) {
              const mediaType = job.comfy_prompt_id ? "videos" : "images";
              const isVideo = ["videos", "video", "gifs"].includes(mediaType) || resultUrl.toLowerCase().includes('.mp4') || resultUrl.toLowerCase().includes('.webm');
              const userId = job.user_id || "anonymous";
              
              if (job.sfn_execution_arn && job.sfn_task_tokens?.[`video_1`]) { // usually scene 1 for single video
                 const sceneId = 1;
                 const taskToken = job.sfn_task_tokens[`video_1`];
                 const s3Key = `generated_videos/${userId}/scenes/${job.uuid}_scene_${sceneId}.mp4`;
                 
                 await sendSfnTaskSuccess(taskToken, resultUrl, !isVideo, s3Key, { s3key: s3Key, id: String(sceneId) });
                 await updateDynamoStatus(job.uuid, job.user_email, "PROCESSING");
                 console.log(`[Recovery Cron] Successfully recovered SFN job ${job.uuid}`);
                 taskHandled = true;
              } else {
                 await processKieAiCompletion({
                   taskId,
                   resultUrl,
                   mediaType,
                   dynamo,
                   s3: s3Client,
                   USER_REQUEST_TABLE,
                   S3_RESOURCE_BUCKET
                 });
                 if (!isVideo) await updateDynamoStatus(job.uuid, job.user_email, "PROCESSING");
                 console.log(`[Recovery Cron] Successfully recovered completed job ${job.uuid}`);
                 taskHandled = true;
              }
            }
          } else if (status === "fail" || status === "create_task_failed" || status === "generate_failed") {
            if (job.request_type === "MOTION_CONTROL") {
              const { handleMotionControlFailure } = require("./prompt/motionControl");
              const retried = await handleMotionControlFailure(job, resJson.data?.msg || "Kie.ai generation failed", dynamo, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET);
              if (retried) {
                console.log(`[Recovery Cron] Job ${job.uuid} failed. Triggered retry.`);
                taskHandled = true;
              }
            }

            if (!taskHandled) {
                const videoGenStart = job.video_gen_start_at || job.created_at;
                let videoGenerationDuration = null;
                if (videoGenStart) {
                  videoGenerationDuration = Math.round((Date.now() - Date.parse(videoGenStart)) / 1000);
                }
                
                if (job.sfn_execution_arn && job.sfn_task_tokens?.[`video_1`]) {
                    const { SFNClient, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");
                    const sfnClient = new SFNClient({ region: REGION });
                    try {
                      await sfnClient.send(new SendTaskFailureCommand({
                        taskToken: job.sfn_task_tokens[`video_1`],
                        error: "KieAiGenerationFailed",
                        cause: resJson.data?.msg || "Kie.ai generation failed"
                      }));
                    } catch (sfnErr) {
                      console.error(`[Recovery Cron] Failed to send task failure command:`, sfnErr.message);
                    }
                }
                
                await updateDynamoStatus(job.uuid, job.user_email, "FAILED", {
                  videoGenerationDuration,
                  error_message: resJson.data.msg || "Kie.ai generation failed"
                });
                console.log(`[Recovery Cron] Job ${job.uuid} failed on Kie.ai. Marked as FAILED.`);
                taskHandled = true;
            }
          }
        }
        
        if (!taskHandled) {
            await updateDynamoStatus(job.uuid, job.user_email, "PROCESSING");
        }
      } catch (jobErr) {
        console.error(`[Recovery Cron] Error processing job ${job.uuid}:`, jobErr.message);
        try {
            await updateDynamoStatus(job.uuid, job.user_email, "PROCESSING");
        } catch (revertErr) {
            console.error(`[Recovery Cron] Error reverting lock for job ${job.uuid}:`, revertErr.message);
        }
      }
    }

    // 2. Fetch recent FAILED jobs for automatic Redrive
    try {
      const { SFNClient, DescribeExecutionCommand, RedriveExecutionCommand } = require("@aws-sdk/client-sfn");
      const sfnClient = new SFNClient({ region: REGION });
      const oneDayAgo = getJakartaISOString(new Date(Date.now() - 24 * 60 * 60 * 1000));
      
      const failedRes = await dynamo.send(new QueryCommand({
        TableName: USER_REQUEST_TABLE,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: "#s = :s AND created_at >= :recent",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "FAILED", ":recent": oneDayAgo },
      }));
      
      const failedJobs = failedRes.Items || [];
      if (failedJobs.length > 0) {
        console.log(`[Recovery Cron] Found ${failedJobs.length} jobs in FAILED state (recent 24h).`);
      }
      
      for (const fJob of failedJobs) {
        if (!fJob.sfn_execution_arn) continue;
        
        try {
          const desc = await sfnClient.send(new DescribeExecutionCommand({
            executionArn: fJob.sfn_execution_arn
          }));
          
          if (desc.redriveStatus === "REDRIVABLE" && (desc.redriveCount || 0) < 2) {
            console.log(`[Recovery Cron] Triggering Redrive for job ${fJob.uuid} (Execution: ${fJob.sfn_execution_arn})`);
            await sfnClient.send(new RedriveExecutionCommand({
              executionArn: fJob.sfn_execution_arn
            }));
            
            await updateDynamoStatus(fJob.uuid, fJob.user_email, "PROCESSING", {
              error_message: `Auto-redriving execution (attempt ${(desc.redriveCount || 0) + 1})...`
            });
          }
        } catch (fErr) {
          console.error(`[Recovery Cron] Failed to check/redrive job ${fJob.uuid}:`, fErr.message);
        }
      }
    } catch (failedQueryErr) {
      console.error("[Recovery Cron] Error querying FAILED jobs:", failedQueryErr.message);
    }

    console.log("[Recovery Cron] Finished successfully");
    return { statusCode: 200, body: "Success" };
  } catch (err) {
    console.error("[Recovery Cron] Fatal Error:", err);
    return { statusCode: 500, body: err.message };
  }
};
