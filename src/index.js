
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { YtDlpDownloader } from './downloader/YtDlpDownloader.js';
import { DiscordVideoBot } from './bot/DiscordVideoBot.js';
import { AronaChatService } from './service/AronaChatService.js';
import { ImageGenService } from './service/ImageGenService.js';
import { HttpVideoServer } from './server/HttpVideoServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();
const botBaseUrlFromLocalEnv = process.env.BOT_BASE_URL;
if (!process.env.DISCORD_TOKEN) {
  dotenv.config({ path: path.join(__dirname, '..', '..', 'backend', '.env') });
  if (botBaseUrlFromLocalEnv) {
    process.env.BOT_BASE_URL = botBaseUrlFromLocalEnv;
  }
}

const token = process.env.DISCORD_TOKEN;
const keyword = process.env.BOT_KEYWORD || 'Arona luộc đi em';

const maxMbEnv = Number(process.env.BOT_MAX_FILE_MB || 8);
const fallbackMaxMb = 8;
const maxMb = Number.isFinite(maxMbEnv) && maxMbEnv > 0 ? maxMbEnv : fallbackMaxMb;
const maxUploadBytes = maxMb * 1024 * 1024;

// 1. Chat Service Config
const aronaProvider = (process.env.ARONA_PROVIDER || 'gemini').toLowerCase();
const chatService = new AronaChatService({
  provider: aronaProvider,
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModelName: process.env.GEMINI_MODEL,
  groqApiKey: process.env.GROQ_API_KEY,
  groqModelName: process.env.GROQ_MODEL,
  pollinationChatModel: process.env.POLLINATION_CHAT_MODEL || 'openai',
  pollinationApiKey: process.env.POLLINATION_API_KEY,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  persona: process.env.ARONA_PERSONA,
  enableWebSearch: process.env.GEMINI_ENABLE_GOOGLE_SEARCH !== 'false',
  webSearchEngine: process.env.ARONA_WEB_SEARCH_ENGINE || 'tavily',
  geminiRpmLimit: Number(process.env.GEMINI_RPM_LIMIT) || 5,
});

// 2. Image Service Config
const imageService = new ImageGenService({
  pollinationsModel: process.env.POLLINATIONS_MODEL || 'flux',
  width: Number(process.env.POLLINATIONS_WIDTH) || 1024,
  height: Number(process.env.POLLINATIONS_HEIGHT) || 1024,
  apiKey: process.env.POLLINATION_API_KEY,
});

const httpPortEnv = Number(process.env.BOT_HTTP_PORT || 0);
const httpPort = Number.isFinite(httpPortEnv) && httpPortEnv > 0 ? httpPortEnv : 4000;
const httpHost = process.env.BOT_HTTP_HOST || '0.0.0.0';
const baseUrlFromEnv = process.env.BOT_BASE_URL;
const defaultBaseUrl = `http://localhost:${httpPort}`;
const httpBaseUrl = (baseUrlFromEnv && baseUrlFromEnv.trim()) || defaultBaseUrl;

const videoServer = new HttpVideoServer({
  port: httpPort,
  host: httpHost,
  baseUrl: httpBaseUrl,
});

const downloader = new YtDlpDownloader();

const bot = new DiscordVideoBot({
  token,
  keyword,
  videoDownloader: downloader,
  chatService,
  imageService,
  maxUploadBytes,
  videoServer,
});

videoServer
  .start()
  .then(() => bot.start())
  .catch((err) => {
    const msg = err && err.message ? err.message : err;
    console.error('[BOT] Không thể khởi động bot', msg);
    process.exit(1);
  });
