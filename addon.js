//===============
// HELLYADDON STREMIO ADDON - CORE ENGINE
// High-precision anime scraper powered by Anime Garden & Nyaa.
// Features:
// - Exact Title Matching (multi-lingual: Chinese, Romaji, English, Japanese Native)
// - Anime Garden Open API Integration (https://animes.garden/docs/api)
// - Full Season Pack / Batch Compatibility (accurate file selection inside packs)
// - Absolute Anime Numbering Compatibility (supports multi-season continuation & dual-numbering)
// - Priority & strict filtering for anime with Chinese subtitles (CHS, CHT, Dual)
// - TorBox & PikPak premium debrid stream unlocking via StremThru + optional P2P mode
// - Support for both Anime Movies and Anime Series
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const {
    searchAnime,
    resolveAnimeMetaFromTitle,
    getAnimeMeta,
    getTrendingAnime,
    getTopAnime,
    getAiringAnime,
    getSeasonalAnime,
    getJikanMeta,
    fetchEpisodeDetails,
    getCurrentSeasonInfo,
    getBangumiSubject
} = require("./lib/anilist");
const { searchAnimeGardenForAnime } = require("./lib/animegarden");
const { searchNyaaForAnime } = require("./lib/nyaa");
const { encodeConfigPayload, fromBase64Safe, parseConfig, toBase64Safe } = require("./lib/config");
const { buildDebridStreams, buildP2PStream, buildParsedFromTitle, dedupeTorrentsByExactSize } = require("./lib/stream-builder");
const {
    extractEpisodeNumber,
    extractEpisodes,
    getBatchRange,
    isEpisodeMatch,
    selectBestVideoFile,
    isSeasonBatch,
    isWrongSeason,
    toSimplifiedChinese,
    toTraditionalChinese,
    verifyExactTitleMatch,
    verifyTitleMatch,
    detectChineseSubtitle
} = require("./lib/parser");
const { getTorrentsForStream } = require("./lib/cache/stream-cache");
const { buildMediaKey } = require("./lib/cache/torrent-cache");
const { checkStoreTorzWithCache } = require("./lib/cache/debrid-cache");
const { filterByCanonical } = require("./lib/normalizer/match");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

//===============
// GLOBAL CONCURRENCY LIMITER
//===============
const MAX_CONCURRENT_SCRAPES = 5;
let activeScrapes = 0;
const scrapeQueue = [];

async function enqueueScrape(queryFn) {
    return new Promise((resolve, reject) => {
        const task = async () => {
            activeScrapes++;
            try {
                const result = await queryFn();
                resolve(result);
            } catch (e) {
                reject(e);
            } finally {
                activeScrapes--;
                if (scrapeQueue.length > 0) {
                    const nextTask = scrapeQueue.shift();
                    nextTask();
                }
            }
        };

        if (activeScrapes < MAX_CONCURRENT_SCRAPES) {
            task();
        } else {
            scrapeQueue.push(task);
        }
    });
}

function applyTitlePreference(metas, userConfig) {
    if (!userConfig.useEnglishTitles || !metas) return metas;
    return metas.map(m => ({ ...m, name: m.englishName || m.name }));
}

function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== "string") return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|GiB|MiB|KiB|B)/i);
    if (!match) return 0;
    const val = parseFloat(match[1]); 
    const unit = match[2].toUpperCase();
    if (unit.includes("G")) return val * 1024 * 1024 * 1024;
    if (unit.includes("M")) return val * 1024 * 1024;
    return val * 1024;
}

function extractTags(title) {
    let res = "SD";
    if (/(4320p|8k|FUHD)/i.test(title)) res = "8K";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    else if (/(1440p|2k|QHD)/i.test(title)) res = "2K";
    else if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(480p|480)/i.test(title)) res = "480p";
    return { res };
}

//===============
// LANGUAGE MATRIX
//===============
const LANG_REGEX = {
    "CHI_SIMP": /\b(chs|gb|sc|zh-cn|zh-hans|schinese)\b|简|简体|简中|简日|内嵌简中/i,
    "CHI_TRAD": /\b(cht|big5|tc|zh-tw|zh-hk|zh-hant|tchinese)\b|繁|繁体|繁中|繁日|内嵌繁中/i,
    "CHI_DUAL": /双语|雙語|简繁|簡繁|中日|中字|中文字幕|中文内嵌|内嵌中字/i,
    "CHI": /\b(chi|chinese|chs|cht|mandarin|zh-cn|zh-tw|zh)\b|(?:^|[\[\(\-_ ])(zh)(?:[\]\)\-_ ]|$)|(简|繁|中文字幕|中文)/i,
    "GER": /\b(ger|deu|german|deutsch|de-de)\b|(?:^|[\[\(\-_ ])(de)(?:[\]\)\-_ ]|$)/i,
    "FRE": /\b(fre|fra|french|vostfr|vf|fr-fr)\b|(?:^|[\[\(\-_ ])(fr)(?:[\]\)\-_ ]|$)/i,
    "ITA": /\b(ita|italian|it-it)\b|(?:^|[\[\(\-_ ])(it)(?:[\]\)\-_ ]|$)/i,
    "SPA": /\b(spa|esp|spanish|es-es|castellano)\b|(?:^|[\[\(\-_ ])(es)(?:[\]\)\-_ ]|$)/i,
    "LAT": /\b(lat|latino|es-mx|es-419)\b|(?:^|[\[\(\-_ ])(lat)(?:[\]\)\-_ ]|$)/i,
    "RUS": /\b(rus|russian|ru-ru)\b|(?:^|[\[\(\-_ ])(ru)(?:[\]\)\-_ ]|$)/i,
    "POR": /\b(por|pt-br|portuguese|pt-pt)\b|(?:^|[\[\(\-_ ])(pt)(?:[\]\)\-_ ]|$)/i,
    "ARA": /\b(ara|arabic|ar-sa)\b|(?:^|[\[\(\-_ ])(ar)(?:[\]\)\-_ ]|$)/i,
    "KOR": /\b(kor|korean|ko-kr)\b|(?:^|[\[\(\-_ ])(ko)(?:[\]\)\-_ ]|$)/i,
    "HIN": /\b(hin|hindi|hi-in)\b|(?:^|[\[\(\-_ ])(hi)(?:[\]\)\-_ ]|$)/i,
    "POL": /\b(pol|polish|pl-pl)\b|(?:^|[\[\(\-_ ])(pl)(?:[\]\)\-_ ]|$)/i,
    "NLD": /\b(nld|dut|dutch|nl-nl)\b|(?:^|[\[\(\-_ ])(nl)(?:[\]\)\-_ ]|$)/i,
    "TUR": /\b(tur|turkish|tr-tr)\b|(?:^|[\[\(\-_ ])(tr)(?:[\]\)\-_ ]|$)/i,
    "VIE": /\b(vie|vietnamese|vi-vn)\b|(?:^|[\[\(\-_ ])(vi)(?:[\]\)\-_ ]|$)/i,
    "IND": /\b(ind|indonesian|id-id)\b|(?:^|[\[\(\-_ ])(id)(?:[\]\)\-_ ]|$)/i,
    "ENG": /\b(eng|english|dubbed|subbed|en-us|en-gb)\b|(?:^|[\[\(\-_ ])(en)(?:[\]\)\-_ ]|$)/i,
    "JPN": /\b(jpn|japanese|raw|jp-jp)\b|(?:^|[\[\(\-_ ])(jp)(?:[\]\)\-_ ]|$)/i,
    "MULTI": /(multi|dual|multi-audio|multi-sub)/i
};

function extractLanguage(title, userLangs = []) {
    const sub = detectChineseSubtitle(title);
    if (sub.hasChinese) {
        if (userLangs.includes(sub.type)) return sub.type;
        if (userLangs.includes("CHI")) return sub.type;
        return sub.type;
    }

    const lower = title.toLowerCase();
    for (let lang of userLangs) {
        if (LANG_REGEX[lang] && LANG_REGEX[lang].test(lower)) return lang;
    }
    if (LANG_REGEX["MULTI"].test(lower)) return "MULTI";
    if (LANG_REGEX["ENG"].test(lower)) return "ENG";
    if (LANG_REGEX["JPN"].test(lower)) return "JPN";
    return "ENG"; 
}

function sanitizeSearchQuery(title) { 
    if (!title) return "";
    return title.replace(/\(.*?\)/g, "")
                .replace(/\[.*?\]/g, "")
                .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—～〜♥♡★☆♪]/g, " ")
                .replace(/\s{2,}/g, " ")
                .trim(); 
}

//===============
// STREMIO ADDON MANIFEST
//===============
const manifest = {
    "id": "org.community.hellyaddon",
    "version": "1.0.0",
    "name": "HellyAddon",
    "logo": BASE_URL + "/favicon.png",
    "description": "High-precision anime scraper powered by Anime Garden & Nyaa with exact title matching, season pack support, Chinese subtitles priority, and TorBox & PikPak.",
    "types": ["anime", "movie", "series"],
    "resources": [
        "catalog",
        {
            "name": "meta",
            "types": ["anime", "movie", "series"],
            "idPrefixes": ["anilist:", "helly_raw:", "nexio_raw:"]
        },
        {
            "name": "stream",
            "types": ["anime", "movie", "series"],
            "idPrefixes": ["anilist:", "nyaa:", "kitsu:", "tt", "helly_raw:", "nexio_raw:"]
        }
    ],
    "catalogs": [
        { "id": "helly_seasonal_series", "type": "anime", "name": "HellyAddon Current Season" },
        { "id": "helly_airing_series", "type": "anime", "name": "HellyAddon Currently Airing" },
        { "id": "helly_trending_series", "type": "anime", "name": "HellyAddon Trending Series" },
        { "id": "helly_top_series", "type": "anime", "name": "HellyAddon Top Rated Series" },
        { "id": "helly_trending_movie", "type": "movie", "name": "HellyAddon Trending Movies" },
        { "id": "helly_top_movie", "type": "movie", "name": "HellyAddon Top Rated Movies" },
        { "id": "helly_search", "type": "anime", "name": "HellyAddon Search", "extra": [{ "name": "search", "isRequired": true }] },
        { "id": "helly_search", "type": "movie", "name": "HellyAddon Search", "extra": [{ "name": "search", "isRequired": true }] },
        { "id": "helly_search", "type": "series", "name": "HellyAddon Series", "extra": [{ "name": "search", "isRequired": true }] }
    ],
    "config": [{ "key": "HellyAddon", "type": "text", "title": "HellyAddon Internal Payload" }],
    "behaviorHints": { "configurable": true, "configurationRequired": true }
};

const CATALOG_CONFIG_KEYS = {
    helly_seasonal_series: "showSeasonalSeries",
    helly_airing_series: "showAiringSeries",
    helly_trending_series: "showTrendingSeries",
    helly_top_series: "showTopSeries",
    helly_trending_movie: "showTrendingMovies",
    helly_top_movie: "showTopMovies",
    helly_search: "showSearchCatalog",
    nexio_seasonal_series: "showSeasonalSeries",
    nexio_airing_series: "showAiringSeries",
    nexio_trending_series: "showTrendingSeries",
    nexio_top_series: "showTopSeries",
    nexio_trending_movie: "showTrendingMovies",
    nexio_top_movie: "showTopMovies",
    nexio_search: "showSearchCatalog"
};

function configuredManifest(config) {
    const userConfig = parseConfig(config);
    const catalogs = manifest.catalogs.filter(cat => {
        const key = CATALOG_CONFIG_KEYS[cat.id];
        if (!key) return true;
        return userConfig[key] !== false;
    });
    const isConfigured = Boolean(
        (userConfig.debridServices && userConfig.debridServices.length > 0) ||
        userConfig.enableP2P
    );
    return {
        ...manifest,
        catalogs,
        behaviorHints: {
            ...manifest.behaviorHints,
            configurationRequired: !isConfigured
        }
    };
}

const builder = new addonBuilder(manifest);

//===============
// CATALOG HANDLER
//===============
builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    try {
        const userConfig = parseConfig(config);

        if ((id === "helly_seasonal_series" || id === "nexio_seasonal_series") && userConfig.showSeasonalSeries !== false) {
            const results = await getSeasonalAnime("anime");
            return { "metas": applyTitlePreference(results.filter(m => m.type === type), userConfig), "cacheMaxAge": 14400 };
        }
        if ((id === "helly_airing_series" || id === "nexio_airing_series") && userConfig.showAiringSeries !== false) {
            const results = await getAiringAnime("anime");
            return { "metas": applyTitlePreference(results.filter(m => m.type === type), userConfig), "cacheMaxAge": 14400 };
        }
        if ((id === "helly_trending_series" || id === "nexio_trending_series") && userConfig.showTrendingSeries !== false) {
            const results = await getTrendingAnime("anime");
            return { "metas": applyTitlePreference(results.filter(m => m.type === type), userConfig), "cacheMaxAge": 21600 };
        }
        if ((id === "helly_top_series" || id === "nexio_top_series") && userConfig.showTopSeries !== false) {
            const results = await getTopAnime("anime");
            return { "metas": applyTitlePreference(results.filter(m => m.type === type), userConfig), "cacheMaxAge": 86400 };
        }
        if ((id === "helly_trending_movie" || id === "nexio_trending_movie") && userConfig.showTrendingMovies !== false) {
            const results = await getTrendingAnime("movie");
            return { "metas": applyTitlePreference(results.filter(m => m.type === type), userConfig), "cacheMaxAge": 21600 };
        }
        if ((id === "helly_top_movie" || id === "nexio_top_movie") && userConfig.showTopMovies !== false) {
            const results = await getTopAnime("movie");
            return { "metas": applyTitlePreference(results.filter(m => m.type === type), userConfig), "cacheMaxAge": 86400 };
        }

        if ((id === "helly_search" || id === "nexio_search") && userConfig.showSearchCatalog !== false && extra && extra.search) {
            const query = extra.search;
            let results = await searchAnime(query);
            
            if (results && results.length > 0) {
                return { "metas": applyTitlePreference(results.filter(m => m.type === type), userConfig), "cacheMaxAge": 3600 };
            }
            
            const jikanResults = await getJikanMeta(query);
            if (jikanResults) {
                return { "metas": applyTitlePreference([jikanResults].filter(m => m.type === type), userConfig), "cacheMaxAge": 3600 };
            }

            const rawB64 = toBase64Safe(query);
            const fallbackCard = {
                "id": `helly_raw:${type}:${rawB64}`,
                "type": type,
                "name": `${query.toUpperCase()}`,
                "poster": "https://placehold.co/600x900/0a0a0c/42a5f5/png?text=" + encodeURIComponent(query.toUpperCase()) + "&font=playfair-display",
                "background": "https://placehold.co/1920x1080/0a0a0c/1a1a24/png?text=" + encodeURIComponent(query.toUpperCase()),
                "description": `🌸 Direct Tracker Search for: "${query}".`,
                "releaseInfo": "DIRECT SEARCH"
            };
            return { "metas": [fallbackCard], "cacheMaxAge": 3600 };
        }

        return { "metas": [] };
    } catch (e) {
        return { "metas": [] };
    }
});

//===============
// META HANDLER
//===============
builder.defineMetaHandler(async ({ type, id, config }) => {
    try {
        const userConfig = parseConfig(config);

        if (id.startsWith("helly_raw:") || id.startsWith("nexio_raw:")) {
            const parts = id.split(":");
            const mType = parts[1];
            const rawPayload = parts[2];
            let rawQuery = "";
            let epNum = 1;
            
            if (rawPayload && rawPayload.includes("-")) {
                let subParts = rawPayload.split("-");
                rawQuery = fromBase64Safe(subParts[0]);
                epNum = parseInt(subParts[1], 10) || 1;
            } else {
                rawQuery = fromBase64Safe(rawPayload);
            }

            const defaultCard = {
                "id": id,
                "type": mType,
                "name": `${rawQuery}`,
                "poster": "https://placehold.co/600x900/0a0a0c/42a5f5/png?text=" + encodeURIComponent(rawQuery.toUpperCase()) + "&font=playfair-display",
                "background": "https://placehold.co/1920x1080/0a0a0c/1a1a24/png?text=" + encodeURIComponent(rawQuery.toUpperCase()),
                "description": `Direct search for "${rawQuery}".`,
                "releaseInfo": "DIRECT SEARCH"
            };

            if (mType === "anime" || mType === "series") {
                defaultCard.videos = Array.from({ "length": 24 }, (_, i) => ({
                    "id": `helly_raw:${mType}:${toBase64Safe(rawQuery)}-${i + 1}`,
                    "title": `Episode ${i + 1}`,
                    "season": 1,
                    "episode": i + 1,
                    "thumbnail": defaultCard.poster
                }));
            } else if (mType === "movie") {
                defaultCard.videos = [{
                    "id": id,
                    "title": rawQuery,
                    "released": new Date().toISOString(),
                    "thumbnail": defaultCard.poster
                }];
                defaultCard.behaviorHints = { "defaultVideoId": id };
            }
            return { "meta": defaultCard, "cacheMaxAge": 86400 };
        }

        const aniListId = id.split(":")[1];
        const rawMeta = await getAnimeMeta(aniListId);
        if (!rawMeta) return { "meta": null };
        
        const meta = { ...rawMeta };
        if (userConfig.useEnglishTitles && meta.englishName) {
            meta.name = meta.englishName;
        }
        meta.id = id;

        if (meta.type === "anime" || meta.type === "series") {
            meta.type = "anime";
            const jikanEps = meta.idMal ? await fetchEpisodeDetails(meta.idMal).catch(() => ({})) : {};
            const epMeta = meta.epMeta || {};
            const defaultThumb = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/42a5f5.png?text=HELLY+EPISODE";
            meta.videos = Array.from({ "length": meta.episodes || 12 }, (_, i) => {
                const epNum = i + 1;
                const jData = jikanEps[epNum] || {};
                const epData = epMeta[epNum] || {};
                return {
                    "id": `${id}-${epNum}`,
                    "title": jData.title || epData.title || `Episode ${epNum}`,
                    "season": 1,
                    "episode": epNum,
                    "thumbnail": epData.thumbnail || defaultThumb
                };
            });
        } else if (meta.type === "movie") {
            meta.videos = [{
                "id": id,
                "title": meta.name || "Movie",
                "released": meta.released || new Date().toISOString(),
                "thumbnail": meta.poster
            }];
            meta.behaviorHints = { "defaultVideoId": id };
        }
        
        return { "meta": meta, "cacheMaxAge": 604800 };
    } catch (e) { return { "meta": null }; }
});

//===============
// STREAM HANDLER (HELLY ENGINE)
//===============
builder.defineStreamHandler(async ({ type, id, config }) => {
    try {
        console.log(`\n[HellyAddon] ===== SEARCH REQUEST =====`);
        console.log(`[HellyAddon] ID: ${id} | Type: ${type}`);

        if (!id.startsWith("anilist:") && !id.startsWith("nyaa:") && !id.startsWith("kitsu:") && !id.startsWith("tt") && !id.startsWith("helly_raw:") && !id.startsWith("nexio_raw:")) {
            return { "streams": [] };
        }

        const userConfig = parseConfig(config);
        
        if (userConfig.debridServices.length === 0 && !userConfig.enableP2P) {
            console.log("[HellyAddon] Stop: no debrid services configured and P2P disabled.");
            return { "streams": [] };
        }

        let aniListId = null;
        let requestedEp = 1;
        let expectedSeason = 1;
        let searchTitleFallback = null;
        let isRawSearch = false;

        const parts = id.split(":");

        if (id.startsWith("kitsu:")) {
            try {
                const kitsuId = parts[1];
                const kRes = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 4000 });
                searchTitleFallback = kRes.data?.data?.attributes?.canonicalTitle || kRes.data?.data?.attributes?.titles?.en_jp;
                requestedEp = parseInt(parts[2], 10) || 1;
            } catch (e) {}
        } else if (id.startsWith("helly_raw:") || id.startsWith("nexio_raw:")) {
            let rawPayload = parts[2];
            if (rawPayload && rawPayload.includes("-")) {
                let subParts = rawPayload.split("-");
                searchTitleFallback = fromBase64Safe(subParts[0]);
                requestedEp = parseInt(subParts[1], 10) || 1;
            } else {
                searchTitleFallback = fromBase64Safe(rawPayload);
                requestedEp = 1;
            }
            expectedSeason = 1;
            isRawSearch = true;
        } else if (id.startsWith("anilist:")) {
            let payload = parts[1];
            if (payload.includes("-")) {
                let subParts = payload.split("-");
                aniListId = subParts[0];
                requestedEp = parseInt(subParts[1], 10) || 1;
            } else {
                aniListId = payload;
                requestedEp = parts.length > 2 ? parseInt(parts[parts.length - 1], 10) : 1;
            }
        } else if (id.startsWith("tt")) {
            if (parts.length > 2) {
                expectedSeason = parseInt(parts[1], 10) || 1;
                requestedEp = parseInt(parts[2], 10) || 1;
            } else { requestedEp = 1; }
        }

        const metaTasks = [];
        if (id.startsWith("tt")) {
            metaTasks.push((async () => {
                const imdbId = parts[0];
                let name = "";
                try {
                    let res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 4000 });
                    name = res.data?.meta?.name;
                } catch(e) {}
                if (!name) {
                    const otherType = type === "movie" ? "series" : "movie";
                    try {
                        let res2 = await axios.get(`https://v3-cinemeta.strem.io/meta/${otherType}/${imdbId}.json`, { timeout: 4000 });
                        name = res2.data?.meta?.name;
                    } catch(e) {}
                }
                return { source: "cinemeta", name: name || "" };
            })());
        }
        if (aniListId) {
            metaTasks.push(getAnimeMeta(aniListId).then(meta => ({ "source": "anilist", "meta": meta })).catch(() => null));
        }

        const metaResults = await Promise.all(metaTasks);
        let freshMeta = null;
        metaResults.forEach(r => {
            if (!r) return;
            if (r.source === "cinemeta") searchTitleFallback = r.name;
            if (r.source === "anilist") freshMeta = r.meta;
        });

        // Translate Cinemeta / IMDb title to AniList/Bangumi to get Chinese titles
        if (id.startsWith("tt") && searchTitleFallback) {
             try {
                const extraMeta = await resolveAnimeMetaFromTitle(searchTitleFallback);
                if (extraMeta) {
                    freshMeta = extraMeta;
                }
            } catch (e) {}
        } else if (!freshMeta && searchTitleFallback && !isRawSearch) {
             try {
                const extraMeta = await resolveAnimeMetaFromTitle(searchTitleFallback);
                if (extraMeta) {
                    freshMeta = extraMeta;
                }
            } catch (e) {}
        }

        if (!freshMeta && !searchTitleFallback) {
            console.log(`[HellyAddon] Abort: No metadata found for ${id}`);
            return { "streams": [] };
        }

        // Season detection from title string if not tt
        const extractSeason = (t) => {
            const nthMatch = t.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:Season|Part|Cour)\b/i);
            if (nthMatch) return parseInt(nthMatch[1], 10);
            const m = t.match(/\b(?:S|Season|Part|Cour|Dai|Di)\s*0*(\d+)\b/i);
            if (m) return parseInt(m[1], 10);
            const cnSeason = t.match(/第\s*([0-9一二三四五六七八九十]+)\s*(?:季|期)/);
            if (cnSeason) {
                const CH_MAP = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7 };
                return CH_MAP[cnSeason[1]] || parseInt(cnSeason[1], 10);
            }
            return null;
        };

        if (!id.startsWith("tt") && !isRawSearch) {
            let detected = null;
            const sources = [searchTitleFallback, freshMeta?.name, freshMeta?.altName, ...(freshMeta?.chineseTitles || [])];
            for (let s of sources) {
                if (s) {
                    let d = extractSeason(s);
                    if (d && d > 1) {
                        detected = d;
                        break;
                    }
                }
            }
            if (detected) expectedSeason = detected;
        }

        const isMovie = type === "movie" || (freshMeta && freshMeta.format === "MOVIE");
        const rawChineseTitles = (freshMeta && Array.isArray(freshMeta.chineseTitles)) ? freshMeta.chineseTitles : [];
        const expandedChineseTitles = new Set();
        rawChineseTitles.forEach(ct => {
            if (!ct) return;
            expandedChineseTitles.add(ct);

            // Simplified and Traditional Chinese variants
            const simp = toSimplifiedChinese(ct);
            const trad = toTraditionalChinese(ct);
            if (simp) expandedChineseTitles.add(simp);
            if (trad) expandedChineseTitles.add(trad);

            // Base title without movie prefixes/suffixes
            const strippedMovie = ct.replace(/^(?:剧场版|劇場版|电影|電影)\s*/i, "")
                                    .replace(/\s*(?:剧场版|劇場版|电影|電影)$/i, "")
                                    .trim();
            if (strippedMovie && strippedMovie.length >= 2) {
                expandedChineseTitles.add(strippedMovie);
                expandedChineseTitles.add(toSimplifiedChinese(strippedMovie));
                expandedChineseTitles.add(toTraditionalChinese(strippedMovie));
            }

            // Base title without season tags
            const strippedSeason = ct.replace(/第\s*[0-9一二三四五六七八九十]+\s*(?:季|期)/g, "")
                                     .replace(/\b(?:Season\s*\d+|S\d+)\b/ig, "")
                                     .trim();
            if (strippedSeason && strippedSeason.length >= 2) {
                expandedChineseTitles.add(strippedSeason);
                expandedChineseTitles.add(toSimplifiedChinese(strippedSeason));
                expandedChineseTitles.add(toTraditionalChinese(strippedSeason));
            }

            // Common anime alias variants (e.g. Chainsaw Man 链锯人 <-> 电锯人)
            if (ct.includes("链锯人")) expandedChineseTitles.add(ct.replace(/链锯人/g, "电锯人"));
            if (ct.includes("电锯人")) expandedChineseTitles.add(ct.replace(/电锯人/g, "链锯人"));
            if (ct.includes("鏈鋸人")) expandedChineseTitles.add(ct.replace(/鏈鋸人/g, "電鋸人"));
            if (ct.includes("電鋸人")) expandedChineseTitles.add(ct.replace(/電鋸人/g, "鏈鋸人"));
            if (ct.includes("蕾塞")) {
                expandedChineseTitles.add(ct.replace(/蕾塞/g, "蕾赛"));
                expandedChineseTitles.add(ct.replace(/蕾塞/g, "蕾潔"));
            }
            if (ct.includes("蕾赛")) {
                expandedChineseTitles.add(ct.replace(/蕾赛/g, "蕾塞"));
                expandedChineseTitles.add(ct.replace(/蕾赛/g, "蕾潔"));
            }
            if (ct.includes("蕾潔")) {
                expandedChineseTitles.add(ct.replace(/蕾潔/g, "蕾塞"));
                expandedChineseTitles.add(ct.replace(/蕾潔/g, "蕾赛"));
            }
        });

        // Also apply alias substitutions on base stripped titles
        Array.from(expandedChineseTitles).forEach(ct => {
            if (ct.includes("链锯人")) expandedChineseTitles.add(ct.replace(/链锯人/g, "电锯人"));
            if (ct.includes("电锯人")) expandedChineseTitles.add(ct.replace(/电锯人/g, "链锯人"));
            if (ct.includes("蕾塞")) {
                expandedChineseTitles.add(ct.replace(/蕾塞/g, "蕾赛"));
                expandedChineseTitles.add(ct.replace(/蕾塞/g, "蕾潔"));
            }
        });

        const chineseTitles = Array.from(expandedChineseTitles);
        const seasonOffset = (freshMeta && Number.isFinite(freshMeta.seasonOffset)) ? freshMeta.seasonOffset : 0;
        const absoluteEp = seasonOffset + requestedEp;

        console.log(`[HellyAddon] Show: "${freshMeta?.name || searchTitleFallback}" | Chinese: [${chineseTitles.join(", ")}] | Season: ${expectedSeason} | Ep: ${requestedEp} (Abs: ${absoluteEp}) | Movie: ${isMovie}`);

        // Canonical title collection for exact matching
        const allCanonicalTitles = [
            ...chineseTitles,
            freshMeta?.name,
            freshMeta?.englishName,
            freshMeta?.nativeName,
            freshMeta?.altName,
            searchTitleFallback,
            ...(Array.isArray(freshMeta?.synonyms) ? freshMeta.synonyms : [])
        ].filter(Boolean);

        // Build search queries for external trackers
        const titleList = [];
        chineseTitles.forEach(t => titleList.push(sanitizeSearchQuery(t)));
        if (searchTitleFallback) titleList.push(sanitizeSearchQuery(searchTitleFallback));
        if (freshMeta?.name) titleList.push(sanitizeSearchQuery(freshMeta.name));
        if (freshMeta?.englishName) titleList.push(sanitizeSearchQuery(freshMeta.englishName));

        const uniqueTitles = [...new Set(titleList.filter(Boolean))];
        const searchQueries = new Set();
        
        uniqueTitles.forEach(t => {
            const stripped = t.replace(/\b(?:\d+(?:st|nd|rd|th)\s+(?:Season|Part|Cour)|Season\s*\d+|S\d+|Part\s*\d+|Cour\s*\d+|Episode\s*\d+|Ep\s*\d+)\b/ig, "")
                              .replace(/第\s*\d+\s*(?:季|期|기|話|话|集)/g, "")
                              .replace(/\s{2,}/g, " ").trim();
            if (stripped.length > 2) searchQueries.add(stripped);
            searchQueries.add(t);
        });

        const sortedQueries = Array.from(searchQueries).sort((a, b) => b.length - a.length);

        // Fetcher cascade
        const fetchAllPossibleTorrents = async () => {
            const epStr = requestedEp < 10 ? `0${requestedEp}` : `${requestedEp}`;
            const sStr = expectedSeason < 10 ? `0${expectedSeason}` : `${expectedSeason}`;
            const absEpStr = absoluteEp && absoluteEp !== requestedEp ? (absoluteEp < 10 ? `0${absoluteEp}` : `${absoluteEp}`) : null;
            const deduplicated = new Map();
            let isTrackerBlocked = false; 

            const addTorrents = (arr) => {
                if (!Array.isArray(arr)) return;
                for (const t of arr) {
                    if (t && t.hash) {
                        deduplicated.set(t.hash.toLowerCase(), t);
                    }
                }
            };

            // 1. PRIMARY SOURCE: ANIME GARDEN
            if (userConfig.enableAnimeGarden !== false) {
                try {
                    const gardenResults = await searchAnimeGardenForAnime({
                        chineseTitles,
                        romajiTitles: [freshMeta?.name, searchTitleFallback].filter(Boolean),
                        englishTitles: [freshMeta?.englishName].filter(Boolean),
                        requestedEp,
                        expectedSeason,
                        isMovie,
                        absoluteEp,
                        subjectId: freshMeta?.subjectId || null
                    });
                    addTorrents(gardenResults);
                    console.log(`[HellyAddon] Anime Garden returned ${gardenResults.length} items (Total deduplicated: ${deduplicated.size})`);
                } catch (e) {
                    console.error("[HellyAddon] Anime Garden error:", e.message);
                }
            }

            // If Anime Garden already returned sufficient results, return early for instant response
            if (deduplicated.size >= 5) {
                return { torrentsArr: Array.from(deduplicated.values()) };
            }

            // 2. SECONDARY SOURCE: NYAA (Fallback if Anime Garden has few results)
            if (userConfig.enableNyaa !== false) {
                const runTask = async (queryFn) => {
                    const startTime = Date.now();
                    try {
                        const res = await queryFn();
                        addTorrents(res);
                    } catch (e) {}
                    const duration = Date.now() - startTime;
                    if (duration > 11000 && deduplicated.size === 0) {
                        isTrackerBlocked = true;
                    }
                };

                let isFirstTitle = true;
                for (const title of sortedQueries) {
                    if (deduplicated.size >= 50 || isTrackerBlocked) break;

                    if (isMovie) {
                        await runTask(() => enqueueScrape(() => searchNyaaForAnime(`${title}`)));
                    } else {
                        await runTask(() => enqueueScrape(() => searchNyaaForAnime(`${title} ${epStr}`)));
                        if (isTrackerBlocked) break; 
                        
                        if (deduplicated.size < 15) {
                            await runTask(() => enqueueScrape(() => searchNyaaForAnime(`${title} S${sStr}E${epStr}`)));
                        }
                        if (isTrackerBlocked) break;

                        if (absEpStr && deduplicated.size < 15) {
                            await runTask(() => enqueueScrape(() => searchNyaaForAnime(`${title} ${absEpStr}`)));
                        }
                        if (isTrackerBlocked) break;
                        
                        if (isFirstTitle) {
                            await runTask(() => enqueueScrape(() => searchNyaaForAnime(`${title} Batch`)));
                            if (isTrackerBlocked) break;
                            
                            if (expectedSeason > 1) {
                                await runTask(() => enqueueScrape(() => searchNyaaForAnime(`${title} S${sStr}`)));
                            }
                        }
                    }
                    isFirstTitle = false;
                }
            }

            return { torrentsArr: Array.from(deduplicated.values()) };
        };

        const mediaKey = buildMediaKey({
            type,
            id,
            expectedSeason,
            requestedEp,
            isMovie,
            isRawSearch
        });

        const torrentResult = await getTorrentsForStream({
            mediaKey,
            scrape: fetchAllPossibleTorrents
        });
        let torrents = torrentResult.torrents;

        if (torrentResult.source === "wait" && !torrents.length) {
            return {
                streams: [
                    {
                        name: "🌸 HELLY [INFO]\nCache warming",
                        description: "First scrape is running. Try this episode again in a few seconds.",
                        url: BASE_URL + "/waiting.mp4"
                    }
                ],
                cacheMaxAge: 15
            };
        }

        //===============
        // CLEANUP FILTER: Drop OST, Manga, Artbooks, Cosplay, Music
        //===============
        torrents = torrents.filter(t => {
            if (!isRawSearch && /\b(?:Soundtrack|OST|MP3|CD|Manga|Light Novel|LN|Artbook|Doujinshi|同人誌|同人CG集|Pictures|Images|Novel|Cosplay|Music|单曲|专辑|广播剧)\b/i.test(t.title)) {
                return false;
            }
            if (t.category && (t.category === "音乐" || t.category === "漫画" || t.category === "日剧")) {
                return false;
            }
            return true;
        });

        //===============
        // EXACT TITLE MATCHING FILTER
        // Checks candidate title against canonical multi-lingual titles
        //===============
        if (!isRawSearch && allCanonicalTitles.length > 0) {
            torrents = torrents.filter(t => {
                return verifyExactTitleMatch(t.title, allCanonicalTitles);
            });
        }

        //===============
        // CANONICAL-GATE FILTER (format, year, distance)
        //===============
        if (!isRawSearch && freshMeta && torrents.length > 0) {
            const canonical = {
                format: freshMeta.format || (isMovie ? "MOVIE" : null),
                year: Number.isFinite(freshMeta.year) ? freshMeta.year : null,
                episodeCount: Number.isFinite(freshMeta.episodes) ? freshMeta.episodes : null,
                mainTitle: freshMeta.name || null,
                englishTitle: freshMeta.englishName || null,
                altName: freshMeta.altName || null,
                nativeName: freshMeta.nativeName || null,
                synonyms: [...(freshMeta.synonyms || []), ...chineseTitles]
            };
            const { kept, dropped } = await filterByCanonical({
                canonical,
                torrents,
                opts: { preferDub: false, requestedEpisode: requestedEp, expectedSeason }
            });
            if (dropped && dropped.length > 0 && process.env.DEBUG_MATCH) {
                console.log(`[HellyAddon] Canonical filter dropped ${dropped.length} torrents:`, dropped.map(d => `${d.torrent.title} -> ${d.gateFailures.join(", ")}`));
            }
            torrents = kept;
            if (!torrents.length) {
                console.log(`[HellyAddon] Warning: All torrents rejected by canonical filter for ${id} (${freshMeta.name})`);
                return { "streams": [], "cacheMaxAge": 60 };
            }
        }

        //===============
        // STRICT SEASON GATE
        // Discards torrents explicitly specifying wrong seasons
        //===============
        if (!isMovie && !isRawSearch) {
            torrents = torrents.filter(t => {
                return !isWrongSeason(t.title, expectedSeason);
            });
        }

        //===============
        // EPISODE & SEASON PACK COMPATIBILITY
        //===============
        if (!isMovie && !isRawSearch) {
            torrents = torrents.filter(t => {
                const isBatch = isSeasonBatch(t.title, expectedSeason, requestedEp, absoluteEp);
                return isBatch || isEpisodeMatch(t.title, requestedEp, expectedSeason, absoluteEp);
            });
        }

        //===============
        // RESOLUTION FILTER
        //===============
        const allowedResolutions = Array.isArray(userConfig.resolutions) && userConfig.resolutions.length > 0 
            ? userConfig.resolutions 
            : ["8K", "4K", "2K", "1080p", "720p", "480p", "SD"];

        torrents = torrents.filter(t => {
            const { res } = extractTags(t.title);
            return allowedResolutions.includes(res);
        });

        //===============
        // STRICT CHINESE FILTER (If enabled by user)
        //===============
        if (userConfig.strictChinese) {
            torrents = torrents.filter(t => {
                const sub = detectChineseSubtitle(t.title, t.fansub);
                return sub.hasChinese === true;
            });
        }

        if (!torrents.length) return { "streams": [], "cacheMaxAge": 60 };

        torrents = dedupeTorrentsByExactSize(torrents);

        // Check availability with TorBox, PikPak, etc.
        const hashes = torrents.map(t => t.hash.toLowerCase());
        const availabilityByEntry = await Promise.all(
            userConfig.debridServices.map(entry =>
                checkStoreTorzWithCache(hashes, entry, {
                    scope: { season: expectedSeason, episode: requestedEp }
                }).catch(error => {
                    console.error(`[HellyAddon] ${entry.service} availability check error: ${error.message}`);
                    return {};
                })
            )
        );
        const hellyPayload = encodeConfigPayload(userConfig);

        const flags = {
            "CHI_SIMP": "🇨🇳",
            "CHI_TRAD": "🇭🇰",
            "CHI_DUAL": "🌍",
            "CHI": "🇨🇳",
            "GER": "🇩🇪", "ITA": "🇮🇹", "FRE": "🇫🇷", "SPA": "🇪🇸",
            "LAT": "💃🏻", "RUS": "🇷🇺", "POR": "🇵🇹", "ARA": "🇸🇦",
            "KOR": "🇰🇷", "HIN": "🇮🇳", "POL": "🇵🇱", "NLD": "🇳🇱",
            "TUR": "🇹🇷", "VIE": "🇻🇳", "IND": "🇮🇩", "JPN": "🇯🇵",
            "ENG": "🇬🇧", "MULTI": "🌍"
        };
        const userLangs = Array.isArray(userConfig.language) ? userConfig.language : [userConfig.language || "CHI_SIMP"];

        const streams = [];

        // Build P2P streams if enabled
        if (userConfig.enableP2P) {
            torrents.forEach(t => {
                const { res } = extractTags(t.title);
                const bytes = parseSizeToBytes(t.size);
                const streamLang = extractLanguage(t.title, userLangs);
                const seeders = parseInt(t.seeders, 10) || 0;
                const isBatch = isSeasonBatch(t.title, expectedSeason, requestedEp, absoluteEp);

                const parsedForP2P = buildParsedFromTitle(t.title, res, streamLang, isBatch, null);
                const p2pStream = buildP2PStream({
                    torrent: t,
                    parsed: parsedForP2P,
                    canonical: freshMeta || null,
                    requestedEp,
                    expectedSeason,
                    anilistId: aniListId || null,
                    streamLang,
                    seeders,
                    bytes,
                    isBatch,
                    isMovie
                });
                streams.push(p2pStream);
            });
        }

        const canonicalForFormatter = freshMeta ? {
            ...freshMeta,
            anilistId: aniListId || (freshMeta.id ? String(freshMeta.id).replace(/^anilist:/, "") : null)
        } : { anilistId: aniListId || null };

        const debridStreams = buildDebridStreams({
            torrents,
            availabilityByEntry,
            userConfig,
            nexioPayload: hellyPayload,
            baseUrl: BASE_URL,
            requestedEp,
            expectedSeason,
            absoluteEp,
            isMovie,
            isRawSearch,
            flags,
            extractTags,
            extractLanguage,
            parseSizeToBytes,
            selectBestVideoFile,
            isEpisodeMatch,
            isSeasonBatch,
            canonical: canonicalForFormatter
        });
        streams.push(...debridStreams);

        console.log(`[HellyAddon] Final streams built: ${streams.length}\n`);

        //===============
        // 4-PHASE HIGH PRECISION SORTER
        // Cached -> Chinese Subtitles -> Language Preference -> Resolution -> Seeders/Size
        //===============
        return { 
            "streams": streams.sort((a, b) => {
                if (a._prog > 0 && b._prog === 0) return -1;
                if (b._prog > 0 && a._prog === 0) return 1;
                if (a._isCached !== b._isCached) return b._isCached ? 1 : -1;

                // Priority for Chinese subtitles
                const isChnA = typeof a._lang === "string" && a._lang.startsWith("CHI");
                const isChnB = typeof b._lang === "string" && b._lang.startsWith("CHI");
                if (userConfig.preferChinese && isChnA !== isChnB) {
                    return isChnA ? -1 : 1;
                }

                // Language Matrix Score
                const getLangScore = (l) => {
                    if (userLangs.includes(l)) return 300 - (userLangs.indexOf(l) * 10);
                    if (l === "CHI_DUAL" || l === "CHI_SIMP" || l === "CHI_TRAD" || l === "CHI") return 250;
                    if (l === "MULTI") return 150;
                    if (l === "ENG") return 100;
                    return 0;
                };
                const langScoreA = getLangScore(a._lang);
                const langScoreB = getLangScore(b._lang);
                if (langScoreA !== langScoreB) return langScoreB - langScoreA;

                // Resolution Score
                const resMap = { "8K": 8, "4K": 4, "2K": 2, "1080p": 1, "720p": 0.5, "480p": 0.25, "SD": 0 };
                const resScoreA = resMap[a._res] || 0;
                const resScoreB = resMap[b._res] || 0;
                if (resScoreA !== resScoreB) return resScoreB - resScoreA;

                const aBatch = a._isBatch && (a._seeders > 0 || a._isCached) ? 1 : 0;
                const bBatch = b._isBatch && (b._seeders > 0 || b._isCached) ? 1 : 0;
                if (aBatch !== bBatch) return bBatch - aBatch;

                if (!a._isCached && !b._isCached) {
                    if (a._seeders !== b._seeders) return b._seeders - a._seeders;
                }

                return b._bytes - a._bytes;
            }), 
            "cacheMaxAge": 3600 
        };
    } catch (err) {
        console.error("[HellyAddon] Stream handler error:", err);
        return { "streams": [] };
    }
});

module.exports = { "addonInterface": builder.getInterface(), configuredManifest, manifest, parseConfig };
