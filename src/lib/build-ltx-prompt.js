"use strict";

/**
 * Sanitize LLM ltx_prompt for LTX/TalkVid:
 * - Remove brand words (TikTok, UGC)
 * - Move negation clauses → ltx_negative_prompt
 * - Replace weak lip-sync phrasing with explicit sync wording
 * - Strip pre-speech smile setup (breaks lip sync in testing)
 * - Strip quoted dialogue when scene is not TalkVid
 */

const BRAND_WORDS_RE = /\b(?:TikTok|UGC)\b/gi;

const SUBTLE_LIP_RE =
  /\b(?:with\s+)?subtle\s+natural\s+lip(?:\s+and\s+head)?\s+movement\s+only\b/gi;

const SUBTLE_LIP_REPLACEMENT =
  "with clear lip movement fully in sync with the spoken line";

/** Khiasan nada/gaya — LTX tidak memicu aksi bicara; ganti dengan speaks langsung. */
const FIGURATIVE_SPEECH_RE =
  /\bspeaks?\s+(?:clearly\s+)?in\s+a\s+[^,"]+(?:tone|manner),?\s*/gi;

const WHILE_SPEAKING_RE = /\bwhile\s+speaking\s+/gi;

const DELIVERS_THEN_SPEAKS_RE =
  /\bdelivers\s+a\s+[^,]+,\s*then\s+speaks\s+/gi;

/** Pre-speech smile/setup before speaks — testing shows this kills lip sync. */
const TALENT_STARTS_WITH_RE =
  /\bThe talent\s+starts?\s+with\s+[^.]+?\s+and\s+speaks\b/gi;

/** Verbose eye-contact fluff before speaks — testing shows this kills lip sync. */
const VERBOSE_EYE_CONTACT_SPEAKS_RES = [
  [
    /\bThe talent\s+looks?\s+directly\s+into\s+the\s+camera\s+with\s+direct\s+eye\s+contact,?\s*eyes\s+locked\s+on\s+(?:the\s+)?lens\s+and\s+speaks\b/gi,
    "The talent looks directly into the camera and speaks",
  ],
  [
    /\blooks?\s+directly\s+into\s+the\s+camera\s+with\s+direct\s+eye\s+contact,?\s*eyes\s+locked\s+on\s+(?:the\s+)?lens\s+and\s+speaks\b/gi,
    "looks directly into the camera and speaks",
  ],
  [
    /\bdirect\s+eye\s+contact\s+with\s+the\s+camera,?\s*eyes\s+locked\s+on\s+(?:the\s+)?lens\s+and\s+speaks\b/gi,
    "looks directly into the camera and speaks",
  ],
  [
    /\bwith\s+direct\s+eye\s+contact,?\s*eyes\s+locked\s+on\s+(?:the\s+)?lens\s+and\s+speaks\b/gi,
    "and speaks",
  ],
];

const PRE_SPEECH_SMILE_RE =
  /(?:,\s*)?starts?\s+with\s+(?:a\s+)?(?:(?:playful|amused|friendly|cheeky)\s+)*(?:(?:\w+)\s+){0,4}smile\s+and\s+/gi;

const SPEAKS_QUOTE_RE =
  /\s*(?:,\s*)?(?:and\s+)?speaks?\s+"[^"]*"(?:\s+with clear lip movement fully in sync with the spoken line)?\.?/gi;

const LIP_SYNC_PHRASE_RE =
  /\bwith clear lip movement fully in sync with the spoken line\.?\s*/gi;

const NEGATIVE_SENTENCE_RE =
  /\b(?:no|not|without|never)\s+[^.!?]+[.!?]?/gi;

const VOICEOVER_POST_RE = /\bvoiceover\s+will\s+be\s+added\s+in\s+post\.?/gi;

const NO_TALKVID_SCENE_TYPES = new Set([
  "reveal_demo",
  "product_hero",
]);

const DEFAULT_TALKVID_NEGATIVES = [
  "no lip movement",
  "no lip sync",
  "no speaking to camera",
  "not speaking to camera",
  "listening to voiceover",
  "no speech",
  "subtle natural lip movement",
];

const DEFAULT_NO_TALKVID_NEGATIVES = [
  "speech",
  "lip sync",
  "dialogue in quotes",
  "speaking to camera",
  "mouth movement",
];

const DEFAULT_LTX_NEGATIVES = [
  "on-screen text",
  "logos",
  "UI",
  "watermark",
  "morphing",
  "flicker",
  "distortion",
  "artifacts",
];

function isTalkvidScene(scene) {
  if (scene?.talkvid === false) return false;
  if (NO_TALKVID_SCENE_TYPES.has(scene?.scene_type)) return false;
  if (scene?.talkvid === true) return true;
  if (scene?.scene_type === "talking_head" || scene?.scene_type === "trial_talent") return true;
  if (scene?.audio_mode === "talking_head") return true;
  if (Array.isArray(scene?.audio_segments)) {
    return scene.audio_segments.some(
      (seg) => seg.talkvid === true || seg.mode === "talking_head"
    );
  }
  return false;
}

function stripBrandWords(text) {
  return String(text || "")
    .replace(BRAND_WORDS_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function splitCsvNegatives(text) {
  const parts = String(text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = [];
  const negatives = [];
  for (const part of parts) {
    if (/^(?:no|not|without|never)\b/i.test(part)) {
      negatives.push(part.replace(/[.;]+$/g, "").trim());
    } else {
      kept.push(part);
    }
  }
  return { kept: kept.join(", "), negatives };
}

function extractNegativeClauses(text) {
  const negatives = [];
  let cleaned = String(text || "");

  for (const re of [VOICEOVER_POST_RE, NEGATIVE_SENTENCE_RE]) {
    cleaned = cleaned.replace(re, (match) => {
      const clause = match.trim().replace(/[.;]+$/g, "");
      if (clause) negatives.push(clause);
      return "";
    });
  }

  const csv = splitCsvNegatives(cleaned);
  cleaned = csv.kept;
  negatives.push(...csv.negatives);

  cleaned = cleaned
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\.\s*\./g, ".")
    .replace(/^\s*[,.]\s*/g, "")
    .replace(/\s*[,.]\s*$/g, "")
    .trim();

  return { cleaned, negatives };
}

function mergeNegativeLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of list) {
      const item = String(raw || "").trim();
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function stripPreSpeechSetup(prompt) {
  return String(prompt || "")
    .replace(TALENT_STARTS_WITH_RE, "The talent speaks")
    .replace(PRE_SPEECH_SMILE_RE, (match) => (match.trim().startsWith(",") ? " and " : ""))
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function stripSpeechForNonTalkvid(prompt) {
  return String(prompt || "")
    .replace(SPEAKS_QUOTE_RE, "")
    .replace(LIP_SYNC_PHRASE_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim();
}

function simplifyEyeContactBeforeSpeaks(prompt) {
  let out = String(prompt || "");
  for (const [re, replacement] of VERBOSE_EYE_CONTACT_SPEAKS_RES) {
    out = out.replace(re, replacement);
  }
  return out
    .replace(/\bThe talent\s+The talent\b/gi, "The talent")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function normalizeExplicitSpeech(prompt, talkvid) {
  if (!talkvid) return stripSpeechForNonTalkvid(prompt);

  return simplifyEyeContactBeforeSpeaks(
    stripPreSpeechSetup(prompt)
      .replace(FIGURATIVE_SPEECH_RE, "speaks ")
      .replace(WHILE_SPEAKING_RE, "")
      .replace(DELIVERS_THEN_SPEAKS_RE, "speaks ")
      .replace(/\bspeaks?\s+to\s+the\s+camera\s+/gi, "speaks ")
      .replace(/\bspeaks?\s{2,}/gi, "speaks ")
      .trim()
  );
}

function collectSceneNegatives(scene) {
  const fromFields = [];
  for (const key of ["ltx_negative_prompt", "negative_prompt", "avoid"]) {
    const val = scene?.[key];
    if (!val) continue;
    if (Array.isArray(val)) {
      fromFields.push(...val);
    } else {
      fromFields.push(
        ...String(val)
          .split(/[,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
  }
  return fromFields;
}

/**
 * @param {object} scene - LLM scene or workflow scene
 * @returns {{ ltx_prompt: string, ltx_negative_prompt: string }}
 */
function buildLtxPromptFields(scene) {
  const raw = String(scene?.ltx_prompt || scene?.prompt || "").trim();
  const talkvid = isTalkvidScene(scene);

  let prompt = "";
  let extracted = [];

  if (raw) {
    prompt = stripBrandWords(raw);
    const { cleaned, negatives } = extractNegativeClauses(prompt);
    prompt = cleaned;
    extracted = negatives;

    if (talkvid) {
      prompt = prompt.replace(SUBTLE_LIP_RE, SUBTLE_LIP_REPLACEMENT);
      prompt = normalizeExplicitSpeech(prompt, true);
    } else {
      prompt = prompt.replace(SUBTLE_LIP_RE, "");
      prompt = normalizeExplicitSpeech(prompt, false);
    }

    prompt = prompt
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.])/g, "$1")
      .replace(/,\s*\./g, ".")
      .replace(/,\s*"/g, ", \"")
      .replace(/"\s+,/g, "\",")
      .replace(/\s+,/g, ",")
      .trim();
  }

  const negativeItems = mergeNegativeLists(
    extracted,
    collectSceneNegatives(scene),
    talkvid ? DEFAULT_TALKVID_NEGATIVES : DEFAULT_NO_TALKVID_NEGATIVES,
    DEFAULT_LTX_NEGATIVES
  );

  return {
    ltx_prompt: prompt,
    ltx_negative_prompt: negativeItems.join(", "),
  };
}

module.exports = {
  buildLtxPromptFields,
  stripBrandWords,
  extractNegativeClauses,
  normalizeExplicitSpeech,
  stripPreSpeechSetup,
  simplifyEyeContactBeforeSpeaks,
  stripSpeechForNonTalkvid,
  isTalkvidScene,
};
