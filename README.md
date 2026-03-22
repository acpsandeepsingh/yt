# HarmonyStream Extraction API & Downloader

This is a private serverless application that powers the HarmonyStream music player and provides a standalone web downloader.

## 🚀 Deployment (Zero Config)

1. **Create a Repository**: Push the files in this folder to a new GitHub repository.
2. **Connect to Vercel**:
   - Go to [Vercel](https://vercel.com).
   - Click **"Add New Project"**.
   - Import your repository.
   - Click **"Deploy"**.

## 📖 Usage Modes

### 1. Web Downloader (Frontend)
Visit your Vercel URL directly (e.g., `https://my-app.vercel.app`).
Paste any YouTube URL to see all available audio and video formats for download.

### 2. Integration API (Backend)
Used by the HarmonyStream website and Android app.
Endpoint: `https://your-app.vercel.app/api/extract?id=VIDEO_ID`

## 🛠 Integration
Once deployed, copy your Vercel URL and paste it into `src/lib/youtube-extractor.ts` in your main HarmonyStream project to enable high-performance streaming.
