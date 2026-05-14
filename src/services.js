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
const { GoogleAuth } = require("google-auth-library");
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
  if (!MIDTRANS_API_URL || !MIDTRANS_SERVER_KEY) {
    throw new Error("Midtrans API URL or Server Key is not configured.");
  }
  const auth = Buffer.from(`${MIDTRANS_SERVER_KEY}:`).toString("base64");
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

let _cachedOpenAiKey = null;
const getOpenAiKey = async () => {
  if (_cachedOpenAiKey) return _cachedOpenAiKey;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    if (!secretsClient) secretsClient = new SecretsManagerClient({ region });
    
    const arn = "arn:aws:secretsmanager:ap-southeast-1:084375570459:secret:open_ai-wCZYqC";
    const data = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
    const secrets = JSON.parse(data.SecretString);
    _cachedOpenAiKey = secrets.secret_key;
    return _cachedOpenAiKey;
  } catch (err) {
    console.error("Failed to fetch OpenAI secret:", err);
    return null;
  }
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

const getGoogleCloudCreds = async () => {
  try {
    const arn = "arn:aws:secretsmanager:ap-southeast-1:084375570459:secret:vertexai-nE9ql9";
    if (!arn) return null;

    let secretData;
    if (!arn.startsWith("arn:aws:secretsmanager")) {
      secretData = JSON.parse(arn);
    } else {
      const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
      if (!secretsClient) secretsClient = new SecretsManagerClient({ region });
      
      const data = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
      secretData = JSON.parse(data.SecretString);
    }

    // Check for the specific 'vertexai' key as requested
    if (secretData.vertexai) {
      const vVal = secretData.vertexai;
      if (typeof vVal === "string") {
        try {
          const parsed = JSON.parse(vVal);
          if (parsed.client_email) return parsed;
        } catch (e) {}
      }
      if (typeof vVal === "object" && vVal !== null && vVal.client_email) return vVal;
    }

    // Check if it's the direct service account object
    if (secretData.client_email) return secretData;

    // If not, it might be wrapped in a Key/Value pair (common in Secrets Manager)
    // We'll look for any value that looks like a JSON string or has client_email
    const keys = Object.keys(secretData);
    console.log("Secret keys found:", keys);

    for (const key of keys) {
      const val = secretData[key];
      if (typeof val === "string" && val.includes("client_email")) {
        try {
          const nested = JSON.parse(val);
          if (nested.client_email) {
            console.log(`Found service account JSON inside key: ${key}`);
            return nested;
          }
        } catch (e) { }
      }
      if (typeof val === "object" && val !== null && val.client_email) {
        console.log(`Found service account object inside key: ${key}`);
        return val;
      }
    }

    console.error("Secret found but no valid service account JSON (missing client_email).");
    return secretData; // Return anyway, auth library will throw the specific error
  } catch (err) {
    console.error("Failed to fetch Vertex AI credentials:", err);
    return null;
  }
};


let _cachedGeminiKey = null;
const getGeminiKey = async () => {
  if (_cachedGeminiKey) return _cachedGeminiKey;
  
  // Try environment variable first
  if (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes("PLACEHOLDER")) {
    _cachedGeminiKey = process.env.GEMINI_API_KEY;
    return _cachedGeminiKey;
  }

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    if (!secretsClient) secretsClient = new SecretsManagerClient({ region });
    
    const arn = "arn:aws:secretsmanager:ap-southeast-1:084375570459:secret:gemini_llm-aoFcff";
    const data = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
    const secrets = JSON.parse(data.SecretString);
    _cachedGeminiKey = secrets.gemini_api_key;
    return _cachedGeminiKey;
  } catch (err) {
    console.error("Failed to fetch Gemini secret from Secrets Manager:", err.message);
    return null;
  }
};

const callGeminiAudio = async (text, config) => {
  console.log("Starting Gemini Audio (Vertex AI Multimodal TTS) call...");
  try {
    const credentials = await getGoogleCloudCreds(); // This will now fetch from vertexai-nE9ql9 if configured
    if (!credentials) {
      throw new Error("Vertex AI credentials not found.");
    }

    const auth = new GoogleAuth({
      credentials,
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    });
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    const accessToken = tokenRes.token;

    const project = credentials.project_id || process.env.VERTEX_AI_PROJECT_ID;
    const location = process.env.VERTEX_AI_LOCATION || "us-central1";
    const modelId = "gemini-2.0-flash-exp"; // Or gemini-2.5-flash-001 when available on Vertex

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

    let voiceName = config?.voice_name || "Aoede";
    if (typeof voiceName === "object" && voiceName.S) {
      voiceName = voiceName.S;
    }

    const payload = {
      contents: [{ role: "user", parts: [{ text }] }],
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
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Vertex AI Gemini API error: ${response.status}`, errorText);
      throw new Error(`Vertex AI Gemini API error: ${response.status} ${errorText}`);
    }

    const json = await response.json();
    const audioPart = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType.includes("audio"));
    
    if (!audioPart) {
      console.error("Gemini Response Body:", JSON.stringify(json));
      throw new Error("No audio content returned from Gemini (Vertex AI).");
    }

    console.log("Gemini Audio (Vertex AI) call successful.");
    return audioPart.inlineData.data; // This is base64 string
  } catch (err) {
    console.error("Gemini Audio (Vertex AI) request failed:", err.message);
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

  for (const key of keys) {
    const redisKey = `comfyui_job_${key}`;
    const count = await redis.get(redisKey);
    const currentCount = parseInt(count || "0");
    const maxJobs = parseInt(process.env.COMFY_MAX_CONCURRENT_JOBS || "1");
    if (currentCount < maxJobs) {
      // Pick this key and increment
      await redis.incr(redisKey);
      console.log(`[Redis] Picked API Key and incremented ${redisKey}`);
      return key;
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
};

