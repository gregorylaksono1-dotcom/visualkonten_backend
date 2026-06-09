const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");
const { getJakartaISOString } = require("../utils");
const { getOpenAiKey, getSignedUrl, uploadInputImage, uploadInputAudio, submitWorkflow } = require("../services");
const { callOpenAIImageEdit } = require("./imageGenerationOpenAI");
const {
  buildMultiSceneWorkflow,
  applyWorkflowAssetFilenames,
  applySceneNegativePrompts,
} = require("../lib/generate-multi-scene-workflow");
const { graphToApiPrompt } = require("../lib/comfy-graph-to-api-prompt");
const { buildLtxPromptFields } = require("../lib/build-ltx-prompt");

function resolveSceneTalkvid(scene) {
  if (scene.talkvid === false) return false;
  if (scene.scene_type === "reveal_demo" || scene.scene_type === "product_hero") {
    return false;
  }
  if (scene.talkvid === true) return true;
  if (Array.isArray(scene.audio_segments)) {
    return scene.audio_segments.some(
      (seg) => seg.talkvid === true || seg.mode === "talking_head"
    );
  }
  return false;
}

/**
 * Executes dynamic multi-scene video generation pipeline for UGC-P requests.
 */
async function generateMultiScenePipeline(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, llmResponse, finalJobPrompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, comfyApiKey, audio, audioDuration, requestType
  } = params;

  console.log(`[MultiSceneGen] Starting dynamic multi-scene pipeline for job ${jobId}`);

  try {
    const apiKey = await getOpenAiKey();
    if (!apiKey) {
      throw new Error("OpenAI API Key not found in secrets.");
    }

    let size = "1024x1536"; // default 9:16
    if (aspectRatio === "16:9") {
      size = "1536x1024";
    } else if (aspectRatio === "1:1") {
      size = "1024x1024";
    }

    const scenes = llmResponse.scenes || [];
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error("No scenes found in LLM response for UGC-P multi-scene generation.");
    }

    const generatedScenes = [];
    const sceneImageFilenames = [];

    // 1. Generate the talent image (1st generation) - Skip for FREE-TRIAL
    let generatedTalentImageUrl = null;
    let talentS3Key = null;

    if (requestType !== "FREE-TRIAL") {
      const talentPrompt = llmResponse.talent_identity?.prompt || "Indonesian woman in her mid-twenties, Southeast Asian facial features, warm brown skin, natural Indonesian appearance, friendly everyday UGC creator, chest-up portrait, soft natural window daylight, real smartphone photo, natural skin texture, photorealistic UGC style";
      console.log(`[MultiSceneGen] Generating talent image with prompt: "${talentPrompt.slice(0, 60)}..."`);
      const { buffer: talentBuffer, fallbackUrl: talentFallbackUrl } = await callOpenAIImageEdit({
        apiKey,
        prompt: talentPrompt,
        size,
        referenceUrls: currentS3ImageUrls
      });

      const folder = "generated_image";
      talentS3Key = `${folder}/${userId || "anonymous"}/${jobId}_talent.png`;

      await s3.send(new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: talentS3Key,
        Body: talentBuffer,
        ContentType: "image/png"
      }));

      const talentImgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: talentS3Key });
      generatedTalentImageUrl = talentFallbackUrl || (await getSignedUrl(s3, talentImgCmd, { expiresIn: 3600 }));
      console.log(`[MultiSceneGen] Talent image generated successfully. URL: ${generatedTalentImageUrl}`);
    }

    const folder = "generated_image";

    // B. Generate first frames for each scene
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneId = scene.scene_id || (i + 1);

      if (scene.consistency?.generate_first_frame === false) {
        // Skip image generation, use the user uploaded talent image directly (currentS3ImageUrls[0])
        const imageUrl = currentS3ImageUrls[0];
        console.log(`[MultiSceneGen] Scene ${sceneId} generate_first_frame is false. Using user uploaded image directly: ${imageUrl}`);
        const comfyImageName = await uploadInputImage(imageUrl, `${jobId}_scene_${sceneId}.png`, comfyApiKey);

        generatedScenes.push({
          scene_id: sceneId,
          s3_key: null,
          url: imageUrl,
          comfy_image_name: comfyImageName
        });
        sceneImageFilenames.push(comfyImageName);
      } else {
        // Generate scene first frame
        let scenePrompt = scene.image_prompt || finalJobPrompt;
        const negativePrompt = String(scene.negative_prompt || "").trim();
        if (negativePrompt) {
          scenePrompt = `${scenePrompt.trim()}. Avoid: ${negativePrompt}.`;
        }
        console.log(`[MultiSceneGen] Generating image for Scene ${sceneId}: "${scenePrompt.slice(0, 80)}..."`);

        const useModelRef = scene.consistency?.use_model_reference !== false;
        let sceneReferenceUrls;
        if (requestType === "FREE-TRIAL") {
          sceneReferenceUrls = useModelRef
            ? currentS3ImageUrls
            : currentS3ImageUrls.slice(1);
        } else {
          sceneReferenceUrls = useModelRef
            ? [generatedTalentImageUrl, ...currentS3ImageUrls]
            : currentS3ImageUrls;
        }

        const { buffer, fallbackUrl } = await callOpenAIImageEdit({
          apiKey,
          prompt: scenePrompt,
          size,
          referenceUrls: sceneReferenceUrls
        });

        const s3Key = `${folder}/${userId || "anonymous"}/${jobId}_scene_${sceneId}.png`;

        await s3.send(new PutObjectCommand({
          Bucket: S3_RESOURCE_BUCKET,
          Key: s3Key,
          Body: buffer,
          ContentType: "image/png"
        }));

        const imgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: s3Key });
        const signedUrl = fallbackUrl || (await getSignedUrl(s3, imgCmd, { expiresIn: 3600 }));

        // 2. Upload to ComfyUI Cloud
        console.log(`[MultiSceneGen] Uploading Scene ${sceneId} image to ComfyUI Cloud...`);
        const comfyImageName = await uploadInputImage(signedUrl, `${jobId}_scene_${sceneId}.png`, comfyApiKey);

        generatedScenes.push({
          scene_id: sceneId,
          s3_key: s3Key,
          url: signedUrl,
          comfy_image_name: comfyImageName
        });

        sceneImageFilenames.push(comfyImageName);
      }
    }

    // 3. Upload TTS Audio to ComfyUI Cloud
    let comfyAudioName = null;
    if (audio && typeof audio === "string" && audio !== "null" && audio !== "undefined" && audio.trim() !== "") {
      console.log(`[MultiSceneGen] Uploading TTS Audio to ComfyUI Cloud... Key: "${audio}"`);
      const audioCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: audio });
      const audioSignedUrl = await getSignedUrl(s3, audioCmd, { expiresIn: 3600 });
      comfyAudioName = await uploadInputAudio(audioSignedUrl, `${jobId}_tts.wav`, comfyApiKey);
    } else {
      console.log(`[MultiSceneGen] No valid audio key provided (received: ${JSON.stringify(audio)}). Skipping audio upload.`);
    }

    // 4. Calculate dimensions for buildMultiSceneWorkflow
    let w = 720, h = 1280; // default 9:16
    if (videoQuality === "1080p") {
      if (aspectRatio === "16:9") { w = 1920; h = 1080; }
      else if (aspectRatio === "1:1") { w = 1080; h = 1080; }
      else { w = 1080; h = 1920; } // 9:16
    } else {
      if (aspectRatio === "16:9") { w = 1280; h = 720; }
      else if (aspectRatio === "1:1") { w = 720; h = 720; }
      else { w = 720; h = 1280; } // 9:16
    }

    // Calculate total duration from scenes first, and maximize the last scene if total < 20s
    let totalSceneDuration = 0;
    for (let i = 0; i < scenes.length; i++) {
      totalSceneDuration += Number(scenes[i].duration_seconds || 4);
    }

    if (totalSceneDuration < 20 && scenes.length > 0) {
      const diff = 20 - totalSceneDuration;
      const lastIndex = scenes.length - 1;
      const originalDuration = Number(scenes[lastIndex].duration_seconds || 4);
      scenes[lastIndex].duration_seconds = originalDuration + diff;
      console.log(`[MultiSceneGen] Adjusting last scene duration. Added ${diff}s to Scene ${lastIndex + 1}. New duration: ${scenes[lastIndex].duration_seconds}s.`);
    }

    // 5. Construct scenes array for workflow builder
    let currentAudioStart = 0;
    const workflowScenes = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const duration = Number(scene.duration_seconds || 4);

      const built = buildLtxPromptFields(scene);
      workflowScenes.push({
        title: scene.scene_name || `Scene ${scene.scene_id || (i + 1)}`,
        image: sceneImageFilenames[i],
        audioStart: currentAudioStart,
        duration: duration,
        prompt: built.ltx_prompt || scene.ltx_prompt || "",
        ltx_negative_prompt: built.ltx_negative_prompt || scene.ltx_negative_prompt || "",
        negative_prompt: built.ltx_negative_prompt || scene.ltx_negative_prompt || "",
        talkvid: resolveSceneTalkvid(scene),
      });
      currentAudioStart += duration;
    }

    // 6. Build and convert workflow
    console.log(`[MultiSceneGen] Building dynamic workflow for ${scenes.length} scenes...`);
    const workflow = buildMultiSceneWorkflow(workflowScenes, {
      baseFile: path.join(__dirname, "..", "workflow", "base1scene.json"),
      audioFile: comfyAudioName,
      audioPad: 22,
      resolution: videoQuality === "1080p" ? "1080p" : "720p",
      width: w,
      height: h,
      upscale: videoQuality === "1080p" ? Math.max(w, h) * 1.2 : Math.max(w, h)
    });

    // Make sure asset filenames are explicitly applied in node values
    applyWorkflowAssetFilenames(workflow, {
      audioFilename: comfyAudioName,
      sceneImageFilenames
    });

    const apiPrompt = graphToApiPrompt(workflow);
    applySceneNegativePrompts(apiPrompt, workflowScenes);

    console.log("[MultiSceneGen] Workflow JSON for debugging:\n" + JSON.stringify(apiPrompt, null, 2));

    // 7. Submit Video Job to ComfyUI Cloud
    console.log(`[MultiSceneGen] Submitting multi-scene workflow to ComfyUI Cloud...`);
    const videoPromptId = await submitWorkflow(apiPrompt, comfyApiKey);
    console.log(`[MultiSceneGen] Submitted successfully. Prompt ID: ${videoPromptId}`);

    // 8. Update DynamoDB with generated images & comfy_prompt_id
    const primaryS3Key = generatedScenes.find(gs => gs.s3_key)?.s3_key || null;
    const updateExpr = ["generated_image = :genImg", "generated_scenes = :genScenes", "comfy_prompt_id = :vp", "#s = :status", "used_api_key = :uak", "updated_at = :now"];
    const exprValues = {
      ":genImg": primaryS3Key,
      ":genScenes": generatedScenes.map(gs => ({
        scene_id: gs.scene_id,
        s3_key: gs.s3_key,
        url: gs.url
      })),
      ":vp": videoPromptId,
      ":status": "PROCESSING",
      ":uak": comfyApiKey || null,
      ":now": getJakartaISOString()
    };
    if (talentS3Key) {
      updateExpr.push("generated_image_talent = :genTalent");
      exprValues[":genTalent"] = talentS3Key;
    }

    const newImageKeys = [];
    if (talentS3Key) newImageKeys.push(talentS3Key);
    generatedScenes.forEach(gs => {
      if (gs.s3_key) newImageKeys.push(gs.s3_key);
    });

    if (newImageKeys.length > 0) {
      updateExpr.push("s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys)");
      exprValues[":empty_list"] = [];
      exprValues[":newKeys"] = newImageKeys;
    }

    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET " + updateExpr.join(", "),
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: exprValues
    }));

    return videoPromptId;

  } catch (err) {
    console.error(`[MultiSceneGen] Error in multi-scene generation pipeline:`, err);
    throw err;
  }
}

module.exports = {
  generateMultiScenePipeline
};
