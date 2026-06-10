"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { processFreeTrialJob } = require("./core/freeTrial");
const { s3Client, PutObjectCommand } = require("./services");
const { getJakartaISOString } = require("./utils");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const saveWorkflowAndFailConcurrency = async (jobId, userEmail, workflow, errorMsg) => {
  console.log(`[Worker] Concurrency limit exceeded for job ${jobId}. Handling FAILED_CONCCURENCY.`);
  if (workflow) {
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: `workflow/${jobId}.json`,
        Body: JSON.stringify(workflow),
        ContentType: "application/json"
      }));
      console.log(`[Worker] Saved failed workflow to S3: workflow/${jobId}.json`);
    } catch (s3Err) {
      console.error(`[Worker] Failed to save workflow to S3:`, s3Err.message);
    }
  }
  try {
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET #s = :s, error_message = :e, updated_at = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "FAILED_CONCCURENCY",
        ":e": errorMsg || "Concurrency limit exceeded",
        ":u": getJakartaISOString(),
      },
    }));
    console.log(`[Worker] Updated DynamoDB status to FAILED_CONCCURENCY for job ${jobId}`);
  } catch (dbErr) {
    console.error(`[Worker] Failed to update DynamoDB status to FAILED_CONCCURENCY:`, dbErr.message);
  }
};

exports.handler = async (event) => {
  const jobId = event.jobId;
  const userEmail = event.userEmail;
  console.log("[FreeTrialWorker] Start", { jobId, userEmail });

  try {
    await processFreeTrialJob({
      job: {
        uuid: jobId,
        user_email: userEmail,
        user_id: event.userId,
        prompt: event.prompt,
        request_type: "FREE-TRIAL",
        ugc_mode: event.ugc_mode || null,
        store_type: event.store_type || null,
        aspect_ratio: event.aspectRatio,
        video_quality: event.videoQuality,
        s3_keys: event.s3_keys || [],
      },
      s3: s3Client,
      dynamo,
      USER_REQUEST_TABLE,
      S3_RESOURCE_BUCKET,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, jobId }) };
  } catch (err) {
    console.error("[FreeTrialWorker] Error:", err);
    if (jobId && userEmail) {
      try {
        if (err.statusCode === 420) {
          await saveWorkflowAndFailConcurrency(jobId, userEmail, err.workflow, err.message);
        } else {
          await dynamo.send(
            new UpdateCommand({
              TableName: USER_REQUEST_TABLE,
              Key: { uuid: jobId, user_email: userEmail },
              UpdateExpression: "SET #s = :s, error_message = :e, updated_at = :u",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":s": "FAILED",
                ":e": err?.message || "FREE-TRIAL process failed",
                ":u": getJakartaISOString(),
              },
            })
          );
        }
      } catch (dErr) {
        console.error("[FreeTrialWorker] Dynamo update error:", dErr);
      }
    }
    throw err;
  }
};
