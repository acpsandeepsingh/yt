const fetch = require('node-fetch');

/**
 * HarmonyStream Hardened Extraction Engine v8
 * Features: Quad-Profile Rotation including low-security device emulation.
 */

const PROFILES = [
  {
    name: 'ANDROID_APP',
    ua: 'com.google.android.youtube/19.05.36 (Linux; U; Android 14; en_US; SM-G998B) gzip',
    headers: {
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': '2.20240215.00.00',
      'Origin': 'https://www.youtube.com',
      'Sec-Fetch-Mode': 'navigate'
    }
  },
  {
    name: 'DESKTOP_WEB',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1'
    }
  },
  {
    name: 'OCULUS_BROWSER',
    ua: 'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/31.0.0.14.537 SamsungBrowser/4.0 Chrome/119.0.6045.193 Mobile Safari/537.36',
    headers: {
      'Accept': '*/*',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site'
    }
  },
  {
    name: 'IOS_APP',
    ua: 'com.google.ios.youtube/19.05.36 (iPhone16,2; U; CPU iPhone OS 17_3 like Mac OS X; en_US)',
    headers: {
      'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': '19.05.36'
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
      const response = await fetch(targetUrl, { headers, timeout: 10000 });
      if (!response.ok) return { error: `HTTP_${response.status}` };
      
      const html = await response.text();

      if (html.includes("confirm you're not a bot") || html.includes("unusual traffic") || html.includes("robot")) {
        return { error: 'BOT_CHALLENGE' };
      }

      if (html.includes("sign in to confirm")) {
         return { error: 'SIGN_IN_REQUIRED' };
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
          contentLength: f.contentLength ? (parseInt(f.contentLength) / 1024 / 1024).toFixed(2) + ' MB' : 'Unknown'
        };
      }).filter(Boolean);

      const bestAudio = parsedFormats.find(f => f.itag === 140) || parsedFormats.find(f => f.mimeType.includes('audio/mp4'));
      const bestVideo = parsedFormats.find(f => f.mimeType.includes('video/mp4') && (parseInt(f.quality) >= 360)) || parsedFormats[0];

      return {
        success: true,
        profile: profile.name,
        title: data.videoDetails?.title || 'Unknown Video',
        author: data.videoDetails?.author || 'Unknown Artist',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        audioUrl: bestAudio?.url || null,
        videoUrl: bestVideo?.url || bestAudio?.url || null,
        allFormats: parsedFormats
      };
    } catch (e) {
      return { error: 'NETWORK_ERROR', message: e.message };
    }
  };

  let lastError = null;
  // Try profiles in rotation
  for (const profile of PROFILES) {
    const result = await tryExtraction(profile);
    if (result.success) return res.status(200).json(result);
    lastError = result;
    if (result.error === 'HTTP_404') break;
  }

  return res.status(403).json({
    success: false,
    error: lastError?.error || 'EXTRACTION_FAILED',
    message: 'YouTube bot detection active. Retrying with different profiles failed.'
  });
};
