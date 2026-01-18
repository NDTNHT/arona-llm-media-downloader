export class PlatformDetector {
  static extractFirstUrl(text) {
    const match = String(text || '').match(/https?:\/\/\S+/i);
    return match ? match[0] : null;
  }

  static sanitizeUrl(rawUrl) {
    if (!rawUrl) return '';
    return String(rawUrl).trim().replace(/^<+|>+$/g, '').replace(/^[`'"]+|[`'"]+$/g, '');
  }

  static isYouTubeUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return host.includes('youtube.com') || host.includes('youtu.be');
    } catch {
      return false;
    }
  }

  static isFacebookUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return (
        host.endsWith('facebook.com') ||
        host.endsWith('fb.watch') ||
        host.endsWith('m.facebook.com') ||
        host.includes('facebook')
      );
    } catch {
      return false;
    }
  }

  static isTwitterUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return (
        host.endsWith('twitter.com') ||
        host.endsWith('x.com') ||
        host.endsWith('mobile.twitter.com') ||
        host.includes('twitter') ||
        host.includes('x.com')
      );
    } catch {
      return false;
    }
  }

  static classifyUrl(url) {
    if (this.isYouTubeUrl(url)) return 'youtube';
    if (this.isFacebookUrl(url)) return 'facebook';
    if (this.isTwitterUrl(url)) return 'twitter';
    return null;
  }
}

