
import { GoogleGenerativeAI } from '@google/generative-ai';
import { tavily as createTavilyClient } from '@tavily/core';
import { StringUtils } from '../utils/StringUtils.js';

export class AronaChatService {
  constructor(options = {}) {
    this.provider = (options.provider || 'gemini').toLowerCase();
    this.geminiApiKey = options.geminiApiKey;
    this.geminiModelName = options.geminiModelName || 'gemini-2.5-flash';
    this.groqApiKey = options.groqApiKey;
    this.groqModelName = options.groqModelName || 'llama-3.1-70b-versatile';
    this.pollinationChatModel = options.pollinationChatModel || 'openai';
    this.pollinationApiKey = options.pollinationApiKey;
    this.tavilyApiKey = options.tavilyApiKey;
    this.persona = options.persona || 'You are Arona, a helpful AI assistant.';
    
    // Web search config
    this.enableWebSearch = options.enableWebSearch !== false; // Default true
    this.webSearchEngine = options.webSearchEngine || 'tavily';

    this.geminiRpmLimit = options.geminiRpmLimit || 5;
    this.geminiCallTimestamps = [];
    
    // State
    this.chats = new Map(); // key -> session object
    
    // Init clients
    this.genAI = null;
    this.geminiModel = null;
    this.tavilyClient = null;

    this.init();
  }

  init() {
    if (this.provider === 'gemini' && this.geminiApiKey) {
      this.genAI = new GoogleGenerativeAI(this.geminiApiKey);
      const tools = this.enableWebSearch && this.webSearchEngine === 'google' ? [{ google_search: {} }] : [];
      this.geminiModel = this.genAI.getGenerativeModel({
        model: this.geminiModelName,
        systemInstruction: this.persona,
        ...(tools.length ? { tools } : {}),
      });
    }

    if (this.tavilyApiKey) {
      this.tavilyClient = createTavilyClient({ apiKey: this.tavilyApiKey });
    }
  }

  canUseGeminiNow() {
    const now = Date.now();
    const windowMs = 60000;
    this.geminiCallTimestamps = this.geminiCallTimestamps.filter((t) => now - t < windowMs);
    if (this.geminiCallTimestamps.length >= this.geminiRpmLimit) {
      return false;
    }
    this.geminiCallTimestamps.push(now);
    return true;
  }

  shouldUseWebSearch(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return false;
    if (s.startsWith('web:') || s.startsWith('search:') || s.startsWith('tìm kiếm:')) return true;
    const keywords = [
      'hôm nay', 'hiện tại', 'bây giờ', 'giá', 'tỷ giá', 'tỉ giá',
      'thời tiết', 'tin tức', 'news', 'cập nhật', 'tìm kiếm',
      'research', 'web search', 'search', 'tìm cho',
    ];
    for (const kw of keywords) {
      if (s.includes(kw)) return true;
    }
    return false;
  }

  normalizeQueryForSearch(raw) {
    let s = String(raw || '').trim();
    const re = /^(web:|search:|tìm kiếm:)\s*/i;
    s = s.replace(re, '').trim();
    return s || String(raw || '').trim();
  }

  async performWebSearch(query) {
    if (!query || !this.tavilyClient) return null;
    try {
      const r = await this.tavilyClient.search(query);
      const results = Array.isArray(r && r.results) ? r.results.slice(0, 3) : [];
      if (!results.length) {
        return (r && (r.answer || r.output || r.summary)) || null;
      }
      const parts = results.map((item, idx) => {
        const title = item.title || '';
        const url = item.url || '';
        const content = item.content || item.snippet || '';
        return `${idx + 1}. ${title} - ${content} (${url})`;
      });
      return parts.join('\n');
    } catch (err) {
      console.error('[ARONA] Web search failed', err);
      return null;
    }
  }

  async buildMessageWithContext(text) {
    if (!this.enableWebSearch || this.webSearchEngine !== 'tavily') return text;
    if (!this.shouldUseWebSearch(text)) return text;
    
    const query = this.normalizeQueryForSearch(text);
    const summary = await this.performWebSearch(query);
    if (!summary) return text;

    return `Dưới đây là kết quả tìm kiếm web liên quan:\n${summary}\n\nCâu hỏi: ${query}\nHãy trả lời dựa trên thông tin này.`;
  }

  makeKey(message) {
    const channelId = message.channelId || (message.channel && message.channel.id) || '';
    return `${channelId}:${message.author.id}`;
  }

  // Refine prompt for image generation using the configured AI
  async refinePromptForImage(originalPrompt) {
    const systemPrompt = "You are an expert prompt engineer for AI image generation (Stable Diffusion/Flux). User will give a simple description. You must output a detailed, high-quality English prompt to generate that image. Output ONLY the prompt text, no explanations.";
    const userMsg = `Refine this description into a high-quality image prompt: "${originalPrompt}"`;

    try {
      if (this.provider === 'groq' && this.groqApiKey) {
        return await this.callGroqChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }]);
      } else if (this.provider === 'pollination') {
        return await this.callPollinationChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }]);
      } else if (this.geminiModel) {
        const result = await this.geminiModel.generateContent(systemPrompt + "\n" + userMsg);
        return StringUtils.stripThinkBlocks(result.response.text());
      }
    } catch (err) {
      console.error('[ARONA] Failed to refine prompt', err);
    }
    return originalPrompt; // Fallback to original
  }

  async handleMessage(message, isStart, isEnd) {
    const key = this.makeKey(message);
    let session = this.chats.get(key);
    
    // Check start
    if (isStart) {
      // Create new session
      if (this.provider === 'gemini' && this.geminiModel) {
        const chat = this.geminiModel.startChat({ history: [] });
        session = { provider: 'gemini', chat };
        this.chats.set(key, session);
      } else if (this.provider === 'groq' && this.groqApiKey) {
        session = { 
          provider: 'groq', 
          messages: [{ role: 'system', content: this.persona }] 
        };
        this.chats.set(key, session);
      } else if (this.provider === 'pollination') {
        session = {
          provider: 'pollination',
          messages: [{ role: 'system', content: this.persona }]
        };
        this.chats.set(key, session);
      } else {
        throw new Error('AI provider not configured properly');
      }
    }

    if (!session) return null; // No active session

    // Check end
    if (isEnd) {
      this.chats.delete(key);
      // Generate farewell
      const farewellPrompt = 'Người dùng muốn kết thúc cuộc trò chuyện. Hãy gửi lời chào tạm biệt ngắn gọn, xưng "em" gọi "sensei".';
      return await this.generateResponse(session, farewellPrompt);
    }

    // Normal chat
    const content = message.content.replace(/hey arona/ig, '').replace(/arona endchat/ig, '').trim();
    if (!content) return isStart ? "Chào thầy! Em có thể giúp gì cho thầy ạ?" : null;

    const enriched = await this.buildMessageWithContext(content);
    return await this.generateResponse(session, enriched);
  }

  async generateResponse(session, text) {
    if (session.provider === 'gemini') {
      if (!this.canUseGeminiNow()) {
        throw new Error('Gemini rate limit exceeded (5 RPM). Please wait.');
      }
      try {
        const result = await session.chat.sendMessage(text);
        return StringUtils.stripThinkBlocks(result.response.text());
      } catch (err) {
        throw err;
      }
    } else if (session.provider === 'groq') {
      session.messages.push({ role: 'user', content: text });
      try {
        const reply = await this.callGroqChat(session.messages);
        session.messages.push({ role: 'assistant', content: reply });
        return reply;
      } catch (err) {
        throw err;
      }
    } else if (session.provider === 'pollination') {
      session.messages.push({ role: 'user', content: text });
      try {
        const reply = await this.callPollinationChat(session.messages);
        session.messages.push({ role: 'assistant', content: reply });
        return reply;
      } catch (err) {
        throw err;
      }
    }
    return 'Error: Unknown provider';
  }

  async callGroqChat(messages) {
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.groqApiKey}`,
      },
      body: JSON.stringify({
        model: this.groqModelName,
        messages,
      }),
    });
    
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || `Groq HTTP ${res.status}`);
    }
    
    const data = await res.json();
    const choice = data.choices?.[0];
    return StringUtils.stripThinkBlocks(choice?.message?.content || '');
  }

  async callPollinationChat(messages) {
    const url = 'https://gen.pollinations.ai/v1/chat/completions';
    const headers = {
      'Content-Type': 'application/json',
    };
    if (this.pollinationApiKey) {
      headers.Authorization = `Bearer ${this.pollinationApiKey}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.pollinationChatModel,
        messages,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Pollinations Chat HTTP ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    return StringUtils.stripThinkBlocks(choice?.message?.content || '');
  }
}
