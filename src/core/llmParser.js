"use strict";

function normalizeLlmJsonText(text) {
  return String(text || "")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function stripMarkdownFences(text) {
  let t = String(text || "").trim();
  const fullFence = t.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fullFence) return fullFence[1].trim();
  const inner = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (inner) return inner[1].trim();
  return t;
}

function removeTrailingCommas(jsonStr) {
  return jsonStr.replace(/,\s*([}\]])/g, "$1");
}

function repairSingleQuotedJson(jsonStr) {
  return jsonStr
    .replace(/'([^'\\]*?)'\s*:/g, '"$1":')
    .replace(/:\s*'([^'\\]*?)'/g, ': "$1"');
}

function escapeControlCharsInStrings(text) {
  const s = String(text || "");
  let out = "";
  let inString = false;
  let quote = null;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === quote) {
        out += ch;
        inString = false;
        quote = null;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code >= 0 && code < 0x20) {
        out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = null;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseStandardLlmResponse(raw) {
  const original = String(raw || "").trim();
  const stripped = stripMarkdownFences(original);
  const normalized = escapeControlCharsInStrings(normalizeLlmJsonText(stripped));

  const candidates = [
    normalized,
    removeTrailingCommas(normalized),
    repairSingleQuotedJson(normalized),
    repairSingleQuotedJson(removeTrailingCommas(normalized))
  ];

  const firstObj = extractFirstJsonObject(normalized);
  if (firstObj) {
    candidates.push(firstObj);
    candidates.push(removeTrailingCommas(firstObj));
    candidates.push(repairSingleQuotedJson(firstObj));
    candidates.push(repairSingleQuotedJson(removeTrailingCommas(firstObj)));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        if (!parsed.product) parsed.product = {};
        if (!parsed.locks) parsed.locks = {};
        if (!parsed.scenes) parsed.scenes = [];
        return parsed;
      }
    } catch (err) {
      // continue trying
    }
  }

  try {
    const simpleParsed = JSON.parse(stripped);
    if (simpleParsed && typeof simpleParsed === "object") {
      return simpleParsed;
    }
  } catch (err) {}

  console.error("LLM JSON Parse Error. Raw Response:", original);
  throw new Error(`Gagal memparsing JSON response dari LLM. Response: ${original.substring(0, 1000)}`);
}

module.exports = {
  parseStandardLlmResponse
};
