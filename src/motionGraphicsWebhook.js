"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = require("@aws-sdk/client-sfn");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const sfnClient = new SFNClient({});

const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;

exports.handler = async (event) => {
  console.log("[MotionGraphicsWebhook] Received webhook event:", JSON.stringify(event, null, 2));
  
  try {
    let body = event.body;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }
    
    // Remotion lambda webhook format
    const { type, renderId, bucketName, outKey, customData, errors } = body;
    
    if (type === "success") {
      const { jobId, userEmail, taskToken } = customData || {};
      if (!jobId || !userEmail) {
        console.warn("[MotionGraphicsWebhook] No jobId or userEmail found in customData.");
        return { statusCode: 200, body: "OK" };
      }
      
      const result_url = `https://${bucketName}.s3.${process.env.AWS_REGION || "ap-southeast-1"}.amazonaws.com/${outKey}`;
      
      console.log(`[MotionGraphicsWebhook] Sending success to SFN for job ${jobId}`);
      
      if (taskToken) {
         try {
           await sfnClient.send(new SendTaskSuccessCommand({
             taskToken,
             output: JSON.stringify({
               Payload: {
                 result_url,
                 completedAt: new Date().toISOString()
               }
             })
           }));
         } catch (sfnErr) {
           console.error("[MotionGraphicsWebhook] Error sending SendTaskSuccess:", sfnErr);
         }
      }
      
      return { statusCode: 200, body: "Webhook processed successfully" };
      
    } else if (type === "error" || type === "timeout") {
      const { jobId, userEmail, taskToken } = customData || {};
      if (jobId && userEmail) {
        console.error(`[MotionGraphicsWebhook] Render failed for job ${jobId}. Errors:`, errors);
        
        if (taskToken) {
           try {
             await sfnClient.send(new SendTaskFailureCommand({
               taskToken,
               error: "RemotionRenderFailed",
               cause: JSON.stringify(errors)
             }));
           } catch (sfnErr) {
             console.error("[MotionGraphicsWebhook] Error sending SendTaskFailure:", sfnErr);
           }
        } else {
           // Fallback to DynamoDB update if no task token
           await docClient.send(new UpdateCommand({
             TableName: USER_REQUEST_TABLE,
             Key: { uuid: jobId, user_email: userEmail },
             UpdateExpression: "SET #s = :status, error_message = :err, updated_at = :now",
             ExpressionAttributeNames: { "#s": "status" },
             ExpressionAttributeValues: {
               ":status": "FAILED",
               ":err": `Motion graphics render failed: ${JSON.stringify(errors)}`,
               ":now": new Date().toISOString()
             }
           }));
        }
      }
      return { statusCode: 200, body: "Webhook error processed" };
    }
    
    return { statusCode: 200, body: "Ignored event type" };
    
  } catch (error) {
    console.error("[MotionGraphicsWebhook] Error processing webhook:", error);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};
