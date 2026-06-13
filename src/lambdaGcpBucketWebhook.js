"use strict";

const path = require("path");
const { Storage } = require("@google-cloud/storage");
const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getSecrets, parseJsonConfig } = require("./lib/config");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET;
const USER_REQUEST_TABLE_NAME = process.env.USER_REQUEST_TABLE_NAME;

const s3Client = new S3Client({ region: REGION });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const getGcpServiceAccount = async () => {
  const config = await getSecrets();
  const raw = config.s3GcpSA;
  if (!raw) {
    throw new Error("Field `s3GcpSA` tidak ditemukan di SSM Parameter Store.");
  }
  return parseJsonConfig(raw);
};

const createGcsClient = async () => {
  const sa = await getGcpServiceAccount();
  return new Storage({
    projectId: sa.project_id,
    credentials: {
      client_email: sa.client_email,
      private_key: sa.private_key,
    },
  });
};

/** Parse API Gateway proxy body (JSON string, optional base64). */
function parseRequestBody(event) {
  let raw = event?.body;

  if (raw == null || raw === "") {
    return typeof event === "object" && !event.httpMethod ? event : {};
  }

  if (typeof raw === "string") {
    if (event.isBase64Encoded) {
      raw = Buffer.from(raw, "base64").toString("utf-8");
    }
    return JSON.parse(raw);
  }

  return raw;
}

/**
 * Support:
 * 1) Pub/Sub push dengan payload unwrapping → body langsung storage#object
 * 2) Pub/Sub push standar → body.message.data (base64 JSON)
 */
function extractGcsObject(body) {
  if (!body || typeof body !== "object") {
    return null;
  }

  // Format yang kamu terima dari GCP (langsung object metadata)
  if (body.bucket && body.name) {
    const isStorageObject =
      body.kind === "storage#object" ||
      typeof body.contentType === "string" ||
      body.generation != null;

    if (isStorageObject && !body.message) {
      return {
        bucket: body.bucket,
        name: String(body.name).replace(/^\/+/, ""),
        contentType: body.contentType,
        source: "direct-gcs-object",
      };
    }
  }

  // Pub/Sub envelope (tanpa unwrapping)
  const pubSubMessage = body.message;
  if (pubSubMessage?.data) {
    const decoded = JSON.parse(
      Buffer.from(pubSubMessage.data, "base64").toString("utf-8")
    );
    const bucket = decoded.bucket || decoded.bucketId;
    const name = (decoded.name || decoded.objectId || "").replace(/^\/+/, "");
    if (bucket && name) {
      return {
        bucket,
        name,
        contentType: decoded.contentType,
        source: "pubsub-envelope",
        messageId: pubSubMessage.messageId,
        publishTime: pubSubMessage.publishTime,
        subscription: body.subscription,
      };
    }
  }

  return null;
}

/**
 * GCS object name: `<id>/<file-name.mp4>` → S3 key: `free-trial/<id>.mp4`
 * Fallback untuk object flat di root bucket: `foo.mp4` → `free-trial/foo.mp4`
 */
function resolveS3TargetKey(gcsObjectName) {
  const normalized = String(gcsObjectName).replace(/^\/+/, "");

  if (!normalized.toLowerCase().endsWith(".mp4")) {
    return null;
  }

  // GCS object bisa berupa "<uuid>/sample_0.mp4" atau "<uuid>/<opId>/sample_0.mp4".
  // Ambil segmen pertama sebagai job UUID untuk update DynamoDB.
  const pathParts = normalized.split("/").filter(Boolean);
  if (pathParts.length > 1) {
    const id = pathParts[0];
    if (!id) return null;
    return {
      id,
      gcsObjectName: normalized,
      s3Key: `free-trial/${id}.mp4`,
    };
  }

  const id = path.posix.basename(normalized, ".mp4");
  return {
    id,
    gcsObjectName: normalized,
    s3Key: `free-trial/${id}.mp4`,
  };
}

function getJakartaISOString() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })
  ).toISOString();
}

async function updateUserRequestCompleted(jobId, s3Key) {
  if (!USER_REQUEST_TABLE_NAME) {
    console.warn("[GcpBucketWebhook] USER_REQUEST_TABLE_NAME tidak dikonfigurasi, skip update DynamoDB.");
    return;
  }

  const q = await dynamo.send(
    new QueryCommand({
      TableName: USER_REQUEST_TABLE_NAME,
      KeyConditionExpression: "#uuid = :u",
      ExpressionAttributeNames: {
        "#uuid": "uuid",
      },
      ExpressionAttributeValues: { ":u": jobId },
      Limit: 1,
      ScanIndexForward: false,
    })
  );

  const item = q.Items?.[0];
  if (!item?.user_email) {
    console.warn("[GcpBucketWebhook] User request tidak ditemukan untuk jobId", { jobId });
    return;
  }

  const now = getJakartaISOString();
  const videoGenStart = item.video_gen_start_at || item.created_at;
  let videoGenDuration = null;
  if (videoGenStart) {
    videoGenDuration = Math.round((Date.now() - Date.parse(videoGenStart)) / 1000);
  }

  const updates = ["#s = :s", "result_url = :r", "updated_at = :u"];
  const exprValues = {
    ":s": "COMPLETED",
    ":r": s3Key,
    ":u": now,
  };

  if (videoGenDuration !== null) {
    updates.push("video_generation_duration = :vgd");
    exprValues[":vgd"] = videoGenDuration;
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: USER_REQUEST_TABLE_NAME,
      Key: { uuid: jobId, user_email: item.user_email },
      UpdateExpression: "SET " + updates.join(", "),
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: exprValues,
    })
  );
}

exports.handler = async (event) => {
  const requestId = event?.requestContext?.requestId || "unknown";

  try {
    const body = parseRequestBody(event);

    console.log("[GcpBucketWebhook] Request diterima", {
      requestId,
      httpMethod: event?.httpMethod,
      path: event?.path,
      isBase64Encoded: event?.isBase64Encoded ?? false,
      bodyKeys: Object.keys(body),
      body,
    });

    const gcs = extractGcsObject(body);
    if (!gcs) {
      console.log("[GcpBucketWebhook] Format body tidak dikenali, diabaikan.", {
        requestId,
        bodyKeys: Object.keys(body),
      });
      return { statusCode: 200, body: "Unrecognized payload" };
    }

    console.log("[GcpBucketWebhook] GCS object teridentifikasi", {
      requestId,
      source: gcs.source,
      bucket: gcs.bucket,
      name: gcs.name,
      contentType: gcs.contentType,
      messageId: gcs.messageId,
    });

    const { bucket: gcsBucketName, name: gcsFileName, contentType } = gcs;

    const target = resolveS3TargetKey(gcsFileName);
    if (!target) {
      console.log("[GcpBucketWebhook] Bukan MP4 atau path tidak valid, diabaikan", {
        requestId,
        gcsBucketName,
        gcsFileName,
      });
      return { statusCode: 200, body: "Non-MP4 ignored" };
    }

    const { id, gcsObjectName, s3Key: targetKey } = target;

    const targetBucket = S3_RESOURCE_BUCKET;
    if (!targetBucket) {
      throw new Error("S3_RESOURCE_BUCKET belum dikonfigurasi.");
    }

    console.log("[GcpBucketWebhook] Memulai transfer GCS → S3", {
      requestId,
      jobId: id,
      source: `gs://${gcsBucketName}/${gcsObjectName}`,
      destination: `s3://${targetBucket}/${targetKey}`,
      contentType: contentType || "video/mp4",
    });

    const gcsClient = await createGcsClient();
    const gcsReadStream = gcsClient
      .bucket(gcsBucketName)
      .file(gcsObjectName)
      .createReadStream();

    // Gunakan Upload untuk stream tanpa ContentLength yang diketahui
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: targetBucket,
        Key: targetKey,
        Body: gcsReadStream,
        ContentType: contentType || "video/mp4",
      },
    });

    await upload.done();

    await updateUserRequestCompleted(id, targetKey);

    console.log("[GcpBucketWebhook] Transfer selesai", {
      requestId,
      jobId: id,
      destination: `s3://${targetBucket}/${targetKey}`,
      dynamoUpdated: true,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        jobId: id,
        s3Uri: `s3://${targetBucket}/${targetKey}`,
      }),
    };
  } catch (error) {
    console.error("[GcpBucketWebhook] Gagal melakukan transfer", {
      requestId,
      error: error?.message || String(error),
      stack: error?.stack,
    });
    return { statusCode: 500, body: "Error" };
  }
};
