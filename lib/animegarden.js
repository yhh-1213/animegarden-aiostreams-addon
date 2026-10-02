//===============
// HELLYADDON ANIME GARDEN CLIENT
// API integration for https://animes.garden/docs/api (https://api.animes.garden)
// Primary indexer for Chinese anime releases (DMHY, Mikan, Moe, Ani / Baha).
// Converts Base32 hashes to 40-hex lowercase infohashes for Debrid & Stremio.
//===============

const axios = require("axios");
const http = require("http");
const https = require("https");
const { isMovieRelease } = require("./parser");

const ANIME_GARDEN_API = process.env.ANIME_GARDEN_URL || "https://api.animes.garden";

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 25 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 25 });
const client = axios.create({ httpAgent, httpsAgent, timeout: 8000 });

// In-memory cache for search queries
const searchCache = new Map();
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_CACHE_ENTRIES = 500;

function getCache(key) {
    if (!searchCache.has(key)) return null;
    const item = searchCache.get(key);
    if (Date.now() - item.time > CACHE_TTL_MS) {
        searchCache.delete(key);
        return null;
    }
    return item.data;
}

function setCache(key, data) {
    if (searchCache.has(key)) searchCache.delete(key);
    else if (searchCache.size >= MAX_CACHE_ENTRIES) {
        searchCache.delete(searchCache.keys().next().value);
    }
    searchCache.set(key, { data, time: Date.now() });
}

function base32ToHex(input) {
    if (!input || typeof input !== "string") return "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    const clean = input.replace(/=+$/, "").toUpperCase();
    for (const char of clean) {
        const val = alphabet.indexOf(char);
        if (val === -1) return "";
        bits += val.toString(2).padStart(5, "0");
    }
    let hex = "";
    for (let i = 0; i + 4 <= bits.length; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex.slice(0, 40).toLowerCase();
}

function extractInfoHash(magnet) {
    if (!magnet || typeof magnet !== "string") return "";
    const m = magnet.match(/magnet:\?xt=urn:btih:([a-zA-Z0-9]+)/i);
    if (!m) return "";
    const raw = m[1].trim();
    if (raw.length === 40 && /^[a-fA-F0-9]{40}$/.test(raw)) {
        return raw.toLowerCase();
    }
    if (raw.length === 32 && /^[a-zA-Z2-7]{32}$/.test(raw)) {
        return base32ToHex(raw);
    }
    return "";
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return "Unknown";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Perform a raw query against Anime Garden /resources endpoint.
 */
async function queryAnimeGardenResources(options = {}) {
    const params = new URLSearchParams();

    if (Array.isArray(options.search)) {
        options.search.filter(Boolean).forEach(s => params.append("search", String(s).trim()));
    } else if (typeof options.search === "string" && options.search.trim()) {
        params.append("search", options.search.trim());
    }

    if (Array.isArray(options.include)) {
        options.include.filter(Boolean).forEach(inc => params.append("include", String(inc).trim()));
    }

    if (Array.isArray(options.keyword)) {
        options.keyword.filter(Boolean).forEach(k => params.append("keyword", String(k).trim()));
    } else if (typeof options.keyword === "string" && options.keyword.trim()) {
        params.append("keyword", options.keyword.trim());
    }

    if (Array.isArray(options.exclude)) {
        options.exclude.filter(Boolean).forEach(e => params.append("exclude", String(e).trim()));
    }

    if (options.type) {
        if (Array.isArray(options.type)) {
            options.type.forEach(t => params.append("type", t));
        } else {
            params.set("type", options.type);
        }
    }

    if (options.subject) {
        params.set("subject", String(options.subject));
    }

    if (options.fansub) {
        params.set("fansub", options.fansub);
    }

    const pageSize = options.pageSize || 100;
    params.set("pageSize", String(pageSize));
    params.set("page", String(options.page || 1));

    const cacheKey = params.toString();
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
        const url = `${ANIME_GARDEN_API}/resources?${params.toString()}`;
        const res = await client.get(url, {
            headers: {
                "User-Agent": "HellyAddon/1.0 (Stremio Anime Scraper; +https://github.com/johnneerdael/nexio-torii)",
                "Accept": "application/json"
            }
        });

        const rawResources = res.data?.resources || [];
        const mapped = rawResources.map(r => {
            const hash = extractInfoHash(r.magnet);
            return {
                title: r.title || "Unknown",
                hash,
                size: formatBytes(r.size),
                sizeBytes: Number(r.size) || 0,
                seeders: 0,
                source: "animegarden",
                pubDate: r.createdAt || null,
                category: r.type || "动画",
                fansub: r.fansub?.name || null,
                publisher: r.publisher?.name || null,
                subjectId: r.subjectId || null
            };
        }).filter(item => item.hash && item.hash.length === 40);

        setCache(cacheKey, mapped);
        return mapped;
    } catch (err) {
        return [];
    }
}

/**
 * Searches Anime Garden for anime with specific title variants, season and episode.
 * Formulates multi-tiered Chinese & international queries.
 */
async function searchAnimeGardenForAnime({
    chineseTitles = [],
    romajiTitles = [],
    englishTitles = [],
    requestedEp = 1,
    expectedSeason = 1,
    isMovie = false,
    absoluteEp = null,
    subjectId = null
}) {
    const deduplicated = new Map();
    const addItems = (items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (item && item.hash && !deduplicated.has(item.hash)) {
                deduplicated.set(item.hash, item);
            }
        }
    };

    const epStr = requestedEp < 10 ? `0${requestedEp}` : `${requestedEp}`;
    const absEpStr = absoluteEp && absoluteEp !== requestedEp ? (absoluteEp < 10 ? `0${absoluteEp}` : `${absoluteEp}`) : null;
    const sStr = expectedSeason < 10 ? `0${expectedSeason}` : `${expectedSeason}`;

    // Chinese season names
    const chineseSeasonMap = { 1: "第一季", 2: "第二季", 3: "第三季", 4: "第四季", 5: "第五季", 6: "第六季", 7: "第七季" };
    const cnSeasonStr = chineseSeasonMap[expectedSeason] || `第${expectedSeason}季`;

    const tasks = [];

    // If we have a Bangumi subject ID, search directly by subject!
    if (subjectId) {
        tasks.push(queryAnimeGardenResources({ subject: subjectId }));
    }

    // 1. Chinese Title Queries (Highest accuracy for Chinese subs)
    for (const cnTitle of chineseTitles.slice(0, 4)) {
        if (!cnTitle || cnTitle.length < 2) continue;

        if (isMovie) {
            // Movie queries
            tasks.push(queryAnimeGardenResources({ search: cnTitle, type: "动画" }));
            if (!isMovieRelease(cnTitle)) {
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: "剧场版", type: "动画" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: "Movie", type: "动画" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: "电影", type: "动画" }));
            }
            // If cnTitle contains distinctive English phrase (e.g. "THE LAST ATTACK"), query it
            const engSub = cnTitle.match(/[A-Za-z0-9][A-Za-z0-9\s:]{2,}[A-Za-z0-9]/);
            if (engSub && engSub[0].trim().length >= 4) {
                tasks.push(queryAnimeGardenResources({ search: engSub[0].trim(), type: "动画" }));
            }
        } else {
            // Series queries
            if (expectedSeason > 1) {
                // Season-explicit queries: e.g. ["咒术回战", "第二季", "01"]
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: [cnSeasonStr, epStr], type: "动画" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: [`第${expectedSeason}期`, epStr], type: "动画" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: [`S${sStr}E${epStr}`], type: "动画" }));
                // Season batch queries
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: cnSeasonStr, type: "合集" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: `第${expectedSeason}期`, type: "合集" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: `S${expectedSeason}`, type: "合集" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: `S${sStr}`, type: "合集" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: cnSeasonStr }));
            } else {
                // S1 query: e.g. ["葬送的芙莉莲", "01"]
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: epStr, type: "动画" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: `E${epStr}`, type: "动画" }));
                // S1 batch: e.g. ["葬送的芙莉莲"], type: "合集"
                tasks.push(queryAnimeGardenResources({ search: cnTitle, type: "合集" }));
            }

            // Absolute episode query if different from requestedEp (e.g. Naruto Shippuden S5E1 = 89, JJK S2 Ep 1 = 25)
            if (absEpStr) {
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: absEpStr, type: "动画" }));
                tasks.push(queryAnimeGardenResources({ search: cnTitle, keyword: `${absEpStr}`, type: "合集" }));
            }
        }
    }

    // Execute first batch of Chinese queries in parallel
    const cnResults = await Promise.all(tasks);
    cnResults.forEach(addItems);

    // If we already found ample results, return early to save time
    if (deduplicated.size >= 25) {
        return Array.from(deduplicated.values());
    }

    // 2. Secondary Queries: Romaji & English Titles
    const secondaryTasks = [];
    const expandedIntl = new Set();
    [...romajiTitles, ...englishTitles].slice(0, 3).forEach(t => {
        if (!t || t.length < 3) return;
        expandedIntl.add(t);
        const clean = t.replace(/[,:;!?'"~`\-_]/g, " ").replace(/\s+/g, " ").trim();
        if (clean && clean !== t) expandedIntl.add(clean);
        const words = clean.split(" ");
        if (!isMovie && words.length > 6) {
            expandedIntl.add(words.slice(0, 5).join(" "));
        }
    });

    for (const title of Array.from(expandedIntl).slice(0, 4)) {
        if (!title || title.length < 3) continue;

        if (isMovie) {
            secondaryTasks.push(queryAnimeGardenResources({ search: title, type: "动画" }));
            const sub = title.match(/[:\-–—]\s*(.+)$/);
            if (sub && sub[1].trim().length >= 3) {
                secondaryTasks.push(queryAnimeGardenResources({ search: sub[1].trim(), type: "动画" }));
            }
        } else {
            if (expectedSeason > 1) {
                secondaryTasks.push(queryAnimeGardenResources({ search: title, keyword: `S${sStr}E${epStr}`, type: "动画" }));
                secondaryTasks.push(queryAnimeGardenResources({ search: title, keyword: `S${sStr}`, type: "合集" }));
                secondaryTasks.push(queryAnimeGardenResources({ search: title, keyword: `S${expectedSeason}`, type: "合集" }));
                secondaryTasks.push(queryAnimeGardenResources({ search: title, keyword: `Season ${expectedSeason}` }));
            } else {
                secondaryTasks.push(queryAnimeGardenResources({ search: title, keyword: epStr, type: "动画" }));
                secondaryTasks.push(queryAnimeGardenResources({ search: title, type: "合集" }));
            }

            if (absEpStr) {
                secondaryTasks.push(queryAnimeGardenResources({ search: title, keyword: absEpStr, type: "动画" }));
            }
        }
    }

    if (secondaryTasks.length > 0) {
        const intlResults = await Promise.all(secondaryTasks);
        intlResults.forEach(addItems);
    }

    return Array.from(deduplicated.values());
}

module.exports = {
    ANIME_GARDEN_API,
    base32ToHex,
    extractInfoHash,
    formatBytes,
    queryAnimeGardenResources,
    searchAnimeGardenForAnime
};
