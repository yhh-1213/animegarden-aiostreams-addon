const axios = require("axios");
const FormData = require("form-data");
const http = require("http");
const https = require("https");

const TORBOX_API_BASE = "https://api.torbox.app";
const TORBOX_USER_AGENT = "HellyAddon/1.0";

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 30 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 30 });
const defaultHttpClient = axios.create({ httpAgent, httpsAgent, timeout: 25000 });

function maskApiKey(key) {
    const s = String(key || "").trim();
    if (!s) return "NONE";
    if (s.length <= 8) return s.slice(0, 2) + "..." + `(len ${s.length})`;
    return s.slice(0, 4) + "..." + s.slice(-4) + ` (len ${s.length})`;
}

function getTorBoxHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": TORBOX_USER_AGENT
    };
}

function mapTorBoxFiles(rawFiles = [], torrentId = "") {
    return (Array.isArray(rawFiles) ? rawFiles : []).map((f, idx) => {
        const fileId = f.id !== undefined ? f.id : idx;
        const name = f.name || f.short_name || "Unknown";
        return {
            id: fileId,
            index: fileId,
            name,
            path: f.s3_path || name,
            size: f.size !== undefined ? f.size : 0,
            link: `torbox://${torrentId}/${fileId}`
        };
    });
}

function mapTorBoxTorrent(torrent, fallbackHash = "") {
    const state = String(torrent?.download_state || "").toLowerCase();
    const isReady = torrent?.download_finished === true ||
                    torrent?.download_present === true ||
                    torrent?.progress === 1 ||
                    state === "cached" ||
                    state === "completed" ||
                    state === "uploading" ||
                    state === "seeding" ||
                    state === "ready";
    const isFailed = state === "stalled (no seeds)" || state === "failed" || state === "error";
    const isPending = !isReady && !isFailed;

    const torrentId = torrent?.id !== undefined ? torrent.id : "";
    const files = mapTorBoxFiles(torrent?.files, torrentId);

    return {
        id: torrentId,
        torrentId,
        hash: String(torrent?.hash || fallbackHash).toLowerCase(),
        status: isReady ? "cached" : (isFailed ? "failed" : (isPending ? "downloading" : state || "unknown")),
        isCached: isReady,
        files
    };
}

/**
 * Checks cached availability for a list of hashes directly with the TorBox API.
 * Bypasses third-party StremThru proxies for maximum speed and reliability.
 */
async function checkTorBoxCached(hashes, apiKey, options = {}) {
    if (!Array.isArray(hashes) || hashes.length === 0) return {};
    const client = options.http || defaultHttpClient;
    const chunkSize = options.chunkSize || 100;
    const results = {};

    console.log(`[TorBox] Checking ${hashes.length} hashes directly with TorBox API (Token: ${maskApiKey(apiKey)})...`);

    for (let i = 0; i < chunkSize && i < hashes.length; i += chunkSize) {
        const chunk = hashes.slice(i, i + chunkSize);
        const url = `${TORBOX_API_BASE}/v1/api/torrents/checkcached?hash=${chunk.join(",")}&format=object&list_files=true`;

        try {
            const res = await client.get(url, {
                headers: getTorBoxHeaders(apiKey),
                timeout: options.timeout || 10000
            });

            if (res.data && res.data.success && res.data.data && typeof res.data.data === "object") {
                for (const [hashKey, item] of Object.entries(res.data.data)) {
                    if (!item) continue;
                    const normHash = String(item.hash || hashKey).toLowerCase();
                    const rawFiles = Array.isArray(item.files) ? item.files : [];
                    const files = rawFiles.map((f, idx) => {
                        const fileId = f.id !== undefined ? f.id : idx;
                        const name = f.name || f.short_name || "Unknown";
                        return {
                            id: fileId,
                            index: fileId,
                            link: `torbox://${normHash}/${fileId}`,
                            name,
                            path: f.s3_path || name,
                            size: f.size !== undefined ? f.size : 0
                        };
                    });

                    results[normHash] = {
                        hash: normHash,
                        status: "cached",
                        isCached: true,
                        files
                    };
                }
            }
        } catch (e) {
            const status = e.response ? e.response.status : 500;
            const detail = e.response?.data?.detail || e.response?.data?.error || e.message;
            console.error(`[TorBox Check Error] Status ${status}: ${typeof detail === "object" ? JSON.stringify(detail) : detail}`);
            if (status === 401 || status === 403) {
                console.error(`[TorBox] Aborting check: API token is rejected by TorBox (Status: ${status}).`);
                break;
            }
        }

        if (i + chunkSize < hashes.length) {
            await new Promise(r => setTimeout(r, options.chunkDelayMs || 50));
        }
    }

    const cachedCount = Object.values(results).filter(x => x.isCached).length;
    console.log(`[TorBox] Availability check finished: ${cachedCount}/${hashes.length} torrents cached in TorBox cloud`);
    return results;
}

/**
 * Adds or retrieves a torrent from the user's TorBox account.
 * Checks existing downloads first before calling createtorrent to avoid duplicates.
 */
async function addTorBoxTorrent(magnet, apiKey, options = {}) {
    const client = options.http || defaultHttpClient;
    const hashMatch = String(magnet || "").match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
    const targetHash = hashMatch ? hashMatch[1].toLowerCase() : "";

    console.log(`[TorBox] Resolving torrent in TorBox account (Hash: ${targetHash || "unknown"}, Token: ${maskApiKey(apiKey)})...`);

    // Helper: query a single torrent by ID with full file list
    async function fetchTorrentById(id) {
        try {
            const res = await client.get(`${TORBOX_API_BASE}/v1/api/torrents/mylist?id=${id}&bypass_cache=true`, {
                headers: getTorBoxHeaders(apiKey),
                timeout: 10000
            });
            const data = res.data?.data;
            if (Array.isArray(data)) {
                return data.find(t => String(t.id) === String(id)) || data[0] || null;
            }
            return data || null;
        } catch (err) {
            console.warn(`[TorBox] Failed fetching torrent detail for ID ${id}: ${err.message}`);
            return null;
        }
    }

    // Step 1: Check if the torrent is already in the user's active/completed torrent list
    let existingTorrent = null;
    try {
        const mylistRes = await client.get(`${TORBOX_API_BASE}/v1/api/torrents/mylist?bypass_cache=true`, {
            headers: getTorBoxHeaders(apiKey),
            timeout: options.timeout || 15000
        });

        const items = Array.isArray(mylistRes.data?.data) ? mylistRes.data.data : [];
        if (targetHash) {
            const found = items.find(t => String(t.hash || "").toLowerCase() === targetHash);
            if (found) {
                if (Array.isArray(found.files) && found.files.length > 0) {
                    existingTorrent = found;
                } else if (found.id !== undefined) {
                    existingTorrent = await fetchTorrentById(found.id);
                }
                if (existingTorrent && Array.isArray(existingTorrent.files) && existingTorrent.files.length > 0) {
                    console.log(`[TorBox] Torrent already exists in user account (ID: ${existingTorrent.id}, State: "${existingTorrent.download_state}")`);
                    return mapTorBoxTorrent(existingTorrent, targetHash);
                }
            }
        }
    } catch (e) {
        console.warn(`[TorBox] Warning: Could not fetch initial mylist: ${e.message}`);
    }

    // Step 2: Add torrent to account via createtorrent
    console.log(`[TorBox] Adding torrent to TorBox account via createtorrent...`);
    let torrentId = existingTorrent?.id || null;
    try {
        const form = new FormData();
        form.append("magnet", magnet);
        form.append("seed", "1");
        form.append("allow_zip", "false");

        const createRes = await client.post(`${TORBOX_API_BASE}/v1/api/torrents/createtorrent`, form, {
            headers: {
                ...form.getHeaders(),
                ...getTorBoxHeaders(apiKey)
            },
            timeout: options.timeout || 25000
        });

        torrentId = createRes.data?.data?.torrent_id || torrentId;
        console.log(`[TorBox] createtorrent successful (Torrent ID: ${torrentId || "unknown"})`);
    } catch (e) {
        const status = e.response ? e.response.status : 500;
        const errDetail = e.response?.data?.detail || e.response?.data?.error || e.message;
        console.error(`[TorBox Add Error] Status ${status}: ${typeof errDetail === "object" ? JSON.stringify(errDetail) : errDetail}`);
        torrentId = e.response?.data?.data?.torrent_id || e.response?.data?.torrent_id || torrentId;
    }

    // Step 3: Fetch the newly added torrent details (with retries)
    const maxRetries = options.maxRetries || 8;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let torrent = null;
            if (torrentId) {
                torrent = await fetchTorrentById(torrentId);
            }

            if (!torrent && targetHash) {
                const mylistRes = await client.get(`${TORBOX_API_BASE}/v1/api/torrents/mylist?bypass_cache=true`, {
                    headers: getTorBoxHeaders(apiKey),
                    timeout: 10000
                });
                const items = Array.isArray(mylistRes.data?.data) ? mylistRes.data.data : [];
                const found = items.find(t => String(t.hash || "").toLowerCase() === targetHash);
                if (found) {
                    torrentId = found.id;
                    torrent = Array.isArray(found.files) && found.files.length > 0 ? found : await fetchTorrentById(found.id);
                }
            }

            if (torrent && Array.isArray(torrent.files) && torrent.files.length > 0) {
                const mapped = mapTorBoxTorrent(torrent, targetHash);
                if (mapped.isCached || attempt >= 4) {
                    console.log(`[TorBox] Torrent status: "${mapped.status}" | files: ${mapped.files.length} | isCached: ${mapped.isCached}`);
                    return mapped;
                }
            }
        } catch (fetchErr) {
            console.warn(`[TorBox] Attempt ${attempt} to fetch torrent metadata failed: ${fetchErr.message}`);
        }

        if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, options.retryDelayMs || 600));
        }
    }

    // Fallback if not ready
    return {
        id: torrentId,
        torrentId,
        hash: targetHash,
        status: "downloading",
        isCached: false,
        files: []
    };
}

/**
 * Generates direct download / playback stream URL for a TorBox file.
 * Requests direct CDN stream link via requestdl; captures redirects and object links cleanly.
 */
async function generateTorBoxLink(link, apiKey, options = {}) {
    const client = options.http || defaultHttpClient;
    console.log(`[TorBox] Requesting direct stream link for: ${link}`);

    let torrentId = null;
    let fileId = null;

    if (typeof link === "string") {
        const m = link.match(/torbox:\/\/([^\/]+)\/([^\/]+)/);
        if (m) {
            torrentId = m[1];
            fileId = m[2];
        } else if (link.startsWith("http://") || link.startsWith("https://")) {
            return link;
        }
    }

    if (!torrentId || fileId === null || fileId === undefined) {
        if (options.file && options.torz) {
            torrentId = options.torz.id || options.torz.torrentId;
            fileId = options.file.id ?? options.file.index;
        }
    }

    // If torrentId is a 40-char infohash rather than a numeric ID, look up its numeric torrent ID
    if (torrentId && !/^\d+$/.test(String(torrentId))) {
        console.log(`[TorBox] torrentId "${torrentId}" is a hash. Looking up numeric ID in user account...`);
        try {
            const listRes = await client.get(`${TORBOX_API_BASE}/v1/api/torrents/mylist?bypass_cache=true`, {
                headers: getTorBoxHeaders(apiKey),
                timeout: 10000
            });
            const list = Array.isArray(listRes.data?.data) ? listRes.data.data : [];
            const found = list.find(t => String(t.hash || "").toLowerCase() === String(torrentId).toLowerCase());
            if (found && found.id !== undefined) {
                console.log(`[TorBox] Found numeric torrent ID: ${found.id}`);
                torrentId = found.id;
            }
        } catch (err) {
            console.warn(`[TorBox] Failed looking up numeric torrent ID: ${err.message}`);
        }
    }

    if (!torrentId) {
        console.error(`[TorBox Link Error] Missing torrentId or fileId from link: "${link}"`);
        throw new Error(`TorBox invalid file link: ${link}`);
    }

    // 1. Request direct CDN download link from TorBox (redirect=false)
    try {
        const query = `token=${encodeURIComponent(apiKey)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(fileId)}&redirect=false`;
        const dlRes = await client.get(`${TORBOX_API_BASE}/v1/api/torrents/requestdl?${query}`, {
            params: {
                token: apiKey,
                torrent_id: torrentId,
                file_id: fileId,
                redirect: "false"
            },
            headers: getTorBoxHeaders(apiKey),
            timeout: options.timeout || 15000,
            maxRedirects: 0,
            validateStatus: s => s >= 200 && s < 400
        });

        // Redirect location header check
        if (dlRes.headers && dlRes.headers.location) {
            console.log(`[TorBox] Direct CDN stream link obtained from redirect header`);
            return dlRes.headers.location;
        }

        // Response body extraction
        const data = dlRes.data?.data;
        const candidate = (typeof data === "string") ? data : (data?.link || data?.url || dlRes.data?.link || dlRes.data?.url);
        if (typeof candidate === "string" && (candidate.startsWith("http://") || candidate.startsWith("https://"))) {
            console.log(`[TorBox] Direct CDN stream link obtained successfully from response body`);
            return candidate;
        }
    } catch (e) {
        const status = e.response ? e.response.status : 500;
        const errDetail = e.response?.data?.detail || e.response?.data?.error || e.message;
        console.warn(`[TorBox requestdl non-redirect] Status ${status}: ${typeof errDetail === "object" ? JSON.stringify(errDetail) : errDetail}`);
    }

    // 2. Secondary attempt: Request with redirect=true and capture 302 Location header directly
    try {
        const redirQuery = `token=${encodeURIComponent(apiKey)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(fileId)}&redirect=true`;
        const redirRes = await client.get(`${TORBOX_API_BASE}/v1/api/torrents/requestdl?${redirQuery}`, {
            params: {
                token: apiKey,
                torrent_id: torrentId,
                file_id: fileId,
                redirect: "true"
            },
            headers: getTorBoxHeaders(apiKey),
            timeout: options.timeout || 15000,
            maxRedirects: 0,
            validateStatus: s => s >= 200 && s < 400
        });

        if (redirRes.headers && redirRes.headers.location) {
            console.log(`[TorBox] Direct CDN stream link obtained from redirect=true Location header`);
            return redirRes.headers.location;
        }
    } catch (e) {
        console.warn(`[TorBox requestdl redirect-capture] Failed: ${e.message}`);
    }

    // 3. Fallback: Return TorBox permanent permalink (TorBox 302 redirects to CDN)
    const permalink = `${TORBOX_API_BASE}/v1/api/torrents/requestdl?token=${encodeURIComponent(apiKey)}&torrent_id=${torrentId}&file_id=${fileId}&redirect=true`;
    console.log(`[TorBox] Returning TorBox permanent permalink: ${permalink.replace(apiKey, maskApiKey(apiKey))}`);
    return permalink;
}

/**
 * Checks user account / subscription status with TorBox.
 */
async function getTorBoxUser(apiKey, options = {}) {
    const client = options.http || defaultHttpClient;
    try {
        const res = await client.get(`${TORBOX_API_BASE}/v1/api/user/me`, {
            headers: getTorBoxHeaders(apiKey),
            timeout: options.timeout || 10000
        });
        return res.data?.data || null;
    } catch (e) {
        return null;
    }
}

module.exports = {
    TORBOX_API_BASE,
    addTorBoxTorrent,
    checkTorBoxCached,
    generateTorBoxLink,
    getTorBoxHeaders,
    getTorBoxUser,
    mapTorBoxFiles,
    mapTorBoxTorrent,
    maskApiKey
};
