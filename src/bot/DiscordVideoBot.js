
import fs from 'fs';
import Discord from 'discord.js';
import { PlatformDetector } from '../platform/PlatformDetector.js';

const { Client, Intents } = Discord;

export class DiscordVideoBot {
  constructor(options) {
    this.token = options.token;
    this.keyword = options.keyword; // for video download
    this.videoDownloader = options.videoDownloader;
    this.chatService = options.chatService;
    this.imageService = options.imageService;
    this.maxUploadBytes = options.maxUploadBytes;
    this.videoServer = options.videoServer || null;
    
    this.client = new Client({
      intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES],
      partials: ['CHANNEL'],
    });
  }

  registerHandlers() {
    this.client.on('messageCreate', async (message) => {
      try {
        if (message.author.bot) return;
        const content = message.content || '';
        const lowerContent = content.toLowerCase();

        // 1. Handle Arona Chat
        if (this.chatService) {
          const isStart = lowerContent.includes('hey arona');
          const isEnd = lowerContent.includes('arona endchat');
          
          // If explicitly starting/ending, or session exists (checked inside handleMessage)
          const reply = await this.chatService.handleMessage(message, isStart, isEnd);
          if (reply) {
            // Also check for drawing request INSIDE chat session
            if (this.imageService && this.imageService.shouldTriggerDraw(content)) {
               await this.handleDrawRequest(message, content);
            }
            // Send chat reply
            // Split long messages if needed (Discord limit 2000)
            if (reply.length > 2000) {
              const chunks = reply.match(/[\s\S]{1,2000}/g) || [];
              for (const chunk of chunks) {
                await message.reply(chunk);
              }
            } else {
              await message.reply(reply);
            }
            return; // Stop processing other triggers if chat handled it
          }
        }

        // 2. Handle Video Download (keyword trigger)
        if (lowerContent.includes(this.keyword.toLowerCase())) {
          await this.handleVideoDownload(message);
          return;
        }

      } catch (err) {
        const msg = err && err.message ? err.message : err;
        console.error('[BOT] Unexpected error', msg);
      }
    });

    this.client.once('ready', () => {
      const tag = this.client.user && this.client.user.tag ? this.client.user.tag : 'bot';
      console.log(`Discord bot logged in as ${tag}`);
    });
  }

  async handleDrawRequest(message, originalPrompt) {
    const mention = `<@${message.author.id}>`;
    let pending = null;
    try {
      pending = await message.reply(`Dạ em sẽ vẽ cho thầy ${mention}, đợi em một xíu nhé.`);
    } catch {}

    try {
      // Refine prompt if chat service available
      let refinedPrompt = originalPrompt;
      if (this.chatService) {
        refinedPrompt = await this.chatService.refinePromptForImage(originalPrompt);
      }

      const result = await this.imageService.generateImage(refinedPrompt);
      
      const textBase = `🎨 Ảnh đã xong cho thầy ${mention}`;
      
      if (result && !result.tooBig) {
        const files = [{ attachment: result.buf, name: result.filename }];
        const payload = { content: textBase, files };
        if (pending) await pending.edit(payload);
        else await message.reply(payload);
      } else {
        const errText = result.tooBig 
          ? `${textBase}, nhưng file ảnh lớn quá nên em không gửi lên Discord được ạ.`
          : `Xin lỗi thầy ${mention}, không tạo được ảnh.`;
        
        if (pending) await pending.edit(errText);
        else await message.reply(errText);
      }
    } catch (err) {
      console.error('[BOT] Drawing error', err);
      const errText = `Xin lỗi thầy ${mention}, bức vẽ bị nổ :sob:.`;
      if (pending) await pending.edit(errText).catch(() => {});
      else await message.reply(errText).catch(() => {});
    }
  }

  async handleVideoDownload(message) {
    const content = message.content || '';
    const rawUrl = PlatformDetector.extractFirstUrl(content);
    const url = PlatformDetector.sanitizeUrl(rawUrl);
    
    if (!url) {
      await message.reply('Không thấy URL hợp lệ trong tin nhắn của thầy.');
      return;
    }

    const platform = PlatformDetector.classifyUrl(url);
    if (!platform) {
      await message.reply('URL không hỗ trợ (chỉ YouTube, Facebook, X).');
      return;
    }

    const pending = await message.reply(`⏳ đợi xíu nhé <@${message.author.id}>`);

    let result;
    try {
      result = await this.videoDownloader.download(platform, url);
    } catch (err) {
      const reason = err && err.message ? err.message : 'Unknown error';
      await pending.edit(`❌ Xin lỗi thầy <@${message.author.id}>, tải video bị lỗi: ${reason}`);
      return;
    }

    const sizeBytes = result.size || 0;
    const limit = this.maxUploadBytes;

    if (sizeBytes > limit) {
      const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
      const limitMb = (limit / (1024 * 1024)).toFixed(2);
      if (this.videoServer) {
        try {
          const url = await this.videoServer.registerMp4(result.filePath, {
            fileName: result.fileName || 'video.mp4',
          });
          const text = `✅ Video đã tải xong (${sizeMb} MB) nhưng lớn hơn giới hạn ${limitMb}MB của Discord nên em không đính kèm được.\n🔗 Link xem: ${url}`;
          await pending.edit(text);
          return;
        } catch (err) {
          const reason = err && err.message ? err.message : 'Unknown error';
          await pending.edit(
            `✅ Video đã tải xong (${sizeMb} MB) nhưng lớn hơn giới hạn ${limitMb}MB của Discord và tạo link xem bị lỗi: ${reason}.`
          );
          try {
            await fs.promises.unlink(result.filePath);
          } catch {}
          return;
        }
      }
      await pending.edit(
        `✅ Video đã tải xong (${sizeMb} MB) nhưng lớn hơn giới hạn ${limitMb}MB của Discord nên em không đính kèm được, thầy ạ.`
      );
      try {
        await fs.promises.unlink(result.filePath);
      } catch {}
      return;
    }

    const files = [
      {
        attachment: result.filePath,
        name: result.fileName || 'video.mp4',
      },
    ];

    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    const text = `✅ Xong rồi <@${message.author.id}>\n📦 Kích thước: ${sizeMb} MB`;

    await pending.edit({ content: text, files });

    try {
      await fs.promises.unlink(result.filePath);
    } catch {}
  }

  async start() {
    if (!this.token) {
      throw new Error('DISCORD_TOKEN missing in environment');
    }
    if (!this.videoDownloader) {
      throw new Error('Video downloader is not configured');
    }
    if (!this.maxUploadBytes || !Number.isFinite(this.maxUploadBytes) || this.maxUploadBytes <= 0) {
      throw new Error('maxUploadBytes is invalid');
    }
    
    this.registerHandlers();
    await this.client.login(this.token);
  }
}
