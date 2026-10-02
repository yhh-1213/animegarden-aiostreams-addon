const {
    FAILED_STATUSES,
    PENDING_STATUSES,
    READY_STATUSES,
    addStoreTorz,
    generateStoreLink
} = require("./debrid");

function buildMagnet(hash, title, trackers = []) {
    const parts = [`magnet:?xt=urn:btih:${hash}`];
    if (title) parts.push(`dn=${encodeURIComponent(title)}`);
    trackers.forEach(tracker => {
        if (tracker) parts.push(`tr=${encodeURIComponent(tracker)}`);
    });
    return parts.join("&");
}

function isBatchTitle(title) {
    return /batch|complete|all\s+episodes/i.test(title || "");
}

// In-memory playback cache (2 hours TTL) for instant seeks, rewinds, and replays
const playbackCache = new Map();
const inFlightResolves = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function getPlaybackCache(key) {
    if (!playbackCache.has(key)) return null;
    const item = playbackCache.get(key);
    if (Date.now() > item.expiresAt) {
        playbackCache.delete(key);
        return null;
    }
    return item;
}

function setPlaybackCache(key, data) {
    if (playbackCache.has(key)) playbackCache.delete(key);
    else if (playbackCache.size >= MAX_CACHE_ENTRIES) {
        playbackCache.delete(playbackCache.keys().next().value);
    }
    playbackCache.set(key, { ...data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function resolveStorePlayback(options) {
    const entryKey = (options.entry?.apiKey || "").slice(0, 10);
    const service = options.entry?.service || "unknown";
    const cacheKey = `${service}_${entryKey}_${options.hash}_${options.episode || 1}`;

    console.log(`[Playback] [${service}] Resolving playback for hash: ${options.hash} (Ep: ${options.episode || 1}, Season: ${options.expectedSeason || 1}, Title: "${options.title || 'Unknown'}")`);

    // 1. Instant Cache Hit (0ms - avoids repeated 20s PikPak task calls)
    const cached = getPlaybackCache(cacheKey);
    if (cached) {
        console.log(`[Playback] [${service}] ⚡ Instant cache hit: ${cached.url}`);
        const action = { type: "redirect", url: cached.url };
        if (cached.filename) {
            Object.defineProperty(action, "filename", { value: cached.filename, enumerable: false });
        }
        return action;
    }

    // 2. Request Coalescing (Merge duplicate concurrent Stremio resolve calls)
    if (inFlightResolves.has(cacheKey)) {
        console.log(`[Playback] [${service}] 🔄 Coalescing duplicate in-flight resolution for ${options.hash}`);
        return inFlightResolves.get(cacheKey);
    }

    const resolvePromise = (async () => {
        const add = options.addStoreTorz || addStoreTorz;
        const generate = options.generateStoreLink || generateStoreLink;
        const magnet = buildMagnet(options.hash, options.title, options.trackers || []);
        console.log(`[Playback] [${service}] Requesting torrent addition to ${service} store...`);
        const torz = await add(magnet, options.entry, options.providerOptions || {});
        const status = String(torz.status || "unknown").toLowerCase();
        const files = Array.isArray(torz.files) ? torz.files : [];

        console.log(`[Playback] [${service}] Store status: "${status}" | Files count: ${files.length} | isCached: ${torz.isCached}`);

        if (PENDING_STATUSES.has(status)) {
            console.warn(`[Playback] [${service}] ⏳ Torrent is pending/downloading to cloud (status: "${status}"). Serving waiting fallback.`);
            return { type: "loading" };
        }
        if (FAILED_STATUSES.has(status)) {
            console.error(`[Playback] [${service}] ❌ Torrent failed on ${service} (status: "${status}").`);
            return { type: "not_found", message: "Torrent is not playable." };
        }
        if (!READY_STATUSES.has(status)) {
            console.warn(`[Playback] [${service}] ⏳ Torrent status "${status}" is not ready. Serving waiting fallback.`);
            return { type: "loading" };
        }

        const isMovie = Boolean(options.isMovie);
        const bestFile = options.selectBestVideoFile(
            files,
            options.episode || 1,
            options.expectedSeason || 1,
            isMovie,
            options.absoluteEp || null,
            options.title || ""
        );

        if (!bestFile) {
            console.warn(`[Playback] [${service}] 📦 No matching video file found for Ep ${options.episode || 1} (Season ${options.expectedSeason || 1}) in ${files.length} files.`);
            if (files.length > 0) {
                console.log(`[Playback] [${service}] Available files in torrent: [${files.slice(0, 10).map(f => `"${f.name || f.path}"`).join(", ")}${files.length > 10 ? ` ...and ${files.length - 10} more` : ""}]`);
            }
            return { type: "archive" };
        }

        const fileLink = bestFile.link || (bestFile.id !== undefined && (torz.id || torz.torrentId) ? `torbox://${torz.id || torz.torrentId}/${bestFile.id}` : "");
        if (!fileLink) {
            console.warn(`[Playback] [${service}] 📦 Selected file "${bestFile.name || bestFile.path}" has no playable link or ID.`);
            return { type: "archive" };
        }

        console.log(`[Playback] [${service}] 🎯 Selected video file: "${bestFile.name || bestFile.path}" (index: ${bestFile.index ?? bestFile.id}, size: ${bestFile.size})`);

        const directLink = await generate(fileLink, options.entry, {
            ...options.providerOptions,
            file: bestFile,
            torz
        });
        if (!directLink) {
            console.error(`[Playback] [${service}] ❌ Service returned empty direct stream link.`);
            return { type: "loading" };
        }

        const filename = bestFile.name || bestFile.path || (options.title ? `${options.title}.mkv` : "video.mkv");
        console.log(`[Playback] [${service}] ✅ Direct playback URL generated successfully for: "${filename}"`);
        setPlaybackCache(cacheKey, { url: directLink, filename });

        const action = { type: "redirect", url: directLink };
        Object.defineProperty(action, "filename", { value: filename, enumerable: false });
        return action;
    })();

    inFlightResolves.set(cacheKey, resolvePromise);

    try {
        return await resolvePromise;
    } finally {
        inFlightResolves.delete(cacheKey);
    }
}

async function resolveStoreSubtitle(options) {
    const add = options.addStoreTorz || addStoreTorz;
    const generate = options.generateStoreLink || generateStoreLink;
    const magnet = buildMagnet(options.hash, options.title, options.trackers || []);
    const torz = await add(magnet, options.entry, options.providerOptions || {});
    const status = String(torz.status || "unknown").toLowerCase();

    if (!READY_STATUSES.has(status)) return { type: "not_found", message: "Subtitle torrent is not ready." };

    const file = (torz.files || []).find(candidate => String(candidate.id) === String(options.fileId));
    if (!file || !file.link) return { type: "not_found", message: "Subtitle not found." };

    const directLink = await generate(file.link, options.entry, options.providerOptions || {});
    if (!directLink) return { type: "not_found", message: "Subtitle link not found." };

    return {
        type: "redirect",
        url: directLink,
        fileName: file.name || file.path || options.fileName || "sub.srt"
    };
}

module.exports = {
    buildMagnet,
    resolveStorePlayback,
    resolveStoreSubtitle
};
