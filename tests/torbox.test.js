const test = require("node:test");
const assert = require("node:assert/strict");

const {
    checkTorBoxCached,
    addTorBoxTorrent,
    generateTorBoxLink,
    getTorBoxUser,
    mapTorBoxFiles,
    mapTorBoxTorrent,
    TORBOX_API_BASE
} = require("../lib/torbox");

const {
    checkStoreTorz,
    addStoreTorz,
    generateStoreLink
} = require("../lib/debrid");

test("checkTorBoxCached checks hashes and formats files correctly", async () => {
    const calls = [];
    const http = {
        get: async (url, options) => {
            calls.push({ url, options });
            return {
                data: {
                    success: true,
                    data: {
                        "08a80a2b0d00925da44f007b4f12e6f34184f1ad": {
                            name: "Test Anime",
                            hash: "08a80a2b0d00925da44f007b4f12e6f34184f1ad",
                            files: [
                                { id: 1, name: "Test Anime - 01.mkv", size: 1000000 }
                            ]
                        }
                    }
                }
            };
        }
    };

    const results = await checkTorBoxCached(
        ["08a80a2b0d00925da44f007b4f12e6f34184f1ad"],
        "test-token",
        { http }
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/v1/api/torrents/checkcached"));
    assert.ok(calls[0].url.includes("format=object"));
    assert.ok(calls[0].url.includes("list_files=true"));
    assert.equal(calls[0].options.headers["Authorization"], "Bearer test-token");

    const item = results["08a80a2b0d00925da44f007b4f12e6f34184f1ad"];
    assert.ok(item);
    assert.equal(item.isCached, true);
    assert.equal(item.status, "cached");
    assert.equal(item.files.length, 1);
    assert.equal(item.files[0].name, "Test Anime - 01.mkv");
    assert.equal(item.files[0].id, 1);
    assert.ok(item.files[0].link.startsWith("torbox://"));
});

test("checkTorBoxCached returns empty object when data is null or empty", async () => {
    const http = {
        get: async () => ({
            data: { success: true, data: null }
        })
    };

    const results = await checkTorBoxCached(["noncachedhash"], "test-token", { http });
    assert.deepEqual(results, {});
});

test("addTorBoxTorrent reuses existing torrent from mylist without creating duplicate", async () => {
    let createCalled = false;
    const http = {
        get: async (url) => {
            if (url.includes("/v1/api/torrents/mylist")) {
                return {
                    data: {
                        success: true,
                        data: [
                            {
                                id: 999,
                                hash: "08a80a2b0d00925da44f007b4f12e6f34184f1ad",
                                download_state: "cached",
                                download_finished: true,
                                files: [
                                    { id: 42, name: "Naruto 01.mkv", size: 500000000 }
                                ]
                            }
                        ]
                    }
                };
            }
            return { data: {} };
        },
        post: async () => {
            createCalled = true;
            return { data: {} };
        }
    };

    const result = await addTorBoxTorrent(
        "magnet:?xt=urn:btih:08a80a2b0d00925da44f007b4f12e6f34184f1ad&dn=Naruto",
        "test-token",
        { http }
    );

    assert.equal(createCalled, false, "Should not call createtorrent when torrent already exists in account");
    assert.equal(result.id, 999);
    assert.equal(result.isCached, true);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].id, 42);
    assert.equal(result.files[0].link, "torbox://999/42");
});

test("addTorBoxTorrent creates torrent when not existing and retrieves it", async () => {
    let created = false;
    const http = {
        get: async (url) => {
            if (!created) {
                // Initial check: empty list
                return { data: { success: true, data: [] } };
            }
            // After creation: returns torrent with id 555
            return {
                data: {
                    success: true,
                    data: [
                        {
                            id: 555,
                            hash: "aabbccddeeff00112233445566778899aabbccdd",
                            download_state: "completed",
                            download_finished: true,
                            files: [
                                { id: 10, name: "Episode 1.mp4", size: 300000000 }
                            ]
                        }
                    ]
                }
            };
        },
        post: async (url) => {
            created = true;
            return {
                data: {
                    success: true,
                    data: { torrent_id: 555 }
                }
            };
        }
    };

    const result = await addTorBoxTorrent(
        "magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd",
        "test-token",
        { http }
    );

    assert.equal(created, true);
    assert.equal(result.id, 555);
    assert.equal(result.isCached, true);
    assert.equal(result.files[0].id, 10);
    assert.equal(result.files[0].link, "torbox://555/10");
});

test("generateTorBoxLink requests direct CDN link and returns it", async () => {
    const http = {
        get: async (url) => {
            assert.ok(url.includes("/v1/api/torrents/requestdl"));
            assert.ok(url.includes("torrent_id=555"));
            assert.ok(url.includes("file_id=10"));
            assert.ok(url.includes("redirect=false"));
            return {
                data: {
                    success: true,
                    data: "https://cdn.torbox.app/stream/video.mp4"
                }
            };
        }
    };

    const link = await generateTorBoxLink("torbox://555/10", "test-token", { http });
    assert.equal(link, "https://cdn.torbox.app/stream/video.mp4");
});

test("generateTorBoxLink falls back to permanent permalink if requestdl fails", async () => {
    const http = {
        get: async () => {
            throw new Error("Rate limit");
        }
    };

    const link = await generateTorBoxLink("torbox://555/10", "test-token", { http });
    assert.ok(link.includes("requestdl?token=test-token&torrent_id=555&file_id=10&redirect=true"));
});

test("checkStoreTorz routes torbox service directly to TorBox native client", async () => {
    const http = {
        get: async (url, options) => {
            assert.ok(url.includes("api.torbox.app"), "URL should be api.torbox.app not stremthru");
            return {
                data: {
                    success: true,
                    data: {
                        "1234567890123456789012345678901234567890": {
                            name: "Direct TB Torrent",
                            files: []
                        }
                    }
                }
            };
        }
    };

    const result = await checkStoreTorz(
        ["1234567890123456789012345678901234567890"],
        { service: "torbox", apiKey: "my-key" },
        { http, cache: false }
    );

    assert.equal(result["1234567890123456789012345678901234567890"].isCached, true);
});

test("addTorBoxTorrent queries mylist?id when existing torrent in mylist has empty files", async () => {
    const queriedIds = [];
    const http = {
        get: async (url) => {
            if (url.includes("/v1/api/torrents/mylist?bypass_cache=true")) {
                return {
                    data: {
                        success: true,
                        data: [
                            {
                                id: 777,
                                hash: "08a80a2b0d00925da44f007b4f12e6f34184f1ad",
                                download_state: "cached",
                                files: [] // Empty in list view
                            }
                        ]
                    }
                };
            }
            if (url.includes("id=777")) {
                queriedIds.push(777);
                return {
                    data: {
                        success: true,
                        data: {
                            id: 777,
                            hash: "08a80a2b0d00925da44f007b4f12e6f34184f1ad",
                            download_state: "completed",
                            download_finished: true,
                            files: [
                                { id: 1, name: "Bleach - 01.mkv", size: 400000000 }
                            ]
                        }
                    }
                };
            }
            return { data: {} };
        },
        post: async () => {
            throw new Error("Should not call createtorrent");
        }
    };

    const result = await addTorBoxTorrent(
        "magnet:?xt=urn:btih:08a80a2b0d00925da44f007b4f12e6f34184f1ad",
        "test-token",
        { http }
    );

    assert.equal(queriedIds.length, 1);
    assert.equal(queriedIds[0], 777);
    assert.equal(result.id, 777);
    assert.equal(result.isCached, true);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, "Bleach - 01.mkv");
});

test("generateTorBoxLink parses object response { success: true, data: { link: '...' } }", async () => {
    const http = {
        get: async (url, config) => {
            assert.ok(url.includes("/v1/api/torrents/requestdl"));
            assert.equal(config.params.torrent_id, "888");
            assert.equal(config.params.file_id, "3");
            return {
                headers: {},
                data: {
                    success: true,
                    data: {
                        link: "https://edge.torbox.app/download/888/file3.mkv",
                        filename: "file3.mkv"
                    }
                }
            };
        }
    };

    const link = await generateTorBoxLink("torbox://888/3", "test-token", { http });
    assert.equal(link, "https://edge.torbox.app/download/888/file3.mkv");
});

test("generateTorBoxLink captures 302 Location header from redirect", async () => {
    const http = {
        get: async (url, config) => {
            if (config.params && config.params.redirect === "false") {
                return {
                    headers: {
                        location: "https://cdn.torbox.app/direct-redirect-link.mp4"
                    },
                    data: ""
                };
            }
            throw new Error("Unexpected call");
        }
    };

    const link = await generateTorBoxLink("torbox://999/1", "test-token", { http });
    assert.equal(link, "https://cdn.torbox.app/direct-redirect-link.mp4");
});

test("generateTorBoxLink resolves numeric ID when link contains a 40-character infohash", async () => {
    const hash = "08a80a2b0d00925da44f007b4f12e6f34184f1ad";
    const http = {
        get: async (url, config) => {
            if (url.includes("/v1/api/torrents/mylist")) {
                return {
                    data: {
                        success: true,
                        data: [
                            { id: 1234, hash: hash }
                        ]
                    }
                };
            }
            if (url.includes("/v1/api/torrents/requestdl")) {
                assert.equal(config.params.torrent_id, 1234, "Should have resolved 40-char hash to numeric ID 1234");
                return {
                    headers: {},
                    data: {
                        success: true,
                        data: "https://edge.torbox.app/video.mkv"
                    }
                };
            }
            throw new Error(`Unexpected url: ${url}`);
        }
    };

    const link = await generateTorBoxLink(`torbox://${hash}/5`, "test-token", { http });
    assert.equal(link, "https://edge.torbox.app/video.mkv");
});

