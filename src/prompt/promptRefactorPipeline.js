/**
 * Modular prompts under prompt/prompt_refactor/ — merged into one system prompt, one LLM call.
 */
const fs = require("fs");
const path = require("path");

const REFACTOR_ROOT = path.join(__dirname, "prompt_refactor");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REFACTOR_ROOT, "manifest.json"), "utf-8")
);

const SHARED_SNIPPETS = ["MERGE_ORCHESTRATOR", "WORD_COUNT_RULES", "GEMINI_VOICES"];

const resolveVariantKey = (requestType, storeType) => {
  if (requestType === "UGC-P") return "UGC-P";
  if (requestType === "UGC-S") {
    return String(storeType || "offline").toLowerCase() === "online"
      ? "UGC-S-online"
      : "UGC-S-offline";
  }
  if (requestType === "PRODUCT") return "PRODUCT";
  return null;
};

const loadLayerPrompt = (variantKey, layerFileName) => {
  const variant = MANIFEST.variants[variantKey];
  if (!variant) throw new Error(`Unknown prompt variant: ${variantKey}`);
  const filePath = path.join(REFACTOR_ROOT, variant.folder, layerFileName);
  return fs.readFileSync(filePath, "utf-8");
};

const loadSharedSnippet = (name) =>
  fs.readFileSync(path.join(REFACTOR_ROOT, "_shared", name), "utf-8");

/** Strip optional markdown fences from LLM JSON responses. */
const parseJsonFromLlm = (raw) => {
  const trimmed = String(raw || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(body);
};

const formatUserVars = (userVars) =>
  Object.entries(userVars)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

/**
 * Gabungkan layer 1–3 + shared rules menjadi satu system prompt.
 */
const buildMergedSystemPrompt = (variantKey) => {
  const variant = MANIFEST.variants[variantKey];
  if (!variant) throw new Error(`Unknown prompt variant: ${variantKey}`);
  const [layer1Name, layer2Name, layer3Name] = variant.layers;

  const sharedBlock = SHARED_SNIPPETS.map((name) => {
    return `### SHARED: ${name}\n${loadSharedSnippet(name)}`;
  }).join("\n\n");

  return [
    sharedBlock,
    "",
    "════════════════════════════════════════",
    "PHASE 1 — PLANNING",
    "════════════════════════════════════════",
    loadLayerPrompt(variantKey, layer1Name),
    "",
    "════════════════════════════════════════",
    "PHASE 2 — SCRIPT WRITER",
    "════════════════════════════════════════",
    loadLayerPrompt(variantKey, layer2Name),
    "",
    "════════════════════════════════════════",
    "PHASE 3 — PROMPT COMPOSER (FINAL OUTPUT SHAPE)",
    "════════════════════════════════════════",
    loadLayerPrompt(variantKey, layer3Name),
  ].join("\n");
};

/**
 * Modular prompts, single LLM call (USE_PROMPT_REFACTOR=true).
 */
const runPromptRefactor = async ({ requestType, storeType, userVars, callLLM }) => {
  const variantKey = resolveVariantKey(requestType, storeType);
  const systemPrompt = buildMergedSystemPrompt(variantKey);
  const userPrompt = formatUserVars(userVars);
  const raw = await callLLM(systemPrompt, userPrompt);
  const pipeline_output = parseJsonFromLlm(raw);

  return {
    variantKey,
    pipeline_output,
  };
};

module.exports = {
  REFACTOR_ROOT,
  MANIFEST,
  resolveVariantKey,
  loadLayerPrompt,
  buildMergedSystemPrompt,
  parseJsonFromLlm,
  runPromptRefactor,
};
