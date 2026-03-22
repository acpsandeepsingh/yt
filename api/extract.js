const fetch = require('node-fetch');

/**
 * HarmonyStream Hardened Extraction Engine v3
 * Features: Automatic Profile Rotation, Human Mimicry, and Comprehensive Error Handling.
 */

const PROFILES = [
  {
    name: 'DESKTOP_WEB',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1'
    }
  },
  {
    name: 'ANDROID_APP',
    ua: 'com.google.android.youtube/19.05.36 (Linux; U; Android 14; en_US; SM-G998B) gzip',
    headers: {
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': '2.20240215.00.00'
    }
  },
  {
    name: 'IOS_SAFARI',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
    headers: {
      'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': '18.49.2'
    }
  }
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, url } = req.query;
  let videoId = id;

  if (url) {
    const match = url.match(/^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/);
    videoId = (match && match[7].length === 11) ? match[7] : null;
  }

  if (!videoId) {
    return res.status(400).json({ success: false, error: 'INVALID_VIDEO_ID' });
  }

  const tryExtraction = async (profile) => {
    const targetUrl = `https://www.youtube.com/watch?v=${videoId}&has_verified=1&bpctr=${Math.floor(Date.now() / 1000)}`;
    const headers = {
      'User-Agent': profile.ua,
      'Accept-Language': 'en-US,en;q=0.9',
      ...profile.headers
    };

    try {
      const response = await fetch(targetUrl, { headers, timeout: 8000 });
      if (!response.ok) return { error: `HTTP_${response.status}` };
      
      const html = await response.text();

      if (html.includes("confirm you're not a bot") || html.includes("unusual traffic") || html.includes("robot")) {
        return { error: 'BOT_CHALLENGE' };
      }

      if (html.includes("vss_host")) { // Check for common blocked patterns
         if (html.includes("sign in to confirm")) return { error: 'SIGN_IN_REQUIRED' };
      }

      const patterns = [
        /ytInitialPlayerResponse\s*=\s*({.+?});/,
        /var\s+ytInitialPlayerResponse\s*=\s*({.+?});/,
        /window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/,
        /ytInitialPlayerResponse\s*=\s*({.+?})</
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
          const sig = params.get('s') || params.get('sig');
          if (streamUrl && sig) streamUrl += `&sig=${sig}`;
        }

        if (!streamUrl) return null;

        return {
          itag: f.itag,
          mimeType: f.mimeType.split(';')[0],
          quality: f.qualityLabel || (f.mimeType.includes('audio') ? 'Audio' : 'Default'),
          url: streamUrl.includes('ratebypass') ? streamUrl : `${streamUrl}&ratebypass=yes`,
          contentLength: f.contentLength || 'Unknown'
        };
      }).filter(Boolean);

      const bestAudio = parsedFormats.find(f => f.itag === 140) || parsedFormats.find(f => f.mimeType.includes('audio/mp4'));
      const bestVideo = parsedFormats.find(f => f.mimeType.includes('video/mp4') && (parseInt(f.quality) >= 360)) || parsedFormats[0];

      return {
        success: true,
        profile: profile.name,
        title: data.videoDetails?.title || 'Unknown Video',
        author: data.videoDetails?.author || 'Unknown Artist',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        audioUrl: bestAudio?.url || null,
        videoUrl: bestVideo?.url || bestAudio?.url || null,
        allFormats: parsedFormats
      };
    } catch (e) {
      return { error: 'NETWORK_TIMEOUT', message: e.message };
    }
  };

  // Profile Rotation Strategy
  let lastError = null;
  for (const profile of PROFILES) {
    const result = await tryExtraction(profile);
    if (result.success) return res.status(200).json(result);
    
    lastError = result;
    // If it's not a block, it's likely a real failure (private video, etc), so don't rotate
    if (result.error !== 'BOT_CHALLENGE' && result.error !== 'HTTP_403' && result.error !== 'SIGN_IN_REQUIRED') break;
  }

  return res.status(403).json({
    success: false,
    error: lastError?.error || 'EXTRACTION_FAILED',
    message: 'YouTube is challenging the server identity. Retrying from a different device or identity is recommended.'
  });
};
