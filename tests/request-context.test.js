const test = require("node:test");
const assert = require("node:assert/strict");

const {
    extractBaseUrlFromReq,
    getRequestBaseUrl,
    runWithRequestContext
} = require("../lib/request-context");
const { buildDebridStreams } = require("../lib/stream-builder");
const { encodeConfigPayload } = require("../lib/config");

test("extractBaseUrlFromReq handles null or missing request", () => {
    assert.equal(extractBaseUrlFromReq(null), null);
    assert.equal(extractBaseUrlFromReq({}), null);
    assert.equal(extractBaseUrlFromReq({ headers: {} }), null);
});

test("extractBaseUrlFromReq extracts standard host and protocol", () => {
    const req = {
        protocol: "http",
        headers: { host: "192.168.1.100:7002" }
    };
    assert.equal(extractBaseUrlFromReq(req), "http://192.168.1.100:7002");
});

test("extractBaseUrlFromReq extracts reverse proxy x-forwarded headers", () => {
    const req = {
        protocol: "http",
        headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "helly.myanimedomain.com",
            host: "localhost:7002"
        }
    };
    assert.equal(extractBaseUrlFromReq(req), "https://helly.myanimedomain.com");
});

test("extractBaseUrlFromReq handles comma-separated multi-proxy headers", () => {
    const req = {
        protocol: "http",
        headers: {
            "x-forwarded-proto": "https, http",
            "x-forwarded-host": "stremio.domain.org, proxy-internal:80",
            host: "proxy-internal:80"
        }
    };
    assert.equal(extractBaseUrlFromReq(req), "https://stremio.domain.org");
});

test("extractBaseUrlFromReq recognizes x-forwarded-ssl header", () => {
    const req = {
        headers: {
            "x-forwarded-ssl": "on",
            host: "ssl-site.com"
        }
    };
    assert.equal(extractBaseUrlFromReq(req), "https://ssl-site.com");
});

test("getRequestBaseUrl falls back to 127.0.0.1:7002 by default", () => {
    const oldEnv = process.env.BASE_URL;
    delete process.env.BASE_URL;
    try {
        assert.equal(getRequestBaseUrl(), "http://127.0.0.1:7002");
    } finally {
        if (oldEnv) process.env.BASE_URL = oldEnv;
    }
});

test("getRequestBaseUrl dynamically retrieves URL from active request context", async () => {
    const oldEnv = process.env.BASE_URL;
    delete process.env.BASE_URL;
    try {
        await runWithRequestContext({ baseUrl: "https://remote-vps.example.com" }, async () => {
            assert.equal(getRequestBaseUrl(), "https://remote-vps.example.com");
            // Verify async boundary persistence
            await new Promise(r => setTimeout(r, 10));
            assert.equal(getRequestBaseUrl(), "https://remote-vps.example.com");
        });
        // Outside context returns fallback
        assert.equal(getRequestBaseUrl(), "http://127.0.0.1:7002");
    } finally {
        if (oldEnv) process.env.BASE_URL = oldEnv;
    }
});

test("getRequestBaseUrl prefers dynamic request context over localhost BASE_URL", async () => {
    const oldEnv = process.env.BASE_URL;
    process.env.BASE_URL = "http://127.0.0.1:7002";
    try {
        await runWithRequestContext({ baseUrl: "https://remote-vps.example.com" }, async () => {
            assert.equal(getRequestBaseUrl(), "https://remote-vps.example.com");
        });
    } finally {
        if (oldEnv) process.env.BASE_URL = oldEnv;
        else delete process.env.BASE_URL;
    }
});

test("getRequestBaseUrl respects explicit non-localhost operator BASE_URL", async () => {
    const oldEnv = process.env.BASE_URL;
    process.env.BASE_URL = "https://custom-cdn.example.org";
    try {
        await runWithRequestContext({ baseUrl: "https://internal-proxy.example.com" }, async () => {
            assert.equal(getRequestBaseUrl(), "https://custom-cdn.example.org");
        });
    } finally {
        if (oldEnv) process.env.BASE_URL = oldEnv;
        else delete process.env.BASE_URL;
    }
});

test("buildDebridStreams seamlessly adopts getRequestBaseUrl when baseUrl is omitted", async () => {
    const oldEnv = process.env.BASE_URL;
    delete process.env.BASE_URL;
    const userConfig = {
        debridServices: [{ service: "realdebrid", apiKey: "rd-key" }],
        hideUncached: false,
        language: ["ENG"]
    };
    const input = {
        torrents: [{
            hash: "1122334455667788990011223344556677889900",
            title: "[Sub] Anime - 01 [1080p].mkv",
            size: "1.0 GB",
            seeders: "10"
        }],
        availabilityByEntry: [{
            "1122334455667788990011223344556677889900": {
                status: "cached",
                isCached: true,
                files: [{ id: 0, index: 0, name: "Anime - 01.mkv", size: 1000 }]
            }
        }],
        userConfig,
        nexioPayload: encodeConfigPayload(userConfig),
        requestedEp: 1,
        expectedSeason: 1,
        isMovie: false,
        isRawSearch: false,
        flags: { ENG: "EN" },
        extractTags: () => ({ res: "1080p" }),
        extractLanguage: () => "ENG",
        parseSizeToBytes: () => 1000,
        selectBestVideoFile: files => files[0],
        isEpisodeMatch: () => true,
        isSeasonBatch: () => false,
        canonical: { anilistId: "1" }
    };

    try {
        await runWithRequestContext({ baseUrl: "https://vps-server.anime.net:8443" }, async () => {
            const streams = buildDebridStreams(input);
            assert.equal(streams.length, 1);
            assert.match(streams[0].url, /^https:\/\/vps-server\.anime\.net:8443\/resolve\//);
        });
    } finally {
        if (oldEnv) process.env.BASE_URL = oldEnv;
    }
});
