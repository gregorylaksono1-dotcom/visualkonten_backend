/**
 * Worker C — The Finish Line & Re-activator
 *
 * Tugas:
 *  1. Menerima webhook dari RunPod/GCP ketika suatu job selesai (atau gagal).
 *  2. Menghapus job dari daftar `active_jobs` sehingga slot terbuka kembali.
 *  3. Update status job di Redis (dan opsional di DynamoDB).
 *  4. Memicu Worker B via QStash supaya slot yang baru kosong langsung diisi.
 *
 * Endpoint: POST /worker-c  (public, no Cognito Auth — diakses langsung oleh RunPod/GCP).
 *
 * Payload dari RunPod (webhook):
 * {
 *   "id": "<runpod_job_id>",
 *   "status": "COMPLETED" | "FAILED",
 *   "output": { ... }    // berisi url hasil, dll.
 * }
 *
 * Job ID aplikasi dikirim lewat query string: ?jobId=<jobId>
 * (didaftarkan Worker B saat dispatch ke RunPod via field `webhook`).
 */

const { Redis } = require("@upstash/redis");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

// ─── Env vars ────────────────────────────────────────────────────────────────
const UPSTASH_REDIS_REST_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const WORKER_B_QSTASH_URL      = process.env.WORKER_B_QSTASH_URL;
const QSTASH_TOKEN             = process.env.QSTASH_TOKEN;
const USER_REQUEST_TABLE_NAME  = process.env.USER_REQUEST_TABLE_NAME;

// Kunci Redis
const ACTIVE_JOBS_KEY   = "active_jobs";
const JOB_DETAIL_PREFIX = "job_detail:";
// TTL untuk menyimpan hasil job yang sudah selesai (misal 7 hari)
const COMPLETED_JOB_TTL = 60 * 60 * 24 * 7;

// ─── Clients ─────────────────────────────────────────────────────────────────

let _redis;
const getRedis = () => {
  if (!_redis) {
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN tidak dikonfigurasi.");
    }
    _redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  }
  return _redis;
};

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse body Lambda (string | object). */
const parseBody = (event) => {
  if (!event?.body) return {};
  if (typeof event.body === "string") {
    try { return JSON.parse(event.body); } catch { return {}; }
  }
  return event.body;
};

/**
 * Perbarui status job di DynamoDB (user_request table).
 * Kolom yang diupdate: status, s3_key (url hasil), updated_at.
 * Tidak melempar error jika tabel tidak dikonfigurasi (opsional).
 */
const updateDynamoDBStatus = async (jobDetail, status, resultUrl) => {
  if (!USER_REQUEST_TABLE_NAME) {
    console.warn("USER_REQUEST_TABLE_NAME tidak dikonfigurasi, skip DynamoDB update.");
    return;
  }
  if (!jobDetail?.uuid || !jobDetail?.user_email) {
    console.warn("jobDetail tidak memiliki uuid/user_email, skip DynamoDB update.");
    return;
  }

  const now = new Date().toISOString();
  const updateExpr = resultUrl
    ? "SET #st = :status, s3_key = :url, updated_at = :now"
    : "SET #st = :status, updated_at = :now";

  const exprValues = {
    ":status": status,
    ":now": now,
    ...(resultUrl ? { ":url": resultUrl } : {}),
  };

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: USER_REQUEST_TABLE_NAME,
        Key: {
          uuid: jobDetail.uuid,
          user_email: jobDetail.user_email,
        },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: exprValues,
      })
    );
    console.log(`DynamoDB updated: job ${jobDetail.uuid} → ${status}`);
  } catch (err) {
    // Jangan re-throw: kegagalan DynamoDB tidak boleh menghentikan alur Redis/QStash
    console.error("DynamoDB update gagal:", err?.message);
  }
};

/**
 * Panggil Worker B via QStash agar slot yang baru kosong segera diisi.
 */
const triggerWorkerB = async () => {
  if (!QSTASH_TOKEN || !WORKER_B_QSTASH_URL) {
    console.warn("QStash tidak dikonfigurasi, skip trigger Worker B.");
    return;
  }
  const res = await fetch(
    `https://qstash-eu-central-1.upstash.io/v2/publish/${WORKER_B_QSTASH_URL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${QSTASH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source: "worker_c" }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`QStash trigger Worker B gagal (${res.status}): ${text}`);
  } else {
    console.log("Worker B berhasil dipicu via QStash.");
  }
};

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log("Worker C (webhook) dipanggil", {
    queryStringParameters: event?.queryStringParameters,
    body: event?.body,
  });

  const redis = getRedis();

  // jobId dikirim Worker B sebagai query-string saat mendaftarkan webhook ke RunPod
  const jobId = event?.queryStringParameters?.jobId;
  if (!jobId) {
    console.error("jobId tidak ada di queryStringParameters.");
    return { statusCode: 400, body: JSON.stringify({ error: "jobId diperlukan." }) };
  }

  const body = parseBody(event);
  // RunPod mengirim status: "COMPLETED" | "FAILED" | "IN_PROGRESS"
  // GCP bisa kirim status berbeda; normalkan di sini
  const rawStatus = String(body.status || "COMPLETED").toUpperCase();
  const isFailed  = rawStatus === "FAILED" || rawStatus === "ERROR";
  const finalStatus = isFailed ? "FAILED" : "COMPLETED";

  // Ekstrak URL hasil (RunPod menaruh di output)
  const output = body.output ?? {};
  const resultUrl =
    output.url ||
    output.video_url ||
    output.image_url ||
    output.result_url ||
    null;

  try {
    // 1. Ambil detail job dari Redis
    const raw = await redis.get(`${JOB_DETAIL_PREFIX}${jobId}`);
    const jobDetail = raw
      ? (typeof raw === "string" ? JSON.parse(raw) : raw)
      : { uuid: jobId };

    // Idempotency guard: jika job sudah terminal (COMPLETED/FAILED), skip pemrosesan ulang.
    // Ini mencegah double-update dari QStash retry atau duplicate webhook.
    const currentStatus = String(jobDetail.status || "").toUpperCase();
    if (currentStatus === "COMPLETED" || currentStatus === "FAILED") {
      console.log(`Job ${jobId} sudah dalam status terminal (${currentStatus}), skip pemrosesan ulang.`);
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: `Job ${jobId} sudah ${currentStatus}, tidak diproses ulang.`,
          idempotent: true,
        }),
      };
    }

    // 2. Hapus dari active_jobs → slot terbuka
    if (jobDetail.worker_url) {
      await redis.srem(`${ACTIVE_JOBS_KEY}:${jobDetail.worker_url}`, jobId);
      console.log(`Job ${jobId} dihapus dari active_jobs:${jobDetail.worker_url} (slot terbuka).`);
    } else {
      // Fallback untuk job lama
      await redis.srem(ACTIVE_JOBS_KEY, jobId);
      console.log(`Job ${jobId} dihapus dari active_jobs (slot terbuka).`);
    }

    // 3. Update detail job di Redis — hanya field tracking minimal
    const updatedDetail = {
      uuid: jobId,           // diperlukan untuk referensi & konsistensi
      user_email: jobDetail.user_email,
      user_id: jobDetail.user_id,
      status: finalStatus,
      worker_url: jobDetail.worker_url || null,
      processing_at: jobDetail.processing_at || null,
      completed_at: new Date().toISOString(),
      result_url: resultUrl,
    };
    console.log(`Updating job_detail Redis untuk ${jobId}:`, JSON.stringify(updatedDetail));
    const setResult = await redis.set(`${JOB_DETAIL_PREFIX}${jobId}`, JSON.stringify(updatedDetail));
    await redis.expire(`${JOB_DETAIL_PREFIX}${jobId}`, COMPLETED_JOB_TTL);
    console.log(`Redis set result untuk ${jobId}: ${setResult} → status seharusnya ${finalStatus}`);

    // 4. Update status di DynamoDB (best-effort)
    console.log(`Mulai DynamoDB update untuk ${jobId}, user_email: ${jobDetail.user_email}`);
    await updateDynamoDBStatus(jobDetail, finalStatus, resultUrl);

    // 5. Panggil Worker B agar slot yang kosong langsung digunakan
    await triggerWorkerB();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Job ${jobId} selesai dengan status ${finalStatus}.`,
        result_url: resultUrl,
      }),
    };
  } catch (err) {
    console.error("Worker C error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Internal error di Worker C." }),
    };
  }
};
