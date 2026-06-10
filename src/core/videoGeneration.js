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
    imageResultUrl, // first_frame: reveal_start (PRODUCT) or talent (UGC-P) or single image
    productFrameUrl, // last_frame: hero (PRODUCT) or product_frame (UGC-P)
    transitionFrameUrl, // mid_frame (PRODUCT 3-keyframe, optional)
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

  let usedApiKey = params.used_api_key;
  let redis = null;

  console.log(`[VideoGen] Triggering Video Generation for job ${jobId}...`);

  try {
    // 1. Predict filenames
    const comfyAudioName = (audioKey && typeof audioKey === "string" && audioKey !== "null" && audioKey !== "undefined" && audioKey.trim() !== "")
      ? `${jobId}_tts.wav`
      : null;

    const comfyImageName = `${jobId}_flux.png`;

    const ig = llmResponse.image_generation || {};
    const useProductThreeFrame =
      request_type === "PRODUCT" &&
      productFrameUrl &&
      transitionFrameUrl &&
      imageResultUrl &&
      (ig.hero_frame || ig.transition_frame || ig.reveal_start_frame);

    const useUgcTwoFrame =
      request_type === "UGC-P" &&
      productFrameUrl &&
      (ig.talent_frame || ig.product_frame);

    const workflowFile = useProductThreeFrame
      ? "product_only_camera_movement (API).json"
      : useUgcTwoFrame
        ? "ugc_talent_and_product (API).json"
        : "Generate UGC Video With Voice Clone (API).json";

    const workflowPath = path.join(__dirname, "..", "workflow", workflowFile);
    const videoWorkflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));

    const comfyHeroName = useProductThreeFrame ? `${jobId}_hero_frame.png` : null;
    const comfyTransitionName = useProductThreeFrame ? `${jobId}_transition_frame.png` : null;
    const comfyProductName = useUgcTwoFrame ? `${jobId}_product_frame.png` : null;

    // 2. Populate Workflow Nodes
    if (videoWorkflow["440"]) videoWorkflow["440"].inputs.image = comfyImageName;

    if (useProductThreeFrame && videoWorkflow["441"] && videoWorkflow["442"]) {
      videoWorkflow["441"].inputs.image = comfyHeroName;
      videoWorkflow["442"].inputs.image = comfyTransitionName;
    } else if (useUgcTwoFrame && videoWorkflow["441"]) {
      videoWorkflow["441"].inputs.image = comfyProductName;
    }
    
    if (videoWorkflow["611"] && comfyAudioName) {
      videoWorkflow["611"].inputs.audio = comfyAudioName;
    }
    
    if (videoWorkflow["614"]) {
      videoWorkflow["614"].inputs.value = llmResponse.ltx_prompt || params.prompt || "";
    }
    
    const randomSeed = Math.floor(Math.random() * 1000000000000000000);
    if (videoWorkflow["478:286"]) videoWorkflow["478:286"].inputs.noise_seed = randomSeed;
    
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
    
    if (videoWorkflow["478:331"]) videoWorkflow["478:331"].inputs.value = (parseFloat(audioDuration) || 10) + 0.5;

    // 3. Try to pick ComfyUI API Key right before upload/submit
    if (!usedApiKey) {
      const { pickComfyApiKey, getComfyApiKeys, getRedis } = require("../services");
      const apiKeysString = await getComfyApiKeys();
      redis = getRedis();
      usedApiKey = await pickComfyApiKey(apiKeysString, redis);
    }

    if (!usedApiKey) {
      console.log(`[VideoGen] All ComfyUI API keys are busy. Concurrency limit reached.`);
      const err = new Error("All ComfyUI API keys are busy (Concurrency Limit)");
      err.statusCode = 420;
      err.workflow = videoWorkflow;
      throw err;
    }

    // 4. Upload assets to ComfyUI Cloud using picked key
    // Upload Audio
    if (comfyAudioName) {
      console.log(`[VideoGen] Uploading TTS Audio to ComfyUI Cloud...`);
      const audioCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: audioKey });
      const audioSignedUrl = await getSignedUrl(s3, audioCmd, { expiresIn: 3600 });
      const returnedAudioName = await uploadInputAudio(audioSignedUrl, comfyAudioName, usedApiKey);
      if (videoWorkflow["611"] && videoWorkflow["611"].inputs) {
        videoWorkflow["611"].inputs.audio = returnedAudioName;
        console.log(`[VideoGen] Updated Node 611 input audio to: ${returnedAudioName}`);
      }
    }

    // Upload main image
    console.log(`[VideoGen] Uploading main image to ComfyUI Cloud...`);
    const returnedMainImageName = await uploadInputImage(imageResultUrl, comfyImageName, usedApiKey);
    if (videoWorkflow["440"] && videoWorkflow["440"].inputs) {
      videoWorkflow["440"].inputs.image = returnedMainImageName;
      console.log(`[VideoGen] Updated Node 440 input image to: ${returnedMainImageName}`);
    }

    // Upload other keyframes
    if (useProductThreeFrame) {
      console.log(`[VideoGen] Uploading hero/transition frames to ComfyUI Cloud...`);
      const returnedHeroName = await uploadInputImage(productFrameUrl, comfyHeroName, usedApiKey);
      const returnedTransitionName = await uploadInputImage(transitionFrameUrl, comfyTransitionName, usedApiKey);
      if (videoWorkflow["441"] && videoWorkflow["441"].inputs) {
        videoWorkflow["441"].inputs.image = returnedHeroName;
      }
      if (videoWorkflow["442"] && videoWorkflow["442"].inputs) {
        videoWorkflow["442"].inputs.image = returnedTransitionName;
      }
    } else if (useUgcTwoFrame) {
      console.log(`[VideoGen] Uploading product frame to ComfyUI Cloud...`);
      const returnedProductName = await uploadInputImage(productFrameUrl, comfyProductName, usedApiKey);
      if (videoWorkflow["441"] && videoWorkflow["441"].inputs) {
        videoWorkflow["441"].inputs.image = returnedProductName;
      }
    }

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
    if (usedApiKey && redis) {
      try {
        const redisKey = `comfyui_job_${usedApiKey}`;
        await redis.decr(redisKey);
        console.log(`[VideoGen] [Redis] Decremented ${redisKey} due to video gen failure`);
      } catch (rErr) {
        console.error("[VideoGen] [Redis] Error decrementing:", rErr.message);
      }
    }
    throw err;
  }
}

module.exports = {
  generateComfyUIVideo
};
