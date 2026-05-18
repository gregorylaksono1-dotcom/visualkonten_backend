const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getOpenAiKey, getSignedUrl } = require("../services");
const { generateComfyUIVideo } = require("./videoGeneration");

async function generateImageOpenAI(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, llmResponse, finalJobPrompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, comfyApiKey, audio, audioDuration
  } = params;

  console.log(`[OpenAI ImageGen] Starting OpenAI Image Edit generation for job ${jobId}`);

  try {
    // 1. Get OpenAI API Key
    const apiKey = await getOpenAiKey();
    if (!apiKey) {
      throw new Error("OpenAI API Key not found in consolidated secrets.");
    }

    // 2. Determine size
    // Portrait (9:16) -> 1024x1536
    // Landscape (16:9) -> 1536x1024
    // Square (1:1) -> 1024x1024
    let size = "1024x1536";
    if (aspectRatio === "16:9") {
      size = "1536x1024";
    } else if (aspectRatio === "1:1") {
      size = "1024x1024";
    }

    // 3. Construct FormData
    const formData = new FormData();
    formData.append("model", "gpt-image-1-mini");
    
    const imagePrompt = llmResponse.image_generation?.prompt || finalJobPrompt;
    formData.append("prompt", imagePrompt);
    formData.append("size", size);

    // Fetch and append S3 images
    for (const url of currentS3ImageUrls) {
      console.log(`[OpenAI ImageGen] Fetching reference image from S3: ${url}`);
      const imgRes = await fetch(url);
      if (!imgRes.ok) {
        throw new Error(`Failed to fetch S3 image from URL: ${url}`);
      }
      const imgBlob = await imgRes.blob();
      formData.append("image[]", imgBlob, "image.png");
    }

    // 4. Call OpenAI API
    console.log(`[OpenAI ImageGen] Sending request to OpenAI API with size ${size}...`);
    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errText}`);
    }

    const resJson = await response.json();
    let buffer;
    let fallbackUrl = "";

    const b64Data = resJson.data?.[0]?.b64_json;
    const urlData = resJson.data?.[0]?.url;

    if (b64Data) {
      console.log(`[OpenAI ImageGen] Successfully received image in base64 format.`);
      buffer = Buffer.from(b64Data, "base64");
    } else if (urlData) {
      console.log(`[OpenAI ImageGen] Successfully received image in URL format: ${urlData}`);
      fallbackUrl = urlData;
      const imgDownloadRes = await fetch(urlData);
      if (!imgDownloadRes.ok) {
        throw new Error(`Failed to download generated image from OpenAI URL: ${imgDownloadRes.status}`);
      }
      buffer = Buffer.from(await imgDownloadRes.arrayBuffer());
    } else {
      throw new Error(`No image data (b64_json or url) returned from OpenAI Edit API. Response: ${JSON.stringify(resJson)}`);
    }

    // 5. Upload generated image to S3
    const folder = "generated_image";
    const ext = "png";
    const contentType = "image/png";
    const s3Key = `${folder}/${userId || "anonymous"}/${jobId}.${ext}`;

    console.log(`[OpenAI ImageGen] Uploading generated image to S3: ${s3Key}`);
    await s3.send(new PutObjectCommand({
      Bucket: S3_RESOURCE_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: contentType
    }));

    // 6. Update DynamoDB with generated_image S3 Key
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET generated_image = :genImg, updated_at = :now",
      ExpressionAttributeValues: {
        ":genImg": s3Key,
        ":now": new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })
      }
    }));

    // 7. Generate signed URL for ComfyUI video generator input
    let imageResultUrl = fallbackUrl;
    if (!imageResultUrl) {
      console.log(`[OpenAI ImageGen] Creating pre-signed URL for S3 image: ${s3Key}`);
      const imgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: s3Key });
      imageResultUrl = await getSignedUrl(s3, imgCmd, { expiresIn: 3600 });
    }

    // 8. Trigger ComfyUI Video Generation
    console.log(`[OpenAI ImageGen] Directing to ComfyUI Video Generation...`);
    await generateComfyUIVideo({
      uuid: jobId,
      user_email: userEmail,
      user_id: userId,
      request_type: params.requestType || "UGC-P",
      llm_response: llmResponse,
      audio,
      audio_duration: audioDuration,
      video_quality: videoQuality,
      aspect_ratio: aspectRatio,
      imageResultUrl, // Pre-signed S3 URL or direct OpenAI URL
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
  generateImageOpenAI
};
