const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

function addWavHeader(pcmBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);

  // RIFF identifier
  header.write("RIFF", 0);
  // File length
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  // RIFF type
  header.write("WAVE", 8);
  // format chunk identifier
  header.write("fmt ", 12);
  // format chunk length
  header.writeUInt32LE(16, 16);
  // sample format (1 is PCM)
  header.writeUInt16LE(1, 20);
  // channel count
  header.writeUInt16LE(numChannels, 22);
  // sample rate
  header.writeUInt32LE(sampleRate, 24);
  // byte rate (sample rate * block align)
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  // block align (channel count * bytes per sample)
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  // bits per sample
  header.writeUInt16LE(bitsPerSample, 34);
  // data chunk identifier
  header.write("data", 36);
  // data chunk length
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function generateTTS(params) {
  const {
    jobId, userEmail, userId, llmResponse,
    S3_RESOURCE_BUCKET, dynamo, USER_REQUEST_TABLE,
    callGeminiAudio, uploadToS3
  } = params;

  try {
    const audioBase64 = await callGeminiAudio(llmResponse.tts_script, llmResponse.tts_global_config);
    if (audioBase64) {
      const pcmBuffer = Buffer.from(audioBase64, "base64");
      
      // Calculate duration in seconds
      // Formula: bytes / (sampleRate * channels * bytesPerSample)
      // For 24000Hz, Mono, 16-bit: bytes / (24000 * 1 * 2) = bytes / 48000
      const duration = pcmBuffer.length / 48000;
      console.log(`[Worker] Audio duration: ${duration.toFixed(2)} seconds`);

      // Gemini 3.1 Flash TTS returns raw PCM (16-bit, 24kHz, Mono)
      // We need to add a WAV header to make it playable.
      const audioBuffer = addWavHeader(pcmBuffer, 24000);
      
      const userIdForS3 = userId || "anonymous";
      const audioS3Key = `audio/${userIdForS3}/${jobId}.wav`;
      
      await uploadToS3(S3_RESOURCE_BUCKET, audioS3Key, audioBuffer, "audio/wav");
      console.log(`[Worker] Saved generated audio to S3 (with WAV header): ${audioS3Key}`);

      // Update DynamoDB with audio key and duration
      await dynamo.send(new UpdateCommand({
        TableName: USER_REQUEST_TABLE,
        Key: { uuid: jobId, user_email: userEmail },
        UpdateExpression: "SET audio = :audio, audio_duration = :duration, updated_at = :now",
        ExpressionAttributeValues: { 
          ":audio": audioS3Key, 
          ":duration": duration,
          ":now": new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }) 
        }
      }));
    }
  } catch (ttsErr) {
    console.error("[Worker] TTS processing error:", ttsErr);
  }
}

module.exports = {
  generateTTS
};
