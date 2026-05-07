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

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || "ap-southeast-1" });

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
  if (!s3ImageUrls.length && jobDetail.s3_key) {
    const cmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: jobDetail.s3_key });
    const url = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
    s3ImageUrls = [url];
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

module.exports = {
  docClient,
  s3Client,
  lambdaClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  enqueueJob,
  invokeComfyUI,
  resolvePricingRow,
  scanUserRequestsForUsage,
  queryCreditHistoryPaged,
  getLatestCreditMetrics,
  sumSuccessfulSpending,
  createMidtransSnapTransaction,
  triggerWorkerBOnce,
  uploadToS3,
  getSignedUrl,
  GetObjectCommand,
};
