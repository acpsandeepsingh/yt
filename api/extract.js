const fetch = require('node-fetch');

/**
 * HarmonyStream Hardened Extraction Engine
 * Features: Identity Rotation, Client Hint Mimicry, and Advanced Error Recovery.
 */

const USER_AGENTS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
};

module.exports = async (req, res) => {
  // CORS Configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, url } = req.query;
  let videoId = id;

  // Handle full URL inputs if provided instead of just ID
  if (url) {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    videoId = (match && match[7].length === 11) ? match[7] : null;
  }

  if (!videoId) {
    return res.status(400).json({ 
      error: 'INVALID_REQUEST', 
      message: 'Provide a valid YouTube Video ID or URL.' 
    });
  }

  /**
   * Main extraction logic with robust error handling
   */
  const tryExtract = async (uaType) => {
    const headers = {
      'User-Agent': USER_AGENTS[uaType],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1'
    };

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}&has_verified=1&bpctr=${Math.floor(Date.now() / 1000)}`;
    
    try {
      const response = await fetch(targetUrl, { headers, timeout: 15000 });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      
      const text = await response.text();

      // Detect Bot Challenges
      if (text.includes("confirm you're not a bot") || text.includes("unusual traffic") || text.includes("robot")) {
        return { error: 'BOT_DETECTED' };
      }

      // Detect Specific Video Restrictions
      if (text.includes("Sign in to confirm your age")) return { error: 'AGE_RESTRICTED' };
      if (text.includes("This video is private")) return { error: 'PRIVATE_VIDEO' };
      if (text.includes("The uploader has not made this video available in your country")) return { error: 'REGION_BLOCKED' };

      // Advanced JSON Discovery Patterns
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

      if (!playerResponse) return { error: 'DATA_PARSE_FAILED' };

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
          // Basic signature join - complex ciphers require JS execution which isn't easy in serverless
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

      // Selection Logic for App Player
      const bestAudio = allFormats.find(f => f.itag === 140) || allFormats.find(f => f.mimeType.includes('audio/mp4'));
      const bestVideo = allFormats.find(f => f.mimeType.includes('video/mp4') && (parseInt(f.quality) >= 360));

      return {
        success: true,
        videoId,
        title: info.title || 'Unknown Title',
        author: info.author || 'Unknown Artist',
        thumbnail: info.thumbnail?.thumbnails?.pop()?.url || '',
        duration: parseInt(info.lengthSeconds || 0),
        audioUrl: bestAudio?.url || null,
        videoUrl: bestVideo?.url || (bestAudio?.url || null),
        allFormats
      };
    } catch (e) {
      return { error: 'NETWORK_ERROR', message: e.message };
    }
  };

  // Tiered Retry Strategy
  let result = await tryExtract('desktop');
  
  // Strategy 1: Desktop fail -> Try Mobile (Lighter Security)
  if (result.error === 'BOT_DETECTED' || result.error === 'HTTP_403') {
    result = await tryExtract('mobile');
  }

  // Strategy 2: Mobile fail -> Try iOS (Strict but often different IP pools)
  if (result.error === 'BOT_DETECTED') {
    result = await tryExtract('ios');
  }

  // Final Response Mapping
  if (result.success) {
    return res.status(200).json(result);
  }

  const errorMap = {
    'BOT_DETECTED': { code: 403, msg: 'YouTube identified the request as a bot. IP restricted.' },
    'AGE_RESTRICTED': { code: 403, msg: 'This video requires age verification.' },
    'REGION_BLOCKED': { code: 403, msg: 'This video is not available in the current server region.' },
    'DATA_PARSE_FAILED': { code: 500, msg: 'Failed to extract streaming data from YouTube.' }
  };

  const finalError = errorMap[result.error] || { code: 500, msg: result.message || 'Unknown Extraction Error' };
  
  return res.status(finalError.code).json({
    success: false,
    error: result.error,
    message: finalError.msg
  });
};
