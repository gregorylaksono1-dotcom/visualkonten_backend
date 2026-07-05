/**
 * UGC LLM: legacy monolith (default)
 */
const fs = require("fs");
const path = require("path");

const PROMPT_DIR = path.join(__dirname, "../prompt");

const parseJsonFromLlm = (raw) => {
  const trimmed = String(raw || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(body);
};

const buildLegacyUserPrompt = (
  requestType,
  description,
  { videoDuration = 15, sellingMode = "hard", lipSync = true } = {}
) => {
  if (requestType === "UGC-P") {
    return `1. {product_description}: ${description}\n2. {video_duration}: ${videoDuration} detik\n3. {selling_mode}: ${sellingMode}\n4. {lip_sync}: ${lipSync}`;
  }
  return `1. {store_description}: ${description}\n2. {video_duration}: ${videoDuration} detik\n3. {lip_sync}: ${lipSync}`;
};

const loadLegacyTemplate = (requestType, storeType) => {
  let fileName = "PROMPT_BUILDER_OmniFlow_V1_1";
  if (requestType === "UGC-S") {
    fileName =
      String(storeType || "offline").toLowerCase() === "online"
        ? "PROMPT_UGC_STORE_ONLINE"
        : "PROMPT_UGC_STORE_OFFLINE";
  }
  return fs.readFileSync(path.join(PROMPT_DIR, fileName), "utf-8");
};

const loadPromptBuilder = async (requestType) => {
  try {
    const { resolvePricingRow } = require("../services");
    const resolved = await resolvePricingRow(requestType);
    if (resolved && resolved.item && resolved.item.prompt) {
      const url = String(resolved.item.prompt).trim();
      if (url.startsWith("http")) {
        console.log(`[UGC-LLM] Fetching prompt builder from S3 URL for ${requestType}: ${url}`);
        const response = await fetch(url);
        if (response.ok) {
          const content = await response.text();
          console.log(`[UGC-LLM] Successfully fetched prompt builder from S3 (${content.length} characters)`);
          return content;
        } else {
          console.error(`[UGC-LLM] S3 prompt fetch failed with status ${response.status} for URL ${url}`);
        }
      }
    }
  } catch (err) {
    console.error(`[UGC-LLM] Error fetching prompt builder from database/S3 for ${requestType}:`, err.message);
  }
  return null;
};

/**
 * @returns {Promise<object>} Pipeline-compatible llm_response object
 */
const generateUgcLlmResponse = async ({
  requestType,
  prompt: description,
  storeType,
  sellingMode = "hard",
  videoDuration = 15,
  lipSync = true,
  callLLM,
}) => {
  if (
    requestType !== "UGC-P" &&
    requestType !== "UGC-S" &&
    requestType !== "FREE-TRIAL" &&
    requestType !== "PRODUCT-CINEMATIC" &&
    requestType !== "PRODUCT-CINEMATIK"
  ) {
    throw new Error(`generateUgcLlmResponse: unsupported requestType ${requestType}`);
  }

  const opts = { videoDuration, sellingMode, lipSync };

  // Fetch the template from S3 URL in database, fallback to local files if it fails
  let template = await loadPromptBuilder(requestType);

  console.log(`[PIPELINE_LOG] [LLM] Calling LLM API for request type: ${requestType}`);

  if (requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK") {
    if (!template) {
      console.log(`[UGC-LLM] PRODUCT-CINEMATIC request: Reading and sending product_ad.md as prompt builder to OpenAI`);
      template = fs.readFileSync(path.join(PROMPT_DIR, "product_ad.md"), "utf-8");
    }
    const userPrompt = `1. {product_description}: ${description}\n2. {video_duration}: ${videoDuration} detik`;
    const aiResponse = await callLLM(template, userPrompt);
    return parseJsonFromLlm(aiResponse);
  }

  if (requestType === "FREE-TRIAL") {
    if (!template) {
      console.log(`[UGC-LLM] FREE-TRIAL request: Reading and sending ugc_free_trial.md as prompt builder to OpenAI`);
      template = fs.readFileSync(path.join(PROMPT_DIR, "ugc_free_trial.md"), "utf-8");
    }
    const userPrompt = buildLegacyUserPrompt("UGC-P", description, opts);
    const aiResponse = await callLLM(template, userPrompt);
    return parseJsonFromLlm(aiResponse);
  }

  if (requestType === "UGC-P") {
    if (!template) {
      console.log(`[UGC-LLM] UGC-P request: Reading and sending ugc_slim.md as prompt builder to OpenAI`);
      template = fs.readFileSync(path.join(PROMPT_DIR, "ugc_slim.md"), "utf-8");
    }
    const userPrompt = buildLegacyUserPrompt(requestType, description, opts);
    const aiResponse = await callLLM(template, userPrompt);
    return parseJsonFromLlm(aiResponse);
  }

  if (!template) {
    console.log(`[UGC-LLM] legacy monolithic prompt (${requestType})`);
    template = loadLegacyTemplate(requestType, storeType);
  }
  const userPrompt = buildLegacyUserPrompt(requestType, description, opts);
  const aiResponse = await callLLM(template, userPrompt);
  return parseJsonFromLlm(aiResponse);
};

module.exports = {
  generateUgcLlmResponse,
};
