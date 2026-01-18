import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

export class HlsTranscodeService {
  constructor(options = {}) {
    this.ffmpegBin = options.ffmpegBin || process.env.FFMPEG_PATH || 'ffmpeg';
    this.ffprobeBin = options.ffprobeBin || process.env.FFPROBE_PATH || 'ffprobe';
  }

  async transcodeToHlsAbr(inputPath, outDir, options = {}) {
    await fs.mkdir(outDir, { recursive: true });

    const preset = options.preset || 'ultrafast';
    const crf = options.crf ?? 26;
    const hlsTime = options.hlsTime ?? 2;
    const hlsFlags = options.hlsFlags || 'append_list+omit_endlist+independent_segments';
    const hlsPlaylistType = options.hlsPlaylistType || 'event';
    const audioBitrate = options.audioBitrate || '128k';

    const useNvenc = String(process.env.FFMPEG_USE_NVENC || 'false').toLowerCase() === 'true';
    const nvPreset = process.env.FFMPEG_NV_PRESET || 'fast';
    const nvDeviceArg = process.env.FFMPEG_NV_DEVICE ? ['-gpu', process.env.FFMPEG_NV_DEVICE] : [];

    let srcHeight = null;
    try {
      const p = spawn(this.ffprobeBin, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=height',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      p.stdout.on('data', (d) => chunks.push(d));
      await new Promise((resolve) => p.on('close', resolve));
      const s = Buffer.concat(chunks).toString().trim();
      const h = parseInt(s, 10);
      if (Number.isFinite(h) && h > 0) srcHeight = h;
    } catch {}

    const baseLadder = options.ladder || [
      { name: '1080', height: 1080, vb: '5000k', maxrate: '5350k', bufsize: '7500k' },
      { name: '720', height: 720, vb: '3000k', maxrate: '3210k', bufsize: '4500k' },
      { name: '480', height: 480, vb: '1500k', maxrate: '1605k', bufsize: '2250k' },
    ];

    let ladder = baseLadder;
    if (srcHeight) {
      ladder = baseLadder.filter((v) => v.height <= srcHeight);
      if (ladder.length === 0) ladder = baseLadder.filter((v) => v.height <= 480).slice(0, 2);
    } else {
      ladder = baseLadder.filter((v) => v.height <= 480).slice(0, 2);
      if (ladder.length === 0) ladder = baseLadder.slice(-2);
    }

    const splitLabels = ladder.map((_, idx) => `[s${idx}]`).join('');
    const scaleChains = ladder
      .map((v, idx) => `[s${idx}]scale=trunc(oh*a/2)*2:${v.height}[v${idx}]`)
      .join(';');
    const filterComplex = `[0:v]split=${ladder.length}${splitLabels};${scaleChains}`;

    const args = ['-hide_banner', '-y', '-i', inputPath, '-filter_complex', filterComplex];
    ladder.forEach((_, idx) => {
      args.push('-map', `[v${idx}]`);
      args.push('-map', '0:a:0');
    });
    ladder.forEach((v, idx) => {
      const useNvForVariant = useNvenc;
      if (useNvForVariant) {
        args.push(
          `-c:v:${idx}`,
          'h264_nvenc',
          ...nvDeviceArg,
          `-preset:v:${idx}`,
          nvPreset,
          `-cq:v:${idx}`,
          String(crf),
          `-g:v:${idx}`,
          '48',
          `-keyint_min:v:${idx}`,
          '48',
          `-b:v:${idx}`,
          v.vb,
          `-maxrate:v:${idx}`,
          v.maxrate,
          `-bufsize:v:${idx}`,
          v.bufsize,
          `-c:a:${idx}`,
          'copy',
        );
      } else {
        args.push(
          `-c:v:${idx}`,
          'libx264',
          `-preset:v:${idx}`,
          preset,
          `-crf:v:${idx}`,
          String(crf),
          `-sc_threshold:v:${idx}`,
          '0',
          `-g:v:${idx}`,
          '48',
          `-keyint_min:v:${idx}`,
          '48',
          `-b:v:${idx}`,
          v.vb,
          `-maxrate:v:${idx}`,
          v.maxrate,
          `-bufsize:v:${idx}`,
          v.bufsize,
          `-c:a:${idx}`,
          'copy',
        );
      }
    });

    const masterName = 'master.m3u8';
    const segmentPattern = path.join(outDir, 'v%v', 'seg_%03d.ts');
    const variantIndexPattern = path.join(outDir, 'v%v', 'index.m3u8');
    try {
      await Promise.all(
        ladder.map((_, idx) => fs.mkdir(path.join(outDir, `v${idx}`), { recursive: true })),
      );
    } catch {}

    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(hlsTime),
      '-hls_playlist_type',
      hlsPlaylistType,
      '-hls_flags',
      hlsFlags,
      '-var_stream_map',
      ladder.map((_, idx) => `v:${idx},a:${idx},name:${ladder[idx].name}`).join(' '),
      '-master_pl_name',
      masterName,
      '-hls_segment_filename',
      segmentPattern,
      variantIndexPattern,
    );

    const child = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
    } catch {}

    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg HLS ABR exited with code ${code}`));
      });
    });

    return {
      masterPlaylistPath: path.join(outDir, masterName),
      outputDir: outDir,
    };
  }
}

