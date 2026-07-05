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
  const audioDuration = audio_duration;
  const aspectRatio = aspect_ratio;

  let usedApiKey = params.used_api_key;
  let redis = null;

  console.log(`[VideoGen] Triggering Seedance Video Generation for job ${jobId}...`);

  try {
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

    // 1. Resolve scenes
    const scenesToBuild = [];
    if (useProductThreeFrame) {
      scenesToBuild.push({
        url: imageResultUrl,
        filename: `${jobId}_reveal_start.png`,
        prompt: (llmResponse.image_generation && llmResponse.image_generation.reveal_start_frame) || params.prompt || "",
        duration: 4,
        talkvid: false
      });
      scenesToBuild.push({
        url: transitionFrameUrl,
        filename: `${jobId}_transition.png`,
        prompt: (llmResponse.image_generation && llmResponse.image_generation.transition_frame) || params.prompt || "",
        duration: 4,
        talkvid: false
      });
      scenesToBuild.push({
        url: productFrameUrl,
        filename: `${jobId}_hero.png`,
        prompt: (llmResponse.image_generation && llmResponse.image_generation.hero_frame) || params.prompt || "",
        duration: 4,
        talkvid: false
      });
    } else if (useUgcTwoFrame) {
      scenesToBuild.push({
        url: imageResultUrl,
        filename: `${jobId}_talent.png`,
        prompt: (llmResponse.image_generation && llmResponse.image_generation.talent_frame) || params.prompt || "",
        duration: 4,
        talkvid: true
      });
      scenesToBuild.push({
        url: productFrameUrl,
        filename: `${jobId}_product.png`,
        prompt: (llmResponse.image_generation && llmResponse.image_generation.product_frame) || params.prompt || "",
        duration: 4,
        talkvid: false
      });
    } else {
      scenesToBuild.push({
        url: imageResultUrl,
        filename: `${jobId}_single.png`,
        prompt: params.prompt || "",
        duration: Number(audioDuration || 4),
        talkvid: (llmResponse.scenes && llmResponse.scenes[0] && llmResponse.scenes[0].talkvid) || false
      });
    }

    // 2. Pick ComfyUI API Key
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
      throw err;
    }

    // 3. Upload scene images to ComfyUI Cloud
    const workflowScenes = [];
    for (const s of scenesToBuild) {
      console.log(`[VideoGen] Uploading image for scene: ${s.filename}...`);
      const returnedName = await uploadInputImage(s.url, s.filename, usedApiKey);
      workflowScenes.push({
        image: returnedName,
        prompt: s.prompt,
        duration: s.duration,
        talkvid: s.talkvid
      });
    }

    // 3.5. Upload TTS Audio if provided
    let comfyAudioName = null;
    if (audio) {
      comfyAudioName = `${jobId}_tts.wav`;
      console.log(`[VideoGen] Uploading TTS Audio to ComfyUI Cloud...`);
      const audioCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: audio });
      const audioSignedUrl = await getSignedUrl(s3, audioCmd, { expiresIn: 3600 });
      await uploadInputAudio(audioSignedUrl, comfyAudioName, usedApiKey);
    }

    // 4. Generate dynamic Seedance workflow
    const { buildSeedanceWorkflow } = require("../lib/generate-seedance-workflow");
    const videoWorkflow = buildSeedanceWorkflow(workflowScenes, {
      resolution: "720p", // hardcoded default
      aspectRatio: aspectRatio || "9:16", // default to 9:16
      audioFile: comfyAudioName
    });

    // 5. Submit Video Job to ComfyUI Cloud
    const { graphToApiPrompt } = require("../lib/comfy-graph-to-api-prompt");

    console.log("=========================================");
    console.log("[VideoGen] ORIGINAL DYNAMIC WORKFLOW GRAPH:");
    console.log(JSON.stringify(videoWorkflow, null, 2));
    console.log("=========================================");

    const apiPrompt = graphToApiPrompt(videoWorkflow);

    console.log("=========================================");
    console.log("[VideoGen] CONVERTED API PROMPT SENT TO COMFYUI:");
    console.log(JSON.stringify(apiPrompt, null, 2));
    console.log("=========================================");

    const videoPromptId = await submitWorkflow(apiPrompt, usedApiKey);
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
