"use strict";

const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { Storage } = require("@google-cloud/storage");
const { GoogleGenAI } = require("@google/genai");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { generateUgcLlmResponse } = require("./ugcLlm");
const { getJakartaISOString } = require("../utils");
const { getSecrets, parseJsonConfig } = require("../lib/config");

const GCS_BUCKET = process.env.GCS_BUCKET;

const parseVeoVideoDurationSeconds = () => {
  const raw = process.env.VEO_VIDEO_DURATION_SECONDS;
  const n = raw != null && String(raw).trim() !== "" ? parseInt(String(raw), 10) : 8;
  return Number.isFinite(n) && n > 0 ? n : 8;
};

const VEO_VIDEO_DURATION_SECONDS = parseVeoVideoDurationSeconds();
const TEXTLESS_VIDEO_INSTRUCTION =
  "The video must be completely textless, with no words, letters, or typography anywhere on the screen. Clean composition.";

const parseVertexServiceAccount = async () => {
  const config = await getSecrets();
  const raw = config.vertex_ai;
  if (!raw) {
    throw new Error("SSM key `vertex_ai` tidak ditemukan.");
  }
  return parseJsonConfig(raw);
};

const parseGcsServiceAccount = async () => {
  const config = await getSecrets();
  const raw = config.s3GcpSA;
  if (!raw) {
    throw new Error("SSM key `s3GcpSA` tidak ditemukan.");
  }
  return parseJsonConfig(raw);
};

/** Normalisasi SA JSON dari SSM (private_key kadang berisi literal \\n). */
const toGoogleAuthCredentials = (sa) => {
  const privateKey = String(sa.private_key || "").replace(/\\n/g, "\n");
  if (!sa.client_email || !privateKey) {
    throw new Error("Service account tidak lengkap (client_email / private_key).");
  }
  return {
    type: sa.type || "service_account",
    project_id: sa.project_id,
    private_key_id: sa.private_key_id,
    private_key: privateKey,
    client_email: sa.client_email,
    client_id: sa.client_id,
    auth_uri: sa.auth_uri || "https://accounts.google.com/o/oauth2/auth",
    token_uri: sa.token_uri || "https://oauth2.googleapis.com/token",
  };
};

const createVertexClients = async () => {
  const vertexSa = await parseVertexServiceAccount();
  const gcsSa = await parseGcsServiceAccount();
  const location = process.env.VERTEX_LOCATION || "us-central1";
  const modelVeo = process.env.VEO_MODEL || "veo-2.0-generate-001";
  const vertexCredentials = toGoogleAuthCredentials(vertexSa);
  const gcsCredentials = toGoogleAuthCredentials(gcsSa);

  const gcs = new Storage({
    projectId: gcsSa.project_id,
    credentials: {
      client_email: gcsCredentials.client_email,
      private_key: gcsCredentials.private_key,
    },
  });

  const ai = new GoogleGenAI({
    vertexai: true,
    project: vertexSa.project_id,
    location,
    googleAuthOptions: {
      credentials: vertexCredentials,
    },
  });

  return { ai, gcs, modelVeo };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGeminiTextWithRetry(ai, systemPrompt, userPrompt, retries = 4) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const result = await ai.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        config: { systemInstruction: systemPrompt },
      });
      const text = result?.text;
      if (!text) throw new Error("Gemini text response kosong.");
      return text;
    } catch (err) {
      lastErr = err;
      if (i === retries) break;
      await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

async function createImageFromPrompt(ai, inputImage, inputMimeType, prompt) {
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: inputMimeType, data: inputImage.toString("base64") } },
          { text: prompt },
        ],
      },
    ],
  });

  const candidates = result?.candidates || [];
  for (const c of candidates) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      if (p?.inlineData?.data) {
        return {
          buffer: Buffer.from(p.inlineData.data, "base64"),
          mimeType: p.inlineData.mimeType || "image/png",
        };
      }
    }
  }
  throw new Error("Gemini image response tidak mengandung inlineData image.");
}

async function getFirstInputImageBuffer(s3, bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const mimeType = res.ContentType || "image/png";
  return { buffer, mimeType };
}

async function uploadBufferToGcs(gcs, bucketName, objectName, buffer, contentType) {
  const file = gcs.bucket(bucketName).file(objectName);
  await file.save(buffer, { contentType, resumable: false });
  return `gs://${bucketName}/${objectName}`;
}

async function processFreeTrialJob(params) {
  const {
    job,
    s3,
    dynamo,
    USER_REQUEST_TABLE,
    S3_RESOURCE_BUCKET,
  } = params;

  const now = getJakartaISOString();
  const FREE_TRIAL_BACKEND = process.env.FREE_TRIAL_BACKEND || "comfyui";

  if (FREE_TRIAL_BACKEND === "comfyui") {
    console.log("[FreeTrial] Running Free Trial under comfyui backend for job", job.uuid);
    const { callOpenAILLM, callGeminiAudio, uploadToS3, getRedis, pickComfyApiKey, getComfyApiKeys } = require("../services");
    const { generateTTS } = require("./tts");
    const { generateMultiScenePipeline } = require("./multiSceneGeneration");
    const { buildTtsGlobalConfig, syncGenderFields } = require("../lib/resolve-voice");

    const redis = getRedis();
    const comfyApiKey = undefined;

    let videoPromptId;
    try {
      console.log("[FreeTrial] Generating LLM response using comfyui / ugc_free_trial.md");
      const llmResponse = await generateUgcLlmResponse({
        requestType: "FREE-TRIAL", // will load ugc_free_trial.md
        prompt: job.prompt,
        storeType: job.store_type || "offline",
        sellingMode: "soft",
        videoDuration: 10,
        lipSync: false,
        callLLM: callOpenAILLM,
      });

      if (llmResponse.voiceover_script && typeof llmResponse.voiceover_script === "object") {
        if (!llmResponse.tts_script) {
          llmResponse.tts_script = llmResponse.voiceover_script.tts_script || llmResponse.voiceover_script.script;
        }
        if (llmResponse.voiceover_script.word_count != null && llmResponse.tts_word_count == null) {
          llmResponse.tts_word_count = llmResponse.voiceover_script.word_count;
        }
      }
      syncGenderFields(llmResponse);
      llmResponse.tts_global_config = buildTtsGlobalConfig(llmResponse, {
        voiceSelectionMode: job.voice_selection_mode || llmResponse.meta?.voice_selection_mode,
        preferredVoice: job.preferred_voice || llmResponse.meta?.preferred_voice,
      });
      if (llmResponse.voiceover_script && llmResponse.tts_global_config?.voice_name) {
        llmResponse.voiceover_script.voice_name = llmResponse.tts_global_config.voice_name;
      }
      console.log(
        `[FreeTrial] TTS voice resolved: gender=${llmResponse.tts_global_config.gender}, voice=${llmResponse.tts_global_config.voice_name}`
      );

      await dynamo.send(new UpdateCommand({
        TableName: USER_REQUEST_TABLE,
        Key: { uuid: job.uuid, user_email: job.user_email },
        UpdateExpression: "SET llm_response = :lr, updated_at = :now",
        ExpressionAttributeValues: { ":lr": llmResponse, ":now": now }
      }));

      let ttsResult = null;
      const hasTtsScript = !!llmResponse.tts_script;
      if (hasTtsScript) {
        const ttsGlobalConfig = llmResponse.tts_global_config || buildTtsGlobalConfig(llmResponse, {
          voiceSelectionMode: job.voice_selection_mode,
          preferredVoice: job.preferred_voice,
        });
        console.log("[FreeTrial] Generating TTS audio...");
        ttsResult = await generateTTS({
          jobId: job.uuid,
          userEmail: job.user_email,
          userId: job.user_id,
          llmResponse: { ...llmResponse, tts_global_config: ttsGlobalConfig },
          S3_RESOURCE_BUCKET,
          dynamo,
          USER_REQUEST_TABLE,
          callGeminiAudio,
          uploadToS3
        });
      }

      if (!ttsResult || !ttsResult.audioS3Key) {
        console.error(`[FreeTrial] TTS Generation FAILED or script missing for job ${job.uuid}. Failing request.`);
        throw new Error("TTS Generation failed or voiceover script missing.");
      } else {
        console.log(`[FreeTrial] TTS Generation SUCCESS for job ${job.uuid}. Audio S3 Key: ${ttsResult.audioS3Key}`);
      }

      // Resolve signed URLs of product & talent images
      const resolvedImageUrls = [];
      if (Array.isArray(job.s3ImageUrls) && job.s3ImageUrls.length > 0) {
        resolvedImageUrls.push(...job.s3ImageUrls);
      } else if (job.s3_keys && job.s3_keys.length > 0) {
        for (const key of job.s3_keys) {
          if (key && typeof key === "string" && key.trim() !== "" && key !== "null" && key !== "undefined") {
            const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
            const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
            resolvedImageUrls.push(signedUrl);
          }
        }
      }

      console.log("[FreeTrial] Triggering dynamic multi-scene video pipeline...");
      videoPromptId = await generateMultiScenePipeline({
        jobId: job.uuid,
        userEmail: job.user_email,
        userId: job.user_id,
        currentS3ImageUrls: resolvedImageUrls,
        llmResponse,
        finalJobPrompt: job.prompt,
        videoQuality: job.video_quality || "720p",
        aspectRatio: job.aspect_ratio || "9:16",
        S3_RESOURCE_BUCKET,
        dynamo,
        s3,
        USER_REQUEST_TABLE,
        comfyApiKey,
        audio: ttsResult?.audioS3Key || null,
        audioDuration: ttsResult?.duration || null,
        requestType: "FREE-TRIAL"
      });
    } catch (err) {
      if (redis && comfyApiKey) {
        try {
          const redisKey = `comfyui_job_${comfyApiKey}`;
          await redis.decr(redisKey);
          console.log(`[Redis] Decremented ${redisKey} in Free Trial catch block due to error: ${err.message}`);
        } catch (rErr) {
          console.error("[Redis] Error decrementing in Free Trial catch block:", rErr.message);
        }
      }
      throw err;
    }

    console.log("[FreeTrial] Dynamic video generation workflow queued successfully. Prompt ID:", videoPromptId);
    return {
      operationName: null,
      comfyPromptId: videoPromptId,
    };
  }

  // Fallback to legacy Vertex AI (Veo) flow
  console.log("[FreeTrial] Running Free Trial under vertex_ai backend for job", job.uuid);
  const { ai, gcs, modelVeo } = await createVertexClients();

  const requestType =
    job.ugc_mode === "toko" ? "UGC-S" : "UGC-P";
  console.log("[FreeTrial] Generating LLM response for job", job.uuid);
  const llmResponse = await generateUgcLlmResponse({
    requestType,
    prompt: job.prompt,
    storeType: job.store_type || "offline",
    sellingMode: "soft",
    videoDuration: VEO_VIDEO_DURATION_SECONDS,
    lipSync: false,
    callLLM: (systemPrompt, userPrompt) =>
      callGeminiTextWithRetry(ai, systemPrompt, userPrompt),
  });

  console.log("[FreeTrial] Refining ltx_prompt to remove voiceover");
  const llmResponseNoVoiceover = await generateUgcLlmResponse({
    requestType,
    prompt: `${llmResponse?.ltx_prompt || job.prompt}\n\nInstruksi tambahan: hilangkan voiceover. Pastikan ltx_prompt final tidak mengandung narasi voiceover, tidak ada dialog, dan tidak ada kutipan ucapan. Fokus hanya pada arahan visual/motion.`,
    storeType: job.store_type || "offline",
    sellingMode: "soft",
    videoDuration: VEO_VIDEO_DURATION_SECONDS,
    lipSync: false,
    callLLM: (systemPrompt, userPrompt) =>
      callGeminiTextWithRetry(ai, systemPrompt, userPrompt),
  });

  const firstInputKey = Array.isArray(job.s3_keys) ? job.s3_keys[0] : null;
  if (!firstInputKey) {
    throw new Error("Input gambar free trial tidak ditemukan.");
  }

  const { buffer: inputBuffer, mimeType: inputMimeType } =
    await getFirstInputImageBuffer(s3, S3_RESOURCE_BUCKET, firstInputKey);

  const imagePrompt =
    llmResponse?.image_generation?.hero_frame?.prompt ||
    llmResponse?.image_generation?.product_frame?.prompt ||
    llmResponse?.image_generation?.prompt ||
    job.prompt;
  console.log("[FreeTrial] Image prompt", imagePrompt);
  const generatedImage = await createImageFromPrompt(
    ai,
    inputBuffer,
    inputMimeType,
    imagePrompt
  );

  const generatedImageS3Key = `generated_image/${job.user_id}/${job.uuid}_free_trial.png`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_RESOURCE_BUCKET,
      Key: generatedImageS3Key,
      Body: generatedImage.buffer,
      ContentType: generatedImage.mimeType,
    })
  );

  await dynamo.send(
    new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: job.uuid, user_email: job.user_email },
      UpdateExpression:
        "SET llm_response = :llm, generated_image = :gi, s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys), updated_at = :now",
      ExpressionAttributeValues: {
        ":llm": llmResponse,
        ":gi": generatedImageS3Key,
        ":empty_list": [],
        ":newKeys": [generatedImageS3Key],
        ":now": now,
      },
    })
  );

  if (!GCS_BUCKET) {
    throw new Error("GCS_BUCKET env belum di-set.");
  }

  console.log("[FreeTrial] Uploading input image to GCS");
  const gcsInputUri = await uploadBufferToGcs(
    gcs,
    GCS_BUCKET,
    `${job.uuid}/input.png`,
    generatedImage.buffer,
    generatedImage.mimeType
  );

  const videoPromptBase =
    llmResponseNoVoiceover?.ltx_prompt ||
    llmResponse?.ltx_prompt ||
    job.prompt;
  const videoPrompt = `${videoPromptBase}\n\n${TEXTLESS_VIDEO_INSTRUCTION}`;
  console.log("[FreeTrial] Video prompt", videoPrompt);

  console.log("[FreeTrial] Generating video with model", modelVeo);
  const operation = await ai.models.generateVideos({
    model: modelVeo,
    source: {
      prompt: videoPrompt,
      image: {
        gcsUri: gcsInputUri,
        mimeType: generatedImage.mimeType,
      },
    },
    config: {
      aspectRatio: job.aspect_ratio || "9:16",
      resolution: "720p",
      durationSeconds: VEO_VIDEO_DURATION_SECONDS,
      outputGcsUri: `gs://${GCS_BUCKET}/${job.uuid}/`,
    },
  });

  await dynamo.send(
    new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: job.uuid, user_email: job.user_email },
      UpdateExpression:
        "SET #s = :status, vertex_operation_name = :op, gcs_output_uri = :gcs, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":status": "PROCESSING",
        ":op": operation?.name || null,
        ":gcs": `gs://${GCS_BUCKET}/${job.uuid}/`,
        ":now": getJakartaISOString(),
      },
    })
  );

  console.log("[FreeTrial] Video generated successfully");
  return {
    operationName: operation?.name || null,
    generatedImageS3Key,
    gcsInputUri,
    llmResponseNoVoiceover,
    videoPromptPreview: videoPrompt,
  };
}

module.exports = {
  processFreeTrialJob,
};

