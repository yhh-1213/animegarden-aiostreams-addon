<p align="center">
  <h1 align="center">🌸 HellyAddon</h1>
  <p align="center"><strong>High-Precision Anime Scraper with Anime Garden (动漫花园) API Integration, Chinese Subtitle Prioritization, and PikPak & TorBox Optimization</strong></p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Stremio-Addon-8a5a9e?style=for-the-badge&logo=stremio" alt="Stremio Addon">
  <img src="https://img.shields.io/badge/Anime_Garden-API-00B0FF?style=for-the-badge" alt="Anime Garden API">
  <img src="https://img.shields.io/badge/Debrid-PikPak_&_TorBox-blue?style=for-the-badge" alt="PikPak & TorBox">
  <img src="https://img.shields.io/badge/Subtitles-Chinese_(简/繁/双语)-e91e63?style=for-the-badge" alt="Chinese Subtitles">
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License MIT">
</p>

---

## 📖 Overview

**HellyAddon** is a high-performance Stremio anime scraper addon designed for precision, low error rates, and specialized support for anime with **Chinese subtitles** (Simplified 简中, Traditional 繁中, Dual/Bilingual 双语).

It directly queries **[Anime Garden](https://animes.garden/docs/api)** (`https://api.animes.garden`) as its primary indexer, backed by **Nyaa.si** as a secondary indexer. It is optimized for debrid playback via StremThru, specifically tuned for **PikPak** (which has comprehensive cloud cache coverage for Anime Garden releases) and **TorBox**.

---

## ✨ Key Features

### 🌸 1. Native Anime Garden API Integration
- Direct REST API integration with `https://api.animes.garden/resources`.
- Full compatibility with Anime Garden endpoints and queries.
- Automatic **Base32 to 40-character hexadecimal infohash conversion** for magnets (essential for debrid resolving and Stremio streaming).
- Fast in-memory LRU caching to eliminate duplicate API requests.

### 🇨🇳 2. Chinese Subtitle Detection & Prioritization
- **Chinese Fansub Group Detection**: Identifies 40+ premier Chinese fansub groups (`ANi`, `LoliHouse`, `SweetSub`, `喵萌奶茶屋`, `桜都字幕组`, `极影字幕社`, `千夏字幕组`, `悠哈璃羽`, `VCB-Studio`, etc.).
- **Subtitle Language Tagging & Badges**: 
  - `🇨🇳 简中 (CHI_SIMP)` - Simplified Chinese
  - `🇭🇰 繁中 (CHI_TRAD)` - Traditional Chinese
  - `🌍 双语 (CHI_DUAL)` - Bilingual Japanese/Chinese
- **Score Boost (+500)**: Chinese subbed releases are automatically prioritized at the top of results.
- **Strict Chinese Mode**: Optional toggle to drop any release that does not have Chinese subtitles.

### 🎯 3. Strict Title & Season Matching
- **Multi-Lingual Title Resolution**: Enriches metadata with Chinese titles (`name_cn`), Bangumi IDs (`subjectId`), Romaji, English, and Japanese native titles via Bangumi API (`api.bgm.tv`) and AniList GraphQL.
- **Broadcast Month Sanitization**: Strips broadcast tags like `★01月新番★` or `[10月新番]` before parsing to prevent false Episode 1 matches on late-season episodes.
- **Strict Chinese Season Gating**: Accurately parses Chinese seasons (`第一季`, `第二季`, `第2期`, `S02`, `2nd Season`) and drops sequels/prequels that do not match the requested season.
- **Anime Movies & TV Series Support**: Separate handling for movies (feature film length filtering) vs episodic TV series.

### 🔢 4. Absolute Anime Numbering & Dual Notation
- **Prequel Episode Offsets**: Derives total previous episodes from AniList relations to match both relative (e.g. S2 Ep 1) and absolute (e.g. Ep 25) numbering schemes used by Chinese fansub releases.
- **Dual Episode Notation**: Parses dual notations such as `14 (23)`, `25 (01)`, and `第25话(第01话)`.

### 📦 5. Season Pack & Batch Compatibility
- **Batch Range Detection**: Detects batch notations (`[01-12]`, `01~28`, `01-24全集`, `全12话`).
- **Target File Selection**: Deep inspection inside season packs to accurately identify and unrestrict the exact video file matching the requested episode number.

### ⚡ 6. Debrid & Playback Support
- **PikPak**: Recommended for Anime Garden. Format: `Email:Password` (supported via StremThru).
- **TorBox**: API token supported with instantaneous cloud caching checks.
- **Other Providers**: RealDebrid, AllDebrid, Premiumize, Debrid-Link, Debrider, EasyDebrid, Offcloud.
- **Optional P2P**: Direct BitTorrent streaming with injected high-speed Chinese trackers.

---

## 🛠️ Configuration & Installation

1. Start the server:
   ```bash
   node server.js
   ```
2. Open your browser and navigate to:
   ```
   http://127.0.0.1:7002/configure
   ```
3. Configure your settings:
   - **Debrid Provider**: Select **PikPak** (enter `Email:Password`) or **TorBox** (enter API key).
   - **Chinese Subtitles & Sources**:
     - *Prioritize Chinese Subtitles (简/繁/双语)*: Enabled by default.
     - *Strict Chinese Subtitles Only*: Enable if you only want Chinese streams.
     - *Anime Garden API (动漫花园)*: Enabled by default.
     - *Nyaa.si Scraper*: Enabled as fallback.
   - **Preferred Languages**: Order your preferred subtitle languages (default: `CHI_SIMP`, `CHI_TRAD`, `CHI_DUAL`, `ENG`).
4. Click **Install in Stremio** or copy your unique manifest URL into Stremio.

---

## 🐳 Docker Deployment

Run with Docker:
```bash
docker build -t hellyaddon .
docker run -d -p 7002:7002 -e PORT=7002 hellyaddon
```

Or using docker-compose:
```yaml
version: "3.8"
services:
  hellyaddon:
    build: .
    ports:
      - "7002:7002"
    environment:
      - PORT=7002
      - BASE_URL=http://localhost:7002
    restart: unless-stopped
```

---

## 🧪 Testing

Run the full automated test suite (165+ tests):
```bash
cmd /c npm test
# Or directly with Node:
node --test tests/*.test.js
```

---

## 📄 License

MIT License.
