/**
 * ComfyUI Worker (AWS Lambda)
 *
 * Alur kerja:
 *  A. SUBMISSION (via Worker A):
 *     1. Upload satu atau lebih input image ke ComfyUI Cloud.
 *     2. Submit workflow (build via workflows.js).
 *     3. Simpan prompt_id ke DynamoDB (status: PROCESSING).
 *
 *  B. POLLING (via EventBridge Schedule):
 *     1. Cari semua job di DynamoDB dengan status "PROCESSING".
 *     2. Cek status di ComfyUI Cloud, update jika COMPLETED/FAILED.
 */

"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { buildWorkflow } = require("./workflows");

// ─── Config ──────────────────────────────────────────────────────────────────
const COMFY_BASE_URL    = "https://cloud.comfy.org";
const COMFY_API_KEY     = process.env.COMFY_CLOUD_API_KEY;
const USER_REQUEST_TABLE = process.env.USER_REQUEST_TABLE_NAME;
const STATUS_INDEX      = process.env.STATUS_CREATED_INDEX_NAME;
const REGION            = process.env.AWS_REGION || "ap-southeast-1";

// ─── DynamoDB ─────────────────────────────────────────────────────────────────
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ─── ComfyUI API helpers ──────────────────────────────────────────────────────

const uploadInputImage = async (imageUrl, filename = "input_image.png") => {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Gagal download input image: ${imageRes.status}`);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

  const formData = new FormData();
  formData.append("image", new Blob([imageBuffer]), filename);
  formData.append("overwrite", "true");

  const uploadRes = await fetch(`${COMFY_BASE_URL}/api/upload/image`, {
    method: "POST",
    headers: { "X-API-Key": COMFY_API_KEY },
    body: formData,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`ComfyUI image upload failed: ${text}`);
  }
  const data = await uploadRes.json();
  return data.name;
};

const submitWorkflow = async (workflow) => {
  const res = await fetch(`${COMFY_BASE_URL}/api/prompt`, {
    method: "POST",
    headers: {
      "X-API-Key": COMFY_API_KEY,
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

const getOutputUrl = async (promptId) => {
  const res = await fetch(`${COMFY_BASE_URL}/api/jobs/${promptId}`, {
    headers: { "X-API-Key": COMFY_API_KEY },
  });
  if (!res.ok) return null;

  const job = await res.json();
  const outputs = job.outputs || {};
  for (const nodeOutputs of Object.values(outputs)) {
    const files = [...(nodeOutputs.gifs || []), ...(nodeOutputs.videos || []), ...(nodeOutputs.images || [])];
    for (const file of files) {
      const url = await resolveSignedUrl(file);
      if (url) return url;
    }
  }
  return null;
};

const resolveSignedUrl = async (fileInfo) => {
  if (!fileInfo?.filename) return null;
  const params = new URLSearchParams({ filename: fileInfo.filename, subfolder: fileInfo.subfolder || "", type: fileInfo.type || "output" });
  const res = await fetch(`${COMFY_BASE_URL}/api/view?${params}`, { headers: { "X-API-Key": COMFY_API_KEY }, redirect: "manual" });
  return res.headers.get("location");
};

// ─── DynamoDB helpers ─────────────────────────────────────────────────────────

const updateDynamoStatus = async (jobId, userEmail, status, { resultUrl, comfyPromptId } = {}) => {
  const updates = ["#s = :s", "updated_at = :u"];
  const names = { "#s": "status" };
  const values = { ":s": status, ":u": new Date().toISOString() };

  if (resultUrl !== undefined) {
    updates.push("result_url = :r");
    values[":r"] = resultUrl;
  }
  if (comfyPromptId !== undefined) {
    updates.push("comfy_prompt_id = :cp");
    values[":cp"] = comfyPromptId;
  }

  try {
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET " + updates.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    console.error("[ComfyUI] Dynamo update error:", err.message);
  }
};

const getProcessingJobs = async () => {
  const res = await dynamo.send(new QueryCommand({
    TableName: USER_REQUEST_TABLE,
    IndexName: STATUS_INDEX,
    KeyConditionExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "PROCESSING" },
  }));
  return res.Items || [];
};

// ─── Core Logic ──────────────────────────────────────────────────────────────

const checkSingleJobStatus = async (job) => {
  const promptId = job.comfy_prompt_id;
  if (!promptId) return;

  try {
    const res = await fetch(`${COMFY_BASE_URL}/api/job/${promptId}/status`, {
      headers: { "X-API-Key": COMFY_API_KEY },
    });

    if (!res.ok) return;
    const { status } = await res.json();
    if (status === "completed") {
      const resultUrl = await getOutputUrl(promptId);
      await updateDynamoStatus(job.uuid, job.user_email, "COMPLETED", { resultUrl });
    } else if (status === "failed" || status === "cancelled") {
      await updateDynamoStatus(job.uuid, job.user_email, "FAILED");
    }
  } catch (err) {
    console.error(`[Poller] Error job ${job.uuid}:`, err.message);
  }
};

const handlePolling = async () => {
  const jobs = await getProcessingJobs();
  if (jobs.length > 0) {
    await Promise.all(jobs.map(checkSingleJobStatus));
  }
};

const handleSubmission = async (event) => {
  const { jobId, userEmail, requestType, prompt, videoQuality, aspectRatio, s3ImageUrls } = event;

  try {
    const imageUrls = Array.isArray(s3ImageUrls) ? s3ImageUrls : (s3ImageUrls ? [s3ImageUrls] : []);
    const uploadedFiles = {};
    for (let i = 0; i < imageUrls.length; i++) {
      const key = `image${i + 1}`;
      uploadedFiles[key] = await uploadInputImage(imageUrls[i], `${jobId}_${key}.png`);
    }

    const workflow = buildWorkflow(requestType, { prompt, videoQuality, aspectRatio, uploadedFiles });
    const promptId = await submitWorkflow(workflow);

    await updateDynamoStatus(jobId, userEmail, "PROCESSING", { comfyPromptId: promptId });
  } catch (err) {
    console.error(`[Submitter] Error job ${jobId}:`, err.message);
    await updateDynamoStatus(jobId, userEmail, "FAILED");
  }
};

// ─── Main Handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return await handlePolling();
  }
  return await handleSubmission(event);
};
