const fetch = require('node-fetch');

/**
 * HarmonyStream Private Extraction API & Engine
 * Optimized for multi-format extraction and robust error handling.
 */
module.exports = async (req, res) => {
  // 1. Setup CORS & Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id, url } = req.query;
  let videoId = id;

  // Resolve ID from URL if provided
  if (url) {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    videoId = (match && match[7].length === 11) ? match[7] : null;
  }

  if (!videoId) {
    return res.status(400).json({ 
      error: 'Invalid Request', 
      message: 'Provide a valid YouTube Video ID or URL.' 
    });
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    // Use the desktop watch page for the most detailed metadata
    const targetUrl = `https://www.youtube.com/watch?v=${videoId}&has_verified=1&bpctr=${timestamp}`;
    
    console.log(`[Engine] Extracting all formats for: ${videoId}`);

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`YouTube Gateway Error: ${response.status}`);
    }

    const text = await response.text();
    
    // Pattern discovery for modern YouTube JSON structures
    const patterns = [
      /ytInitialPlayerResponse\s*=\s*({.+?});/,
      /var\s+ytInitialPlayerResponse\s*=\s*({.+?});/,
      /window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/
    ];

    let playerResponse = null;
    for (const p of patterns) {
      const match = text.match(p);
      if (match) {
        try {
          playerResponse = JSON.parse(match[1]);
          if (playerResponse.streamingData) break;
        } catch (e) { continue; }
      }
    }

    if (!playerResponse) {
      return res.status(404).json({ 
        error: 'Extraction Failed', 
        message: 'Could not find streaming data. The video might be age-restricted or private.' 
      });
    }

    // Specific Status Error Handling
    if (playerResponse.playabilityStatus && playerResponse.playabilityStatus.status !== 'OK') {
      return res.status(403).json({
        error: 'Unplayable Video',
        message: playerResponse.playabilityStatus.reason || 'YouTube blocked access to this video.'
      });
    }

    const streamingData = playerResponse.streamingData;
    const info = playerResponse.videoDetails || {};
    
    const formats = [
      ...(streamingData.adaptiveFormats || []),
      ...(streamingData.formats || [])
    ];

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

    // Map all available formats for the downloader UI
    const allFormats = formats.map(f => {
      const url = getUrl(f);
      if (!url) return null;

      // Clean up common 403 markers
      const finalUrl = url.includes('ratebypass') ? url : `${url}&ratebypass=yes`;

      return {
        itag: f.itag,
        mimeType: f.mimeType.split(';')[0],
        quality: f.qualityLabel || (f.mimeType.includes('audio') ? 'Audio' : 'Default'),
        contentLength: f.contentLength ? (parseInt(f.contentLength) / 1024 / 1024).toFixed(2) + ' MB' : 'Stream',
        url: finalUrl,
        hasAudio: f.mimeType.includes('audio') || !!f.audioChannels,
        hasVideo: f.mimeType.includes('video')
      };
    }).filter(f => f !== null);

    // Primary streams for the HarmonyStream Player
    const bestAudio = allFormats.find(f => f.itag === 140) || allFormats.find(f => f.mimeType.includes('audio/mp4'));
    const bestVideo = allFormats.find(f => f.mimeType.includes('video/mp4') && parseInt(f.quality) >= 360);

    return res.status(200).json({
      success: true,
      videoId: videoId,
      title: info.title || 'Unknown Title',
      author: info.author || 'Unknown Artist',
      thumbnail: info.thumbnail?.thumbnails?.pop()?.url || '',
      duration: parseInt(info.lengthSeconds || 0),
      // App Player Fields
      audioUrl: bestAudio?.url || getUrl(formats.find(f => f.mimeType.includes('audio'))),
      videoUrl: bestVideo?.url || bestAudio?.url,
      // Downloader UI Fields
      allFormats: allFormats
    });

  } catch (error) {
    console.error(`[Fatal]`, error);
    return res.status(500).json({ 
      error: 'Server Error', 
      message: error.message 
    });
  }
};
