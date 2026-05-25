const fs = require("fs");
const path = require("path");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

async function generateComfyUIImage(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, llmResponse, finalJobPrompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET,
    dynamo, USER_REQUEST_TABLE, redis,
    uploadInputImage, submitWorkflow, uploadToS3,
  } = params;

  console.log(`[Worker] Starting ComfyUI Image Generation for ${jobId}`);
  try {
    // Pick an API Key if not provided
    let comfyApiKey = params.comfyApiKey;
    if (!comfyApiKey) {
      const { pickComfyApiKey, getComfyApiKeys } = require("../services");
      const apiKeysString = await getComfyApiKeys();
      comfyApiKey = await pickComfyApiKey(apiKeysString, redis);
    }

    if (!comfyApiKey) {
        console.log(`[Worker] All ComfyUI API keys are busy. Skipping Image Gen for job ${jobId}.`);
        return;
    }

    // Upload reference image first
    const refImageName = await uploadInputImage(currentS3ImageUrls[0], `${jobId}_ref.png`, comfyApiKey);

    // Load Flux workflow (need to resolve path relative to this file)
    const fluxPath = path.join(__dirname, "..", "workflow", "Flux.2 [Klein] 4B Distilled_ Image Edit (API).json");
    const fluxWorkflow = JSON.parse(fs.readFileSync(fluxPath, "utf-8"));

    // 1. Node 76: Load Image
    if (fluxWorkflow["76"] && fluxWorkflow["76"].inputs) {
      fluxWorkflow["76"].inputs.image = refImageName;
    }

    // 2. Node 75:66: Width and Height based on videoQuality and aspectRatio
    let w = 720, h = 1280; // default 720p portrait
    
    if (videoQuality === "480p") {
      if (aspectRatio === "16:9") { w = 854; h = 480; }
      else if (aspectRatio === "1:1") { w = 480; h = 480; }
      else { w = 480; h = 854; } // 9:16
    } else { 
      // Default to 720p
      if (aspectRatio === "16:9") { w = 1280; h = 720; }
      else if (aspectRatio === "1:1") { w = 720; h = 720; }
      else { w = 720; h = 1280; } // 9:16
    }

    if (fluxWorkflow["75:66"] && fluxWorkflow["75:66"].inputs) {
      fluxWorkflow["75:66"].inputs.width = w;
      fluxWorkflow["75:66"].inputs.height = h;
    }

    // 3. Node 75:74: Prompt
    const imagePrompt = llmResponse.image_generation?.prompt || finalJobPrompt;
    if (fluxWorkflow["75:74"] && fluxWorkflow["75:74"].inputs) {
      fluxWorkflow["75:74"].inputs.text = imagePrompt;
    }

    // Node 9: Save Image (Filename Prefix)
    if (fluxWorkflow["9"] && fluxWorkflow["9"].inputs) {
      fluxWorkflow["9"].inputs.filename_prefix = jobId;
    }


    // Submit workflow
    const imgPromptId = await submitWorkflow(fluxWorkflow, comfyApiKey);
    console.log(`[Worker] ComfyUI Image Gen submitted: ${imgPromptId} using key ${comfyApiKey.substring(0, 8)}...`);

    // Update DynamoDB with image_prompt_id and used_api_key
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET image_prompt_id = :ip, used_api_key = :uak, updated_at = :now",
      ExpressionAttributeValues: { 
          ":ip": imgPromptId, 
          ":uak": comfyApiKey,
          ":now": getJakartaISOString() 
      }
    }));

  } catch (imgErr) {
    console.error("[Worker] ComfyUI Image Gen error:", imgErr);
  }
}

module.exports = {
  generateComfyUIImage
};
