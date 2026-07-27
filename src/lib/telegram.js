"use strict";

const https = require("https");

const TELEGRAM_TOKEN = "8611691550:AAF5omYCHcqn7-bulHn3HQPJ6b4-mWOLObU";
const TELEGRAM_CHAT_ID = "7989331780";

/**
 * Sends a raw text message to Telegram chat.
 * @param {string} text 
 */
function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(text)}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log("[Telegram] Notification sent. Response:", data);
        resolve(data);
      });
    }).on("error", (err) => {
      console.error("[Telegram] Notification failed:", err.message);
      resolve(null); // resolve rather than reject to avoid crashing lambda
    });
  });
}

/**
 * Formats and sends a job status notification (COMPLETED, FAILED, FAILED_CONCCURENCY).
 * @param {string} jobId 
 * @param {string} status 
 * @param {object} details 
 */
function sendJobStatusNotification(jobId, status, details = {}) {
  const statusEmoji = status === "COMPLETED" ? "✅" : "❌";
  let text = `${statusEmoji} JOB STATUS UPDATE: ${status}

🆔 ID: ${jobId}`;

  if (details.userEmail) {
    text += `\n👤 User: ${details.userEmail}`;
  }
  if (details.resultUrl) {
    text += `\n🔗 Result S3 Key: ${details.resultUrl}`;
  }
  if (details.error_message) {
    text += `\n⚠️ Error: ${details.error_message}`;
  }

  return sendTelegramMessage(text);
}

module.exports = {
  sendTelegramMessage,
  sendJobStatusNotification
};
