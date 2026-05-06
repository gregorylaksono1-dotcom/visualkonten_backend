const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  GetCommand,
  TransactWriteCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const { Redis } = require("@upstash/redis");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});
const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;
const TOPUP_CREDIT_TABLE_NAME = process.env.TOPUP_CREDIT_TABLE_NAME;
const TOPUP_CREDIT_USER_EMAIL_INDEX = process.env.TOPUP_CREDIT_USER_EMAIL_INDEX;
const USER_REQUEST_TABLE_NAME = process.env.USER_REQUEST_TABLE_NAME;
const USER_REQUEST_USER_EMAIL_INDEX = process.env.USER_REQUEST_USER_EMAIL_INDEX;
const PRICING_TABLE_NAME = process.env.PRICING_TABLE_NAME;
const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET || "dapurartisan";
const MIDTRANS_API_URL = process.env.MIDTRANS_API_URL;
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const MIDTRANS_FINISH_CALLBACK_URL = process.env.MIDTRANS_FINISH_CALLBACK_URL;

// ─── Redis / QStash (untuk Worker A sebagai Produsen) ───────────────────────
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const WORKER_B_QSTASH_URL = process.env.WORKER_B_QSTASH_URL;

// Kunci Redis
const TASK_QUEUE_KEY = "task_queue";
const ACTIVE_JOBS_KEY = "active_jobs";
const JOB_DETAIL_PREFIX = "job_detail:";
const IS_WORKER_ACTIVE_KEY = "is_worker_active";

/** Singleton Redis client per cold-start Lambda. */
let _redis;
const getRedis = () => {
  if (!_redis) {
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;
    _redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  }
  return _redis;
};

/**
 * Worker A: Enqueue job ke Redis dan (sekali) bangunkan Worker B via QStash.
 * Fire-and-forget — kegagalan di sini TIDAK membatalkan response ke user.
 *
 * @param {string} jobId - UUID job yang sudah disimpan di DynamoDB
 * @param {object} jobDetail - Detail lengkap job untuk disimpan di Redis
 */
const enqueueJob = async (jobId, jobDetail) => {
  const redis = getRedis();
  if (!redis) {
    console.warn("Redis tidak dikonfigurasi — job tidak dimasukkan ke antrean.");
    return;
  }

  try {
    // 1. Simpan detail job di Redis (TTL 2 jam sebagai pengaman)
    // Simpan hanya field minimal yang dibutuhkan untuk orkestrasi (sisanya ada di DynamoDB)
    const slimDetail = {
      uuid: jobId,           // diperlukan Worker C untuk UpdateCommand DynamoDB
      user_email: jobDetail.user_email,
      user_id: jobDetail.user_id,
      status: "PENDING",
      worker_url: null,
      processing_at: null,
      completed_at: null,
      result_url: null,
    };
    await redis.set(
      `${JOB_DETAIL_PREFIX}${jobId}`,
      JSON.stringify(slimDetail)
    );

    // 2. Masukkan jobId ke antrean (LPUSH → RPOP = FIFO)
    await redis.lpush(TASK_QUEUE_KEY, jobId);
    console.log(`Job ${jobId} dimasukkan ke task_queue.`);

    // 3. Bangunkan Worker B hanya jika sistem belum aktif
    //    SET NX (set if not exists) + EXPIRE 60 detik sebagai flag TTL
    const flagSet = await redis.set(IS_WORKER_ACTIVE_KEY, "1", { ex: 60, nx: true });
    if (flagSet === "OK" || flagSet === 1) {
      // Flag baru di-set → sistem belum aktif, bangunkan Worker B
      await triggerWorkerBOnce();
    } else {
      console.log("is_worker_active sudah true — Worker B sudah jalan, tidak perlu memicu ulang.");
    }
  } catch (err) {
    // Jangan throw — Redis error tidak membatalkan transaksi kredit user
    console.error("enqueueJob error:", err?.message);
  }
};

/** Kirim satu pesan QStash ke Worker B. */
const triggerWorkerBOnce = async () => {
  if (!QSTASH_TOKEN || !WORKER_B_QSTASH_URL) {
    console.warn("QStash tidak dikonfigurasi — Worker B tidak dibangunkan.");
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
      body: JSON.stringify({ source: "worker_a" }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`QStash trigger gagal (${res.status}): ${text}`);
  } else {
    console.log("Worker B berhasil dibangunkan via QStash.");
  }
};
// ────────────────────────────────────────────────────────────────────────────

/** Sort key standar baris harga utama (boleh pakai SK lain; Query ambil 1 baris pertama). */
const PRICING_CHARGE_DEFAULT = "default";

const pathEndsWithResource = (event, suffix) => {
  const p = event.path || "";
  const rp = event.requestContext?.resourcePath || event.resource || "";
  return p.endsWith(suffix) || rp === suffix;
};

/** Email yang disimpan di user_request / topup agar konsisten dengan query. */
const normalizeUserEmail = (raw) => String(raw || "").trim().toLowerCase();

/** Kandidat email dari token (raw + lower) untuk match baris lama di DynamoDB. */
const usageEmailCandidates = (raw) => {
  const trimmed = String(raw || "").trim();
  const lower = trimmed.toLowerCase();
  const out = [];
  if (trimmed) out.push(trimmed);
  if (lower && lower !== trimmed) out.push(lower);
  return out;
};

const mapUserRequestUsageRow = (item) => ({
  uuid: item.uuid,
  prompt: item.prompt,
  request_type: item.request_type,
  resource_family: item.resource_family,
  credit_amount: item.credit_amount,
  status: item.status,
  created_at: item.created_at,
  s3_key: item.s3_key ?? null,
});

/**
 * Baris tanpa created_at tidak masuk GSI UserEmailCreatedIndex.
 * Scan tabel (dengan filter email) memuat data lama / sebelum GSI.
 */
const scanUserRequestsForUsage = async (tableName, emails, sinceIso, maxItems) => {
  if (!emails.length) return [];
  const emailSet = new Set(emails.map((e) => String(e || "").trim()));
  const matchesEmail = (item) => {
    const ue = String(item.user_email || "").trim();
    if (!ue) return false;
    if (emailSet.has(ue)) return true;
    if (emailSet.has(ue.toLowerCase())) return true;
    return emails.some((e) => ue.toLowerCase() === String(e || "").trim().toLowerCase());
  };
  const inWindow = (item) => {
    const ca = item.created_at;
    if (ca == null || ca === "") return true;
    return String(ca) >= sinceIso;
  };

  const collected = [];
  let exclusiveStartKey;
  let pages = 0;
  const maxPages = 20;

  while (collected.length < maxItems && pages < maxPages) {
    pages += 1;
    const res = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
        Limit: 200,
      })
    );
    for (const item of res.Items || []) {
      if (!matchesEmail(item) || !inWindow(item)) continue;
      collected.push(item);
    }
    exclusiveStartKey = res.LastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }

  collected.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return collected.slice(0, maxItems);
};

const parseImageBase64 = (raw) => {
  if (raw == null || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^data:([^;]+);base64,(.+)$/i);
  if (m) {
    return { contentType: m[1], buffer: Buffer.from(m[2], "base64") };
  }
  return { contentType: "image/jpeg", buffer: Buffer.from(s, "base64") };
};

const extFromContentType = (ct) => {
  const c = String(ct || "").toLowerCase();
  if (c.includes("png")) return "png";
  if (c.includes("webp")) return "webp";
  if (c.includes("gif")) return "gif";
  return "jpg";
};

const ALLOWED_VIDEO_QUALITY = new Set(["480p", "720p", "1080p"]);
const ALLOWED_ASPECT_RATIO = new Set(["9:16", "16:9", "1:1"]);

const normalizeVideoQuality = (raw) => {
  const q = String(raw || "720p").trim().toLowerCase();
  return ALLOWED_VIDEO_QUALITY.has(q) ? q : "720p";
};

const normalizeAspectRatio = (raw) => {
  const a = String(raw || "16:9").trim();
  return ALLOWED_ASPECT_RATIO.has(a) ? a : "16:9";
};

/**
 * Nilai kredit dari satu baris pricing.
 * Mendukung: atribut `amount` / `credits`, atau angka di SK/atribut `charge` (string "5" seperti di konsol).
 */
const parseCreditsFromPricingItem = (item) => {
  if (!item) return NaN;
  const raw = item.amount ?? item.credits ?? item.charge;
  if (raw === undefined || raw === null || raw === "") return NaN;
  const n = Math.round(Number(String(raw).trim()));
  return n;
};

/**
 * Baca harga dari tabel pricing (PK key, SK charge).
 * GetItem (key, charge=default) jika dipakai; lalu Query partition `key` Limit 1.
 */
const resolvePricingRow = async (decodedKey) => {
  if (!PRICING_TABLE_NAME || !decodedKey) return null;
  const k = String(decodedKey).trim();
  if (!k) return null;

  try {
    const getRes = await docClient.send(
      new GetCommand({
        TableName: PRICING_TABLE_NAME,
        Key: { key: k, charge: PRICING_CHARGE_DEFAULT },
      })
    );
    if (getRes.Item) {
      const n = parseCreditsFromPricingItem(getRes.Item);
      if (Number.isFinite(n) && n > 0) {
        return { amount: n, item: getRes.Item };
      }
    }
  } catch (e) {
    console.warn("pricing GetItem", k, e?.message);
  }
  const q = await docClient.send(
    new QueryCommand({
      TableName: PRICING_TABLE_NAME,
      KeyConditionExpression: "#kk = :k",
      ExpressionAttributeNames: { "#kk": "key" },
      ExpressionAttributeValues: { ":k": k },
      Limit: 1,
      ScanIndexForward: true,
    })
  );
  const item = q.Items?.[0];
  if (!item) return null;
  const n = parseCreditsFromPricingItem(item);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { amount: n, item };
};

const defaultHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
};

const response = (statusCode, body) => ({
  statusCode,
  headers: defaultHeaders,
  body: JSON.stringify(body),
});

const getClaims = (event) => event?.requestContext?.authorizer?.claims || {};
const generateFriendlyOrderId = (userId) => {
  const safeUserId = String(userId || "usr").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const shortUserPrefix = (safeUserId.slice(0, 3) || "usr").padEnd(3, "x");
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const timestamp =
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());

  return `${shortUserPrefix}-${timestamp}`;
};

const parseBody = (event) => {
  if (!event?.body) return {};
  if (typeof event.body === "string") {
    try {
      return JSON.parse(event.body);
    } catch {
      return {};
    }
  }
  return event.body;
};

/**
 * Midtrans expiry.start_time format:
 * YYYY-MM-DD HH:mm:ss +0700 (WIB / Asia Jakarta)
 */
const formatMidtransStartTime = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second} +0700`;
};

const pickEnabledPaymentsByNominal = (nominal) => {
  if (nominal < 20000) {
    // Nominal kecil: prioritaskan e-wallet / QR channel.
    return ["shopeepay", "gopay", "qris"];
  }
  if (nominal > 1000000) {
    // Nominal besar: tambah opsi kartu dan VA populer.
    return ["credit_card", "bca_va", "bni_va", "mandiri_clickpay"];
  }
  // Nominal menengah: default tanpa kartu kredit.
  return ["bca_va", "gopay", "qris", "shopeepay", "echannel"];
};

// Filter by status uses UserEmailIndex + FilterExpression + pagination (no extra GSI).
// If partition grows very large, consider a GSI (e.g. user_email + status_sort_key) to reduce RCU.
const buildCreditStatusFilterParts = (statusGroup) => {
  const g = String(statusGroup || "all").toLowerCase();
  if (g === "all") return null;
  const names = { "#st": "status" };
  if (g === "success") {
    return {
      FilterExpression: "#st IN (:s0, :s1, :s2, :s3)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: {
        ":s0": "SUCCESS",
        ":s1": "SETTLEMENT",
        ":s2": "BERHASIL",
        ":s3": "CAPTURE",
      },
    };
  }
  if (g === "pending") {
    return {
      FilterExpression: "#st IN (:p0, :p1)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: {
        ":p0": "PENDING",
        ":p1": "MENUNGGU",
      },
    };
  }
  if (g === "failed") {
    return {
      FilterExpression:
        "(attribute_not_exists(#st) OR NOT (#st IN (:s0, :s1, :s2, :s3, :p0, :p1)))",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: {
        ":s0": "SUCCESS",
        ":s1": "SETTLEMENT",
        ":s2": "BERHASIL",
        ":s3": "CAPTURE",
        ":p0": "PENDING",
        ":p1": "MENUNGGU",
      },
    };
  }
  return null;
};

const queryCreditHistoryPaged = async (userEmail, filterParts, maxItems, pageSize, maxPages) => {
  const collected = [];
  let exclusiveStartKey;
  let pages = 0;
  while (pages < maxPages && collected.length < maxItems) {
    pages += 1;
    const params = {
      TableName: TOPUP_CREDIT_TABLE_NAME,
      IndexName: TOPUP_CREDIT_USER_EMAIL_INDEX,
      KeyConditionExpression: "user_email = :email",
      ExpressionAttributeValues: {
        ":email": userEmail,
        ...(filterParts?.ExpressionAttributeValues || {}),
      },
      ScanIndexForward: false,
      Limit: pageSize,
      ExclusiveStartKey: exclusiveStartKey,
    };
    if (filterParts?.FilterExpression) {
      params.FilterExpression = filterParts.FilterExpression;
    }
    if (filterParts?.ExpressionAttributeNames) {
      params.ExpressionAttributeNames = filterParts.ExpressionAttributeNames;
    }
    const res = await docClient.send(new QueryCommand(params));
    for (const item of res.Items || []) {
      collected.push(item);
      if (collected.length >= maxItems) break;
    }
    if (collected.length >= maxItems) break;
    exclusiveStartKey = res.LastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }
  return collected.slice(0, maxItems);
};

const getLatestCreditMetrics = async (userEmail) => {
  const res = await docClient.send(
    new QueryCommand({
      TableName: TOPUP_CREDIT_TABLE_NAME,
      IndexName: TOPUP_CREDIT_USER_EMAIL_INDEX,
      KeyConditionExpression: "user_email = :email",
      ExpressionAttributeValues: {
        ":email": userEmail,
      },
      ScanIndexForward: false,
      Limit: 20,
    })
  );
  const items = res.Items || [];
  const latestItem = items[0] || {};
  const usageFromItems = items.reduce((total, item) => total + Number(item.usage || 0), 0);
  const usage = Number(latestItem.usage ?? usageFromItems ?? 0);
  const balance = Number(latestItem.balance ?? 0);
  return { usage, balance, tailItems: items };
};

const sumSuccessfulSpending = async (userEmail) => {
  const filterParts = buildCreditStatusFilterParts("success");
  const items = await queryCreditHistoryPaged(userEmail, filterParts, 5000, 80, 80);
  return items.reduce((sum, item) => {
    const n = Number(item.total);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
};


const handleGetHello = async (event) => {
  return response(200, { message: "Hello World from BikinAi.com backend!" });
};

const handleGetUser = async (event) => {
  const claims = getClaims(event);
  const userId = claims.sub;
  if (!userId) {
    return response(401, { error: "Unauthorized: missing user id claim." });
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: PROFILE_TABLE_NAME,
      KeyConditionExpression: "user_id = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
      Limit: 1,
    })
  );

  return response(200, { data: result.Items?.[0] || null });
};

const handleGetPricing = async (event, pricingKeyParam) => {
  if (!PRICING_TABLE_NAME) {
    return response(500, { error: "PRICING_TABLE_NAME is not configured." });
  }
  const decodedKey = decodeURIComponent(String(pricingKeyParam).trim());
  if (!decodedKey) {
    return response(400, { error: "Missing pricing key." });
  }
  const resolved = await resolvePricingRow(decodedKey);
  if (!resolved) {
    return response(404, { error: `Pricing not found for key "${decodedKey}".` });
  }
  return response(200, {
    data: {
      key: resolved.item.key,
      charge: resolved.item.charge,
      amount: resolved.amount,
    },
  });
};

const handleGetTopup = async (event, topupOrderId) => {
  const claims = getClaims(event);
  const userEmail =
    claims.email ||
    claims["cognito:username"] ||
    claims.username;
  if (!userEmail) {
    return response(401, { error: "Unauthorized: missing email claim." });
  }

  const decodedId = decodeURIComponent(String(topupOrderId));
  const topupResult = await docClient.send(
    new QueryCommand({
      TableName: TOPUP_CREDIT_TABLE_NAME,
      KeyConditionExpression: "#uuid = :orderId",
      ExpressionAttributeNames: {
        "#uuid": "uuid",
      },
      ExpressionAttributeValues: {
        ":orderId": decodedId,
      },
      Limit: 1,
    })
  );
  const item = topupResult.Items?.[0];
  if (!item || item.user_email !== userEmail) {
    return response(404, { error: "Topup not found." });
  }
  let creditBalance = null;
  const userIdFromTopup = String(item.user_id || "").trim();
  if (userIdFromTopup) {
    const profileResult = await docClient.send(
      new QueryCommand({
        TableName: PROFILE_TABLE_NAME,
        KeyConditionExpression: "user_id = :userId",
        ExpressionAttributeValues: {
          ":userId": userIdFromTopup,
        },
        Limit: 1,
      })
    );
    const profileItem = profileResult.Items?.[0] || null;
    if (profileItem?.credit_balance !== undefined && profileItem?.credit_balance !== null) {
      const n = Number(profileItem.credit_balance);
      creditBalance = Number.isFinite(n) ? n : null;
    }
  }
  return response(200, { data: { ...item, credit_balance: creditBalance } });
};

const handleGetCredit = async (event) => {
  const claims = getClaims(event);
  const userEmail =
    claims.email ||
    claims["cognito:username"] ||
    claims.username;
  if (!userEmail) {
    return response(401, { error: "Unauthorized: missing email claim." });
  }

  const qs = event.queryStringParameters || {};
  if (String(qs.spent_total_only || "") === "1") {
    const { usage, balance } = await getLatestCreditMetrics(userEmail);
    const spent_success_total = await sumSuccessfulSpending(userEmail);
    return response(200, {
      data: [],
      usage,
      balance,
      spent_success_total,
    });
  }

  const statusGroup = String(qs.status || "all").toLowerCase();
  const limitRaw = qs.limit != null ? Number(qs.limit) : NaN;
  const hasExplicitLimit = Number.isFinite(limitRaw);
  const requestedLimit = hasExplicitLimit
    ? Math.min(500, Math.max(1, Math.floor(limitRaw)))
    : statusGroup !== "all"
      ? 200
      : 20;
  const wantsExtendedHistory =
    hasExplicitLimit || statusGroup !== "all";

  const filterParts = buildCreditStatusFilterParts(statusGroup);

  let items;
  if (!wantsExtendedHistory && statusGroup === "all") {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TOPUP_CREDIT_TABLE_NAME,
        IndexName: TOPUP_CREDIT_USER_EMAIL_INDEX,
        KeyConditionExpression: "user_email = :email",
        ExpressionAttributeValues: {
          ":email": userEmail,
        },
        ScanIndexForward: false,
        Limit: 20,
      })
    );
    items = result.Items || [];
  } else {
    const maxItems = requestedLimit;
    items = await queryCreditHistoryPaged(
      userEmail,
      filterParts,
      maxItems,
      50,
      40
    );
  }

  const latestItem = items[0] || {};
  const usageFromItems = items.reduce(
    (total, item) => total + Number(item.usage || 0),
    0
  );
  const usage = Number(latestItem.usage ?? usageFromItems ?? 0);
  const balance = Number(latestItem.balance ?? 0);

  const body = {
    data: items,
    usage,
    balance,
  };
  if (wantsExtendedHistory) {
    const metrics = await getLatestCreditMetrics(userEmail);
    body.usage = metrics.usage;
    body.balance = metrics.balance;
  }

  return response(200, body);
};

const handleGetUsage = async (event) => {
  if (!USER_REQUEST_TABLE_NAME) {
    return response(500, { error: "USER_REQUEST_TABLE_NAME is not configured." });
  }

  const claims = getClaims(event);
  const userEmailRaw =
    claims.email || claims["cognito:username"] || claims.username;
  if (!userEmailRaw) {
    return response(401, { error: "Unauthorized: missing email claim." });
  }

  const candidates = usageEmailCandidates(userEmailRaw);
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString();

  const byUuid = new Map();

  if (USER_REQUEST_USER_EMAIL_INDEX) {
    for (const email of candidates) {
      try {
        const result = await docClient.send(
          new QueryCommand({
            TableName: USER_REQUEST_TABLE_NAME,
            IndexName: USER_REQUEST_USER_EMAIL_INDEX,
            KeyConditionExpression:
              "user_email = :email AND created_at >= :since",
            ExpressionAttributeValues: {
              ":email": email,
              ":since": sinceIso,
            },
            ScanIndexForward: false,
            Limit: 100,
          })
        );
        for (const it of result.Items || []) {
          if (it?.uuid) byUuid.set(it.uuid, it);
        }
      } catch (err) {
        console.error("GET /usage GSI query failed", {
          name: err?.name,
          message: err?.message,
        });
      }
    }
  }

  let items = [...byUuid.values()];
  /* Baris tanpa created_at tidak ikut GSI; index belum deploy; atau email beda format → Scan terbatas. */
  if (!items.length) {
    const scanned = await scanUserRequestsForUsage(
      USER_REQUEST_TABLE_NAME,
      candidates,
      sinceIso,
      100
    );
    for (const it of scanned) {
      if (it?.uuid) byUuid.set(it.uuid, it);
    }
    items = [...byUuid.values()];
  }

  items.sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
  const data = items.slice(0, 100).map(mapUserRequestUsageRow);

  return response(200, { data });
};

const handlePostSnap = async (event) => {
  const claims = getClaims(event);
  const userEmail = claims.email || claims["cognito:username"] || claims.username;
  const userId = claims.sub;
  const firstName = claims.name || claims.given_name || "Customer";
  if (!userEmail || !userId) {
    return response(401, { error: "Unauthorized: missing user claims." });
  }

  const body = parseBody(event);
  const totalCredit = Number(body.total_credit || 0);
  const totalPrice = Number(body.total_price || 0);
  if (!totalCredit || !totalPrice) {
    return response(400, { error: "total_credit and total_price are required." });
  }

  const orderId = generateFriendlyOrderId(userId);
  const now = new Date().toISOString();

  await docClient.send(
    new PutCommand({
      TableName: TOPUP_CREDIT_TABLE_NAME,
      Item: {
        uuid: orderId,
        user_email: userEmail,
        user_id: userId,
        created_at: now,
        updated_at: now,
        amount: totalCredit,
        total: totalPrice,
        status: "PENDING",
      },
    })
  );

  const midtransBody = {
    transaction_details: {
      order_id: orderId,
      gross_amount: totalPrice,
    },
    enabled_payments: pickEnabledPaymentsByNominal(totalPrice),
    customer_details: {
      first_name: firstName,
      email: userEmail,
      user_id: userId,
    },
    expiry: {
      start_time: formatMidtransStartTime(),
      unit: "minutes",
      duration: 60,
    },
    custom_field1: userId,
    custom_field2: userEmail,
    custom_field3: orderId,
  };
  const finishCallback = String(
    body.finish_callback_url || MIDTRANS_FINISH_CALLBACK_URL || ""
  ).trim();
  if (finishCallback) {
    midtransBody.callbacks = {
      finish: finishCallback,
    };
  }
  console.log("creating midtrans snap transaction", {
    orderId,
    userId,
    userEmail,
    totalCredit,
    totalPrice,
    midtransApiUrl: MIDTRANS_API_URL,
    finishCallback: finishCallback || null,
  });

  const basicAuth = Buffer.from(`${MIDTRANS_SERVER_KEY}:`).toString("base64");
  const midtransRes = await fetch(MIDTRANS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify(midtransBody),
  });

  const midtransJson = await midtransRes.json();
  console.log("midtrans snap response", {
    orderId,
    status: midtransRes.status,
    ok: midtransRes.ok,
    body: midtransJson,
  });
  if (!midtransRes.ok) {
    console.error("midtrans snap creation failed", {
      orderId,
      status: midtransRes.status,
      body: midtransJson,
    });
    return response(502, {
      error: "Failed to create Midtrans Snap transaction.",
      detail: midtransJson,
    });
  }

  return response(200, {
    order_id: orderId,
    token: midtransJson.token || null,
    payment_url:
      midtransJson.payment_url ||
      midtransJson.redirect_url ||
      midtransJson.url ||
      null,
    midtrans: midtransJson,
  });
};

const handlePostResource = async (event) => {
  if (!USER_REQUEST_TABLE_NAME) {
    return response(500, { error: "USER_REQUEST_TABLE_NAME is not configured." });
  }

  const claims = getClaims(event);
  const userEmailRaw =
    claims.email || claims["cognito:username"] || claims.username;
  const userId = claims.sub;
  if (!userEmailRaw || !userId) {
    return response(401, { error: "Unauthorized: missing user claims." });
  }
  const userEmail = normalizeUserEmail(userEmailRaw);

  const body = parseBody(event);
  const prompt = String(body.prompt || "").trim();
  const imageBase64 =
    body.image_base64 != null ? String(body.image_base64) : "";
  const hasImage = Boolean(imageBase64.trim());
  const resourceFamilyRaw = String(
    body.resource_family ?? body.media_family ?? "image"
  ).toLowerCase();
  const resourceFamily = resourceFamilyRaw === "video" ? "video" : "image";

  let requestType;
  let pricingKey;

  const videoQuality = resourceFamily === "video" ? normalizeVideoQuality(body.video_quality) : null;
  const aspectRatio = resourceFamily === "video" ? normalizeAspectRatio(body.aspect_ratio) : null;

  if (resourceFamily === "video") {
    requestType = hasImage ? "image-to-video" : "text-to-video";
    const basePricingKey = hasImage ? "IMAGE-TO-VIDEO" : "TEXT-TO-VIDEO";
    const qualityNum = videoQuality ? videoQuality.replace("p", "") : "720";
    pricingKey = `${basePricingKey}-${qualityNum}`;
  } else {
    requestType = hasImage ? "image-to-image" : "text-to-image";
    pricingKey = hasImage ? "IMAGE-TO-IMAGE" : "TEXT-TO-IMAGE";
  }

  if (!prompt) {
    return response(400, { error: "prompt is required." });
  }

  if (!PRICING_TABLE_NAME) {
    return response(500, { error: "PRICING_TABLE_NAME is not configured." });
  }
  const pricingResolved = await resolvePricingRow(pricingKey);
  if (!pricingResolved) {
    return response(404, {
      error: `Pricing belum dikonfigurasi untuk "${pricingKey}". Tambahkan baris di tabel pricing (PK key, SK charge, atribut amount Number).`,
    });
  }
  const creditAmount = pricingResolved.amount;

  const videoOptions =
    resourceFamily === "video" && videoQuality && aspectRatio
      ? { video_quality: videoQuality, aspect_ratio: aspectRatio }
      : {};

  if (body.credit_amount !== undefined && body.credit_amount !== null && body.credit_amount !== "") {
    const declared = Number(body.credit_amount);
    if (Number.isNaN(declared) || declared !== creditAmount) {
      return response(400, {
        error: `credit_amount harus ${creditAmount} (sesuai tabel pricing untuk ${pricingKey}).`,
      });
    }
  }

  const now = new Date().toISOString();
  const requestId = randomUUID();

  const profileDebitTransact = {
    Update: {
      TableName: PROFILE_TABLE_NAME,
      Key: {
        user_id: String(userId),
        user_type: "CUSTOMER",
      },
      UpdateExpression:
        "SET credit_balance = if_not_exists(credit_balance, :z) - :c, credit_usage = if_not_exists(credit_usage, :z) + :c, updated_at = :now",
      ConditionExpression:
        "attribute_exists(user_id) AND attribute_exists(user_type) AND credit_balance >= :c",
      ExpressionAttributeValues: {
        ":z": 0,
        ":c": creditAmount,
        ":now": now,
      },
    },
  };

  const runResourceTransact = async (putItem) => {
    try {
      await docClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: USER_REQUEST_TABLE_NAME,
                Item: putItem,
              },
            },
            profileDebitTransact,
          ],
        })
      );
    } catch (err) {
      if (err?.name === "TransactionCanceledException") {
        const reasons = err.CancellationReasons || [];
        if (reasons.some((r) => r?.Code === "ConditionalCheckFailed")) {
          return response(402, {
            error: "Insufficient credit balance or profile not found.",
            required_credit: creditAmount,
          });
        }
      }
      console.error("POST /resource transact error", err);
      return response(500, { error: err.message || "Transaction failed." });
    }
    return null;
  };

  if (!hasImage) {
    const putItem = {
      uuid: requestId,
      user_email: userEmail,
      user_id: userId,
      prompt,
      request_type: requestType,
      resource_family: resourceFamily,
      status: "PENDING",
      credit_amount: creditAmount,
      created_at: now,
      updated_at: now,
      ...videoOptions,
    };
    const errRes = await runResourceTransact(putItem);
    if (errRes) return errRes;

    // Worker A: masukkan job ke Redis queue & bangunkan Worker B (fire-and-forget)
    await enqueueJob(requestId, {
      uuid: requestId,
      user_email: userEmail,
      user_id: userId,
      prompt,
      request_type: requestType,
      resource_family: resourceFamily,
      s3_key: null,
      ...videoOptions,
    });

    return response(200, {
      data: {
        uuid: requestId,
        user_email: userEmail,
        request_type: requestType,
        resource_family: resourceFamily,
        status: "PENDING",
        credit_amount: creditAmount,
        s3_key: null,
        ...videoOptions,
      },
    });
  }

  const parsed = parseImageBase64(imageBase64);
  if (!parsed?.buffer?.length) {
    return response(400, { error: "Invalid image_base64 payload." });
  }

  const ext = extFromContentType(parsed.contentType);
  const s3Key = `user_request/${userId}/${requestId}.${ext}`;

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_RESOURCE_BUCKET,
        Key: s3Key,
        Body: parsed.buffer,
        ContentType: parsed.contentType,
      })
    );
  } catch (err) {
    console.error("S3 PutObject failed", err);
    return response(502, { error: "Failed to upload image to storage." });
  }

  const putItem = {
    uuid: requestId,
    user_email: userEmail,
    user_id: userId,
    prompt,
    request_type: requestType,
    resource_family: resourceFamily,
    status: "PENDING",
    s3_key: s3Key,
    credit_amount: creditAmount,
    created_at: now,
    updated_at: now,
    ...videoOptions,
  };
  const errRes = await runResourceTransact(putItem);
  if (errRes) return errRes;

  // Worker A: masukkan job ke Redis queue & bangunkan Worker B (fire-and-forget)
  await enqueueJob(requestId, {
    uuid: requestId,
    user_email: userEmail,
    user_id: userId,
    prompt,
    request_type: requestType,
    resource_family: resourceFamily,
    s3_key: s3Key,
    ...videoOptions,
  });

  return response(200, {
    data: {
      uuid: requestId,
      user_email: userEmail,
      request_type: requestType,
      resource_family: resourceFamily,
      status: "PENDING",
      credit_amount: creditAmount,
      s3_key: s3Key,
      ...videoOptions,
    },
  });
};

exports.handler = async (event) => {
  try {
    const routeKey = `${event.httpMethod} ${event.path}`;

    if (routeKey === "GET /hello") return await handleGetHello(event);
    if (routeKey === "GET /user") return await handleGetUser(event);

    const pricingKeyParam = event.pathParameters?.key;
    if (event.httpMethod === "GET" && pricingKeyParam) {
      const path = event.path || "";
      const resource = event.resource || "";
      if (path.includes("/pricing/") || resource === "/pricing/{key}" || String(resource).includes("/pricing/")) {
        return await handleGetPricing(event, pricingKeyParam);
      }
    }

    const topupOrderId = event.pathParameters?.orderId;
    if (event.httpMethod === "GET" && topupOrderId) {
      const path = event.path || "";
      const resource = event.resource || "";
      if (path.includes("/topup/") || resource === "/topup/{orderId}" || resource.includes("/topup/")) {
        return await handleGetTopup(event, topupOrderId);
      }
    }

    if (routeKey === "GET /credit") return await handleGetCredit(event);

    if (String(event.httpMethod || "").toUpperCase() === "GET" && pathEndsWithResource(event, "/usage")) {
      return await handleGetUsage(event);
    }

    if (routeKey === "POST /snap") return await handlePostSnap(event);

    if (String(event.httpMethod || "").toUpperCase() === "POST" && pathEndsWithResource(event, "/resource")) {
      return await handlePostResource(event);
    }

    return response(404, { error: "Not Found" });
  } catch (err) {
    console.error("Handler error:", err);
    return response(500, { error: "Internal Server Error" });
  }
};
