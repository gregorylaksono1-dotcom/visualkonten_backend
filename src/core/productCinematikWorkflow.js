"use strict";

const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("../utils");
const { getSignedUrl } = require("../services");
const { generateComfyUIVideo } = require("./videoGeneration");

/**
 * Executes Product Cinematic video generation pipeline.
 * Triggers video generation tasks for ALL scenes in parallel using Kie.ai.
 */
async function generateProductCinematicPipeline(params) {
  const {
    jobId, userEmail, userId, llmResponse, finalJobPrompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, requestType,
    existingJob
  } = params;

  console.log(`[ProductCinematic] Starting Product Cinematic pipeline for job ${jobId}`);

  try {
    const scenes = llmResponse.scene || llmResponse.scenes || [];
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error("No scenes found in LLM response for Product Cinematic generation.");
    }

    // 1. Resolve keyframe image URLs for each scene from preview stage
    const sceneInputs = [];
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

      // talkvid is false for product cinematic scenes unless explicitly set to true
      const talkvid = scene.talkvid === true;

      sceneInputs.push({
        sceneId,
        url: sceneUrl,
        prompt: scene.ltx_prompt || scene.prompt || finalJobPrompt,
        talkvid
      });
    }

    // 2. Submit all video tasks to Kie.ai in parallel
    console.log(`[ProductCinematic] Submitting ${sceneInputs.length} scenes to Kie.ai in parallel...`);
    const submissionPromises = sceneInputs.map(sceneInput => {
      return generateComfyUIVideo({
        uuid: jobId,
        user_email: userEmail,
        user_id: userId,
        request_type: requestType,
        llm_response: llmResponse,
        video_quality: videoQuality,
        aspect_ratio: aspectRatio,
        imageResultUrl: sceneInput.url,
        dynamo,
        s3,
        USER_REQUEST_TABLE,
        S3_RESOURCE_BUCKET,
        prompt: sceneInput.prompt,
        sceneId: sceneInput.sceneId,
        talkvid: sceneInput.talkvid
      });
    });

    const taskIds = await Promise.all(submissionPromises);
    console.log(`[ProductCinematic] Successfully submitted all scenes. Task IDs: ${taskIds.join(", ")}`);

    // 3. Build video_scenes array
    const videoScenes = taskIds.map((taskId, i) => {
      const sceneKey = `scene_${sceneInputs[i].sceneId}`;
      return {
        [sceneKey]: taskId,
        isFinish: false
      };
    });

    // 4. Update DynamoDB status to PROCESSING and save video_scenes
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET video_scenes = :vs, comfy_prompt_id = :cp, #s = :status, updated_at = :now, video_gen_start_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":vs": videoScenes,
        ":cp": taskIds[0], // Store first taskId in comfy_prompt_id for backward compatibility
        ":status": "PROCESSING",
        ":now": getJakartaISOString()
      }
    }));

    console.log(`[ProductCinematic] Successfully updated DynamoDB for job ${jobId}`);
    return taskIds[0];

  } catch (err) {
    console.error(`[ProductCinematic] Error in Product Cinematic pipeline:`, err);
    throw err;
  }
}

module.exports = {
  generateProductCinematicPipeline
};
