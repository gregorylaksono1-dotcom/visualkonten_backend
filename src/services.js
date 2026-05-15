/**
 * Service functions for Worker A (DB, Storage, Queue, External APIs)
 */

"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { Redis } = require("@upstash/redis");
const { parseCreditsFromPricingItem, buildCreditStatusFilterParts } = require("./utils");

const region = process.env.AWS_REGION || "ap-southeast-1";
const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({ region });
const lambdaClient = new LambdaClient({ region });
let secretsClient = null; // Lazy init

const PRICING_TABLE_NAME = process.env.PRICING_TABLE_NAME;
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const WORKER_B_QSTASH_URL = process.env.WORKER_B_QSTASH_URL;
const COMFYUI_FUNCTION_NAME = process.env.COMFYUI_FUNCTION_NAME;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const MIDTRANS_API_URL = process.env.MIDTRANS_API_URL;
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";

// Redis Singleton
let _redis;
const getRedis = () => {
  if (!_redis) {
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;
    _redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  }
  return _redis;
};

const triggerWorkerBOnce = async () => {
  if (!QSTASH_TOKEN || !WORKER_B_QSTASH_URL) return;
  await fetch(`https://qstash-eu-central-1.upstash.io/v2/publish/${WORKER_B_QSTASH_URL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${QSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: "worker_a" }),
  });
};

const enqueueJob = async (jobId, jobDetail) => {
  const redis = getRedis();
  if (!redis) return;
  try {
    const slimDetail = {
      uuid: jobId,
      user_email: jobDetail.user_email,
      user_id: jobDetail.user_id,
      status: "PENDING",
    };
    await redis.set(`job_detail:${jobId}`, JSON.stringify(slimDetail));
    await redis.lpush("task_queue", jobId);
    const flagSet = await redis.set("is_worker_active", "1", { ex: 60, nx: true });
    if (flagSet === "OK" || flagSet === 1) {
      await triggerWorkerBOnce();
    }
  } catch (err) {
    console.error("enqueueJob error:", err.message);
  }
};

const invokeComfyUI = async (jobId, jobDetail) => {
  if (!COMFYUI_FUNCTION_NAME) return;

  let s3ImageUrls = jobDetail.s3ImageUrls || [];
  if (!s3ImageUrls.length && jobDetail.s3_keys && jobDetail.s3_keys.length > 0) {
    s3ImageUrls = [];
    for (const key of jobDetail.s3_keys) {
      const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: key });
      s3ImageUrls.push(await getSignedUrl(s3Client, cmd, { expiresIn: 3600 }));
    }
  }

  const payload = {
    jobId,
    userEmail: jobDetail.userEmail || jobDetail.user_email,
    userId: jobDetail.userId || jobDetail.user_id,
    requestType: jobDetail.requestType || jobDetail.request_type,
    prompt: jobDetail.prompt,
    videoQuality: jobDetail.videoQuality || jobDetail.video_quality,
    aspectRatio: jobDetail.aspectRatio || jobDetail.aspect_ratio,
    s3ImageUrls,
  };

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: COMFYUI_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify(payload),
    }));
  } catch (err) {
    console.error("invokeComfyUI error:", err.message);
  }
};

const resolvePricingRow = async (decodedKey) => {
  if (!PRICING_TABLE_NAME || !decodedKey) return null;
  const k = String(decodedKey).trim();
  try {
    const getRes = await docClient.send(new GetCommand({
      TableName: PRICING_TABLE_NAME,
      Key: { key: k, charge: "default" },
    }));
    if (getRes.Item) {
      const n = parseCreditsFromPricingItem(getRes.Item);
      if (Number.isFinite(n) && n > 0) return { amount: n, item: getRes.Item };
    }
    const q = await docClient.send(new QueryCommand({
      TableName: PRICING_TABLE_NAME,
      KeyConditionExpression: "#kk = :k",
      ExpressionAttributeNames: { "#kk": "key" },
      ExpressionAttributeValues: { ":k": k },
      Limit: 1,
    }));
    const item = q.Items?.[0];
    if (!item) return null;
    const n = parseCreditsFromPricingItem(item);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { amount: n, item };
  } catch (err) {
    console.error("resolvePricingRow error:", err.message);
    return null;
  }
};

const scanUserRequestsForUsage = async (tableName, emails, sinceIso, maxItems) => {
  if (!emails.length) return [];
  const emailSet = new Set(emails.map((e) => String(e || "").trim().toLowerCase()));
  const collected = [];
  let exclusiveStartKey;
  let pages = 0;
  while (collected.length < maxItems && pages < 20) {
    pages++;
    const res = await docClient.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: exclusiveStartKey,
      Limit: 200,
    }));
    for (const item of res.Items || []) {
      const ue = String(item.user_email || "").trim().toLowerCase();
      if (!emailSet.has(ue)) continue;
      const ca = item.created_at;
      if (ca && ca < sinceIso) continue;
      collected.push(item);
    }
    exclusiveStartKey = res.LastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }
  collected.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return collected.slice(0, maxItems);
};

const queryCreditHistoryPaged = async (userEmail, filterParts, maxItems, pageSize, maxPages, startKey = null) => {
  const table = process.env.TOPUP_CREDIT_TABLE_NAME;
  const index = process.env.TOPUP_CREDIT_USER_EMAIL_INDEX;
  const collected = [];
  let exclusiveStartKey = startKey;
  let pages = 0;
  let finalLastEvaluatedKey = null;

  while (pages < maxPages && collected.length < maxItems) {
    pages++;
    const params = {
      TableName: table,
      IndexName: index,
      KeyConditionExpression: "user_email = :email",
      ExpressionAttributeValues: { ":email": userEmail, ...(filterParts?.ExpressionAttributeValues || {}) },
      ScanIndexForward: false,
      Limit: pageSize,
      ExclusiveStartKey: exclusiveStartKey,
    };
    if (filterParts?.FilterExpression) params.FilterExpression = filterParts.FilterExpression;
    if (filterParts?.ExpressionAttributeNames) params.ExpressionAttributeNames = filterParts.ExpressionAttributeNames;
    const res = await docClient.send(new QueryCommand(params));
    for (const item of res.Items || []) {
      collected.push(item);
      if (collected.length >= maxItems) break;
    }
    exclusiveStartKey = res.LastEvaluatedKey;
    finalLastEvaluatedKey = res.LastEvaluatedKey;
    if (collected.length >= maxItems || !exclusiveStartKey) break;
  }
  return { items: collected, lastEvaluatedKey: finalLastEvaluatedKey };
};

const getLatestCreditMetrics = async (userEmail) => {
  const table = process.env.TOPUP_CREDIT_TABLE_NAME;
  const index = process.env.TOPUP_CREDIT_USER_EMAIL_INDEX;
  const res = await docClient.send(new QueryCommand({
    TableName: table,
    IndexName: index,
    KeyConditionExpression: "user_email = :email",
    ExpressionAttributeValues: { ":email": userEmail },
    ScanIndexForward: false,
    Limit: 20,
  }));
  const items = res.Items || [];
  const latestItem = items[0] || {};
  const usageFromItems = items.reduce((total, item) => total + Number(item.usage || 0), 0);
  const usage = Number(latestItem.usage ?? usageFromItems ?? 0);
  const balance = Number(latestItem.balance ?? 0);
  return { usage, balance, tailItems: items };
};

const sumSuccessfulSpending = async (userEmail) => {
  const filterParts = buildCreditStatusFilterParts("success");
  const res = await queryCreditHistoryPaged(userEmail, filterParts, 5000, 80, 80);
  return res.items.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
};

const createMidtransSnapTransaction = async (midtransBody) => {
  const serverKey = await getMidtransServerKey() || MIDTRANS_SERVER_KEY;
  if (!MIDTRANS_API_URL || !serverKey) {
    throw new Error("Midtrans API URL or Server Key is not configured.");
  }
  const auth = Buffer.from(`${serverKey}:`).toString("base64");
  const res = await fetch(MIDTRANS_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(midtransBody),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Midtrans API failed (${res.status}): ${text}`);
  }
  return await res.json();
};

const uploadToS3 = async (bucket, key, buffer, contentType) => {
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
};

const MAIN_SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-1:084375570459:secret:VisualKonten-sLUo5Q";

let _cachedSecrets = null;
const getSecrets = async () => {
  if (_cachedSecrets) return _cachedSecrets;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    if (!secretsClient) secretsClient = new SecretsManagerClient({ region });
    const data = await secretsClient.send(new GetSecretValueCommand({ SecretId: MAIN_SECRET_ARN }));
    _cachedSecrets = JSON.parse(data.SecretString);
    return _cachedSecrets;
  } catch (err) {
    console.error("Failed to fetch consolidated secrets:", err);
    return {};
  }
};

const getOpenAiKey = async () => {
  const secrets = await getSecrets();
  return secrets.open_ai || null;
};


const getGeminiKey = async () => {
  const secrets = await getSecrets();
  return secrets.gemini_api_key || null;
};

const getMidtransServerKey = async () => {
  const secrets = await getSecrets();
  return secrets.midtrans_server_key || null;
};

const getGoogleClientId = async () => {
  const secrets = await getSecrets();
  return secrets.google_client_id || null;
};

const getGoogleClientSecret = async () => {
  const secrets = await getSecrets();
  return secrets.google_client_secret || null;
};

const getComfyApiKeys = async () => {
  const secrets = await getSecrets();
  return secrets.comfy_api_key || null;
};

const callOpenAILLM = async (systemPrompt, userPrompt) => {
  console.log("Starting OpenAI gpt-4.1 call...");
  const apiKey = await getOpenAiKey();
  if (!apiKey) {
    console.error("OpenAI API Key not found in Secrets Manager.");
    throw new Error("OpenAI API Key not found.");
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 1.25,
        top_p: 0.95,
        frequency_penalty: 0.6,
        presence_penalty: 0.8
      })
    });

    if (!response.ok) {
      const errorJson = await response.json().catch(() => ({}));
      console.error(`OpenAI API error: ${response.status}`, JSON.stringify(errorJson));
      throw new Error(`OpenAI API error: ${response.status} ${JSON.stringify(errorJson)}`);
    }

    const json = await response.json();
    console.log("OpenAI gpt-4.1 call successful.");
    return json.choices[0].message.content.trim();
  } catch (err) {
    console.error("OpenAI request failed:", err.message);
    throw err;
  }
};

const callGeminiAudio = async (text, config) => {
  console.log("Starting Gemini Audio (Multimodal TTS) call...");
  try {
    const apiKey = await getGeminiKey();
    if (!apiKey) {
      throw new Error("Gemini API Key not found in Secrets Manager.");
    }

    const modelId = "gemini-3.1-flash-tts-preview";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    let voiceName = config?.voice_name || "Aoede";
    if (typeof voiceName === "object" && voiceName.S) {
      voiceName = voiceName.S;
    }

    const speakingRate = config?.speaking_rate || 1.0;
    const pitch = config?.pitch || 0.0;
    let finalPrompt = text;

    if (speakingRate !== 1.0 || pitch !== 0.0) {
      let instructions = "[System Instruction: ";
      if (speakingRate !== 1.0) instructions += `Speaking rate: ${speakingRate}x. `;
      if (pitch !== 0.0) instructions += `Pitch: ${pitch > 0 ? 'higher' : 'lower'}. `;
      instructions += "]\n\n";
      finalPrompt = instructions + text;
    }

    const payload = {
      contents: [{ parts: [{ text: finalPrompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName
            }
          }
        }
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini API error: ${response.status}`, errorText);
      throw new Error(`Gemini API error: ${response.status} ${errorText}`);
    }

    const json = await response.json();
    const audioPart = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType.includes("audio"));

    if (!audioPart) {
      console.error("Gemini Response Body:", JSON.stringify(json));
      throw new Error("No audio content returned from Gemini.");
    }

    console.log("Gemini Audio call successful.");
    return audioPart.inlineData.data; // This is base64 string
  } catch (err) {
    console.error("Gemini Audio request failed:", err.message);
    throw err;
  }
};

/**
 * Pick an available ComfyUI API Key from the provided list based on Redis job counts.
 * Maximum concurrent jobs per key is 1.
 */
const pickComfyApiKey = async (apiKeysString, redis) => {
  if (!apiKeysString || !redis) return null;
  const keys = apiKeysString.split(",").map(k => k.trim()).filter(k => k);
  if (keys.length === 0) return null;
  console.log(`[Worker] Keys: ${keys}`);
  for (const key of keys) {
    const redisKey = `comfyui_job_${key}`;
    const count = await redis.get(redisKey);
    console.log(`[Worker] Count: ${count} for key ${key}`);
    const currentCount = parseInt(count || "0");
    const maxJobs = parseInt(process.env.COMFY_MAX_CONCURRENT_JOBS || "1");
    if (currentCount < maxJobs) {
      console.log(`Picking key ${key}`)
      // Pick this key and increment
      await redis.incr(redisKey);
      await redis.expire(redisKey, 600); // Auto-release after 10 mins if something goes wrong
      console.log(`[Redis] Picked API Key and incremented ${redisKey} (TTL: 10m)`);
      return key;
    }
  }
  return null;
};

const COMFY_BASE_URL = "https://cloud.comfy.org";

const uploadInputImage = async (imageUrl, filename = "input_image.png", apiKey) => {
  if (!apiKey) throw new Error("API Key is required for uploadInputImage");
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Gagal download input image: ${imageRes.status}`);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

  const formData = new FormData();
  formData.append("image", new Blob([imageBuffer]), filename);
  formData.append("overwrite", "true");

  const uploadRes = await fetch(`${COMFY_BASE_URL}/api/upload/image`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: formData,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`ComfyUI image upload failed: ${text}`);
  }
  const data = await uploadRes.json();
  return data.name;
};

const uploadInputAudio = async (audioUrl, filename = "input_audio.wav", apiKey) => {
  if (!apiKey) throw new Error("API Key is required for uploadInputAudio");
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error(`Gagal download input audio: ${audioRes.status}`);
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  const formData = new FormData();
  formData.append("audio", new Blob([audioBuffer]), filename);
  formData.append("overwrite", "true");

  const uploadRes = await fetch(`${COMFY_BASE_URL}/api/upload/audio`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: formData,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`ComfyUI audio upload failed: ${text}`);
  }
  const data = await uploadRes.json();
  return data.name;
};

const submitWorkflow = async (workflow, apiKey) => {
  if (!apiKey) throw new Error("API Key is required for submitWorkflow");
  const res = await fetch(`${COMFY_BASE_URL}/api/prompt`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ComfyUI submit failed: ${text}`);
  }
  const data = await res.json();
  return data.prompt_id;
};

const resolveSignedUrl = async (fileInfo, apiKey) => {
  if (!fileInfo?.filename || !apiKey) return null;
  const params = new URLSearchParams({ 
    filename: fileInfo.filename, 
    subfolder: fileInfo.subfolder || "", 
    type: fileInfo.type || "output" 
  });
  const res = await fetch(`${COMFY_BASE_URL}/api/view?${params}`, { 
    headers: { "X-API-Key": apiKey }, 
    redirect: "manual" 
  });
  return res.headers.get("location");
};

const getOutputUrl = async (promptId, apiKey) => {
  const res = await fetch(`${COMFY_BASE_URL}/api/jobs/${promptId}`, {
    headers: { "X-API-Key": apiKey },
  });
  if (!res.ok) return null;

  const job = await res.json();
  const outputs = job.outputs || {};
  for (const nodeOutputs of Object.values(outputs)) {
    const files = [...(nodeOutputs.gifs || []), ...(nodeOutputs.videos || []), ...(nodeOutputs.images || [])];
    for (const file of files) {
      const url = await resolveSignedUrl(file, apiKey);
      if (url) return url;
    }
  }
  return null;
};

module.exports = {
  docClient,
  s3Client,
  lambdaClient,
  secretsClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  GetObjectCommand,
  PutObjectCommand,
  getSignedUrl,
  enqueueJob,
  invokeComfyUI,
  resolvePricingRow,
  scanUserRequestsForUsage,
  queryCreditHistoryPaged,
  getLatestCreditMetrics,
  sumSuccessfulSpending,
  createMidtransSnapTransaction,
  uploadToS3,
  callOpenAILLM,
  callGeminiAudio,
  getRedis,
  pickComfyApiKey,
  getComfyApiKeys,
  uploadInputImage,
  uploadInputAudio,
  submitWorkflow,
  getOutputUrl,
  resolveSignedUrl
};

