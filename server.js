require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const { getRouter } = require("stremio-addon-sdk");
const { addonInterface, configuredManifest } = require("./addon");
const { parseConfig } = require("./lib/config");
const { selectBestVideoFile } = require("./lib/parser");
const { resolveStorePlayback, resolveStoreSubtitle } = require("./lib/playback");
const { maskApiKey } = require("./lib/debrid");
const { applyHttpCacheHeaders } = require("./lib/cache/http-cache");
const { extractBaseUrlFromReq, getRequestBaseUrl, runWithRequestContext } = require("./lib/request-context");

const app = express();
app.set("trust proxy", true);
app.use(express.json()); 

// Dynamic request context captures host & protocol for remote playback resolution
app.use((req, res, next) => {
    const baseUrl = extractBaseUrlFromReq(req);
    runWithRequestContext({ baseUrl, req }, () => {
        next();
    });
}); 

//===============
// CORS & PREFLIGHT HANDLING
// This middleware ensures that strict environments like Stremio Web 
// on Apple devices (WebKit) do not block the addon requests.
// We explicitly allow the "Range" header for subtitle seeking.
//===============
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }
    next();
});

app.use(applyHttpCacheHeaders);

//===============
// GLOBAL ERROR HANDLER
// Prevents the Node.js process from crashing if a promise is rejected 
// without a ".catch()" block somewhere in the async operations.
//===============
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "static")));

const port = process.env.PORT || 7002;
const NYAA_DOMAIN = (process.env.NYAA_DOMAIN || "https://nyaa.iss.one").replace(/\/+$/, "");

// API status endpoint
app.get("/health", (req, res) => res.status(200).json({ "status": "alive" }));

//===============
// NYAA STATUS CHECK
// Caches the Nyaa.si health status for 5 minutes (300000ms) to prevent 
// spamming the tracker with health check pings from the frontend UI.
//===============
let nyaaCache = { "status": "checking", "timestamp": 0 };

app.get("/nyaa-status", async (req, res) => {
    const now = Date.now();
    if (now - nyaaCache.timestamp < 300000 && nyaaCache.status !== "checking") {
        return res.json({ "status": nyaaCache.status });
    }
    
    try {
        await axios.get(NYAA_DOMAIN, {
            "timeout": 5000,
            "headers": {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
            },
            "validateStatus": function (status) {
                // Nyaa often returns 403 or 503 when under Cloudflare protection, 
                // but that still means the server is "alive" and reachable.
                return (status >= 200 && status < 300) || status === 403 || status === 503;
            }
        });

        nyaaCache = { "status": "online", "timestamp": now };
        res.json({ "status": "online" });
    } catch (error) {
        nyaaCache = { "status": "online", "timestamp": now };
        res.json({ "status": "online" });
    }
});

//===============
// ANIME GARDEN STATUS CHECK
//===============
let gardenCache = { "status": "checking", "timestamp": 0 };

app.get("/garden-status", async (req, res) => {
    const now = Date.now();
    if (now - gardenCache.timestamp < 300000 && gardenCache.status !== "checking") {
        return res.json({ "status": gardenCache.status });
    }
    try {
        await axios.get("https://api.animes.garden/resources?page=1&pageSize=1", {
            timeout: 5000,
            headers: { "User-Agent": "HellyAddon/1.0" }
        });
        gardenCache = { "status": "online", "timestamp": now };
        res.json({ "status": "online" });
    } catch (e) {
        gardenCache = { "status": "online", "timestamp": now };
        res.json({ "status": "online" });
    }
});

app.get("/configure", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

//===============
// BULLETPROOF SUBTITLE PROXY
// Bypasses CORS and bandwidth limitations by piping the subtitle file 
// directly through our backend to the Stremio video player.
// Includes connection-drop detection to prevent memory leaks.
//===============
app.get("/sub/:nexioPayload/:serviceIndex/:hash/:fileId", async (req, res) => {
    const { nexioPayload, serviceIndex, hash, fileId } = req.params;
    const userConfig = parseConfig({ HellyAddon: nexioPayload, NexioTorii: nexioPayload });
    const entry = userConfig.debridServices[parseInt(serviceIndex, 10)];
    let clientAborted = false;

    req.on("close", () => { clientAborted = true; });

    if (!entry) return res.status(404).send("Debrid service not found");

    try {
        const action = await resolveStoreSubtitle({
            entry,
            hash,
            fileId,
            title: req.query.title || "",
            fileName: req.query.filename || "sub.srt"
        });

        if (action.type !== "redirect") return res.status(404).send(action.message || "Subtitle not found");

        const subResponse = await axios.get(action.url, { responseType: "stream", timeout: 10000 });
        if (clientAborted) {
            if (subResponse.data && subResponse.data.destroy) subResponse.data.destroy();
            return;
        }

        const ext = String(action.fileName || "sub.srt").split(".").pop().toLowerCase();
        let finalMime = subResponse.headers["content-type"];

        if (!finalMime || finalMime.includes("octet-stream") || finalMime.includes("plain")) {
            if (ext === "vtt") finalMime = "text/vtt";
            else if (ext === "ass" || ext === "ssa") finalMime = "text/x-ssa";
            else if (ext === "srt") finalMime = "application/x-subrip";
            else finalMime = "text/plain";
        }

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", finalMime);
        res.setHeader("Cache-Control", "public, max-age=86400");

        subResponse.data.on("error", () => res.end());
        req.on("close", () => {
            if (subResponse.data && subResponse.data.destroy) subResponse.data.destroy();
        });
        subResponse.data.pipe(res);

    } catch (e) {
        console.error("[Sub Proxy Error]", e.message);
        res.status(500).send("Error fetching subtitle data");
    }
});
    
//===============
// FALLBACK VIDEOS
// When a torrent is uncached and needs to be downloaded by the Debrid service, 
// Stremio cannot wait. We send a small looping video back immediately.
//===============
function serveLoadingVideo(req, res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.redirect(getRequestBaseUrl() + "/waiting.mp4");
}

function serveArchiveVideo(req, res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.redirect(getRequestBaseUrl() + "/archive.mp4");
}

//===============
// STREAM RESOLVER
// Receives the direct click from the user in Stremio.
// Locates the hash on the Debrid service, determines the best file, 
// unrestricts it, and redirects the Stremio player to the raw MP4/MKV URL.
//===============
app.get("/resolve/:nexioPayload/:serviceIndex/:hash/:episode?", async (req, res) => {
    const { nexioPayload, serviceIndex, hash, episode } = req.params;
    const userConfig = parseConfig({ HellyAddon: nexioPayload, NexioTorii: nexioPayload });
    const sIndex = parseInt(serviceIndex, 10);
    const entry = userConfig.debridServices[sIndex];

    console.log(`\n[Resolve] ===== INCOMING STREAM RESOLVE REQUEST =====`);
    console.log(`[Resolve] Hash: ${hash} | Episode: ${episode || 1} | Season: ${req.query.season || 1} | Movie: ${req.query.movie === "1"}`);
    console.log(`[Resolve] Title: "${req.query.title || 'Unknown'}"`);

    if (!entry) {
        console.error(`[Resolve] ❌ Debrid service at index ${serviceIndex} not found! Configured services: [${userConfig.debridServices.map(s => s.service).join(", ") || 'none'}]`);
        return res.status(404).send("Debrid service not found");
    }

    console.log(`[Resolve] Target Service: "${entry.service}" (Token: ${maskApiKey(entry.apiKey)})`);

    try {
        const action = await resolveStorePlayback({
            entry,
            hash,
            episode: parseInt(episode || "1", 10) || 1,
            expectedSeason: parseInt(req.query.season || "1", 10) || 1,
            title: req.query.title || "",
            isMovie: req.query.movie === "1" || req.query.movie === "true",
            absoluteEp: req.query.abs ? parseInt(req.query.abs, 10) : null,
            selectBestVideoFile
        });

        console.log(`[Resolve] [${entry.service}] Action returned: "${action.type}"`);

        if (action.type === "redirect") {
            const rawFilename = action.filename || req.query.title || "video.mkv";
            const isMp4 = /\.mp4$/i.test(rawFilename) || /\[MP4\]/i.test(rawFilename);
            const safeExt = isMp4 ? ".mp4" : ".mkv";
            const finalFilename = /\.(mkv|mp4|avi)$/i.test(rawFilename) ? rawFilename : `${rawFilename}${safeExt}`;
            const cleanAscii = finalFilename.replace(/[^\x20-\x7E]/g, "_");

            console.log(`[Resolve] [${entry.service}] 🚀 302 Redirecting to stream: "${cleanAscii}"`);
            console.log(`[Resolve] [${entry.service}] Stream URL: ${action.url.slice(0, 100)}...`);

            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            return res.redirect(302, action.url);
        }
        if (action.type === "archive") {
            console.warn(`[Resolve] [${entry.service}] 📦 Torrent file not matched or archive pack not ready.`);
            return res.status(404).send("Torrent file not matched or archive pack not ready.");
        }
        if (action.type === "not_found") {
            console.error(`[Resolve] [${entry.service}] ❌ Torrent not playable: ${action.message || "Not playable"}`);
            return res.status(404).send(action.message || "Torrent is not playable.");
        }
        console.warn(`[Resolve] [${entry.service}] ⏳ Stream downloading or pending in cloud.`);
        return res.status(503).send("Torrent is downloading to debrid cloud. Please check back in a few minutes.");
    } catch (e) {
        const status = e.response ? e.response.status : null;
        const errData = e.response?.data?.error || e.response?.data || null;
        console.error(`[Resolve Error] [${entry.service}] Core resolution failure: ${e.message}`);
        if (status) console.error(`[Resolve Error] [${entry.service}] HTTP Status: ${status}`);
        if (errData) console.error(`[Resolve Error] [${entry.service}] Response body: ${typeof errData === 'object' ? JSON.stringify(errData) : errData}`);
        console.warn(`[Resolve Error] [${entry.service}] Serving waiting.mp4 fallback video to player.`);
        return serveLoadingVideo(req, res);
    }
});

app.get("/manifest.json", (req, res) => {
    res.json(configuredManifest({}, getRequestBaseUrl()));
});

app.get("/:config/manifest.json", (req, res, next) => {
    try {
        let decoded = null;
        try {
            decoded = JSON.parse(req.params.config);
        } catch (e) {
            decoded = req.params.config;
        }
        res.json(configuredManifest(decoded, getRequestBaseUrl()));
    } catch (e) {
        next();
    }
});

// Automatically wrap raw Base64 configuration payloads in the URL
// so that Stremio Addon SDK's JSON.parse parser can digest them
app.use((req, res, next) => {
    const m = req.url.match(/^\/([A-Za-z0-9_-]{20,})\/(manifest\.json|(?:catalog|meta|stream)\/.*)/);
    if (m) {
        const payload = m[1];
        const rest = m[2];
        try {
            if (!payload.startsWith("%7B") && !payload.startsWith("{")) {
                const wrapped = encodeURIComponent(JSON.stringify({ HellyAddon: payload }));
                req.url = `/${wrapped}/${rest}`;
            }
        } catch (_) {}
    }
    next();
});

app.use("/", getRouter(addonInterface));
app.listen(port, "0.0.0.0", () => console.log("🌸 HELLYADDON ONLINE | PORT " + port));
