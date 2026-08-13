# Panduan Instalasi & Deploy Remotion Pipeline (Post-Production) ke Production

Dokumen ini berisi panduan langkah-demi-langkah beserta penjelasan perintah (*commands*) yang diperlukan untuk men-deploy pipeline `post_production` dan `motion_graphics` (yang menggunakan Remotion) ke environment AWS baru (seperti *Production*) yang belum memiliki infrastruktur Remotion.

---

## Prasyarat
Sebelum memulai, pastikan Anda telah memiliki akses AWS dan *credential* production sudah terkonfigurasi di lokal Anda:
1. Node.js terinstall.
2. AWS CLI terinstall dan login ke akun AWS yang sesuai (`aws configure` atau menggunakan `--profile production`).

---

## Langkah 1: Deploy Fungsi Lambda Remotion
Remotion di cloud membutuhkan satu fungsi AWS Lambda sentral untuk melakukan proses rendering (merender browser headless). Fungsi ini dibuat menggunakan CLI dari Remotion secara otomatis.

**Perintah:**
```bash
npx remotion lambda functions deploy --memory 2048 --timeout 900 --region ap-southeast-1 --profile production
```

**Arti Perintah:**
- `npx remotion lambda functions deploy`: Memerintahkan Remotion CLI untuk membuat/memperbarui AWS Lambda rendering di akun AWS Anda.
- `--memory 2048`: Mengalokasikan 2 GB RAM (disarankan untuk rendering video yang stabil).
- `--timeout 900`: Menyetel batas waktu maksimum Lambda (15 menit).
- `--region ap-southeast-1`: Memilih region AWS (misal: Singapore).

> **PENTING:** Setelah perintah ini selesai, ia akan mencetak nama fungsi (misal: `remotion-render-4-0-504-mem2048mb-disk2048mb-900sec`). **Simpan nama fungsi ini.**

---

## Langkah 2: Deploy Site (Template Post-Production) ke S3
Setelah Lambda perender siap, ia butuh aset/kode React dari proyek Remotion kita. Aset ini di-bundle dan di-upload ke S3 Bucket yang di-manage oleh Remotion.

Buka terminal dan masuk ke folder proyek Remotion `post-production`:
```bash
cd post-production
npm install
```

**Perintah Deploy Site:**
```bash
npx remotion lambda sites create src/index.ts --site-name post-production-site --region ap-southeast-1 --profile production
```

**Arti Perintah:**
- `sites create src/index.ts`: Mendaftarkan dan mem-bundle proyek Remotion dari file *entry-point* `src/index.ts`.
- `--site-name post-production-site`: Menamai *bundle* ini di S3 agar mudah dikenali.

> **PENTING:** Setelah perintah ini selesai, ia akan mencetak URL *Serve URL* (misal: `https://remotionlambda-xxxx.s3.ap-southeast-1.amazonaws.com/sites/post-production-site/index.html`). **Simpan URL ini.**

*(Opsional: Lakukan hal yang sama untuk folder `motion-graphics` jika juga ingin di-deploy):*
```bash
cd ../motion-graphics
npm install
npx remotion lambda sites create src/index.ts --site-name motion-graphics-site --region ap-southeast-1 --profile production
```

---

## Langkah 3: Update `samconfig.toml` Backend
Fungsi SAM backend kita (`PostProductionFunction` dll) butuh tahu di mana Lambda dan Site Remotion tadi berada agar bisa memerintahkan rendering.

Buka file `samconfig.toml` di folder `backend`, cari blok environment untuk production (`[production.deploy.parameters]`). 
Di dalam `parameter_overrides`, sesuaikan variabel berikut dengan nilai yang Anda simpan di langkah sebelumnya:

```toml
RemotionAwsRegion="ap-southeast-1" \
RemotionFunctionName="<NAMA_FUNGSI_DARI_LANGKAH_1>" \
RemotionServeUrl="<SERVE_URL_DARI_LANGKAH_2>" \
```

---

## Langkah 4: Deploy Backend (AWS SAM)
Terakhir, Anda me-deploy aplikasi backend agar `PostProductionFunction` menerima variabel environment yang baru.

Masuk ke folder `backend`:
```bash
cd backend
```

**Perintah Build:**
```bash
sam build
```
*(Membangun seluruh fungsi Lambda backend, termasuk menjalankan `esbuild` untuk fungsi post-production).*

**Perintah Deploy:**
```bash
sam deploy --config-env production --profile production
```
*(Men-deploy infrastruktur backend Bikinbikin beserta statemachine Step Functions dan seluruh fungsi backend ke production).*

---
## Kesimpulan
Setelah semua langkah di atas dijalankan, pipeline end-to-end `post_production` di production sudah akan siap digunakan! Anda tidak perlu me-deploy ulang *Langkah 1* untuk selamanya kecuali Anda mengubah versi Remotion. Jika Anda sekadar merubah aset/kode template React di `post-production`, Anda hanya perlu mengulang *Langkah 2*.
