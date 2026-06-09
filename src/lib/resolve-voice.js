"use strict";

const ALLOWED_VOICES = {
  male: ["Puck", "Charon", "Fenrir", "Achird", "Iapetus", "Algenib"],
  female: ["Aoede", "Kore", "Achernar", "Callirrhoe", "Despina", "Gacrux"],
};

const DEFAULT_VOICE_BY_GENDER = {
  male: "Charon",
  female: "Kore",
};

function normalizeGender(value) {
  const g = String(value || "").trim().toLowerCase();
  if (g === "male" || g === "m" || g === "pria" || g === "laki") return "male";
  if (g === "female" || g === "f" || g === "wanita" || g === "perempuan") return "female";
  return "";
}

function resolveTalentGender(llmResponse) {
  const tid = llmResponse?.talent_identity || {};
  const vs = llmResponse?.voiceover_script || {};
  return normalizeGender(tid.gender) || normalizeGender(vs.gender) || "female";
}

function isVoiceAllowedForGender(voiceName, gender) {
  const pool = ALLOWED_VOICES[gender] || ALLOWED_VOICES.female;
  return pool.includes(String(voiceName || "").trim());
}

/**
 * Sync voiceover_script.gender from talent_identity when only one is set.
 */
function syncGenderFields(llmResponse) {
  if (!llmResponse || typeof llmResponse !== "object") return llmResponse;

  const tid = llmResponse.talent_identity || {};
  const vs = llmResponse.voiceover_script || {};
  const tidGender = normalizeGender(tid.gender);
  const vsGender = normalizeGender(vs.gender);
  const gender = tidGender || vsGender;

  if (!gender) return llmResponse;

  if (!llmResponse.talent_identity) llmResponse.talent_identity = {};
  if (!llmResponse.voiceover_script) llmResponse.voiceover_script = {};

  llmResponse.talent_identity.gender = gender;
  llmResponse.voiceover_script.gender = gender;

  if (!llmResponse.voiceover_script.allowed_voices) {
    llmResponse.voiceover_script.allowed_voices = ALLOWED_VOICES;
  }

  return llmResponse;
}

/**
 * @param {object} llmResponse
 * @param {{ voiceSelectionMode?: string, preferredVoice?: string }} [options]
 */
function resolveVoiceName(llmResponse, options = {}) {
  const gender = resolveTalentGender(llmResponse);
  const pool = ALLOWED_VOICES[gender] || ALLOWED_VOICES.female;
  const vs = llmResponse?.voiceover_script || {};
  const mode =
    options.voiceSelectionMode ||
    vs.voice_selection_mode ||
    llmResponse?.meta?.voice_selection_mode ||
    "llm_cast";

  if (mode === "user_pick" && options.preferredVoice) {
    const pick = String(options.preferredVoice).trim();
    if (isVoiceAllowedForGender(pick, gender)) return pick;
  }

  if (mode === "random") {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const candidate = String(vs.voice_name || "").trim();
  if (isVoiceAllowedForGender(candidate, gender)) return candidate;

  return DEFAULT_VOICE_BY_GENDER[gender] || DEFAULT_VOICE_BY_GENDER.female;
}

/**
 * Build tts_global_config with gender-valid voice (never default Aoede for male).
 */
function buildTtsGlobalConfig(llmResponse, options = {}) {
  syncGenderFields(llmResponse);
  const vs = llmResponse?.voiceover_script || {};
  const existing = llmResponse?.tts_global_config || {};
  const voiceName = resolveVoiceName(llmResponse, options);

  return {
    voice_name: voiceName,
    speaking_rate: existing.speaking_rate ?? llmResponse?.voice_profile?.speaking_rate ?? 1.0,
    pitch: existing.pitch ?? llmResponse?.voice_profile?.pitch ?? 0.0,
    gender: resolveTalentGender(llmResponse),
    tts_script: vs.tts_script || llmResponse?.tts_script || "",
  };
}

module.exports = {
  ALLOWED_VOICES,
  DEFAULT_VOICE_BY_GENDER,
  normalizeGender,
  resolveTalentGender,
  isVoiceAllowedForGender,
  syncGenderFields,
  resolveVoiceName,
  buildTtsGlobalConfig,
};
