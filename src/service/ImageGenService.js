
import { StringUtils } from '../utils/StringUtils.js';

export class ImageGenService {
  constructor(options = {}) {
    this.pollinationsModel = options.pollinationsModel || 'flux';
    this.width = options.width || 1024;
    this.height = options.height || 1024;
    this.apiKey = options.apiKey || ''; // Optional Pollinations API key
  }

  shouldTriggerDraw(text) {
    const s = String(text || '').toLowerCase();
    if (!s) return false;
    const keywords = [
      'vẽ ', 've ', 've di', 'vẽ đi', 'vẽ hộ',
      'tạo ảnh', 'tao anh', 'vẽ cho',
      'draw ', 'draw me', 'image ', 'picture ',
      'bức tranh', 'hình ảnh',
    ];
    for (const kw of keywords) {
      if (s.includes(kw)) return true;
    }
    return false;
  }

  async generateImage(prompt) {
    const cleanedPrompt = String(prompt || '').trim();
    if (!cleanedPrompt) {
      throw new Error('Missing prompt for image generation');
    }

    const upstreamParams = new URLSearchParams();
    upstreamParams.set('model', this.pollinationsModel);
    upstreamParams.set('width', String(this.width));
    upstreamParams.set('height', String(this.height));
    
    const encodedPromptForPath = encodeURIComponent(cleanedPrompt);
    let upstreamUrl = '';
    const headers = {};

    if (this.apiKey) {
      upstreamUrl = `https://gen.pollinations.ai/image/${encodedPromptForPath}?${upstreamParams.toString()}`;
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else {
      upstreamParams.set('nologo', 'true');
      upstreamUrl = `https://image.pollinations.ai/prompt/${encodedPromptForPath}?${upstreamParams.toString()}`;
    }

    const maxAttempts = 3;
    let lastErr = null;

    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        const res = await fetch(upstreamUrl, {
          method: 'GET',
          headers,
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`Pollinations failed (${res.status}): ${txt.slice(0, 200)}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        
        let ext = 'png';
        if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
        else if (contentType.includes('webp')) ext = 'webp';
        else if (contentType.includes('gif')) ext = 'gif';

        const filename = `arona-draw.${ext}`;
        const tooBig = buf.length > 8 * 1024 * 1024;

        return { buf, filename, tooBig };
      } catch (err) {
        lastErr = err;
        const msg = err && err.message ? String(err.message) : '';
        const shouldRetry =
          msg.includes('ENOTFOUND') ||
          msg.includes('pollinations failed (500)');
        
        if (!shouldRetry || i === maxAttempts - 1) {
          throw err;
        }
        await StringUtils.sleep(1000);
      }
    }
    throw lastErr || new Error('Pollinations failed after retries');
  }
}
