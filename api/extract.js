const fetch = require('node-fetch');

/**
 * HarmonyStream Hardened Extraction Engine
 * Features: Client Identity Rotation, Modern Browser Mimicry, and Triple-Tier Recovery.
 */

const PROFILES = [
  {
    name: 'DESKTOP_WEB',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Sec-Fetch-Dest': 'document' }
  },
  {
    name: 'MOBILE_ANDROID',
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
    headers: { 'X-YouTube-Client-Name': '2', 'X-YouTube-Client-Version': '2.20230301.09.00' }
  },
  {
    name: 'IOS_SAFARI',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    headers: { 'X-YouTube-Client-Name': '5', 'X-YouTube-Client-Version': '17.33.2' }
  }
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Type', 'application/json');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, url } = req.query;
  let videoId = id;

  if (url) {
    const match = url.match(/^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/);
    videoId = (match && match[7].length === 11) ? match[7] : null;
  }

  if (!videoId) {
    return res.status(400).json({ success: false, error: 'INVALID_ID' });
  }

  const tryExtraction = async (profile) => {
    const headers = {
      'User-Agent': profile.ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...profile.headers
    };

    const target = `https://www.youtube.com/watch?v=${videoId}&has_verified=1&bpctr=${Math.floor(Date.now() / 1000)}`;
    
    try {
      const response = await fetch(target, { headers, timeout: 10000 });
      if (!response.ok) return { error: `HTTP_${response.status}` };
      
      const html = await response.text();

      if (html.includes("confirm you're not a bot") || html.includes("unusual traffic")) {
        return { error: 'BOT_CHALLENGE' };
      }

      const patterns = [
        /ytInitialPlayerResponse\s*=\s*({.+?});/,
        /var\s+ytInitialPlayerResponse\s*=\s*({.+?});/,
        /window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/
      ];

      let data = null;
      for (const p of patterns) {
        const m = html.match(p);
        if (m) {
          try {
            const parsed = JSON.parse(m[1]);
            if (parsed.streamingData) { data = parsed; break; }
          } catch (e) {}
        }
      }

      if (!data) return { error: 'DATA_NOT_FOUND' };

      const formats = [...(data.streamingData.adaptiveFormats || []), ...(data.streamingData.formats || [])];
      
      const parsedFormats = formats.map(f => {
        let streamUrl = f.url;
        if (!streamUrl && (f.signatureCipher || f.cipher)) {
          const params = new URLSearchParams(f.signatureCipher || f.cipher);
          streamUrl = params.get('url');
          // Note: Full decryption of complex signatures usually requires running JS,
          // but many videos work with direct URL extraction or basic param joining.
          const sig = params.get('s') || params.get('sig');
          if (streamUrl && sig) streamUrl += `&sig=${sig}`;
        }

        if (!streamUrl) return null;

        return {
          itag: f.itag,
          mimeType: f.mimeType.split(';')[0],
          quality: f.qualityLabel || (f.mimeType.includes('audio') ? 'Audio' : 'Default'),
          url: streamUrl.includes('ratebypass') ? streamUrl : `${streamUrl}&ratebypass=yes`,
          contentLength: f.contentLength
        };
      }).filter(Boolean);

      const bestAudio = parsedFormats.find(f => f.itag === 140) || parsedFormats.find(f => f.mimeType.includes('audio/mp4'));
      const bestVideo = parsedFormats.find(f => f.mimeType.includes('video/mp4') && (parseInt(f.quality) >= 360));

      return {
        success: true,
        title: data.videoDetails?.title || 'Unknown',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        audioUrl: bestAudio?.url || null,
        videoUrl: bestVideo?.url || bestAudio?.url || null,
        allFormats: parsedFormats
      };
    } catch (e) {
      return { error: 'FETCH_ERROR', message: e.message };
    }
  };

  // Execution with Profile Rotation
  for (const profile of PROFILES) {
    const result = await tryExtraction(profile);
    if (result.success) return res.status(200).json(result);
    if (result.error !== 'BOT_CHALLENGE' && result.error !== 'HTTP_403') break; 
    // If blocked as bot, try next profile immediately
  }

  return res.status(403).json({
    success: false,
    error: 'BOT_DETECTION_ACTIVE',
    message: 'YouTube is challenging our cloud IP. Retrying from device is recommended.'
  });
};
