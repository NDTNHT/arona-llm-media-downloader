
```markdown
# Arona LLM Discord Media Bot

A self-hosted Discord bot that:

- Chats using an LLM (“Arona from blue archive”) directly in Discord
- Downloads media from YouTube / Facebook / X (Twitter) links in messages
- Optionally exposes a small HTTP server to host large video files

> Note: The HTTP server includes basic watch / player pages and oEmbed metadata, but **in-frame/embedded video players may not work on all platforms or all the time**. Treat this project primarily as a **media downloader** with a simple file host.

## Features

- **LLM chat**: Talk to Arona in Discord, backed by configurable LLM providers.
- **Media downloading**: Detects supported URLs, downloads video with `yt-dlp` and uploads to Discord if small enough.
- **Large file handling**: If the file is too big for Discord, it returns an HTTP link instead of an attachment.
- **Optional HTTP video server**: Serves downloaded videos via simple endpoints (download and basic watch page).

## Requirements

- Node.js 18+
- A Discord bot token
- `yt-dlp` and `ffmpeg` installed on the host (optionally `aria2c` for faster downloads)
- `yt-dlp` is included, unzip the 7z
## Quick Start

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure `.env`**

   In the `bot` folder, edit `.env` (template) and set at least:

   ```env
   DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
   BOT_KEYWORD=

   BOT_HTTP_HOST=0.0.0.0
   BOT_HTTP_PORT=4000
   BOT_BASE_URL=http://127.0.0.1

   BOT_MAX_FILE_MB=8
   
   # Optional: LLM / API keys
   GEMINI_API_KEY=YOUR_GEMINI_API_KEY
   GEMINI_MODEL=gemini-2.0-flash
   ```

3. **Run the bot**

   ```bash
   npm start
   ```

4. **Use in Discord**

   - Send a message containing the configured `BOT_KEYWORD` and a supported URL to download a video.
   - If the video is small enough, the bot uploads it directly (experimental and fill fail).
   - If it is too large, the bot replies with a link from the HTTP video server.
   
## Important Notes

- The HTTP server and watch/player pages are **best-effort utilities**. They are not a full video streaming platform.
- In-frame players or rich embeds may not work consistently across Discord / browsers.
- The main purpose of this project is a **downloader bot** with a simple file host for large files.
- i used AI to clone the logic from a nother bot which is heavly binded by a webserver (by using its hls and inframe videos playing link)
  i havent able to test the feature properly because i cant get a new domain or ssl cert :sob: you can try to enable https on the download link
  it might be able to run a discord in-frame player
## License

This project is licensed under the **MIT License**.
```
