# pip install websocket-client requests
import websocket
import json
import requests
import argparse
import time
import logging
from logging.handlers import TimedRotatingFileHandler
import os
import uuid

# ==========================================
# SETUP LOGGING (Daily Rolling)
# ==========================================
if not os.path.exists('logs'):
    os.makedirs('logs')

logger = logging.getLogger("ComfyRelay")
logger.setLevel(logging.INFO)
log_formatter = logging.Formatter('[%(asctime)s] [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)

file_handler = TimedRotatingFileHandler(
    filename='logs/comfy_relay.log',
    when='midnight',
    interval=1,
    backupCount=30,
    encoding='utf-8'
)
file_handler.setFormatter(log_formatter)
file_handler.suffix = "%Y-%m-%d"

logger.addHandler(console_handler)
logger.addHandler(file_handler)

# ==========================================
# FUNGSI API & WEBHOOK
# ==========================================

def get_signed_url(filename, subfolder, file_type, api_key):
    """
    Menembak API Comfy.org untuk mendapatkan URL unduhan asli (Signed URL).
    Hal ini penting agar backend/frontend Anda bisa mendownload hasilnya tanpa API Key.
    """
    base_url = "https://cloud.comfy.org"
    params = {
        "filename": filename,
        "subfolder": subfolder,
        "type": file_type
    }
    headers = {"X-API-Key": api_key}
    
    try:
        # Menggunakan allow_redirects=False untuk menangkap 302 Redirect Location
        response = requests.get(f"{base_url}/api/view", params=params, headers=headers, allow_redirects=False)
        if response.status_code == 302:
            return response.headers.get('Location')
        else:
            logger.warning(f"Gagal mendapat URL untuk {filename}. Status: {response.status_code}")
            return None
    except Exception as e:
        logger.error(f"Error fetching signed URL: {e}")
        return None

def send_webhook(webhook_url, payload):
    """Mengirim payload final ke Backend Anda"""
    try:
        response = requests.post(webhook_url, json=payload, timeout=10)
        logger.info(f"[WEBHOOK] Sent to {webhook_url} | Status: {response.status_code}")
    except Exception as e:
        logger.error(f"[WEBHOOK ERROR] Gagal mengirim ke webhook: {e}")

# ==========================================
# WEBSOCKET EVENT HANDLERS
# ==========================================

def on_message(ws, message):
    # Abaikan data binary (preview gambar berjalan)
    if isinstance(message, bytes):
        return

    try:
        data = json.loads(message)
        msg_type = data.get('type')
        msg_data = data.get('data', {})
        prompt_id = msg_data.get('prompt_id')

        # Abaikan pesan yang tidak punya prompt_id (bukan job milik kita)
        if not prompt_id:
            return

        # 1. TAMPUNG OUTPUT SETIAP KALI NODE SELESAI
        if msg_type == 'executed':
            node_id = msg_data.get('node')
            output_data = msg_data.get('output', {})
            
            if prompt_id not in ws.job_outputs:
                ws.job_outputs[prompt_id] = {}
            
            # Simpan output node (biasanya berisi array filename video/image)
            ws.job_outputs[prompt_id][node_id] = output_data

        # 2. SAAT SELURUH JOB SUKSES
        elif msg_type == 'execution_success':
            logger.info(f"[SUCCESS] Job {prompt_id} tuntas!")
            
            # Ambil semua history file yang sudah dicatat dari event 'executed'
            outputs = ws.job_outputs.pop(prompt_id, {})
            download_urls = []
            
            # Loop melalui output dan ubah menjadi Download URL Publik
            for node_id, node_output in outputs.items():
                logger.info(f"[RELAY] Processing outputs for node {node_id}")
                # LTX-Video dan ComfyUI biasanya mengeluarkan tipe ini
                for media_key in ['images', 'videos', 'video', 'audio', 'gifs']:
                    if media_key in node_output:
                        for file_info in node_output[media_key]:
                            filename = file_info.get('filename', '')
                            subfolder = file_info.get('subfolder', '')
                            file_type = file_info.get('type', 'output')
                            
                            # Deteksi media type asli berdasarkan ekstensi jika perlu
                            detected_type = media_key
                            if filename.lower().endswith(('.mp4', '.webm', '.mov')):
                                detected_type = 'videos'
                            elif filename.lower().endswith(('.wav', '.mp3', '.ogg')):
                                detected_type = 'audio'
                                
                            logger.info(f"  - Found {media_key} file: {filename} (Detected as: {detected_type})")
                            
                            signed_url = get_signed_url(filename, subfolder, file_type, ws.api_key)
                            if signed_url:
                                download_urls.append({
                                    "node_id": node_id,
                                    "media_type": detected_type,
                                    "filename": filename,
                                    "url": signed_url
                                })

            payload = {
                "status": "completed",
                "prompt_id": prompt_id,
                "downloads": download_urls, # Ini berisi list link siap download!
                "raw_outputs": outputs
            }
            send_webhook(ws.webhook_url, payload)

        # 3. SAAT JOB GAGAL / ERROR
        elif msg_type == 'execution_error':
            logger.error(f"[ERROR] Job {prompt_id} gagal! Reason: {msg_data.get('exception_message')}")
            ws.job_outputs.pop(prompt_id, None) # Hapus dari cache
            
            payload = {
                "status": "failed",
                "prompt_id": prompt_id,
                "error_details": msg_data
            }
            send_webhook(ws.webhook_url, payload)
            
        # 4. SAAT DIBATALKAN USER / INTERRUPTED
        elif msg_type == 'execution_interrupted':
            logger.warning(f"[CANCELLED] Job {prompt_id} diinterupsi/dibatalkan.")
            ws.job_outputs.pop(prompt_id, None)
            
            payload = {
                "status": "cancelled",
                "prompt_id": prompt_id
            }
            send_webhook(ws.webhook_url, payload)

    except Exception as e:
        logger.error(f"[PARSE ERROR] Kesalahan memproses JSON: {e}")

def on_error(ws, error):
    logger.error(f"[WS ERROR] Koneksi bermasalah: {error}")

def on_close(ws, close_status_code, close_msg):
    logger.warning(f"[WS CLOSED] Koneksi terputus. Mencoba auto-reconnect...")

def on_open(ws):
    logger.info("[WS OPEN] Terhubung dan memantau Comfy Cloud API!")

def start_relay(client_id, api_key, webhook_url):
    # Endpoint resmi WebSocket Cloud Comfy
    ws_url = f"wss://cloud.comfy.org/ws?clientId={client_id}&token={api_key}"
    
    logger.info("==================================================")
    logger.info("  VisualKonten Comfy.org Micro-Relay Started")
    logger.info(f"  Target Webhook: {webhook_url}")
    logger.info("==================================================")
    
    ws = websocket.WebSocketApp(
        ws_url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )
    
    # Simpan state ke dalam instance websocket agar bisa dipanggil saat event berlangsung
    ws.webhook_url = webhook_url
    ws.api_key = api_key
    ws.job_outputs = {} # Menyimpan sementara history node per prompt_id
    
    ws.run_forever(reconnect=5)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Comfy Cloud WS to Webhook Relay")
    # Jika client_id tidak di-supply, skrip akan membuat UUID secara otomatis (Sesuai panduan Cloud Comfy terbaru)
    parser.add_argument("--client_id", default=str(uuid.uuid4()), help="ID Client Unik")
    parser.add_argument("--api_key", required=True, help="API Key Comfy Cloud Anda")
    parser.add_argument("--webhook_url", required=True, help="URL Backend Webhook Anda")
    
    args = parser.parse_args()
    
    start_relay(args.client_id, args.api_key, args.webhook_url)

# 1. Buka sesi screen baru
## screen -S comfy_relay

# 2. Jalankan skrip Python dengan argumen Anda
## python3 comfy_relay.py \
##   --api_key "comfyui-7c3bf4ab37ed56490c6430b2200d069d752da323ef86389d88484527b2aca176" \
##   --webhook_url "https://xayhmg0s7b.execute-api.ap-southeast-1.amazonaws.com/dev/comfyui-webhook"

# 3. Tekan CTRL+A, lalu tekan D (Untuk detach / membiarkannya berjalan di background)