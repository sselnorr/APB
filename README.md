# APB Content Machine

NestJS service for:

- Google Drive ingest -> video description generation -> scheduled multi-platform publishing
- Telegram bot operator workflow for channel drafts with approve/edit/delete/rewrite
- Article ingestion -> summarize -> Telegram draft + social written draft generation
- Railway-ready long-running runtime with PostgreSQL as the system of record

## Main Flow

### Video

- New videos are discovered in `GOOGLE_DRIVE_INGEST_FOLDER_ID`
- Each video is processed in `createdTime` order
- A sibling `.txt` description is created directly in `INGEST`
- The oldest ready unpublished video is scheduled into the next Berlin publish window
- After successful publication to all configured platforms, video and `.txt` move to `Sent`

### Telegram Drafts

- Article sources are scanned every 6 hours
- New materials are summarized into a cluster
- A Telegram draft is created and sent to the owner chat with inline actions
- `Publish` posts to `TELEGRAM_CHANNEL_ID`
- `Edit` accepts text, photo, or text + photo and rewrites the stored draft assets

### Social Written Queue

- The same article cluster also creates a `Written` text + image draft
- These items are scheduled with the same publish windows
- Real X/Threads/Facebook publishing is intentionally stubbed until external API details are provided

## Required Environment

Use `.env.example` as the only source of truth for required variables.

Important variables:

- `DATABASE_URL`
- `APP_TIMEZONE`
- `PUBLISH_WINDOWS`
- `GOOGLE_DRIVE_INGEST_FOLDER_ID`
- `GOOGLE_DRIVE_SENT_FOLDER_ID`
- `GOOGLE_DRIVE_WRITTEN_FOLDER_ID`
- `GOOGLE_DRIVE_PUBLISHED_FOLDER_ID`
- `GOOGLE_DRIVE_TG_DRAFTS_FOLDER_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_CHAT_ID`
- `TELEGRAM_CHANNEL_ID`
- `OPENAI_API_KEY`
- `UPLOAD_POST_API_KEY`
- `UPLOAD_POST_USERNAME`
- `ARTICLE_SOURCES_JSON`

## Local Commands

```bash
npm install --include=dev
npx prisma generate
npm run build
node ./node_modules/jest/bin/jest.js --runInBand
node ./node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand
```

## Railway Notes

- The runtime image installs `ffmpeg`
- Prisma client is generated inside the Docker image
- Secrets should live in Railway environment variables, not in committed files
- The Telegram bot must be admin in the target channel

## Current Deliberate Limitations

- Notion sync is a placeholder adapter only
- Social network publisher for X/Threads/Facebook is a placeholder adapter only
- Upload-Post undocumented editor features like platform music library selection remain deferred
