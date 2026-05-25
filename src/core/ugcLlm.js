/**
 * UGC LLM: legacy monolith (default) | modular refactor via USE_PROMPT_REFACTOR=true (1× LLM).
 */
const fs = require("fs");
const path = require("path");
const {
  runPromptRefactor,
  parseJsonFromLlm,
} = require("../prompt/promptRefactorPipeline");

const PROMPT_DIR = path.join(__dirname, "../prompt");

const isPromptRefactorEnabled = () =>
  String(process.env.USE_PROMPT_REFACTOR || "").toLowerCase() === "true";

const buildUserVars = (requestType, description, { videoDuration = 15, sellingMode = "hard" } = {}) => {
  if (requestType === "UGC-P") {
    return {
      product_description: description,
      video_duration: videoDuration,
      selling_mode: sellingMode,
    };
  }
  return {
    store_description: description,
    video_duration: videoDuration,
  };
};

const buildLegacyUserPrompt = (requestType, description, { videoDuration = 15, sellingMode = "hard" } = {}) => {
  if (requestType === "UGC-P") {
    return `1. {product_description}: ${description}\n2. {video_duration}: ${videoDuration} detik\n3. {selling_mode}: ${sellingMode}`;
  }
  return `1. {store_description}: ${description}\n2. {video_duration}: ${videoDuration} detik`;
};

const loadLegacyTemplate = (requestType, storeType) => {
  let fileName = "PROMPT_UGC_PRODUCT";
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
  callLLM,
}) => {
  if (requestType !== "UGC-P" && requestType !== "UGC-S") {
    throw new Error(`generateUgcLlmResponse: unsupported requestType ${requestType}`);
  }

  const opts = { videoDuration, sellingMode };

  if (isPromptRefactorEnabled()) {
    console.log(`[UGC-LLM] modular refactor (${requestType}, store=${storeType || "n/a"})`);
    const { variantKey, pipeline_output } = await runPromptRefactor({
      requestType,
      storeType,
      userVars: buildUserVars(requestType, description, opts),
      callLLM,
    });
    return {
      ...pipeline_output,
      prompt_pipeline: {
        version: "1.0",
        variant: variantKey,
      },
    };
  }

  console.log(`[UGC-LLM] legacy monolithic prompt (${requestType})`);
  const template = loadLegacyTemplate(requestType, storeType);
  const userPrompt = buildLegacyUserPrompt(requestType, description, opts);
  const aiResponse = await callLLM(template, userPrompt);
  return parseJsonFromLlm(aiResponse);
};

module.exports = {
  isPromptRefactorEnabled,
  generateUgcLlmResponse,
};
