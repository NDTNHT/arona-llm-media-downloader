import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { PlatformDetector } from '../platform/PlatformDetector.js';

function sanitizeName(name) {
  let safe = String(name || 'video')
    .replace(/[\n\r]/g, ' ')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safe.length) safe = 'video';
  const maxBasename = 80;
  if (safe.length > maxBasename) safe = safe.slice(0, maxBasename).trim();
  return safe;
}

async function findExecutable(candidates) {
  for (const c of candidates) {
    try {
      if (c.includes(path.sep) || c.toLowerCase().endsWith('.exe')) {
        try {
          await fs.promises.access(c);
          return c;
        } catch {}
      }
      const ok = await new Promise((resolve) => {
        try {
          const p = spawn(c, ['--version'], { shell: false });
          p.on('error', () => resolve(false));
          p.on('exit', (code) => resolve(code === 0));
        } catch {
          resolve(false);
        }
      });
      if (ok) return c;
    } catch {}
  }
  return null;
}

export class YtDlpDownloader {
  constructor(options = {}) {
    const cwd = process.cwd();
    const isWin = process.platform === 'win32';
    const aria2Env = process.env.ARIA2C_PATH || '';
    this.ytDlpCandidates = options.ytDlpCandidates || [
      path.join(cwd, 'yt-dlp.exe'),
      'yt-dlp',
      'yt-dlp.exe',
    ];
    this.aria2Candidates =
      options.aria2Candidates ||
      (isWin
        ? [
            aria2Env,
            'aria2c',
            'aria2c.exe',
            path.join(cwd, 'aria2c.exe'),
            path.join(cwd, 'aria2c'),
          ].filter(Boolean)
        : [
            aria2Env,
            'aria2c',
            path.join(cwd, 'aria2c'),
          ].filter(Boolean));
    this.ffmpegCandidates =
      options.ffmpegCandidates ||
      (isWin
        ? [
            process.env.FFMPEG_PATH || '',
            'ffmpeg',
            'ffmpeg.exe',
            path.join(cwd, 'ffmpeg.exe'),
            path.join(cwd, 'ffmpeg'),
          ].filter(Boolean)
        : [
            process.env.FFMPEG_PATH || '',
            'ffmpeg',
            path.join(cwd, 'ffmpeg'),
          ].filter(Boolean));
  }

  async ensureTools() {
    const ytDlpCmd = await findExecutable(this.ytDlpCandidates);
    if (!ytDlpCmd) {
      throw new Error('Không tìm thấy yt-dlp. Hãy đặt yt-dlp.exe cạnh project hoặc thêm vào PATH.');
    }
    const aria2Cmd = await findExecutable(this.aria2Candidates);
    const ffmpegCmd = await findExecutable(this.ffmpegCandidates);
    if (!ffmpegCmd) {
      throw new Error('Không tìm thấy ffmpeg. Hãy cài ffmpeg hoặc đặt ffmpeg.exe cạnh project.');
    }
    return { ytDlpCmd, aria2Cmd, ffmpegCmd };
  }

  async download(platform, url) {
    const cleanedUrl = PlatformDetector.sanitizeUrl(url);
    if (!cleanedUrl) {
      throw new Error('URL không hợp lệ');
    }
    if (platform === 'youtube' && !PlatformDetector.isYouTubeUrl(cleanedUrl)) {
      throw new Error('URL không phải YouTube hợp lệ');
    }
    if (platform === 'facebook' && !PlatformDetector.isFacebookUrl(cleanedUrl)) {
      throw new Error('URL không phải Facebook hợp lệ');
    }
    if (platform === 'twitter' && !PlatformDetector.isTwitterUrl(cleanedUrl)) {
      throw new Error('URL không phải Twitter/X hợp lệ');
    }

    const { ytDlpCmd, aria2Cmd } = await this.ensureTools();

    const baseName = sanitizeName(`${platform}_video`);
    const ext = 'mp4';
    const fileName = `${baseName}_${Date.now()}.${ext}`;
    const tmpPath = path.join(os.tmpdir(), fileName);

    const args = ['-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4', '-o', tmpPath, cleanedUrl];

    if (aria2Cmd) {
      args.unshift('--external-downloader-args', 'aria2c: -x 16 -s 16 -k 1M');
      args.unshift('--external-downloader', aria2Cmd);
    }

    const result = await new Promise((resolve) => {
      const p = spawn(ytDlpCmd, args, { shell: false });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => {
        out += d.toString();
      });
      p.stderr.on('data', (d) => {
        err += d.toString();
      });
      p.on('error', () => resolve({ code: 1, out, err: err || 'spawn error' }));
      p.on('close', (code) => resolve({ code, out, err }));
    });

    if (result.code !== 0) {
      const tailErr = (result.err || result.out || '').split('\n').slice(-20).join('\n');
      throw new Error(tailErr || 'Tải video thất bại (yt-dlp lỗi).');
    }

    const stat = await fs.promises.stat(tmpPath);
    return {
      filePath: tmpPath,
      fileName,
      size: stat.size,
    };
  }
}
