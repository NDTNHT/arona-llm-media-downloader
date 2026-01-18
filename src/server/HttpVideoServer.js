import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawn } from 'child_process';

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function probeMp4Duration(filePath) {
  return new Promise((resolve) => {
    const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
    try {
      const p = spawn(ffprobeBin, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
      const chunks = [];
      p.stdout.on('data', (d) => {
        chunks.push(d);
      });
      p.on('error', () => {
        resolve(null);
      });
      p.on('close', () => {
        try {
          const s = Buffer.concat(chunks).toString().trim();
          const d = parseFloat(s);
          if (Number.isFinite(d) && d > 0) resolve(d);
          else resolve(null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

function applyMp4Headers(res, stat, filename, durationSec) {
  const total = stat.size;
  const etag = `W/"${total}-${stat.mtimeMs}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (Number.isFinite(durationSec) && durationSec > 0) {
    res.setHeader('X-Content-Duration', durationSec);
    res.setHeader('Content-Duration', durationSec);
  }
  return total;
}

function getPlaceholderPng() {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X6N7kAAAAASUVORK5CYII=';
  return Buffer.from(base64, 'base64');
}

export class HttpVideoServer {
  constructor(options = {}) {
    this.port = options.port || 4000;
    this.host = options.host || '0.0.0.0';
    this.baseUrl = options.baseUrl || `http://localhost:${this.port}`;
    const forceHttpsRaw = process.env.FORCE_HTTPS_FOR_OG || process.env.BOT_FORCE_HTTPS;
    const forceHttpsEnv = String(forceHttpsRaw || '').toLowerCase() === 'true';
    const baseIsHttps = typeof this.baseUrl === 'string' && this.baseUrl.startsWith('https://');
    this.forceHttps = forceHttpsEnv && baseIsHttps;
    this.server = null;
    this.videos = new Map();
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer(this.handleRequest.bind(this));
    await new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log(`[HTTP] Video server listening on ${this.host}:${this.port}`);
  }

  async registerMp4(filePath, options = {}) {
    const stat = await fs.promises.stat(filePath);
    const filename = options.fileName || path.basename(filePath);
    let duration = null;
    try {
      duration = await probeMp4Duration(filePath);
    } catch {
      duration = null;
    }
    const token = generateToken();
    this.videos.set(token, {
      kind: 'mp4',
      filePath,
      fileName: filename,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      createdAt: Date.now(),
      duration,
    });
    const urlPath = `/api/files/shared/${token}/download`;
    return this.baseUrl.replace(/\/+$/, '') + urlPath;
  }

  async handleRequest(req, res) {
    try {
      const parsed = url.parse(req.url || '', true);
      const pathname = parsed.pathname || '/';
      if (pathname.startsWith('/api/files/shared/') && pathname.endsWith('/download')) {
        await this.handleSharedDownload(pathname, req, res, parsed);
        return;
      }
      if (pathname.startsWith('/v/')) {
        await this.handleMp4Request(pathname, req, res);
        return;
      }
      if (pathname.startsWith('/watch/')) {
        await this.handleWatchPage(pathname, req, res, parsed);
        return;
      }
      if (pathname.startsWith('/player/')) {
        await this.handlePlayerPage(pathname, req, res);
        return;
      }
      if (pathname.startsWith('/thumbnail/')) {
        await this.handleThumbnail(pathname, req, res);
        return;
      }
      if (pathname === '/api/share/oembed') {
        await this.handleOEmbed(req, res, parsed);
        return;
      }
      res.statusCode = 404;
      res.end('Not found');
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    }
  }

  async handleMp4Request(pathname, req, res) {
    const match = /^\/v\/([a-zA-Z0-9_-]+)\.mp4$/.exec(pathname);
    if (!match) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const token = match[1];
    const record = this.videos.get(token);
    if (!record || record.kind !== 'mp4') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    let stat;
    try {
      stat = await fs.promises.stat(record.filePath);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const total = applyMp4Headers(res, stat, record.fileName, record.duration);
    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', total);
      res.statusCode = 200;
      res.end();
      return;
    }
    const range = req.headers.range;
    if (range && typeof range === 'string') {
      const parts = range.replace(/bytes=/, '').split('-');
      let start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start >= total || end < start) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${total}`);
        res.end();
        return;
      }
      const chunkSize = end - start + 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', chunkSize);
      const stream = fs.createReadStream(record.filePath, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        res.end();
      });
      stream.pipe(res);
      return;
    }

    const ua = req.headers['user-agent'] || '';
    const isDiscordBot = /Discordbot/i.test(ua);
    if (isDiscordBot) {
      const probeMbEnv = Number(process.env.DISCORD_PROBE_CHUNK_MB);
      const probeMb = Number.isFinite(probeMbEnv) && probeMbEnv > 0 ? probeMbEnv : 2;
      const probeSize = Math.max(
        256 * 1024,
        Math.min(64 * 1024 * 1024, Math.floor(probeMb * 1024 * 1024)),
      );
      const start = 0;
      const end = Math.min(total - 1, start + probeSize - 1);
      const chunkSize = end - start + 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', chunkSize);
      const stream = fs.createReadStream(record.filePath, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        res.end();
      });
      stream.pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', total);
    const stream = fs.createReadStream(record.filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
    stream.pipe(res);
  }

  async handleWatchPage(pathname, req, res, parsed) {
    const match = /^\/watch\/([a-zA-Z0-9_-]+)/.exec(pathname);
    if (!match) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const token = match[1];
    const record = this.videos.get(token);
    if (!record || record.kind !== 'mp4') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0];
    let scheme = forwardedProto || 'http';
    if (this.forceHttps) scheme = 'https';
    const base = host ? `${scheme}://${host}` : this.baseUrl.replace(/\/+$/, '');
    const search = parsed && parsed.search ? parsed.search : '';
    const pageUrlAbs = `${base}${pathname}${search}`;
    const playerUrlAbs = `${base}/player/${token}`;
    const imgUrlAbs = `${base}/thumbnail/${token}`;
    const title = record.fileName || 'Shared Video';
    const width = 1280;
    const height = 720;
    const ua = req.headers['user-agent'] || '';
    const isBot = /Discordbot|facebookexternalhit|Slackbot|Twitterbot/i.test(ua);
    if (isBot) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const vParam = Date.now();
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <title>${title}</title>
  <link rel="alternate" type="application/json+oembed" href="${base}/api/share/oembed?url=${encodeURIComponent(
      pageUrlAbs,
    )}&format=json">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#435cda">
  <meta property="og:title" content="${title}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${pageUrlAbs}">
  <meta property="og:image" content="${imgUrlAbs}">
  <meta property="og:image:width" content="${width}">
  <meta property="og:image:height" content="${height}">
  <meta name="twitter:card" content="player">
  <meta name="twitter:player" content="${playerUrlAbs}">
  <meta name="twitter:player:width" content="${width}">
  <meta name="twitter:player:height" content="${height}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:image" content="${imgUrlAbs}">
  <style>
    body { margin:0; background:#0b0b0b; color:#fff; display:grid; place-items:center; min-height:100vh; }
    .container { width:100%; max-width:${width}px; padding:16px; }
    video { width:100%; height:auto; background:#000; }
  </style>
</head>
<body>
  <div class="container">
    <h3 style="font-family: system-ui, sans-serif; font-weight: 600;">${title}</h3>
    <video id="video" controls autoplay playsinline src="${base}/v/${token}.mp4"></video>
    <div style="margin-top:12px">
      <a href="${base}/v/${token}.mp4?v=${vParam}" style="color:#9ecbff;text-decoration:none">Open streaming</a>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</body>
</html>`;
    res.statusCode = 200;
    res.end(html);
  }

  async handlePlayerPage(pathname, req, res) {
    const match = /^\/player\/([a-zA-Z0-9_-]+)/.exec(pathname);
    if (!match) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const token = match[1];
    const record = this.videos.get(token);
    if (!record || record.kind !== 'mp4') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0];
    let scheme = forwardedProto || 'http';
    if (this.forceHttps) scheme = 'https';
    const base = host ? `${scheme}://${host}` : this.baseUrl.replace(/\/+$/, '');
    const title = record.fileName || 'Player';
    const width = 1280;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html,body{margin:0;padding:0;background:#000}#wrap{display:grid;place-items:center;min-height:100vh}video{width:100%;height:auto;background:#000;max-width:${width}px}</style></head><body><div id="wrap"><video src="${base}/v/${token}.mp4" controls playsinline autoplay></video></div></body></html>`;
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors 'self' https://discord.com https://twitter.com https://x.com https://facebook.com;",
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    res.end(html);
  }

  async handleThumbnail(pathname, req, res) {
    const match = /^\/thumbnail\/([a-zA-Z0-9_-]+)/.exec(pathname);
    if (!match) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    const png = getPlaceholderPng();
    res.setHeader('Content-Length', png.length);
    res.end(png);
  }

  async handleOEmbed(req, res, parsed) {
    const query = parsed && parsed.query ? parsed.query : {};
    const urlParam = typeof query.url === 'string' ? query.url : '';
    if (!urlParam) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'missing url' }));
      return;
    }
    let token = null;
    try {
      const u = new URL(urlParam);
      const m = /^\/watch\/([a-zA-Z0-9_-]+)/.exec(u.pathname || '');
      if (m) token = m[1];
    } catch {
      const m = /\/watch\/([a-zA-Z0-9_-]+)/.exec(urlParam);
      if (m) token = m[1];
    }
    if (!token) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const record = this.videos.get(token);
    if (!record || record.kind !== 'mp4') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0];
    let scheme = forwardedProto || 'http';
    if (this.forceHttps) scheme = 'https';
    const base = host ? `${scheme}://${host}` : this.baseUrl.replace(/\/+$/, '');
    const width = 1280;
    const height = 720;
    const playerUrl = `${base}/player/${token}`;
    const thumbnailUrl = `${base}/thumbnail/${token}`;
    const oembed = {
      type: 'video',
      version: '1.0',
      provider_name: 'AronaBot',
      provider_url: base,
      title: record.fileName || 'Shared Video',
      cache_age: 86400,
      thumbnail_url: thumbnailUrl,
      thumbnail_width: width,
      thumbnail_height: height,
      width,
      height,
      html: `<iframe src="${playerUrl}" width="${width}" height="${height}" frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>`,
    };
    if (Number.isFinite(record.duration) && record.duration > 0) {
      oembed.duration = record.duration;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(oembed));
  }

  async handleSharedDownload(pathname, req, res, parsed) {
    const match = /^\/api\/files\/shared\/([a-zA-Z0-9_-]+)\/download$/.exec(pathname);
    if (!match) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const token = match[1];
    const record = this.videos.get(token);
    if (!record || record.kind !== 'mp4') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    let stat;
    try {
      stat = await fs.promises.stat(record.filePath);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    record.downloads = (record.downloads || 0) + 1;
    const total = stat.size;
    const filename = record.fileName || path.basename(record.filePath);
    const etag = `W/"${total}-${stat.mtimeMs}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', total);
      res.statusCode = 200;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', total);
    const stream = fs.createReadStream(record.filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
    stream.pipe(res);
  }
}

