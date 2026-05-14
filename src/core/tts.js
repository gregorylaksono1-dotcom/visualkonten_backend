const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

async function generateTTS(params) {
  const {
    jobId, userEmail, userId, llmResponse,
    S3_RESOURCE_BUCKET, dynamo, USER_REQUEST_TABLE,
    callGeminiAudio, uploadToS3
  } = params;

  try {
    const audioBase64 = await callGeminiAudio(llmResponse.tts_script, llmResponse.tts_global_config);
    if (audioBase64) {
      const audioBuffer = Buffer.from(audioBase64, "base64");
      const userIdForS3 = userId || "anonymous";
      const audioS3Key = `audio/${userIdForS3}/${jobId}.wav`;
      
      await uploadToS3(S3_RESOURCE_BUCKET, audioS3Key, audioBuffer, "audio/wav");
      console.log(`[Worker] Saved generated audio to S3: ${audioS3Key}`);

      // Update DynamoDB with audio key
      await dynamo.send(new UpdateCommand({
        TableName: USER_REQUEST_TABLE,
        Key: { uuid: jobId, user_email: userEmail },
        UpdateExpression: "SET audio = :audio, updated_at = :now",
        ExpressionAttributeValues: { ":audio": audioS3Key, ":now": new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }) }
      }));
    }
  } catch (ttsErr) {
    console.error("[Worker] TTS processing error:", ttsErr);
  }
}

module.exports = {
  generateTTS
};
