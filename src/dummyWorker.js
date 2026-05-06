/**
 * Dummy Worker (AWS Lambda)
 * 
 * Mensimulasikan perilaku GPU worker nyata (ComfyUI wrapper):
 *  1. Terima request dari Worker B
 *  2. Respond 200 OK segera (job diterima) ← seperti RunPod/ComfyUI async
 *  3. Proses generation di background (simulasi 5 detik)
 *  4. Panggil webhook Worker C ketika selesai
 * 
 * CATATAN: Karena ini Lambda, background processing dilakukan SEBELUM return
 * (await tetap dipakai agar Lambda tidak freeze sebelum callback selesai).
 * GPU worker nyata akan melakukan step 3-4 di server yang long-running.
 */

exports.handler = async (event) => {
  console.log("Dummy Worker dipanggil", { body: event.body });
  
  let payload = {};
  if (event.body) {
    try {
      payload = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {}
  }

  const jobId = payload.job_id;
  const callbackUrl = payload.callback_url;

  if (!jobId || !callbackUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing job_id or callback_url" })
    };
  }

  console.log(`[Dummy Worker] Job ${jobId} diterima. Respond segera ke Worker B, lalu proses async...`);

  // Simulasi: server langsung terima job & akan memproses di background
  // (GPU worker nyata: POST ke ComfyUI /prompt → dapat prompt_id → respond segera)
  const simulatedPromptId = jobId; // pada ComfyUI nyata ini adalah prompt_id dari /prompt

  // Simulasi background processing: delay 5 detik (ComfyUI generation ~1-5 menit)
  console.log(`[Dummy Worker] Memproses job ${jobId} selama 5 detik (simulasi generation)...`);
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Setelah selesai, kirim webhook ke Worker C
  console.log(`[Dummy Worker] Job ${jobId} selesai! Mengirim webhook ke Worker C...`);
  
  const webhookPayload = {
    id: jobId,
    status: "COMPLETED",
    output: {
      url: "https://dummy-result-url.com/dummy-video.mp4",
      message: "This is a dummy result"
    }
  };

  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload)
    });

    if (response.ok) {
      console.log(`[Dummy Worker] Webhook sukses dikirim untuk job ${jobId} (Status: ${response.status})`);
    } else {
      const errText = await response.text();
      console.error(`[Dummy Worker] Webhook gagal untuk job ${jobId} (Status: ${response.status}): ${errText}`);
    }
  } catch (err) {
    console.error(`[Dummy Worker] Network error saat memanggil webhook untuk job ${jobId}:`, err.message);
  }

  // Kembalikan response 200 ke Worker B
  // Pada worker nyata, ini terjadi SEBELUM processing selesai (async pattern)
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Job diterima oleh Dummy Worker",
      job_id: jobId,
      prompt_id: simulatedPromptId, // pada ComfyUI nyata: prompt_id dari /prompt endpoint
    })
  };
};
