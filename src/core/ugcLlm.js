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

let cachedRuleMaster = null;

const getRuleMaster = async () => {
  if (cachedRuleMaster) return cachedRuleMaster;
  console.log(`[UGC-LLM] Fetching rule_master.md from S3...`);
  const response = await fetch("https://gambr-public.s3.ap-southeast-1.amazonaws.com/prompt/rule_master.md");
  if (!response.ok) {
    throw new Error(`Failed to fetch rule_master.md: ${response.status}`);
  }
  cachedRuleMaster = await response.text();
  console.log(`[UGC-LLM] Successfully fetched and cached rule_master.md (${cachedRuleMaster.length} characters)`);
  return cachedRuleMaster;
};

const getSystemPromptWrapper = () => {
  const wrapperPath = path.join(__dirname, "../prompt/wrapper.txt");
  if (!fs.existsSync(wrapperPath)) {
    console.warn(`[UGC-LLM] wrapper.txt not found at ${wrapperPath}`);
    return "";
  }
  let content = fs.readFileSync(wrapperPath, "utf-8");
  const notesIndex = content.indexOf("CATATAN PEMAKAIAN");
  if (notesIndex !== -1) {
    const lastSeparator = content.lastIndexOf("================================================================================", notesIndex);
    if (lastSeparator !== -1) {
      content = content.substring(0, lastSeparator).trim();
    } else {
      content = content.substring(0, notesIndex).trim();
    }
  }
  return content;
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
  imageUrls = []
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

  // Resolve template (builder) based on request type if not already retrieved
  if (requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK") {
    if (!template) {
      console.log(`[UGC-LLM] PRODUCT-CINEMATIC request: Reading product_ad.md as prompt builder`);
      template = fs.readFileSync(path.join(PROMPT_DIR, "product_ad.md"), "utf-8");
    }
  } else if (requestType === "FREE-TRIAL") {
    if (!template) {
      console.log(`[UGC-LLM] FREE-TRIAL request: Reading ugc_free_trial.md as prompt builder`);
      template = fs.readFileSync(path.join(PROMPT_DIR, "ugc_free_trial.md"), "utf-8");
    }
  } else if (requestType === "UGC-P") {
    if (!template) {
      console.log(`[UGC-LLM] UGC-P request: Reading ugc_slim.md as prompt builder`);
      template = fs.readFileSync(path.join(PROMPT_DIR, "ugc_slim.md"), "utf-8");
    }
  } else {
    if (!template) {
      console.log(`[UGC-LLM] legacy monolithic prompt (${requestType})`);
      template = loadLegacyTemplate(requestType, storeType);
    }
  }

  // Build the Product Brief description
  let briefPrompt = "";
  if (requestType === "PRODUCT-CINEMATIC" || requestType === "PRODUCT-CINEMATIK") {
    briefPrompt = `1. {product_description}: ${description}\n2. {video_duration}: ${videoDuration} detik`;
  } else if (requestType === "FREE-TRIAL") {
    briefPrompt = buildLegacyUserPrompt("UGC-P", description, opts);
  } else {
    briefPrompt = buildLegacyUserPrompt(requestType, description, opts);
  }

  // Load Rule Master and construct System Prompt (wrapper + rule master)
  const ruleMaster = await getRuleMaster();
  const wrapperContent = getSystemPromptWrapper();
  const systemPrompt = `${wrapperContent}\n\n${ruleMaster}`;

  // Construct User Prompt (builder template + product brief)
  const userPrompt = `## BUILDER FORMAT PROTOCOL\n${template}\n\n## PRODUCT BRIEF\n${briefPrompt}`;

  const aiResponse = await callLLM(systemPrompt, userPrompt, imageUrls);
  return parseJsonFromLlm(aiResponse);
};

module.exports = {
  generateUgcLlmResponse,
  getRuleMaster,
  getSystemPromptWrapper
};
