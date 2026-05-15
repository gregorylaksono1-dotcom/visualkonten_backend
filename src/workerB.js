/**
 * Worker B — The Gatekeeper
 *
 * Tugas:
 *  1. Cek berapa job yang sedang berjalan (active_jobs set di Redis/Upstash).
 *  2. Jika ada slot kosong → ambil job dari antrean (task_queue) dan kirim ke RunPod/GCP.
 *  3. Jika masih ada sisa slot setelah mengirim → panggil diri sendiri via QStash
 *     agar job berikutnya di-kick tanpa menunggu.
 *  4. Jika slot penuh → keluar (Worker C akan membangunkan kembali saat slot kosong).
 *
 * Dibangunkan oleh: Worker A (saat job baru masuk) atau Worker C (saat job selesai).
 * Endpoint: POST /worker-b (dipanggil via QStash — no Cognito Auth).
 */

const { Redis } = require("@upstash/redis");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { callOpenAILLM, callGoogleTTS, uploadToS3 } = require("./services");
const { generateTTS } = require("./core/tts");
const fs = require("fs");
const path = require("path");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ─── Env vars ────────────────────────────────────────────────────────────────
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID; // RunPod serverless endpoint id
const GCP_WEBHOOK_URL = process.env.GCP_WEBHOOK_URL;    // alternatif GCP Cloud Run URL
const WORKER_B_QSTASH_URL = process.env.WORKER_B_QSTASH_URL; // URL publik Worker B ini
const WORKER_C_URL = process.env.WORKER_C_URL;        // URL publik Worker C (webhook target untuk RunPod)
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const MAX_ACTIVE_SLOTS = Number(process.env.MAX_ACTIVE_SLOTS || "2"); // Set default max active job = 2

// Konfigurasi Worker URLs
let workerUrls = [];
if (process.env.WORKER_URLS) {
  workerUrls = process.env.WORKER_URLS.split(",").map(u => u.trim()).filter(Boolean);
} else {
  if (process.env.RUNPOD_ENDPOINT_ID) {
    workerUrls.push(`https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/run`);
  } else if (process.env.GCP_WEBHOOK_URL) {
    workerUrls.push(process.env.GCP_WEBHOOK_URL);
  }
}

// Kunci Redis
const TASK_QUEUE_KEY = "task_queue";
const ACTIVE_JOBS_KEY = "active_jobs";
const JOB_DETAIL_PREFIX = "job_detail:";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Inisialisasi klien Redis (lazy, singleton per cold-start). */
let _redis;
const getRedis = () => {
  if (!_redis) {
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN tidak dikonfigurasi.");
    }
    _redis = new Redis({
      url: UPSTASH_REDIS_REST_URL,
      token: UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
};

/**
 * Kirim job ke Worker URL yang dipilih.
 * Mendukung URL eksternal (custom) dan URL RunPod.
 * @returns {Promise<string>} executorJobId
 */
const dispatchToWorker = async (url, jobId, jobDetail) => {
  const webhookUrl = `${WORKER_C_URL}?jobId=${encodeURIComponent(jobId)}`;

  const isRunPod = url.includes("runpod.ai");
  let payload;
  let headers = { "Content-Type": "application/json" };

  if (isRunPod) {
    if (!RUNPOD_API_KEY) {
      throw new Error("RUNPOD_API_KEY tidak dikonfigurasi untuk RunPod URL.");
    }
    payload = {
      input: {
        job_id: jobId,
        prompt: jobDetail.prompt,
        request_type: jobDetail.request_type,
        resource_family: jobDetail.resource_family,
        s3_key: jobDetail.s3_key ?? null,
        video_quality: jobDetail.video_quality ?? null,
        aspect_ratio: jobDetail.aspect_ratio ?? null,
        user_email: jobDetail.user_email,
        user_id: jobDetail.user_id,
      },
      webhook: webhookUrl,
    };
    headers["Authorization"] = `Bearer ${RUNPOD_API_KEY}`;
  } else {
    payload = {
      job_id: jobId,
      callback_url: webhookUrl,
      ...jobDetail,
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Worker dispatch failed (${res.status}): ${text}`);
  }

  let json = {};
  try { json = await res.json(); } catch (e) { }
  return json.job_id || json.id || jobId;
};

/**
 * Memicu Worker B lagi via QStash (fire-and-forget, tanpa delay).
 * Dipakai agar slot berikutnya langsung diisi tanpa menunggu callback dari RunPod.
 */
const triggerWorkerBViaqStash = async () => {
  if (!QSTASH_TOKEN || !WORKER_B_QSTASH_URL) {
    console.warn("QStash tidak dikonfigurasi, skip self-trigger.");
    return;
  }
  const res = await fetch(`https://qstash-eu-central-1.upstash.io/v2/publish/${WORKER_B_QSTASH_URL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${QSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source: "worker_b_self" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`QStash self-trigger gagal (${res.status}): ${text}`);
  }
};

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log("Worker B dipanggil", { source: event?.body });

  const redis = getRedis();

  try {
    // 1. Cek worker URL mana yang memiliki slot kosong
    if (workerUrls.length === 0) {
      console.log("Tidak ada worker endpoint yang dikonfigurasi.");
      return { statusCode: 500, body: JSON.stringify({ error: "Worker endpoints tidak dikonfigurasi." }) };
    }

    let selectedWorkerUrl = null;
    let selectedActiveCount = 0;

    for (const url of workerUrls) {
      const activeCount = await redis.scard(`${ACTIVE_JOBS_KEY}:${url}`);
      if (activeCount < MAX_ACTIVE_SLOTS) {
        selectedWorkerUrl = url;
        selectedActiveCount = activeCount;
        break;
      }
    }

    if (!selectedWorkerUrl) {
      console.log("Semua slot di semua worker penuh. Worker B keluar — Worker C akan membangunkan kembali.");
      return { statusCode: 200, body: JSON.stringify({ message: "Semua slot penuh, standby." }) };
    }

    console.log(`Slot aktif untuk ${selectedWorkerUrl}: ${selectedActiveCount} / ${MAX_ACTIVE_SLOTS}`);

    // 2. Ambil satu job dari antrean (RPOP = FIFO karena Worker A pakai LPUSH)
    const jobId = await redis.rpop(TASK_QUEUE_KEY);
    if (!jobId) {
      console.log("Antrean kosong. Worker B selesai.");
      return { statusCode: 200, body: JSON.stringify({ message: "Antrean kosong." }) };
    }

    console.log(`Mengambil job: ${jobId}`);

    // 3. Ambil detail job dari Redis
    const raw = await redis.get(`${JOB_DETAIL_PREFIX}${jobId}`);
    if (!raw) {
      console.warn(`Detail job ${jobId} tidak ditemukan di Redis, skip.`);
      // Tetap cek apakah ada job lain di antrean
      await triggerWorkerBViaqStash();
      return { statusCode: 200, body: JSON.stringify({ message: `Job ${jobId} detail tidak ditemukan.` }) };
    }
    const jobDetail = typeof raw === "string" ? JSON.parse(raw) : raw;

    // 4. Tandai job sebagai aktif di url tersebut
    await redis.sadd(`${ACTIVE_JOBS_KEY}:${selectedWorkerUrl}`, jobId);

    // 5. Perpanjang TTL detail job (pengaman agar tidak dihapus Redis sebelum selesai)
    await redis.expire(`${JOB_DETAIL_PREFIX}${jobId}`, 3600); // 1 jam

    // 6. Update status + simpan worker_url SEBELUM dispatch
    //    Penting: worker_url harus tersedia di Redis SEBELUM Worker C dipanggil callback,
    //    agar srem bisa menghapus dari key yang benar (active_jobs:{url})
    const processingDetail = {
      uuid: jobId,           // diperlukan Worker C untuk UpdateCommand DynamoDB
      user_email: jobDetail.user_email,
      user_id: jobDetail.user_id,
      status: "PROCESSING",
      worker_url: selectedWorkerUrl,
      processing_at: new Date().toISOString(),
      completed_at: null,
      result_url: null,
    };
    await redis.set(`${JOB_DETAIL_PREFIX}${jobId}`, JSON.stringify(processingDetail));

    // 7. Heavy AI Processing (UGC-P) — Fire and Forget support
    if (jobDetail.request_type === "UGC-P") {
      try {
        console.log(`[WorkerB] Processing UGC-P AI requirements for job ${jobId}`);
        const templatePath = path.join(__dirname, "PROMPT_UGC_PRODUCT");
        const template = fs.readFileSync(templatePath, "utf-8");

        const orientationMap = { "9:16": "portrait", "16:9": "landscape", "1:1": "square" };
        const orientation = orientationMap[jobDetail.aspect_ratio] || "portrait";
        const userPrompt = `1. {product_description}: ${jobDetail.prompt}\n2. {video_duration}: 15 detik\n3. {image_orientation}: ${orientation}`;

        const aiResponse = await callOpenAILLM(template, userPrompt);
        if (aiResponse) {
          const llmResponse = JSON.parse(aiResponse);
          jobDetail.prompt = llmResponse.ltx_prompt || aiResponse; // Update prompt for executor

          // Update DynamoDB
          await dynamo.send(new UpdateCommand({
            TableName: process.env.USER_REQUEST_TABLE_NAME,
            Key: { uuid: jobId, user_email: jobDetail.user_email },
            UpdateExpression: "SET llm_response = :lr, updated_at = :now",
            ExpressionAttributeValues: { ":lr": llmResponse, ":now": new Date().toISOString() }
          }));



          // Trigger Google TTS if script exists
          if (llmResponse.tts_script && llmResponse.tts_global_config) {
            await generateTTS({
              jobId,
              userEmail: jobDetail.user_email,
              userId: jobDetail.user_id,
              llmResponse,
              S3_RESOURCE_BUCKET: process.env.S3_RESOURCE_BUCKET || "dapurartisan",
              dynamo,
              USER_REQUEST_TABLE: process.env.USER_REQUEST_TABLE_NAME,
              callGoogleTTS,
              uploadToS3
            });
          }
        }
      } catch (e) {
        console.error("[WorkerB] AI processing error:", e);
      }
    }

    // 8. Dispatch ke selectedWorkerUrl
    const executorJobId = await dispatchToWorker(selectedWorkerUrl, jobId, jobDetail);
    console.log(`Job ${jobId} dikirim ke ${selectedWorkerUrl}, executor_job_id: ${executorJobId}`);
    // executor_job_id tidak disimpan kembali ke Redis untuk menghindari overwrite status dari Worker C.

    // 8. Jika masih ada slot kosong (di url mana saja) dan ada item di antrean, kick Worker B lagi
    const remaining = await redis.llen(TASK_QUEUE_KEY);

    let hasEmptySlot = false;
    for (const url of workerUrls) {
      const activeCount = await redis.scard(`${ACTIVE_JOBS_KEY}:${url}`);
      if (activeCount < MAX_ACTIVE_SLOTS) {
        hasEmptySlot = true;
        break;
      }
    }

    if (remaining > 0 && hasEmptySlot) {
      console.log(`Masih ada ${remaining} job di antrean dan slot masih tersedia. Self-trigger Worker B.`);
      await triggerWorkerBViaqStash();
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Job berhasil dikirim ke executor.",
        job_id: jobId,
        executor_job_id: executorJobId,
      }),
    };
  } catch (err) {
    console.error("Worker B error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Internal error di Worker B." }),
    };
  }
};
