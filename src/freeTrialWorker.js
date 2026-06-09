"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { processFreeTrialJob } = require("./core/freeTrial");
const { s3Client } = require("./services");
const { getJakartaISOString } = require("./utils");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

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
      } catch (dErr) {
        console.error("[FreeTrialWorker] Dynamo update error:", dErr);
      }
    }
    throw err;
  }
};
