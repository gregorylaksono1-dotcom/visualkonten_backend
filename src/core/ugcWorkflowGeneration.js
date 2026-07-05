const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("../utils");
const { getSignedUrl, uploadInputImage, uploadInputAudio, submitWorkflow } = require("../services");


/**
 * Executes dynamic multi-scene video generation pipeline for UGC-P requests.
 */
async function generateMultiScenePipeline(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, llmResponse, finalJobPrompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, audio, audioDuration, requestType,
    existingJob
  } = params;

  console.log(`[MultiSceneGen] Starting dynamic multi-scene pipeline for job ${jobId}`);

  let comfyApiKey = params.comfyApiKey;
  let redis = null;

  try {
    let scenes = llmResponse.scenes || [];
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error("No scenes found in LLM response for UGC-P multi-scene generation.");
    }
    if (requestType === "FREE-TRIAL") {
      scenes = scenes.slice(0, 2);
    }

    // 1. Load existing talent image - Skip for FREE-TRIAL
    let generatedTalentImageUrl = null;
    let talentS3Key = null;

    if (requestType !== "FREE-TRIAL") {
      if (existingJob && existingJob.generated_image_talent) {
        talentS3Key = existingJob.generated_image_talent;
        const talentImgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: talentS3Key });
        generatedTalentImageUrl = await getSignedUrl(s3, talentImgCmd, { expiresIn: 3600 });
        console.log(`[MultiSceneGen] Reusing existing talent image: ${talentS3Key}`);
      } else {
        throw new Error("Missing generated talent image from preview stage.");
      }
    }

    // 2. Load existing scene images
    const generatedScenes = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneId = scene.scene_id || (i + 1);

      const existingScene = Array.isArray(existingJob?.generated_scenes)
        ? existingJob.generated_scenes.find(gs => gs.scene_id === sceneId)
        : null;

      if (!existingScene) {
        throw new Error(`Missing generated scene keyframe for Scene ${sceneId} from preview stage.`);
      }

      let sceneUrl = existingScene.url;
      if (existingScene.s3_key) {
        try {
          const imgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: existingScene.s3_key });
          sceneUrl = await getSignedUrl(s3, imgCmd, { expiresIn: 3600 });
        } catch (e) {
          console.error(`Error resigning for scene ${sceneId}`, e);
        }
      }

      generatedScenes.push({
        scene_id: sceneId,
        s3_key: existingScene.s3_key,
        url: sceneUrl
      });
    }

    // 4. Pick ComfyUI API Key right before uploading/submitting
    if (!comfyApiKey) {
      const { pickComfyApiKey, getComfyApiKeys, getRedis } = require("../services");
      const apiKeysString = await getComfyApiKeys();
      redis = getRedis();
      comfyApiKey = await pickComfyApiKey(apiKeysString, redis);
    }

    if (!comfyApiKey) {
      console.log(`[MultiSceneGen] All ComfyUI API keys are busy. Concurrency limit reached.`);
      const err = new Error("All ComfyUI API keys are busy (Concurrency Limit)");
      err.statusCode = 420;
      throw err;
    }

    // 5. Upload keyframe images for each scene and construct workflow scenes array
    const sceneImageFilenames = generatedScenes.map(gs => `${jobId}_scene_${gs.scene_id}.png`);
    const workflowScenes = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const gs = generatedScenes[i];
      const comfyImageName = sceneImageFilenames[i];
      console.log(`[MultiSceneGen] Uploading Scene ${gs.scene_id} image to ComfyUI Cloud...`);
      const returnedName = await uploadInputImage(gs.url, comfyImageName, comfyApiKey);

      workflowScenes.push({
        image: returnedName,
        prompt: scene.ltx_prompt || scene.prompt || "",
        duration: Number(scene.duration_seconds || 4),
        talkvid: scene.talkvid ?? false
      });
    }

    // 5.5. Upload TTS Audio if provided
    let comfyAudioName = null;
    if (audio) {
      comfyAudioName = `${jobId}_tts.wav`;
      console.log(`[MultiSceneGen] Uploading TTS Audio to ComfyUI Cloud...`);
      const audioCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: audio });
      const audioSignedUrl = await getSignedUrl(s3, audioCmd, { expiresIn: 3600 });
      await uploadInputAudio(audioSignedUrl, comfyAudioName, comfyApiKey);
    }

    // 6. Generate dynamic Seedance workflow
    const { buildSeedanceWorkflow } = require("../lib/generate-seedance-workflow");
    const workflow = buildSeedanceWorkflow(workflowScenes, {
      resolution: "720p", // default to 720p
      aspectRatio: aspectRatio || "9:16", // default to 9:16
      audioFile: comfyAudioName
    });

    // 7. Convert to API Prompt and Submit Video Job to ComfyUI Cloud
    const { graphToApiPrompt } = require("../lib/comfy-graph-to-api-prompt");

    console.log("=========================================");
    console.log("[MultiSceneGen] ORIGINAL DYNAMIC WORKFLOW GRAPH:");
    console.log(JSON.stringify(workflow, null, 2));
    console.log("=========================================");

    const apiPrompt = graphToApiPrompt(workflow);

    console.log("=========================================");
    console.log("[MultiSceneGen] CONVERTED API PROMPT SENT TO COMFYUI:");
    console.log(JSON.stringify(apiPrompt, null, 2));
    console.log("=========================================");

    console.log(`[MultiSceneGen] Submitting multi-scene workflow to ComfyUI Cloud...`);
    const videoPromptId = await submitWorkflow(apiPrompt, comfyApiKey);
    console.log(`[MultiSceneGen] Submitted successfully. Prompt ID: ${videoPromptId}`);

    // 8. Update status to PROCESSING and set comfy_prompt_id / used_api_key
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET comfy_prompt_id = :vp, #s = :status, used_api_key = :uak, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":vp": videoPromptId,
        ":status": "PROCESSING",
        ":uak": comfyApiKey || null,
        ":now": getJakartaISOString()
      }
    }));

    return videoPromptId;

  } catch (err) {
    console.error(`[MultiSceneGen] Error in multi-scene generation pipeline:`, err);
    if (comfyApiKey && redis) {
      try {
        const redisKey = `comfyui_job_${comfyApiKey}`;
        await redis.decr(redisKey);
        console.log(`[MultiSceneGen] [Redis] Decremented ${redisKey} due to pipeline failure`);
      } catch (rErr) {
        console.error("[MultiSceneGen] [Redis] Error decrementing:", rErr.message);
      }
    }
    throw err;
  }
}

module.exports = {
  generateMultiScenePipeline
};
