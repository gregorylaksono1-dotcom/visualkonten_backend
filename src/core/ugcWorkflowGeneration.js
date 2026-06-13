const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");
const { getJakartaISOString } = require("../utils");
const { getFalAiKey, getSignedUrl, uploadInputImage, uploadInputAudio, submitWorkflow } = require("../services");
const { callOpenAIImageEdit } = require("./imageGenerationOpenAI");
const {
  buildMultiSceneWorkflow,
  applyWorkflowAssetFilenames,
  applySceneNegativePrompts,
} = require("../lib/generate-multi-scene-workflow");
const { graphToApiPrompt } = require("../lib/comfy-graph-to-api-prompt");
const { buildLtxPromptFields } = require("../lib/build-ltx-prompt");

const DEFAULT_ANTI_STUDIO_NEGATIVE =
  "stock photo, catalog photo, studio lighting, commercial photography, beauty retouching, flawless skin, magazine shoot, fashion campaign, professional model, glamour portrait, CGI, 3D render, tabloid photo, airbrushed skin, porcelain skin, editorial fashion, catalog look, professional studio backdrop, plastic skin, perfect symmetry";

const TALENT_APPEAL_PHRASE =
  "naturally attractive, photogenic face, pleasant appealing features, charismatic everyday creator look";

const DEFAULT_TALENT_PORTRAIT_PROMPT =
  "Indonesian woman in her mid-twenties, Southeast Asian facial features, warm brown skin, natural Indonesian appearance, naturally attractive photogenic face with pleasant appealing features, charismatic everyday creator look, chest-up portrait, soft natural window daylight, real smartphone photo, natural skin texture, photorealistic UGC style";

function resolveTalentImageNegative(llmResponse) {
  return (
    String(llmResponse?.talent_identity?.image_negative_avoid || "").trim() ||
    String(llmResponse?.meta?.image_generation?.anti_studio_negative || "").trim() ||
    DEFAULT_ANTI_STUDIO_NEGATIVE
  );
}

function appendAvoidNegative(prompt, negative) {
  const neg = String(negative || "").trim();
  if (!neg) return prompt;
  return `${String(prompt || "").trim()}. Avoid: ${neg}.`;
}

function hasTalentAppealPhrase(text) {
  return /attractive|photogenic|appealing|charismatic/i.test(String(text || ""));
}

function buildTalentPortraitPrompt(llmResponse) {
  const tid = llmResponse?.talent_identity || {};
  const parts = [];
  if (tid.prompt) parts.push(tid.prompt);
  if (tid.gender) parts.push(`gender: ${tid.gender}`);
  if (tid.age_range) parts.push(`age range: ${tid.age_range}`);
  if (tid.outfit_lock) parts.push(`outfit: ${tid.outfit_lock}`);
  if (tid.hair_lock) parts.push(`hair style: ${tid.hair_lock}`);
  if (tid.ethnicity) parts.push(`ethnicity: ${tid.ethnicity}`);

  if (parts.length === 0) {
    parts.push(DEFAULT_TALENT_PORTRAIT_PROMPT);
  } else if (!hasTalentAppealPhrase(parts.join(", "))) {
    parts.push(TALENT_APPEAL_PHRASE);
  }

  return appendAvoidNegative(parts.join(", "), resolveTalentImageNegative(llmResponse));
}

function resolveSceneTalkvid(scene) {
  if (scene.talkvid === false) return false;
  if (scene.scene_type === "reveal_demo" || scene.scene_type === "product_hero") {
    return false;
  }
  if (scene.talkvid === true) return true;
  if (scene.scene_type === "talking_head" || scene.scene_type === "trial_talent") return true;
  if (scene.audio_mode === "talking_head") return true;
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
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, audio, audioDuration, requestType
  } = params;

  console.log(`[MultiSceneGen] Starting dynamic multi-scene pipeline for job ${jobId}`);

  let comfyApiKey = params.comfyApiKey;
  let redis = null;

  try {
    const apiKey = await getFalAiKey();
    if (!apiKey) {
      throw new Error("Fal.ai API Key not found in secrets.");
    }

    let size = "1024x1536"; // default 9:16
    if (aspectRatio === "16:9") {
      size = "1536x1024";
    } else if (aspectRatio === "1:1") {
      size = "1024x1024";
    }

    let scenes = llmResponse.scenes || [];
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error("No scenes found in LLM response for UGC-P multi-scene generation.");
    }
    if (requestType === "FREE-TRIAL") {
      scenes = scenes.slice(0, 2);
    }

    const generatedScenes = [];

    // 1. Generate the talent image (1st generation) - Skip for FREE-TRIAL
    let generatedTalentImageUrl = null;
    let talentS3Key = null;

    if (requestType !== "FREE-TRIAL") {
      const talentPrompt = buildTalentPortraitPrompt(llmResponse);
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

    // 2. Generate first frames for each scene (Save to S3, do not upload to ComfyUI yet)
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneId = scene.scene_id || (i + 1);

      if (requestType === "FREE-TRIAL") {
        let scenePrompt = "";
        let sceneReferenceUrls = [];

        if (i === 0) {
          // Scene 1: full body talent + product — talent ref + product ref
          scenePrompt = scene.image_prompt || buildTalentPortraitPrompt(llmResponse);
          const negativePrompt = String(scene.negative_prompt || "").trim();
          scenePrompt = appendAvoidNegative(
            scenePrompt,
            negativePrompt || resolveTalentImageNegative(llmResponse)
          );
          const useModelRef = scene.consistency?.use_model_reference !== false;
          const useProductRef = scene.consistency?.use_product_reference !== false;
          if (useModelRef && useProductRef) {
            sceneReferenceUrls = [currentS3ImageUrls[0], currentS3ImageUrls[1]].filter(Boolean);
          } else if (useModelRef) {
            sceneReferenceUrls = currentS3ImageUrls[0] ? [currentS3ImageUrls[0]] : [];
          } else {
            sceneReferenceUrls = currentS3ImageUrls.slice(1).filter(Boolean);
          }
        } else {
          scenePrompt = scene.image_prompt || finalJobPrompt;
          scenePrompt = appendAvoidNegative(
            scenePrompt,
            scene.negative_prompt || resolveTalentImageNegative(llmResponse)
          );
          sceneReferenceUrls = currentS3ImageUrls.slice(1).filter(Boolean);
        }
        if (sceneReferenceUrls.length === 0 && currentS3ImageUrls.length > 0) {
          sceneReferenceUrls = [currentS3ImageUrls[0]];
        }

        console.log(`[MultiSceneGen] [FREE-TRIAL] Generating image for Scene ${sceneId}: "${scenePrompt.slice(0, 80)}..."`);
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

        generatedScenes.push({
          scene_id: sceneId,
          s3_key: s3Key,
          url: signedUrl
        });

      } else {
        if (scene.consistency?.generate_first_frame === false) {
          const imageUrl = currentS3ImageUrls[0];
          console.log(`[MultiSceneGen] Scene ${sceneId} generate_first_frame is false. Using user uploaded image directly: ${imageUrl}`);

          generatedScenes.push({
            scene_id: sceneId,
            s3_key: null,
            url: imageUrl
          });
        } else {
          let scenePrompt = scene.image_prompt || finalJobPrompt;
          const negativePrompt = String(scene.negative_prompt || "").trim();
          if (negativePrompt) {
            scenePrompt = `${scenePrompt.trim()}. Avoid: ${negativePrompt}.`;
          }
          console.log(`[MultiSceneGen] Generating image for Scene ${sceneId}: "${scenePrompt.slice(0, 80)}..."`);

          const useModelRef = scene.consistency?.use_model_reference !== false;
          const sceneReferenceUrls = useModelRef
            ? [generatedTalentImageUrl, ...currentS3ImageUrls]
            : currentS3ImageUrls;

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

          generatedScenes.push({
            scene_id: sceneId,
            s3_key: s3Key,
            url: signedUrl
          });
        }
      }
    }

    // 3. Update DynamoDB with generated S3 asset keys first (so recoveryCron can find them)
    const primaryS3Key = generatedScenes.find(gs => gs.s3_key)?.s3_key || null;
    const updateExpr = ["generated_image = :genImg", "generated_scenes = :genScenes", "updated_at = :now"];
    const exprValues = {
      ":genImg": primaryS3Key,
      ":genScenes": generatedScenes.map(gs => ({
        scene_id: gs.scene_id,
        s3_key: gs.s3_key,
        url: gs.url
      })),
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
      ExpressionAttributeValues: exprValues
    }));

    // 4. Predict ComfyUI filenames and construct workflow
    const comfyAudioName = audio ? `${jobId}_tts.wav` : null;
    const comfyTalentImageName = talentS3Key ? `${jobId}_talent.png` : null;
    const sceneImageFilenames = generatedScenes.map(gs => `${jobId}_scene_${gs.scene_id}.png`);

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

    let totalSceneDuration = 0;
    for (let i = 0; i < scenes.length; i++) {
      totalSceneDuration += Number(scenes[i].duration_seconds || 4);
    }

    const targetMinDuration = requestType === "FREE-TRIAL" ? 10 : 20;
    if (totalSceneDuration < targetMinDuration && scenes.length > 0) {
      const diff = targetMinDuration - totalSceneDuration;
      const lastIndex = scenes.length - 1;
      const originalDuration = Number(scenes[lastIndex].duration_seconds || 4);
      scenes[lastIndex].duration_seconds = originalDuration + diff;
      console.log(`[MultiSceneGen] Adjusting last scene duration. Added ${diff}s to Scene ${lastIndex + 1}. New duration: ${scenes[lastIndex].duration_seconds}s.`);
    }

    const workflowScenes = [];
    let currentAudioStart = 0;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const duration = Number(scene.duration_seconds || 4);

      const built = buildLtxPromptFields(scene);
      workflowScenes.push({
        title: scene.scene_name || `Scene ${scene.scene_id || (i + 1)}`,
        image: sceneImageFilenames[i], // Predicted filename
        audioStart: currentAudioStart,
        duration: duration,
        prompt: built.ltx_prompt || scene.ltx_prompt || "",
        ltx_negative_prompt: built.ltx_negative_prompt || scene.ltx_negative_prompt || "",
        negative_prompt: built.ltx_negative_prompt || scene.ltx_negative_prompt || "",
        talkvid: resolveSceneTalkvid(scene),
      });
      currentAudioStart += duration;
    }

    console.log(`[MultiSceneGen] Building dynamic workflow for ${scenes.length} scenes...`);
    const runpod = process.env.RUNPOD === "true";
    const s3FilenamePrefix = `${userId || "anonymous"}_${jobId}`;

    const bypassLtxRewriter = process.env.BYPASS_LTX_REWRITER === "true" ||
      (llmResponse && llmResponse.meta && (llmResponse.meta.bypass_ltx_rewriter === true || llmResponse.meta.bypass_rewriter === true));

    const workflow = buildMultiSceneWorkflow(workflowScenes, {
      baseFile: path.join(__dirname, "..", "workflow", "base1scene.json"),
      audioFile: comfyAudioName,
      audioPad: 22,
      resolution: videoQuality === "1080p" ? "1080p" : "720p",
      width: w,
      height: h,
      upscale: videoQuality === "1080p" ? Math.max(w, h) * 1.2 : Math.max(w, h),
      runpod,
      s3FilenamePrefix,
      bypassLtxRewriter
    });

    applyWorkflowAssetFilenames(workflow, {
      audioFilename: comfyAudioName,
      sceneImageFilenames
    });

    const apiPrompt = graphToApiPrompt(workflow, { bypassLtxRewriter });
    applySceneNegativePrompts(apiPrompt, workflowScenes);

    // Assert that scene 1 prompt in node 2100 value is correct and has not been stripped
    const p2100 = apiPrompt["2100"] || apiPrompt[2100];
    if (p2100 && p2100.inputs && typeof p2100.inputs.value === "string") {
      const val = p2100.inputs.value;
      const originalPrompt = scenes[0]?.ltx_prompt || scenes[0]?.prompt || "";
      if (originalPrompt.includes("speaks ") && (!val.includes('and speaks "') || !val.includes("fully in sync with the spoken line"))) {
        console.error(`[Assertion Failed] Node 2100 value is missing speaks clause or sync line.`);
        console.error(`Original scene prompt: ${originalPrompt}`);
        console.error(`Constructed value: ${val}`);
        throw new Error(`Assertion Failed: Node 2100 value does not contain required lip sync dialogue clause!`);
      }
    }

    console.log("[MultiSceneGen] Workflow JSON for debugging:\n" + JSON.stringify(apiPrompt, null, 2));

    // 5. Try to pick ComfyUI API Key right before uploading/submitting
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
      err.workflow = apiPrompt;
      throw err;
    }

    // 6. Upload assets to ComfyUI Cloud
    // Upload talent image
    if (talentS3Key && generatedTalentImageUrl) {
      console.log(`[MultiSceneGen] Uploading talent image to ComfyUI Cloud...`);
      await uploadInputImage(generatedTalentImageUrl, `${jobId}_talent.png`, comfyApiKey);
    }

    // Upload generated scene images
    for (let i = 0; i < generatedScenes.length; i++) {
      const gs = generatedScenes[i];
      const imageUrl = gs.url;
      const comfyImageName = sceneImageFilenames[i];
      console.log(`[MultiSceneGen] Uploading Scene ${gs.scene_id} image to ComfyUI Cloud...`);
      const returnedName = await uploadInputImage(imageUrl, comfyImageName, comfyApiKey);
      
      const nodeId = String(2000 + i);
      if (apiPrompt[nodeId] && apiPrompt[nodeId].inputs) {
        apiPrompt[nodeId].inputs.image = returnedName;
        console.log(`[MultiSceneGen] Updated Node ${nodeId} input image to: ${returnedName}`);
      }
    }

    // Upload TTS Audio
    if (audio && comfyAudioName) {
      console.log(`[MultiSceneGen] Uploading TTS Audio to ComfyUI Cloud...`);
      const audioCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: audio });
      const audioSignedUrl = await getSignedUrl(s3, audioCmd, { expiresIn: 3600 });
      const returnedAudioName = await uploadInputAudio(audioSignedUrl, comfyAudioName, comfyApiKey);
      
      if (apiPrompt["611"] && apiPrompt["611"].inputs) {
        apiPrompt["611"].inputs.audio = returnedAudioName;
        console.log(`[MultiSceneGen] Updated Node 611 input audio to: ${returnedAudioName}`);
      }
    }

    // 7. Submit Video Job to ComfyUI Cloud
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
