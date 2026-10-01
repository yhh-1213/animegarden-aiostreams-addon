//===============
// NEXIO TORII METADATA PROVIDER - ANILIST & MYANIMELIST (JIKAN)
// This module handles all metadata requests for the add-on.
//===============

const axios = require("axios");
const fuzz = require("fuzzball");
const { extractSeasonNumber } = require("./parser");

const ANILIST_URL = "https://graphql.anilist.co";

function toBase64Safe(str) {
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

//===============
// CACHE & RATE LIMITING CONFIGURATION
//===============
const apiCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function setLRUCache(key, dataOrPromise) {
    if (apiCache.has(key)) {
        apiCache.delete(key);
    } else if (apiCache.size >= MAX_CACHE_ENTRIES) {
        apiCache.delete(apiCache.keys().next().value);
    }
    apiCache.set(key, { timestamp: Date.now(), data: dataOrPromise });
}

function getLRUCache(key) {
    if (apiCache.has(key)) {
        const item = apiCache.get(key);
        if (Date.now() - item.timestamp < CACHE_TTL) {
            apiCache.delete(key);
            apiCache.set(key, item);
            return item.data;
        } else {
            apiCache.delete(key);
        }
    }
    return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatDescription(anime) {
    let text = anime.description || anime.synopsis || "No description available.";
    text = text.replace(/~![\s\S]*?!~/g, "[Spoiler removed]");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<[^>]*>?/gm, "");
    text = text.replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#039;/g, "\"").replace(/&mdash;/g, "—");
    text = text.replace(/\[Written by MAL Rewrite\]/gi, "").trim();
    text = text.replace(/\r/g, "");
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    let header = [];
    if (anime.format) header.push("📺 Format: " + anime.format);
    if (anime.status) header.push("📌 Status: " + anime.status.replace(/_/g, " "));
    if (anime.releaseDate) header.push("📅 Released: " + anime.releaseDate);
    
    if (anime.averageScore) {
        let finalScore = parseInt(anime.averageScore);
        if (finalScore > 100) finalScore = Math.round(finalScore / 10);
        if (finalScore > 100) finalScore = 100;
        header.push("⭐️ Score: " + finalScore + "%");
    }
    
    if (header.length > 0) return header.join(" | ") + "\n\n" + text;
    return text;
}

async function _fetchAniList(query, variables, retries = 3) {
    const cacheKey = "anilist_" + JSON.stringify(variables || {});
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await axios.post(ANILIST_URL, { query, variables }, { timeout: 6000 });
                if (!response.data || !response.data.data || !response.data.data.Page) {
                    apiCache.delete(cacheKey);
                    return [];
                }
                
                const results = response.data.data.Page.media.map(anime => {
                    const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
                    const englishTitle = anime.title.english || anime.title.romaji || "Unknown";
                    
                    const year = anime.startDate?.year || anime.seasonYear;
                    const month = anime.startDate?.month;
                    const day = anime.startDate?.day;
                    
                    const releaseDateStr = year ? (month ? month.toString().padStart(2, "0") + "/" + year : "" + year) : null;
                    const releaseInfo = year ? "" + year : undefined;
                    const released = year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).toISOString() : undefined;
                    
                    let epCount = anime.episodes;
                    if (!epCount && anime.nextAiringEpisode && anime.nextAiringEpisode.episode) {
                        epCount = anime.nextAiringEpisode.episode - 1;
                    }
                    if (!epCount || epCount < 1) epCount = 1;

                    const stremioType = anime.format === "MOVIE" ? "movie" : "anime";

                    return {
                        id: "anilist:" + anime.id,
                        type: stremioType, 
                        name: cleanTitle,
                        englishName: englishTitle,
                        poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                        background: anime.bannerImage || "",
                        description: formatDescription({ ...anime, releaseDate: releaseDateStr }),
                        releaseInfo: releaseInfo,
                        released: released,
                        episodes: epCount
                    };
                });
                setLRUCache(cacheKey, results);
                return results;
            } catch (error) {
                const status = error.response ? error.response.status : "Network";
                console.error("[AniList] Fetch Error (Attempt " + (attempt + 1) + "/" + retries + "): Status " + status);
                if (attempt < retries - 1) await sleep((status === 429) ? 2000 * (attempt + 1) : 1000);
            }
        }
        apiCache.delete(cacheKey);
        return [];
    })();
    setLRUCache(cacheKey, fetchPromise);
    return fetchPromise;
}

async function searchAnime(query) {
    if (!query || query.length < 3) return [];
    const graphqlQuery = `
        query ($search: String) { 
            Page(page: 1, perPage: 50) { 
                media(search: $search, type: ANIME, isAdult: false) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { search: query });
}

function generateRomajiVariants(title, isMovie = false) {
    const variants = new Set();
    if (!title || typeof title !== "string") return [];

    const clean = title.replace(/[,:;!?'"~`\-_]/g, " ").replace(/\s+/g, " ").trim();
    if (clean && clean !== title) variants.add(clean);

    // Hepburn vowel variations: o <-> ou
    const ouVariant = clean.replace(/\b(t|sh|k|ky|ry|j|ch|s|n|m|h|hy|b|by|p|py|g|gy|d|z)o([bcdfghjklmnpqrstvwxyz])/gi, "$1ou$2");
    if (ouVariant && ouVariant !== clean) variants.add(ouVariant);

    const oVariant = clean.replace(/\b(t|sh|k|ky|ry|j|ch|s|n|m|h|hy|b|by|p|py|g|gy|d|z)ou([bcdfghjklmnpqrstvwxyz])/gi, "$1o$2");
    if (oVariant && oVariant !== clean) variants.add(oVariant);

    // Only truncate to first 4 words for long series titles if NOT a movie
    if (!isMovie) {
        const words = clean.split(" ");
        if (words.length > 3) {
            const shortClean = words.slice(0, 4).join(" ");
            variants.add(shortClean);
            const shortOu = shortClean.replace(/\b(t|sh|k|ky|ry|j|ch|s|n|m|h|hy|b|by|p|py|g|gy|d|z)o([bcdfghjklmnpqrstvwxyz])/gi, "$1ou$2");
            if (shortOu && shortOu !== shortClean) variants.add(shortOu);
        }
    }

    return Array.from(variants);
}

async function searchKitsuForTitles(query) {
    if (!query) return null;
    const cacheKey = "kitsu_" + query.toLowerCase().trim();
    const cached = getLRUCache(cacheKey);
    if (cached) return cached;

    try {
        const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=3`;
        const res = await axios.get(url, { timeout: 4000 });
        const items = res.data?.data || [];
        for (const item of items) {
            const attr = item.attributes || {};
            const titles = attr.titles || {};
            if (titles.ja_jp || titles.en_jp || attr.canonicalTitle) {
                const result = {
                    ja: titles.ja_jp || null,
                    romaji: titles.en_jp || attr.canonicalTitle || null,
                    english: titles.en || null
                };
                setLRUCache(cacheKey, result);
                return result;
            }
        }
    } catch (e) {}
    return null;
}

async function searchAnimeSmart(query, options = {}) {
    if (!query || query.length < 2) return [];

    // 1. Direct AniList search
    let results = await searchAnime(query);
    if (results && results.length > 0) return results;

    // 2. Try Romaji variants (vowel normalization & stripped punctuation)
    const variants = generateRomajiVariants(query, options.isMovie);
    for (const v of variants) {
        results = await searchAnime(v);
        if (results && results.length > 0) return results;
    }

    // 3. Fallback to Kitsu to find canonical Japanese / Romaji title
    const kitsuTitles = await searchKitsuForTitles(query);
    if (kitsuTitles) {
        if (kitsuTitles.ja) {
            results = await searchAnime(kitsuTitles.ja);
            if (results && results.length > 0) return results;
        }
        if (kitsuTitles.romaji) {
            results = await searchAnime(kitsuTitles.romaji);
            if (results && results.length > 0) return results;
        }
    }

    return [];
}

async function resolveAnimeMetaFromTitle(searchTitle, options = {}) {
    if (!searchTitle) return null;
    const isMovie = Boolean(options.isMovie || options.type === "movie" || options.format === "MOVIE");
    const targetYear = options.year ? parseInt(options.year, 10) : null;
    const expectedSeason = options.expectedSeason || options.season || 1;

    // 1. Smart AniList search (with Romaji variants & Kitsu bridge)
    const searchResults = await searchAnimeSmart(searchTitle, { isMovie });
    if (searchResults && searchResults.length > 0) {
        const scoredCandidates = [];

        for (const candidate of searchResults.slice(0, 10)) {
            const matchedId = candidate.id.split(":")[1];
            const extraMeta = await getAnimeMeta(matchedId);
            if (!extraMeta) continue;

            let score = 0;

            if (isMovie) {
                // When searching for a movie, reject multi-episode TV series
                if (extraMeta.format === "TV" && (extraMeta.episodes > 1 || extraMeta.episodes === null)) {
                    continue;
                }
                // Reject if year differs significantly (> 4 years)
                if (targetYear && extraMeta.year && Math.abs(extraMeta.year - targetYear) > 4) {
                    continue;
                }
                if (extraMeta.format === "MOVIE") score += 60;
            } else {
                // TV series preference
                if (extraMeta.format === "TV") score += 40;
                else if (extraMeta.format === "ONA") score += 10;
                else if (extraMeta.format === "SPECIAL" || extraMeta.format === "OVA") score += 5;
                else if (extraMeta.format === "MOVIE") score -= 50;

                // Season matching
                const candidateSeason = extractSeasonNumber(extraMeta.name) || extractSeasonNumber(extraMeta.englishName || "");
                if (expectedSeason > 1) {
                    if (candidateSeason === expectedSeason) {
                        score += 60;
                    } else if (candidateSeason && candidateSeason !== expectedSeason) {
                        score -= 50;
                    }
                } else {
                    if (!candidateSeason || candidateSeason === 1) {
                        score += 30;
                    } else {
                        score -= 50;
                    }
                }
            }

            // Title similarity
            const t1 = extraMeta.englishName || extraMeta.name;
            const ratio = fuzz.token_set_ratio(searchTitle, t1);
            score += Math.round(ratio * 0.5);

            // Spin-off / Mini-anime penalty when not requested in search title
            const isSpinoff = /ミニアニメ|mini anime|chibi|●●|break time|picture drama|gekijo|sanpo/i.test(
                extraMeta.name + " " + (extraMeta.altName || "") + " " + (extraMeta.chineseTitles || []).join(" ")
            );
            if (isSpinoff && !/mini|chibi|●●/i.test(searchTitle)) {
                score -= 60;
            }

            scoredCandidates.push({ extraMeta, score });
        }

        if (scoredCandidates.length > 0) {
            scoredCandidates.sort((a, b) => b.score - a.score);
            if (scoredCandidates[0].score > 0) {
                return scoredCandidates[0].extraMeta;
            }
        }
    }

    // 2. Bangumi Subject lookup fallback with candidate scoring
    const variants = new Set();
    variants.add(searchTitle);

    let subtitle = null;
    const subMatch = searchTitle.match(/[:\-–—]\s*(.+)$/);
    if (subMatch && subMatch[1].trim().length >= 3) {
        subtitle = subMatch[1].trim();
        variants.add(subtitle);
    }

    const noMovie = searchTitle.replace(/\b(?:the\s+)?movie:?\s*/i, "").trim();
    if (noMovie && noMovie !== searchTitle) variants.add(noMovie);

    generateRomajiVariants(searchTitle, isMovie).forEach(v => variants.add(v));

    try {
        const kitsu = await searchKitsuForTitles(searchTitle);
        if (kitsu) {
            if (kitsu.romaji) {
                variants.add(kitsu.romaji);
                const kSub = kitsu.romaji.match(/[:\-–—]\s*(.+)$/);
                if (kSub && kSub[1].trim().length >= 3) variants.add(kSub[1].trim());
            }
            if (kitsu.ja) variants.add(kitsu.ja);
        }
    } catch (e) {}

    const candidates = [];
    for (const v of variants) {
        const bgmItems = await searchBangumiSubjects(v);
        for (const item of bgmItems) {
            if (!item.name_cn && !item.name) continue;
            let score = 0;
            const itemTitle = (item.name + " " + (item.name_cn || "")).toLowerCase();
            const itemYear = item.date ? parseInt(item.date.slice(0, 4), 10) : null;

            if (isMovie) {
                if (item.platform === "剧场版") score += 30;
                else if (/剧场版|劇場版|movie|电影/i.test(itemTitle)) score += 20;
                else if (item.eps === 1) score += 10;
                else if (item.eps > 1) score -= 50;
            } else {
                if (item.platform === "剧场版") score -= 50;
                const bgmSeason = extractSeasonNumber(item.name) || extractSeasonNumber(item.name_cn || "");
                if (expectedSeason > 1) {
                    if (bgmSeason === expectedSeason) score += 60;
                    else if (bgmSeason && bgmSeason !== expectedSeason) score -= 50;
                } else {
                    if (!bgmSeason || bgmSeason === 1) score += 30;
                    else score -= 50;
                }
                const isSpinoff = /ミニアニメ|mini anime|chibi|●●|break time|picture drama|gekijo|sanpo/i.test(itemTitle);
                if (isSpinoff && !/mini|chibi|●●/i.test(searchTitle)) {
                    score -= 60;
                }
            }

            if (subtitle && itemTitle.includes(subtitle.toLowerCase())) {
                score += 40;
            }

            if (targetYear && itemYear) {
                const diff = Math.abs(targetYear - itemYear);
                if (diff === 0) score += 25;
                else if (diff <= 1) score += 10;
                else score -= diff * 5;
            }

            candidates.push({ item, score, itemYear });
        }
    }

    if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0].item;
        if (best && (best.name_cn || best.name)) {
            const chineseTitles = [];
            if (best.name_cn) chineseTitles.push(best.name_cn);
            if (best.name && /[^\x00-\x7F]/.test(best.name) && best.name !== best.name_cn) {
                chineseTitles.push(best.name);
            }

            return {
                id: "bgm:" + best.id,
                name: best.name || searchTitle,
                englishName: searchTitle,
                nativeName: best.name,
                chineseTitles,
                name_cn: best.name_cn,
                subjectId: best.id,
                format: isMovie ? "MOVIE" : (best.platform === "剧场版" ? "MOVIE" : "TV"),
                year: best.date ? parseInt(best.date.slice(0, 4), 10) : targetYear,
                episodes: isMovie ? 1 : (best.eps || 12),
                isMovie: Boolean(isMovie || best.platform === "剧场版")
            };
        }
    }

    return null;
}

//===============
// STREMIO CATALOG FILTER
//===============
async function getTrendingAnime(stremioType = "anime") {
    const formats = stremioType === "movie" ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"];
    const graphqlQuery = `
        query ($sort: [MediaSort], $formats: [MediaFormat]) { 
            Page(page: 1, perPage: 40) { 
                media(type: ANIME, isAdult: false, sort: $sort, format_in: $formats) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { sort: ["TRENDING_DESC"], formats });
}

async function getTopAnime(stremioType = "anime") {
    const formats = stremioType === "movie" ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"];
    const graphqlQuery = `
        query ($sort: [MediaSort], $formats: [MediaFormat]) { 
            Page(page: 1, perPage: 40) { 
                media(type: ANIME, isAdult: false, sort: $sort, format_in: $formats) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { sort: ["SCORE_DESC"], formats });
}

//===============
// PARALLEL AIRING FETCH
//===============
async function getAiringAnime(stremioType = "anime") {
    const formats = stremioType === "movie" ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA"];
    const graphqlQuery = `
        query ($page: Int, $sort: [MediaSort], $formats: [MediaFormat], $status: MediaStatus) { 
            Page(page: $page, perPage: 50) { 
                media(type: ANIME, isAdult: false, sort: $sort, format_in: $formats, status: $status) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;

    const [page1, page2] = await Promise.all([
        _fetchAniList(graphqlQuery, { page: 1, sort: ["POPULARITY_DESC"], formats: formats, status: "RELEASING" }),
        _fetchAniList(graphqlQuery, { page: 2, sort: ["POPULARITY_DESC"], formats: formats, status: "RELEASING" })
    ]);

    const combined = [...page1, ...page2];
    const unique = Array.from(new Map(combined.map(item => [item.id, item])).values());
    
    return unique;
}

//===============
// CURRENT SEASON DYNAMIC CALCULATOR
//===============
function getCurrentSeasonInfo() {
    const month = new Date().getMonth(); // 0-11
    let year = new Date().getFullYear();
    let season = "WINTER";

    if (month >= 2 && month <= 4) { season = "SPRING"; }
    else if (month >= 5 && month <= 7) { season = "SUMMER"; }
    else if (month >= 8 && month <= 10) { season = "FALL"; }
    else { 
        season = "WINTER"; 
        // In Anime, December counts towards the upcoming year's Winter season
        if (month === 11) year += 1;
    }

    return { season, year };
}

async function getSeasonalAnime(stremioType = "anime") {
    const formats = stremioType === "movie" ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA"];
    const { season, year } = getCurrentSeasonInfo();

    const graphqlQuery = `
        query ($page: Int, $sort: [MediaSort], $formats: [MediaFormat], $season: MediaSeason, $seasonYear: Int) { 
            Page(page: $page, perPage: 50) { 
                media(type: ANIME, isAdult: false, sort: $sort, format_in: $formats, season: $season, seasonYear: $seasonYear) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;

    const [page1, page2] = await Promise.all([
        _fetchAniList(graphqlQuery, { page: 1, sort: ["POPULARITY_DESC"], formats: formats, season: season, seasonYear: year }),
        _fetchAniList(graphqlQuery, { page: 2, sort: ["POPULARITY_DESC"], formats: formats, season: season, seasonYear: year })
    ]);

    const combined = [...page1, ...page2];
    const unique = Array.from(new Map(combined.map(item => [item.id, item])).values());
    
    return unique;
}

async function searchBangumiSubjects(keyword) {
    if (!keyword) return [];
    const cleanKey = String(keyword).toLowerCase().trim();
    const cacheKey = "bgm_search_" + cleanKey;
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    try {
        const response = await axios.post("https://api.bgm.tv/v0/search/subjects", {
            keyword: cleanKey,
            filter: { type: [2] }
        }, {
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "HellyAddon/1.0"
            },
            timeout: 5000
        });

        const rawList = response.data?.data || [];
        if (rawList.length > 0) {
            const items = rawList.map(item => ({
                id: item.id,
                name: item.name,
                name_cn: item.name_cn || null,
                eps: item.eps || null,
                platform: item.platform || null,
                date: item.date || null
            }));
            setLRUCache(cacheKey, items);
            return items;
        }
    } catch (e) {}

    try {
        const legacy = await axios.get(`https://api.bgm.tv/search/subject/${encodeURIComponent(cleanKey)}?type=2`, {
            headers: { "User-Agent": "HellyAddon/1.0" },
            timeout: 5000
        });
        const rawList = legacy.data?.list || [];
        if (rawList.length > 0) {
            const items = rawList.map(item => ({
                id: item.id,
                name: item.name,
                name_cn: item.name_cn || null,
                eps: item.eps || null,
                platform: null,
                date: item.air_date || null
            }));
            setLRUCache(cacheKey, items);
            return items;
        }
    } catch (e) {}

    return [];
}

async function getBangumiSubject(keyword, options = {}) {
    if (!keyword) return null;
    const cleanKey = String(keyword).replace(/[–—\-·•:：]/g, " ").replace(/\s+/g, " ").trim();
    let items = await searchBangumiSubjects(cleanKey);
    if (!items.length && cleanKey !== keyword) {
        items = await searchBangumiSubjects(keyword);
    }
    if (!items.length) return null;

    const expectedEps = options.episodes || null;
    const expectedFormat = options.format || "TV";

    const scored = items.map(item => {
        let score = 0;
        const itemTitle = (item.name || "") + " " + (item.name_cn || "");

        // Penalize promos, collabs, games, commercials
        if (/\b(?:PUBG|collab|mobile|game|commercial|cm)\b|绝地求生|联动|宣传片|特别篇/i.test(itemTitle)) {
            score -= 80;
        }

        // Format
        if (expectedFormat === "TV") {
            if (item.platform === "TV") score += 40;
            else if (item.platform === "剧场版") score -= 50;
            else if (item.platform === "WEB" || item.platform === "OVA") score -= 20;
        } else if (expectedFormat === "MOVIE") {
            if (item.platform === "剧场版") score += 50;
            else if (item.platform === "TV") score -= 50;
        }

        // Episode count
        if (expectedEps && item.eps) {
            if (item.eps === expectedEps) score += 60;
            else if (Math.abs(item.eps - expectedEps) <= 3) score += 40;
            else if (expectedEps > 10 && item.eps === 1) score -= 60;
        }

        // Similarity
        const ratio = fuzz.token_set_ratio(cleanKey, item.name || "");
        score += Math.round(ratio * 0.4);

        return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0].item : items[0];
}

async function getAnimeMeta(anilistId, retries = 3) {
    const cacheKey = "anilist_meta_" + anilistId;
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    const graphqlQuery = `
        query ($id: Int) { 
            Media(id: $id, type: ANIME) { 
                id 
                idMal
                title { romaji english native } 
                synonyms 
                coverImage { extraLarge } 
                bannerImage 
                description 
                format 
                episodes 
                nextAiringEpisode { episode airingAt }
                streamingEpisodes { title thumbnail }
                averageScore
                status
                seasonYear
                startDate { year month day }
                relations {
                    edges {
                        relationType
                        node {
                            id
                            title { romaji english native }
                            format
                            episodes
                        }
                    }
                }
            } 
        }`;
    
    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await axios.post(ANILIST_URL, { query: graphqlQuery, variables: { id: parseInt(anilistId) } }, { timeout: 6000 });
                const anime = response.data?.data?.Media;
                
                if (!anime) {
                    apiCache.delete(cacheKey);
                    return null;
                }

                const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
                const englishTitle = anime.title.english || anime.title.romaji || "Unknown";

                const year = anime.startDate?.year || anime.seasonYear;
                const month = anime.startDate?.month;
                const day = anime.startDate?.day;
                
                const releaseDateStr = year ? (month ? month.toString().padStart(2, "0") + "/" + year : "" + year) : null;
                const releaseInfo = year ? "" + year : undefined;
                const released = year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).toISOString() : undefined;

                let epCount = anime.episodes;
                if (!epCount && anime.nextAiringEpisode && anime.nextAiringEpisode.episode) {
                    epCount = anime.nextAiringEpisode.episode - 1;
                }
                if (!epCount || epCount < 1) epCount = 1;

                let epMeta = {};
                if (anime.streamingEpisodes) {
                    anime.streamingEpisodes.forEach(ep => {
                        const match = ep.title.match(/(?:Episode|Ep)\s+(\d+)\s*[-:]\s*(.*)/i);
                        if (match) {
                            epMeta[parseInt(match[1])] = { title: match[2].trim(), thumbnail: ep.thumbnail };
                        } else {
                            const matchNum = ep.title.match(/\d+/);
                            if (matchNum) epMeta[parseInt(matchNum[0])] = { title: ep.title.trim(), thumbnail: ep.thumbnail };
                        }
                    });
                }

                const baseTime = year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).getTime() : Date.now();
                const stremioType = anime.format === "MOVIE" ? "movie" : "anime";

                let seasonOffset = 0;
                const isNumberedSeason = (extractSeasonNumber(cleanTitle) > 1) || 
                                         (extractSeasonNumber(englishTitle) > 1) || 
                                         /\b(?:2nd|3rd|4th|\d+th)\s+Season\b/i.test(cleanTitle) ||
                                         /\b(?:2nd|3rd|4th|\d+th)\s+Season\b/i.test(englishTitle);
                if (isNumberedSeason) {
                    const edges = anime.relations?.edges || [];
                    const prequels = edges.filter(e => e.relationType === "PREQUEL" && (e.node?.format === "TV" || e.node?.format === "ONA"));
                    if (prequels.length > 0) {
                        seasonOffset = prequels.reduce((acc, p) => acc + (p.node?.episodes || 0), 0);
                    }
                }

                const bgm = await getBangumiSubject(anime.title?.native || cleanTitle, { episodes: epCount, format: anime.format }).catch(() => null);
                const chineseSynonyms = (anime.synonyms || []).filter(s => /[\u4e00-\u9fa5]/.test(s));
                const chineseTitles = [...new Set([bgm?.name_cn, ...chineseSynonyms].filter(Boolean))];

                const result = {
                    id: "anilist:" + anime.id,
                    idMal: anime.idMal,
                    type: stremioType,
                    format: anime.format || null, // raw AniList format (TV/MOVIE/OVA/SPECIAL/ONA/MUSIC) — used by lib/normalizer hard gates
                    year: Number.isFinite(year) ? year : null,
                    name: cleanTitle,
                    englishName: englishTitle,
                    altName: anime.title.english || "",
                    nativeName: anime.title?.native || null,
                    chineseTitles,
                    name_cn: bgm?.name_cn || (chineseTitles[0] || null),
                    seasonOffset,
                    subjectId: bgm?.id || null,
                    synonyms: anime.synonyms || [],
                    poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                    background: anime.bannerImage || "",
                    description: formatDescription({ ...anime, releaseDate: releaseDateStr }),
                    releaseInfo: releaseInfo,
                    released: released,
                    episodes: epCount,
                    epMeta: epMeta,
                    baseTime: baseTime,
                    nextAiringEpisode: anime.nextAiringEpisode
                };

                setLRUCache(cacheKey, result);
                return result;

            } catch (error) {
                const status = error.response ? error.response.status : "Network";
                console.error("[AniList] Meta Error (Attempt " + (attempt + 1) + "/" + retries + "): Status " + status);
                if (attempt < retries - 1) await sleep((status === 429) ? 2000 * (attempt + 1) : 1000);
            }
        }
        apiCache.delete(cacheKey);
        return null;
    })();

    setLRUCache(cacheKey, fetchPromise);
    return fetchPromise;
}

async function fetchEpisodeDetails(malId) {
    if (!malId) return {};
    const cacheKey = "jikan_eps_" + malId;
    const cached = getLRUCache(cacheKey);
    if (cached) return cached;

    const eps = {};
    try {
        let page = 1;
        let hasNextPage = true;
        
        while (hasNextPage && page <= 4) {
            const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, { timeout: 4000 });
            if (res.data && res.data.data) {
                res.data.data.forEach(ep => {
                    eps[ep.mal_id] = { title: ep.title, aired: ep.aired };
                });
            }
            
            hasNextPage = res.data?.pagination?.has_next_page;
            if (hasNextPage) {
                page++;
                await sleep(400); 
            }
        }
        setLRUCache(cacheKey, eps);
    } catch (e) {
        console.error("[Jikan] Episode Pagination Error:", e.message);
    }
    return eps;
}

async function getJikanMeta(cleanedTitle, retries = 3) {
    const cacheKey = "jikan_" + cleanedTitle;
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const url = "https://api.jikan.moe/v4/anime?q=" + encodeURIComponent(cleanedTitle) + "&sfw=false&limit=1";
                const response = await axios.get(url, { timeout: 4000 });
                const data = response.data?.data;
                
                if (data && data.length > 0) {
                    const anime = data[0];
                    const year = anime.aired?.prop?.from?.year || anime.year;
                    const month = anime.aired?.prop?.from?.month;
                    const day = anime.aired?.prop?.from?.day;
                    
                    const releaseDateStr = year ? (month ? month.toString().padStart(2, "0") + "/" + year : "" + year) : null;
                    const releaseInfo = year ? "" + year : undefined;
                    const released = year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).toISOString() : undefined;
                    const stremioType = (anime.type === "Movie") ? "movie" : "anime";

                    const result = {
                        type: stremioType,
                        name: anime.title || "Unknown",
                        englishName: anime.title_english || anime.title || "Unknown",
                        poster: anime.images?.jpg?.large_image_url || null,
                        background: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || null,
                        description: formatDescription({ 
                            synopsis: anime.synopsis, format: anime.type, status: anime.status, 
                            releaseDate: releaseDateStr, averageScore: anime.score ? Math.round(anime.score * 10) : null
                        }),
                        releaseInfo: releaseInfo,
                        released: released,
                        episodes: anime.episodes || null,
                        altName: anime.title_english || "",
                        synonyms: anime.title_synonyms || [],
                        baseTime: year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).getTime() : Date.now(),
                        epMeta: {}
                    };

                    setLRUCache(cacheKey, result);
                    return result;
                }
                apiCache.delete(cacheKey);
                return null; 
            } catch (error) {
                const status = error.response ? error.response.status : "Network";
                console.error("[Jikan MAL] Fallback Error: Status " + status);
                if (attempt < retries - 1) await sleep((status === 429) ? 3000 * (attempt + 1) : 1000);
            }
        }
        apiCache.delete(cacheKey);
        return null;
    })();
    setLRUCache(cacheKey, fetchPromise);
    return fetchPromise;
}

module.exports = {
    searchAnime,
    searchAnimeSmart,
    resolveAnimeMetaFromTitle,
    generateRomajiVariants,
    getAnimeMeta,
    getTrendingAnime,
    getTopAnime,
    getAiringAnime,
    getSeasonalAnime,
    getJikanMeta,
    fetchEpisodeDetails,
    getCurrentSeasonInfo,
    getBangumiSubject,
    searchBangumiSubjects
};
