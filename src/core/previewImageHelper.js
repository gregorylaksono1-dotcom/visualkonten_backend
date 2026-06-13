const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getFalAiKey, getSignedUrl } = require("../services");
const { callOpenAIImageEdit } = require("./imageGenerationOpenAI");
const { getJakartaISOString } = require("../utils");

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

/**
 * Generates all preview images (talent image + scene keyframes) and updates job status to PREVIEW.
 */
async function generatePreviewAssets(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, llmResponse, finalJobPrompt, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, requestType
  } = params;

  console.log(`[PreviewHelper] Starting preview asset generation for job ${jobId}`);

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

  const isUgcMode = requestType === "UGC-P" || requestType === "UGC-S";
  const scenes = llmResponse.scene || llmResponse.scenes || [];
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("No scenes found in LLM response for preview generation.");
  }

  const generatedScenes = [];
  const folder = "generated_image";

  // 1. Generate the talent image (UGC-P only and not FREE-TRIAL)
  let generatedTalentImageUrl = null;
  let talentS3Key = null;

  if (isUgcMode && requestType !== "FREE-TRIAL") {
    const talentPrompt = buildTalentPortraitPrompt(llmResponse);
    console.log(`[PreviewHelper] Generating talent image with prompt: "${talentPrompt.slice(0, 60)}..."`);
    const { buffer: talentBuffer, fallbackUrl: talentFallbackUrl } = await callOpenAIImageEdit({
      apiKey,
      prompt: talentPrompt,
      size,
      referenceUrls: currentS3ImageUrls
    });

    talentS3Key = `${folder}/${userId || "anonymous"}/${jobId}_talent.png`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_RESOURCE_BUCKET,
      Key: talentS3Key,
      Body: talentBuffer,
      ContentType: "image/png"
    }));

    const talentImgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: talentS3Key });
    generatedTalentImageUrl = talentFallbackUrl || (await getSignedUrl(s3, talentImgCmd, { expiresIn: 3600 }));
    console.log(`[PreviewHelper] Talent image generated successfully. URL: ${generatedTalentImageUrl}`);
  }

  // 2. Generate keyframe images for all scenes
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneId = scene.scene_id || (i + 1);

    if (isUgcMode) {
      if (requestType === "FREE-TRIAL") {
        let scenePrompt = "";
        let sceneReferenceUrls = [];

        if (i === 0) {
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

        console.log(`[PreviewHelper] [FREE-TRIAL] Generating image for Scene ${sceneId}: "${scenePrompt.slice(0, 80)}..."`);
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
        // UGC Standard/Premium
        if (scene.consistency?.generate_first_frame === false) {
          const imageUrl = currentS3ImageUrls[0];
          console.log(`[PreviewHelper] Scene ${sceneId} generate_first_frame is false. Using direct image: ${imageUrl}`);

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
          console.log(`[PreviewHelper] Generating image for Scene ${sceneId}: "${scenePrompt.slice(0, 80)}..."`);

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
    } else {
      // Cinematic request types
      if (scene.consistency?.generate_first_frame === false) {
        const imageUrl = currentS3ImageUrls[0];
        console.log(`[PreviewHelper] Cinematic Scene ${sceneId} generate_first_frame is false. Using direct image: ${imageUrl}`);

        generatedScenes.push({
          scene_id: sceneId,
          s3_key: null,
          url: imageUrl
        });
      } else {
        let scenePrompt = scene.image_prompt || finalJobPrompt;
        const negativePrompt = String(scene.image_negative_prompt || scene.negative_prompt || "").trim();
        if (negativePrompt) {
          scenePrompt = `${scenePrompt.trim()}. Avoid: ${negativePrompt}.`;
        }
        console.log(`[PreviewHelper] Generating cinematic image for Scene ${sceneId}: "${scenePrompt.slice(0, 80)}..."`);

        const sceneReferenceUrls = currentS3ImageUrls;

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

  // 3. Update DynamoDB with generated assets and set status to PREVIEW
  const startTime = params.startTime || Date.now();
  const previewDuration = Math.round((Date.now() - startTime) / 1000);

  const primaryS3Key = generatedScenes.find(gs => gs.s3_key)?.s3_key || null;
  const updateExpr = ["generated_image = :genImg", "generated_scenes = :genScenes", "#s = :status", "updated_at = :now", "preview_duration = :prevDur"];
  const exprValues = {
    ":genImg": primaryS3Key,
    ":genScenes": generatedScenes.map(gs => ({
      scene_id: gs.scene_id,
      s3_key: gs.s3_key,
      url: gs.url
    })),
    ":status": "PREVIEW",
    ":now": getJakartaISOString(),
    ":prevDur": previewDuration
  };

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

  if (talentS3Key) {
    updateExpr.push("generated_image_talent = :genTalent");
    exprValues[":genTalent"] = talentS3Key;
  }

  await dynamo.send(new UpdateCommand({
    TableName: USER_REQUEST_TABLE,
    Key: { uuid: jobId, user_email: userEmail },
    UpdateExpression: "SET " + updateExpr.join(", "),
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: exprValues
  }));

  console.log(`[PreviewHelper] Preview generation successful for job ${jobId}. Status updated to PREVIEW.`);
  return { success: true };
}

module.exports = {
  generatePreviewAssets
};
