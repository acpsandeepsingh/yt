const fetch = require('node-fetch');

/**
 * HarmonyStream Hardened Extraction Engine
 * Features: Identity Rotation, Client Hint Mimicry, and Adaptive Fallbacks.
 */

const USER_AGENTS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, url } = req.query;
  let videoId = id;

  if (url) {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    videoId = (match && match[7].length === 11) ? match[7] : null;
  }

  if (!videoId) {
    return res.status(400).json({ error: 'Invalid Request', message: 'Provide a valid YouTube Video ID.' });
  }

  const tryExtract = async (uaType) => {
    const headers = {
      'User-Agent': USER_AGENTS[uaType],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Service-Worker-Navigation-Preload': 'true'
    };

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}&has_verified=1&bpctr=${Math.floor(Date.now() / 1000)}`;
    
    try {
      const response = await fetch(targetUrl, { headers, timeout: 10000 });
      const text = await response.text();

      if (text.includes("confirm you're not a bot") || text.includes("unusual traffic")) {
        return { error: 'BOT_DETECTED' };
      }

      const patterns = [
        /ytInitialPlayerResponse\s*=\s*({.+?});/,
        /var\s+ytInitialPlayerResponse\s*=\s*({.+?});/,
        /window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/,
        /ytInitialPlayerResponse\s*=\s*({.+?})</
      ];

      let playerResponse = null;
      for (const p of patterns) {
        const match = text.match(p);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            if (parsed.streamingData) {
              playerResponse = parsed;
              break;
            }
          } catch (e) { continue; }
        }
      }

      if (!playerResponse) return { error: 'NO_DATA' };

      const info = playerResponse.videoDetails || {};
      const streamingData = playerResponse.streamingData;
      const formats = [...(streamingData.adaptiveFormats || []), ...(streamingData.formats || [])];

      const getUrl = (f) => {
        if (!f) return null;
        if (f.url) return f.url;
        if (f.signatureCipher || f.cipher) {
          const c = f.signatureCipher || f.cipher;
          const p = new URLSearchParams(c);
          const u = p.get('url');
          const s = p.get('s') || p.get('sig');
          return u && s ? `${u}&sig=${s}` : u;
        }
        return null;
      };

      const allFormats = formats.map(f => {
        const url = getUrl(f);
        if (!url) return null;
        return {
          itag: f.itag,
          mimeType: f.mimeType.split(';')[0],
          quality: f.qualityLabel || (f.mimeType.includes('audio') ? 'Audio' : 'Default'),
          contentLength: f.contentLength ? (parseInt(f.contentLength) / 1024 / 1024).toFixed(2) + ' MB' : 'Stream',
          url: url.includes('ratebypass') ? url : `${url}&ratebypass=yes`,
          hasAudio: f.mimeType.includes('audio') || !!f.audioChannels,
          hasVideo: f.mimeType.includes('video')
        };
      }).filter(f => f !== null);

      const bestAudio = allFormats.find(f => f.itag === 140) || allFormats.find(f => f.mimeType.includes('audio/mp4'));
      const bestVideo = allFormats.find(f => f.mimeType.includes('video/mp4') && parseInt(f.quality) >= 360);

      return {
        success: true,
        videoId,
        title: info.title || 'Unknown',
        author: info.author || 'Unknown',
        thumbnail: info.thumbnail?.thumbnails?.pop()?.url || '',
        duration: parseInt(info.lengthSeconds || 0),
        audioUrl: bestAudio?.url || getUrl(formats.find(f => f.mimeType.includes('audio'))),
        videoUrl: bestVideo?.url || bestAudio?.url,
        allFormats
      };
    } catch (e) {
      return { error: 'FETCH_ERROR', message: e.message };
    }
  };

  // Attempt 1: Desktop
  let result = await tryExtract('desktop');
  
  // Attempt 2: Mobile Fallback (often bypasses Vercel IP blocks)
  if (result.error === 'BOT_DETECTED') {
    console.log(`[Engine] Desktop blocked for ${videoId}, retrying with Mobile identity...`);
    result = await tryExtract('mobile');
  }

  if (result.success) {
    return res.status(200).json(result);
  }

  return res.status(403).json({
    error: 'Extraction Blocked',
    message: 'YouTube identified this request as a bot. Fallback to standard player required.',
    details: result.error
  });
};
