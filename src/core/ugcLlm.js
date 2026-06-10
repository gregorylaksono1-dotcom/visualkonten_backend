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
  if (requestType !== "UGC-P" && requestType !== "UGC-S" && requestType !== "FREE-TRIAL") {
    throw new Error(`generateUgcLlmResponse: unsupported requestType ${requestType}`);
  }

  const opts = { videoDuration, sellingMode, lipSync };

  if (requestType === "FREE-TRIAL") {
    console.log(`[UGC-LLM] FREE-TRIAL request: Reading and sending ugc_free_trial.md as prompt builder to OpenAI`);
    const template = fs.readFileSync(path.join(PROMPT_DIR, "ugc_free_trial.md"), "utf-8");
    const userPrompt = buildLegacyUserPrompt("UGC-P", description, opts);
    const aiResponse = await callLLM(template, userPrompt);
    return parseJsonFromLlm(aiResponse);
  }

  if (requestType === "UGC-P") {
    console.log(`[UGC-LLM] UGC-P request: Reading and sending ugc_slim.md as prompt builder to OpenAI`);
    const template = fs.readFileSync(path.join(PROMPT_DIR, "ugc_slim.md"), "utf-8");
    const userPrompt = buildLegacyUserPrompt(requestType, description, opts);
    const aiResponse = await callLLM(template, userPrompt);
    return parseJsonFromLlm(aiResponse);
  }

  console.log(`[UGC-LLM] legacy monolithic prompt (${requestType})`);
  const template = loadLegacyTemplate(requestType, storeType);
  const userPrompt = buildLegacyUserPrompt(requestType, description, opts);
  const aiResponse = await callLLM(template, userPrompt);
  return parseJsonFromLlm(aiResponse);
};

module.exports = {
  generateUgcLlmResponse,
};
