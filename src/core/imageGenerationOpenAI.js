const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("../utils");
const { getOpenAiKey, getSignedUrl } = require("../services");
const { generateComfyUIVideo } = require("./videoGeneration");

function resolveImagePrompts(llmResponse, finalJobPrompt) {
  const ig = llmResponse.image_generation || {};
  const talent = ig.talent_frame?.prompt;
  const product = ig.product_frame?.prompt;
  if (talent && product) {
    return [
      { key: "talent_frame", prompt: talent, suffix: "talent" },
      { key: "product_frame", prompt: product, suffix: "product" }
    ];
  }
  const hero = ig.hero_frame?.prompt;
  const transition = ig.transition_frame?.prompt;
  const reveal = ig.reveal_start_frame?.prompt;
  if (hero && transition && reveal) {
    return [
      { key: "hero_frame", prompt: hero, suffix: "hero" },
      { key: "transition_frame", prompt: transition, suffix: "transition" },
      { key: "reveal_start_frame", prompt: reveal, suffix: "reveal" }
    ];
  }
  if (hero && reveal) {
    return [
      { key: "hero_frame", prompt: hero, suffix: "hero" },
      { key: "reveal_start_frame", prompt: reveal, suffix: "reveal" }
    ];
  }
  const legacy = ig.prompt || finalJobPrompt;
  return [{ key: "prompt", prompt: legacy, suffix: "main" }];
}

async function callOpenAIImageEdit({ apiKey, prompt, size, referenceUrls }) {
  const formData = new FormData();
  formData.append("model", "gpt-image-1-mini");
  formData.append("prompt", prompt);
  formData.append("size", size);

  let imgIndex = 1;
  for (const url of referenceUrls) {
    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      throw new Error(`Failed to fetch S3 image from URL: ${url}`);
    }
    const imgBlob = await imgRes.blob();
    formData.append("image[]", imgBlob, `image${imgIndex}.png`);
    imgIndex++;
  }

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errText}`);
  }

  const resJson = await response.json();
  const b64Data = resJson.data?.[0]?.b64_json;
  const urlData = resJson.data?.[0]?.url;

  if (b64Data) {
    return { buffer: Buffer.from(b64Data, "base64"), fallbackUrl: "" };
  }
  if (urlData) {
    const imgDownloadRes = await fetch(urlData);
    if (!imgDownloadRes.ok) {
      throw new Error(`Failed to download generated image from OpenAI URL: ${imgDownloadRes.status}`);
    }
    return {
      buffer: Buffer.from(await imgDownloadRes.arrayBuffer()),
      fallbackUrl: urlData
    };
  }
  throw new Error(`No image data returned from OpenAI Edit API. Response: ${JSON.stringify(resJson)}`);
}

async function generateImageOpenAI(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, llmResponse, finalJobPrompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, comfyApiKey, audio, audioDuration, requestType
  } = params;

  console.log(`[OpenAI ImageGen] Starting OpenAI Image Edit generation for job ${jobId}`);

  try {
    const apiKey = await getOpenAiKey();
    if (!apiKey) {
      throw new Error("OpenAI API Key not found in consolidated secrets.");
    }

    let size = "1024x1536";
    if (aspectRatio === "16:9") {
      size = "1536x1024";
    } else if (aspectRatio === "1:1") {
      size = "1024x1024";
    }

    const promptJobs = resolveImagePrompts(llmResponse, finalJobPrompt);
    const isThreeFrameProduct = promptJobs.length === 3 && promptJobs.some((j) => j.key === "transition_frame");
    const isTwoFrame = promptJobs.length === 2;

    const orderedJobs = isThreeFrameProduct
      ? [...promptJobs].sort((a, b) => {
          const order = { hero_frame: 0, transition_frame: 1, reveal_start_frame: 2, product_frame: 0, talent_frame: 1 };
          return (order[a.key] ?? 9) - (order[b.key] ?? 9);
        })
      : isTwoFrame
        ? [...promptJobs].sort((a, b) => (a.key === "product_frame" || a.key === "hero_frame" ? -1 : 1))
        : promptJobs;

    const generated = {};
    let primaryS3Key = null;
    let primarySignedUrl = null;

    for (const job of orderedJobs) {
      console.log(`[OpenAI ImageGen] Generating ${job.key} (${job.suffix})...`);
      const { buffer, fallbackUrl } = await callOpenAIImageEdit({
        apiKey,
        prompt: job.prompt,
        size,
        referenceUrls: currentS3ImageUrls
      });

      const folder = "generated_image";
      const s3Key = `${folder}/${userId || "anonymous"}/${jobId}_${job.suffix}.png`;

      await s3.send(new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: "image/png"
      }));

      generated[job.key] = s3Key;

      const imgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: s3Key });
      const signedUrl = fallbackUrl || (await getSignedUrl(s3, imgCmd, { expiresIn: 3600 }));

      if (job.key === "talent_frame" || job.key === "prompt" || job.key === "reveal_start_frame") {
        primaryS3Key = s3Key;
        primarySignedUrl = signedUrl;
      }
      if (job.key === "hero_frame") {
        generated.hero_frame_url = signedUrl;
      }
      if (job.key === "transition_frame") {
        generated.transition_frame_url = signedUrl;
      }
      if (job.key === "reveal_start_frame") {
        generated.reveal_start_frame_url = signedUrl;
      }
      if (job.key === "product_frame") {
        generated.product_frame_url = signedUrl;
      }
      if (job.key === "talent_frame") {
        generated.talent_frame_url = signedUrl;
      }
    }

    const updateValues = {
      ":genImg": primaryS3Key,
      ":now": getJakartaISOString()
    };
    let updateExpr = "SET generated_image = :genImg, updated_at = :now";

    if (isThreeFrameProduct) {
      updateExpr += ", generated_image_hero = :genHero, generated_image_transition = :genTrans, generated_image_reveal = :genReveal";
      updateValues[":genHero"] = generated.hero_frame;
      updateValues[":genTrans"] = generated.transition_frame;
      updateValues[":genReveal"] = generated.reveal_start_frame;
    } else if (isTwoFrame) {
      updateExpr += ", generated_image_product = :genProd, generated_image_talent = :genTalent";
      updateValues[":genProd"] = generated.product_frame || generated.hero_frame;
      updateValues[":genTalent"] = generated.talent_frame;
    }

    const newImageKeys = Object.values(generated).filter(Boolean);
    if (newImageKeys.length > 0) {
      updateExpr += ", s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys)";
      updateValues[":empty_list"] = [];
      updateValues[":newKeys"] = newImageKeys;
    }

    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: updateValues
    }));

    const imageResultUrl = primarySignedUrl;
    const productFrameUrl = generated.product_frame_url || generated.hero_frame_url || null;
    const transitionFrameUrl = generated.transition_frame_url || null;

    console.log(`[OpenAI ImageGen] Directing to ComfyUI Video Generation (twoFrame=${isTwoFrame}, threeFrameProduct=${isThreeFrameProduct})...`);
    await generateComfyUIVideo({
      uuid: jobId,
      user_email: userEmail,
      user_id: userId,
      request_type: requestType || "UGC-P",
      llm_response: llmResponse,
      audio,
      audio_duration: audioDuration,
      video_quality: videoQuality,
      aspect_ratio: aspectRatio,
      imageResultUrl,
      productFrameUrl,
      transitionFrameUrl,
      used_api_key: comfyApiKey,
      dynamo,
      s3,
      USER_REQUEST_TABLE,
      S3_RESOURCE_BUCKET,
      prompt: finalJobPrompt
    });
  } catch (err) {
    console.error(`[OpenAI ImageGen] Error in OpenAI Image pipeline:`, err);
    throw err;
  }
}

module.exports = {
  generateImageOpenAI,
  callOpenAIImageEdit
};
