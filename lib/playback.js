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

    // 1. Instant Cache Hit (0ms - avoids repeated 20s PikPak task calls)
    const cached = getPlaybackCache(cacheKey);
    if (cached) {
        const action = { type: "redirect", url: cached.url };
        if (cached.filename) {
            Object.defineProperty(action, "filename", { value: cached.filename, enumerable: false });
        }
        return action;
    }

    // 2. Request Coalescing (Merge duplicate concurrent Stremio resolve calls)
    if (inFlightResolves.has(cacheKey)) {
        return inFlightResolves.get(cacheKey);
    }

    const resolvePromise = (async () => {
        const add = options.addStoreTorz || addStoreTorz;
        const generate = options.generateStoreLink || generateStoreLink;
        const magnet = buildMagnet(options.hash, options.title, options.trackers || []);
        const torz = await add(magnet, options.entry, options.providerOptions || {});
        const status = String(torz.status || "unknown").toLowerCase();

        if (PENDING_STATUSES.has(status)) return { type: "loading" };
        if (FAILED_STATUSES.has(status)) return { type: "not_found", message: "Torrent is not playable." };
        if (!READY_STATUSES.has(status)) return { type: "loading" };

        const files = Array.isArray(torz.files) ? torz.files : [];
        const isMovie = Boolean(options.isMovie);
        const bestFile = options.selectBestVideoFile(
            files,
            options.episode || 1,
            options.expectedSeason || 1,
            isMovie || !isBatchTitle(options.title)
        );

        if (!bestFile || !bestFile.link) return { type: "archive" };

        const directLink = await generate(bestFile.link, options.entry, options.providerOptions || {});
        if (!directLink) return { type: "loading" };

        const filename = bestFile.name || bestFile.path || (options.title ? `${options.title}.mkv` : "video.mkv");
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
