const axios = require("axios");
const http = require("http");
const https = require("https");

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 30 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 30 });
const defaultHttpClient = axios.create({ httpAgent, httpsAgent, timeout: 25000 });

const apiCache = new Map();
const MAX_CACHE_ENTRIES = 500;
const API_USER_AGENT = "NexioTorii/1.0";
const DEFAULT_STREMTHRU_URL = "https://stremthrufortheweak.nhyira.dev";
const PENDING_STATUSES = new Set(["queued", "downloading", "processing", "magnet_conversion"]);
const READY_STATUSES = new Set(["cached", "downloaded", "completed", "ready", "seeding"]);
const FAILED_STATUSES = new Set(["failed", "invalid"]);

const {
    checkTorBoxCached,
    addTorBoxTorrent,
    generateTorBoxLink,
    getTorBoxUser
} = require("./torbox");

function getStremThruUrl(options = {}) {
    return String(options.stremthruUrl || process.env.STREMTHRU_URL || DEFAULT_STREMTHRU_URL).replace(/\/+$/, "");
}

function setCache(key, dataOrPromise, ttlMs = 60000) {
    if (apiCache.has(key)) apiCache.delete(key);
    else if (apiCache.size >= MAX_CACHE_ENTRIES) apiCache.delete(apiCache.keys().next().value);
    apiCache.set(key, { data: dataOrPromise, expiresAt: Date.now() + ttlMs });
}

function getCache(key) {
    if (!apiCache.has(key)) return null;
    const item = apiCache.get(key);
    if (item.expiresAt <= Date.now()) {
        apiCache.delete(key);
        return null;
    }
    apiCache.delete(key);
    apiCache.set(key, item);
    return item.data;
}

function buildHeaders(entry) {
    return {
        "X-StremThru-Store-Name": entry.service,
        "X-StremThru-Store-Authorization": `Bearer ${entry.apiKey}`,
        "User-Agent": API_USER_AGENT
    };
}

function normalizeStoreFile(file = {}) {
    const index = file.index !== undefined ? file.index : -1;
    const path = file.path || file.name || "Unknown";
    return {
        id: index,
        index,
        link: file.link || "",
        name: file.name || path,
        path,
        size: file.size !== undefined ? file.size : 0
    };
}

function mapTorzItem(item = {}) {
    const status = String(item.status || "unknown").toLowerCase();
    const hash = String(item.hash || "").toLowerCase();
    return {
        hash,
        status,
        isCached: READY_STATUSES.has(status),
        files: Array.isArray(item.files) ? item.files.map(normalizeStoreFile) : []
    };
}

function serviceCacheKey(prefix, entry, extra) {
    return `${prefix}_${entry.service}_${String(entry.apiKey || "").slice(0, 8)}_${extra}`;
}

function maskApiKey(key) {
    const s = String(key || "").trim();
    if (!s) return "NONE";
    if (s.length <= 8) return s.slice(0, 2) + "..." + `(len ${s.length})`;
    return s.slice(0, 4) + "..." + s.slice(-4) + ` (len ${s.length})`;
}

async function checkStoreTorz(hashes, entry, options = {}) {
    if (!Array.isArray(hashes) || hashes.length === 0) return {};

    const http = options.http || defaultHttpClient;
    const useCache = options.cache !== false;
    const hashKey = [...hashes].map(String).sort().join(",");
    const cacheKey = serviceCacheKey("torz_check", entry, hashKey);
    const cached = useCache ? getCache(cacheKey) : null;
    if (cached) return cached;

    if (entry.service === "torbox") {
        const promise = checkTorBoxCached(hashes, entry.apiKey, options).then(result => {
            if (useCache) setCache(cacheKey, result, 60000);
            return result;
        });
        if (useCache) setCache(cacheKey, promise, 10000);
        return promise;
    }

    const performFetch = async () => {
        const results = {};
        const chunkSize = options.chunkSize || 500;
        const stremthruUrl = getStremThruUrl(options);

        console.log(`[StremThru] [${entry.service}] Checking ${hashes.length} hashes via ${stremthruUrl} (Token: ${maskApiKey(entry.apiKey)})...`);

        try {
            for (let i = 0; i < hashes.length; i += chunkSize) {
                const chunk = hashes.slice(i, i + chunkSize);
                const url = `${stremthruUrl}/v0/store/torz/check?hash=${chunk.join(",")}`;
                const res = await http.get(url, {
                    headers: buildHeaders(entry),
                    timeout: options.timeout || 8000
                });

                const items = res.data && res.data.data && Array.isArray(res.data.data.items)
                    ? res.data.data.items
                    : [];
                items.forEach(item => {
                    const mapped = mapTorzItem(item);
                    if (mapped.hash) results[mapped.hash] = mapped;
                });

                if (i + chunkSize < hashes.length) {
                    await new Promise(resolve => setTimeout(resolve, options.chunkDelayMs || 100));
                }
            }

            const cachedCount = Object.values(results).filter(x => x.isCached).length;
            console.log(`[StremThru] [${entry.service}] Availability check finished: ${cachedCount}/${hashes.length} torrents cached in store`);

            return { data: results, ttl: 60000 };
        } catch (e) {
            const status = e.response ? e.response.status : 500;
            const errObj = e.response?.data?.error;
            const errorDetail = errObj?.message || e.response?.data?.message || (typeof e.response?.data === "string" ? e.response.data : "") || e.message;
            const upstreamCause = errObj?.__upstream_cause__ ? JSON.stringify(errObj.__upstream_cause__) : "";
            console.error(`[StremThru ${entry.service} Check Error] Status ${status}: ${errorDetail} ${upstreamCause ? `| Upstream: ${upstreamCause}` : ""}`);
            const ttl = status === 401 || status === 403 ? 3600000 : status === 429 ? 30000 : 10000;
            return { data: {}, ttl };
        }
    };

    const promise = performFetch().then(result => {
        if (useCache) setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    if (useCache) setCache(cacheKey, promise, 10000);
    return promise;
}

async function addStoreTorz(magnet, entry, options = {}) {
    if (entry.service === "torbox") {
        return addTorBoxTorrent(magnet, entry.apiKey, options);
    }
    const http = options.http || defaultHttpClient;
    const stremthruUrl = getStremThruUrl(options);
    console.log(`[StremThru] [${entry.service}] Adding magnet to store via ${stremthruUrl} (Token: ${maskApiKey(entry.apiKey)})`);
    try {
        const res = await http.post(`${stremthruUrl}/v0/store/torz`, { link: magnet }, {
            headers: buildHeaders(entry),
            timeout: options.timeout || 25000
        });
        const mapped = mapTorzItem(res.data && res.data.data ? res.data.data : {});
        console.log(`[StremThru] [${entry.service}] Store status: "${mapped.status}" | files: ${mapped.files.length} | isCached: ${mapped.isCached}`);
        return mapped;
    } catch (e) {
        const status = e.response ? e.response.status : 500;
        const errObj = e.response?.data?.error;
        const errorDetail = errObj?.message || e.response?.data?.message || (typeof e.response?.data === "string" ? e.response.data : "") || e.message;
        const upstreamCause = errObj?.__upstream_cause__ ? JSON.stringify(errObj.__upstream_cause__) : "";
        console.error(`[StremThru ${entry.service} Add Error] Status ${status}: ${errorDetail} ${upstreamCause ? `| Upstream: ${upstreamCause}` : ""}`);
        throw e;
    }
}

async function generateStoreLink(link, entry, options = {}) {
    if (entry.service === "torbox") {
        return generateTorBoxLink(link, entry.apiKey, options);
    }
    const http = options.http || defaultHttpClient;
    const stremthruUrl = getStremThruUrl(options);
    console.log(`[StremThru] [${entry.service}] Requesting download link generation from store...`);
    try {
        const res = await http.post(`${stremthruUrl}/v0/store/torz/link/generate`, { link }, {
            headers: buildHeaders(entry),
            timeout: options.timeout || 25000
        });
        const directLink = res.data && res.data.data ? res.data.data.link : "";
        if (directLink) {
            console.log(`[StremThru] [${entry.service}] Direct stream link generated successfully`);
        } else {
            console.warn(`[StremThru] [${entry.service}] Warning: Store returned empty link`);
        }
        return directLink;
    } catch (e) {
        const status = e.response ? e.response.status : 500;
        const errObj = e.response?.data?.error;
        const errorDetail = errObj?.message || e.response?.data?.message || (typeof e.response?.data === "string" ? e.response.data : "") || e.message;
        const upstreamCause = errObj?.__upstream_cause__ ? JSON.stringify(errObj.__upstream_cause__) : "";
        console.error(`[StremThru ${entry.service} Link Error] Status ${status}: ${errorDetail} ${upstreamCause ? `| Upstream: ${upstreamCause}` : ""}`);
        throw e;
    }
}

async function checkStoreUser(entry, options = {}) {
    if (entry.service === "torbox") {
        const user = await getTorBoxUser(entry.apiKey, options);
        if (user) return user;
    }
    const http = options.http || defaultHttpClient;
    const res = await http.get(`${getStremThruUrl(options)}/v0/store/user`, {
        headers: buildHeaders(entry),
        timeout: options.timeout || 15000
    });
    return res.data && res.data.data ? res.data.data : null;
}

module.exports = {
    FAILED_STATUSES,
    PENDING_STATUSES,
    READY_STATUSES,
    addStoreTorz,
    addTorBoxTorrent,
    checkStoreTorz,
    checkStoreUser,
    checkTorBoxCached,
    generateStoreLink,
    generateTorBoxLink,
    getTorBoxUser,
    mapTorzItem,
    maskApiKey,
    normalizeStoreFile
};
