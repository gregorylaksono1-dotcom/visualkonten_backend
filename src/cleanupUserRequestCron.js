"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getJakartaISOString } = require("./utils");
const { sendTelegramMessage } = require("./lib/telegram");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME || "user_request";
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const DEFAULT_RETENTION_DAYS = parseInt(process.env.CLEANUP_RETENTION_DAYS || "30", 10);

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3Client = new S3Client({ region: REGION });

/**
 * Extracts the S3 object key from an S3 URL or direct key string.
 * Ignores third-party non-S3 external URLs (e.g. Kie.ai, fal.ai, googleapis, etc.)
 *
 * @param {string} urlOrKey 
 * @param {string} bucketName 
 * @returns {string|null}
 */
function extractS3Key(urlOrKey, bucketName) {
  if (!urlOrKey || typeof urlOrKey !== "string") return null;
  const trimmed = urlOrKey.trim();
  if (!trimmed) return null;

  // Handle full URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();

      // Check if host points to AWS S3 or CloudFront asset
      const isS3Host = host.includes(".s3.") || host.startsWith("s3.") || host === "s3.amazonaws.com" || host.includes("amazonaws.com");
      const isCloudFront = host.includes("cloudfront.net");

      if (isS3Host || isCloudFront) {
        let pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
        // Remove bucket name if path-style URL: e.g. "dapurartisan/user_request/..."
        if (bucketName && pathname.startsWith(bucketName + "/")) {
          pathname = pathname.substring(bucketName.length + 1);
        }
        return pathname || null;
      }

      // External third-party URL (e.g., kie.ai, storage.googleapis.com)
      return null;
    } catch (e) {
      return null;
    }
  }

  // Not a URL: direct key (clean query params and leading slashes if any)
  const cleanKey = decodeURIComponent(trimmed.split("?")[0]).replace(/^\/+/, "");
  return cleanKey || null;
}

/**
 * Collects and deduplicates all S3 keys related to a user_request record.
 * 
 * @param {object} item 
 * @param {string} bucketName 
 * @returns {string[]}
 */
function collectS3KeysFromItem(item, bucketName) {
  const keys = new Set();

  function addCandidate(val) {
    if (!val) return;

    // Handle strings that might be JSON encoded arrays or objects
    if (typeof val === "string") {
      const trimmed = val.trim();
      if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
        try {
          const parsed = JSON.parse(trimmed);
          addCandidate(parsed);
          return;
        } catch (e) {
          // not valid JSON, treat as raw string
        }
      }
      const key = extractS3Key(trimmed, bucketName);
      if (key) keys.add(key);
      return;
    }

    if (Array.isArray(val)) {
      for (const elem of val) {
        addCandidate(elem);
      }
      return;
    }

    if (typeof val === "object") {
      // Check known scene/asset properties
      if (val.s3_key) addCandidate(val.s3_key);
      if (val.s3key) addCandidate(val.s3key);
      if (val.Key) addCandidate(val.Key);
      if (val.url) addCandidate(val.url);
      if (val.processedImageUrl) addCandidate(val.processedImageUrl);
      if (val.musicUrl) addCandidate(val.musicUrl);

      // In case key is named e.g. scene_1: "..."
      for (const [k, v] of Object.entries(val)) {
        if (k.toLowerCase().includes("s3") || k.toLowerCase().includes("url")) {
          addCandidate(v);
        }
      }
    }
  }

  // Explicit fields requested by user
  addCandidate(item.generated_image);
  addCandidate(item.generated_image_talent);
  addCandidate(item.generated_scenes);
  addCandidate(item.s3_keys);
  addCandidate(item.video_scenes);
  addCandidate(item.audio);

  // Additional related media fields to ensure complete cleanup and save space
  addCandidate(item.result_url);
  addCandidate(item.video_ref_key);
  addCandidate(item.audio_url);
  addCandidate(item.audio_key);
  addCandidate(item.music_url);
  addCandidate(item.generated_image_hero);
  addCandidate(item.generated_image_transition);
  addCandidate(item.generated_image_reveal);
  addCandidate(item.generated_image_product);
  addCandidate(item.audio_s3_key);
  addCandidate(item.voiceover_s3_key);

  // Check llm_response if present
  if (item.llm_response && typeof item.llm_response === "object") {
    try {
      if (item.llm_response.musicResult) addCandidate(item.llm_response.musicResult);
      if (item.llm_response.pixianResult) addCandidate(item.llm_response.pixianResult);
      if (item.llm_response.imageGenResult) addCandidate(item.llm_response.imageGenResult);
    } catch (e) {}
  }

  return Array.from(keys);
}

/**
 * Deletes objects from S3 in batches up to 1000 keys per call.
 * 
 * @param {string} bucket 
 * @param {string[]} keys 
 * @returns {Promise<number>} Number of successfully deleted objects
 */
async function deleteS3Objects(bucket, keys) {
  if (!keys || keys.length === 0) return 0;
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  let deletedCount = 0;

  for (let i = 0; i < uniqueKeys.length; i += 1000) {
    const chunk = uniqueKeys.slice(i, i + 1000);
    const params = {
      Bucket: bucket,
      Delete: {
        Objects: chunk.map((Key) => ({ Key })),
        Quiet: false,
      },
    };

    try {
      const res = await s3Client.send(new DeleteObjectsCommand(params));
      const deletedInBatch = res.Deleted ? res.Deleted.length : (chunk.length - (res.Errors?.length || 0));
      deletedCount += deletedInBatch;

      if (res.Errors && res.Errors.length > 0) {
        console.error(`[Cleanup Cron] S3 DeleteObjects encountered ${res.Errors.length} errors:`, res.Errors);
      }
    } catch (err) {
      console.error("[Cleanup Cron] S3 DeleteObjects error:", err.message);
    }
  }

  return deletedCount;
}

/**
 * Deletes user_request items from DynamoDB in batches of up to 25.
 * 
 * @param {string} tableName 
 * @param {object[]} items 
 * @returns {Promise<number>} Number of successfully deleted rows
 */
async function deleteDynamoItems(tableName, items) {
  let deletedCount = 0;
  const validItems = items.filter((it) => it && it.uuid && it.user_email);

  for (let i = 0; i < validItems.length; i += 25) {
    const chunk = validItems.slice(i, i + 25);
    let requestItems = {
      [tableName]: chunk.map((it) => ({
        DeleteRequest: {
          Key: {
            uuid: it.uuid,
            user_email: it.user_email,
          },
        },
      })),
    };

    let retries = 0;
    while (requestItems && requestItems[tableName] && requestItems[tableName].length > 0 && retries < 3) {
      try {
        const res = await dynamo.send(new BatchWriteCommand({ RequestItems: requestItems }));
        const unprocessed = res.UnprocessedItems?.[tableName]?.length || 0;
        const processed = requestItems[tableName].length - unprocessed;
        deletedCount += processed;

        requestItems = res.UnprocessedItems;
        if (requestItems && requestItems[tableName] && requestItems[tableName].length > 0) {
          retries++;
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, retries)));
        }
      } catch (batchErr) {
        console.error("[Cleanup Cron] BatchWriteCommand failed, falling back to individual DeleteCommand:", batchErr.message);
        for (const item of chunk) {
          try {
            await dynamo.send(new DeleteCommand({
              TableName: tableName,
              Key: {
                uuid: item.uuid,
                user_email: item.user_email,
              },
            }));
            deletedCount++;
          } catch (singleErr) {
            console.error(`[Cleanup Cron] Failed to delete DynamoDB item ${item.uuid}:`, singleErr.message);
          }
        }
        requestItems = null;
        break;
      }
    }
  }

  return deletedCount;
}

/**
 * Main Lambda Handler for user_request daily cleanup cron job.
 * Runs once a day at Jakarta midnight (00:00 WIB / 17:00 UTC).
 */
exports.handler = async (event = {}) => {
  const startTime = Date.now();
  const executionTimeJakarta = getJakartaISOString(new Date(startTime));
  const retentionDays = Number(event.retentionDays || DEFAULT_RETENTION_DAYS);
  const cutoffMs = startTime - (retentionDays * 24 * 60 * 60 * 1000);
  const cutoffDate = new Date(cutoffMs);
  const cutoffDateJakarta = getJakartaISOString(cutoffDate);
  const isDryRun = event.dryRun === true;

  console.log(`[Cleanup Cron] Starting user_request cleanup cronjob.`);
  console.log(`[Cleanup Cron] Execution time: ${executionTimeJakarta} WIB`);
  console.log(`[Cleanup Cron] Retention: ${retentionDays} days (Cutoff: < ${cutoffDateJakarta} WIB)`);
  console.log(`[Cleanup Cron] Table: ${USER_REQUEST_TABLE}, Bucket: ${S3_RESOURCE_BUCKET}, DryRun: ${isDryRun}`);

  try {
    let lastEvaluatedKey = undefined;
    let totalScanned = 0;
    const expiredItems = [];
    const allS3KeysToDelete = [];

    // 1. Scan DynamoDB user_request table
    do {
      const scanParams = {
        TableName: USER_REQUEST_TABLE,
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const res = await dynamo.send(new ScanCommand(scanParams));
      const items = res.Items || [];
      totalScanned += items.length;

      for (const item of items) {
        if (!item.created_at) continue;
        const createdMs = Date.parse(item.created_at);
        if (!isNaN(createdMs) && createdMs < cutoffMs) {
          expiredItems.push(item);
          const itemKeys = collectS3KeysFromItem(item, S3_RESOURCE_BUCKET);
          allS3KeysToDelete.push(...itemKeys);
        }
      }

      lastEvaluatedKey = res.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const uniqueS3Keys = [...new Set(allS3KeysToDelete.filter(Boolean))];
    console.log(`[Cleanup Cron] Scan completed. Total scanned: ${totalScanned}, Expired (> ${retentionDays}d): ${expiredItems.length}, S3 keys to delete: ${uniqueS3Keys.length}`);

    let deletedS3Count = 0;
    let deletedDynamoCount = 0;

    if (!isDryRun) {
      // 2. Delete S3 objects
      if (uniqueS3Keys.length > 0) {
        console.log(`[Cleanup Cron] Deleting ${uniqueS3Keys.length} S3 objects from ${S3_RESOURCE_BUCKET}...`);
        deletedS3Count = await deleteS3Objects(S3_RESOURCE_BUCKET, uniqueS3Keys);
        console.log(`[Cleanup Cron] Deleted ${deletedS3Count} objects from S3.`);
      }

      // 3. Delete DynamoDB rows
      if (expiredItems.length > 0) {
        console.log(`[Cleanup Cron] Deleting ${expiredItems.length} rows from DynamoDB table ${USER_REQUEST_TABLE}...`);
        deletedDynamoCount = await deleteDynamoItems(USER_REQUEST_TABLE, expiredItems);
        console.log(`[Cleanup Cron] Deleted ${deletedDynamoCount} rows from DynamoDB.`);
      }
    } else {
      console.log(`[Cleanup Cron] DryRun enabled. Skipped deletion. Expired: ${expiredItems.length}, S3 keys: ${uniqueS3Keys.length}`);
      deletedS3Count = uniqueS3Keys.length;
      deletedDynamoCount = expiredItems.length;
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

    // 4. Send Telegram summary notification
    const telegramMessage = [
      `🧹 [CRONJOB] PEMBERSIHAN DATA USER REQUEST (> 1 BULAN)`,
      ``,
      `📅 Waktu Eksekusi: ${executionTimeJakarta} WIB`,
      `⏳ Batas Cutoff: < ${cutoffDateJakarta} WIB (> ${retentionDays} hari)`,
      `🗂️ Total user_request diperiksa: ${totalScanned}`,
      `🗑️ Total user_request dihapus: ${deletedDynamoCount}${isDryRun ? " (DryRun)" : ""}`,
      `📦 Total data S3 dihapus: ${deletedS3Count}${isDryRun ? " (DryRun)" : ""}`,
      `⏱️ Durasi Proses: ${durationSec}s`,
      ``,
      deletedDynamoCount > 0
        ? `✅ Berhasil membersihkan user_request kadaluarsa dan menghemat space storage S3.`
        : `ℹ️ Tidak ada user_request yang lebih dari 1 bulan. Space S3 dan database aman.`
    ].join("\n");

    try {
      const shouldSendTelegram = event.disableTelegram !== true;
      if (shouldSendTelegram) {
        await sendTelegramMessage(telegramMessage, { force: true });
      }
    } catch (teleErr) {
      console.error("[Cleanup Cron] Failed to send Telegram notification:", teleErr.message);
    }

    return {
      statusCode: 200,
      summary: {
        executionTime: executionTimeJakarta,
        cutoffDate: cutoffDateJakarta,
        retentionDays,
        totalScanned,
        deletedRequests: deletedDynamoCount,
        deletedS3Objects: deletedS3Count,
        durationSeconds: Number(durationSec),
        dryRun: isDryRun,
      },
    };
  } catch (err) {
    console.error("[Cleanup Cron] Fatal error during cleanup:", err);

    try {
      const errorMsg = [
        `⚠️ [CRONJOB ERROR] PEMBERSIHAN DATA USER REQUEST GAGAL!`,
        ``,
        `📅 Waktu: ${executionTimeJakarta} WIB`,
        `❌ Error: ${err.message}`,
        `📍 Stack: ${err.stack?.split("\n")?.[1] || "N/A"}`
      ].join("\n");
      await sendTelegramMessage(errorMsg, { force: true });
    } catch (teleErr) {
      console.error("[Cleanup Cron] Failed to send error alert to Telegram:", teleErr.message);
    }

    return {
      statusCode: 500,
      error: err.message,
    };
  }
};

// Export internal helpers for testing
module.exports = {
  handler: exports.handler,
  extractS3Key,
  collectS3KeysFromItem,
  deleteS3Objects,
  deleteDynamoItems,
};
