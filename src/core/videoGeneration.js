const fs = require("fs");
const path = require("path");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { 
  uploadInputImage, 
  uploadInputAudio, 
  submitWorkflow, 
  getSignedUrl 
} = require("../services");
const { getJakartaISOString } = require("../utils");

/**
 * Triggers the ComfyUI Video Generation workflow (LTX-2.3)
 * using a previously generated image and TTS audio.
 */
async function generateComfyUIVideo(params) {
  const {
    uuid, user_email, user_id, request_type,
    llm_response, audio, audio_duration,
    video_quality, aspect_ratio,
    imageResultUrl, // first_frame / talent (or single image)
    productFrameUrl, // last_frame for UGC-P 2-keyframe (optional)
    used_api_key,
    dynamo, s3, USER_REQUEST_TABLE, S3_RESOURCE_BUCKET
  } = params;

  const jobId = uuid;
  const userEmail = user_email;
  const userId = user_id;
  const llmResponse = llm_response || {};
  const audioKey = audio;
  const audioDuration = audio_duration;
  const videoQuality = video_quality;
  const aspectRatio = aspect_ratio;
  const usedApiKey = used_api_key;

  console.log(`[VideoGen] Triggering Video Generation for job ${jobId}...`);

  try {
    // 1. Get Signed URL for Audio (since ComfyUI needs to download it)
    const audioCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: audioKey });
    const audioSignedUrl = await getSignedUrl(s3, audioCmd, { expiresIn: 3600 });

    // 2. Upload to ComfyUI Cloud (ComfyUI prefers filenames of uploaded files)
    const comfyImageName = await uploadInputImage(imageResultUrl, `${jobId}_flux.png`, usedApiKey);
    const comfyAudioName = await uploadInputAudio(audioSignedUrl, `${jobId}_tts.wav`, usedApiKey);

    // 3. Load Video Workflow JSON
    const useTwoFrame =
      request_type === "UGC-P" &&
      productFrameUrl &&
      (llmResponse.image_generation?.talent_frame || llmResponse.image_generation?.product_frame);

    const workflowFile = useTwoFrame
      ? "ugc_talent_and_product (API).json"
      : "Generate UGC Video With Voice Clone (API).json";

    const workflowPath = path.join(__dirname, "..", "workflow", workflowFile);
    const videoWorkflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));

    // 4. Populate Workflow Nodes
    
    // Node 440: first_frame (talent or single image)
    if (videoWorkflow["440"]) videoWorkflow["440"].inputs.image = comfyImageName;

    if (useTwoFrame && videoWorkflow["441"]) {
      const comfyProductName = await uploadInputImage(
        productFrameUrl,
        `${jobId}_product_frame.png`,
        usedApiKey
      );
      videoWorkflow["441"].inputs.image = comfyProductName;
      console.log(`[VideoGen] 2-frame UGC-P: 440=${comfyImageName}, 441=${comfyProductName}`);
    }
    
    // Node 611: Load Audio
    if (videoWorkflow["611"]) videoWorkflow["611"].inputs.audio = comfyAudioName;
    
    // Node 614: Prompt (Multimodal LTX prompt)
    if (videoWorkflow["614"]) {
      videoWorkflow["614"].inputs.value = llmResponse.ltx_prompt || params.prompt || "";
    }
    
    // Node 478:286: Noise Seed
    const randomSeed = Math.floor(Math.random() * 1000000000000000000);
    if (videoWorkflow["478:286"]) videoWorkflow["478:286"].inputs.noise_seed = randomSeed;
    
    // Width & Height (Nodes 478:330 and 478:324)
    let w = 720, h = 1280; // default to 720p 9:16
    if (videoQuality === "1080p") {
      if (aspectRatio === "16:9") { w = 1920; h = 1080; }
      else if (aspectRatio === "1:1") { w = 1080; h = 1080; }
      else { w = 1080; h = 1920; } // 9:16
    } else {
      if (aspectRatio === "16:9") { w = 1280; h = 720; }
      else if (aspectRatio === "1:1") { w = 720; h = 720; }
      else { w = 720; h = 1280; } // 9:16
    }
    if (videoWorkflow["478:330"]) videoWorkflow["478:330"].inputs.value = w;
    if (videoWorkflow["478:324"]) videoWorkflow["478:324"].inputs.value = h;
    
    // Node 478:331: Duration (audio length + padding)
    if (videoWorkflow["478:331"]) videoWorkflow["478:331"].inputs.value = (parseFloat(audioDuration) || 10) + 0.5;

    // 5. Submit Video Job to ComfyUI Cloud
    const videoPromptId = await submitWorkflow(videoWorkflow, usedApiKey);
    console.log(`[VideoGen] Video job submitted successfully: ${videoPromptId}`);

    // 6. Update DynamoDB with the new Video Prompt ID
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET comfy_prompt_id = :vp, #s = :status, used_api_key = :uak, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { 
        ":vp": videoPromptId,
        ":status": "PROCESSING",
        ":uak": usedApiKey || null,
        ":now": getJakartaISOString() 
      }
    }));

    return videoPromptId;

  } catch (err) {
    console.error(`[VideoGen] Error triggering video for job ${jobId}:`, err);
    throw err;
  }
}

module.exports = {
  generateComfyUIVideo
};
