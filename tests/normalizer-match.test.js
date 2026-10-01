const test = require("node:test");
const assert = require("node:assert/strict");

const { filterByCanonical } = require("../lib/normalizer/match");

const NARUTO = { mainTitle: "NARUTO", englishTitle: "Naruto", synonyms: [], format: "TV", year: 2002, episodeCount: 220 };
const ONE_PIECE = { mainTitle: "ONE PIECE", englishTitle: "ONE PIECE", synonyms: [], format: "TV", year: 1999, episodeCount: 1100 };

test("filterByCanonical drops a same-title different-year torrent", async () => {
    const torrents = [
        // legitimate
        { title: "[SubsPlease] Naruto - 01 [1080p].mkv", hash: "good", size: "500 MB", seeders: 100, source: "nyaa" },
        // year-gate fail (Naruto 2002 vs hypothetical 2030 reboot)
        { title: "Naruto Reboot 2030 - 01.mkv", hash: "bad-year", size: "500 MB", seeders: 1, source: "nyaa" }
    ];
    const { kept, dropped } = await filterByCanonical({ canonical: NARUTO, torrents });
    const keptHashes = kept.map(t => t.hash);
    assert.ok(keptHashes.includes("good"), "expected the SubsPlease torrent to survive");
    assert.ok(!keptHashes.includes("bad-year"), "expected the 2030 reboot torrent to be dropped");
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].gateFailures.join(" | "), /year/);
});

test("filterByCanonical drops Recap Movie when canonical is TV", async () => {
    const torrents = [
        { title: "[Erai-raws] One Piece - 1100 [1080p].mkv", hash: "tv", size: "500 MB", seeders: 100 },
        { title: "One Piece Recap Movie [BD 1080p]", hash: "recap", size: "1 GB", seeders: 50 }
    ];
    const { kept, dropped } = await filterByCanonical({ canonical: ONE_PIECE, torrents });
    const keptHashes = kept.map(t => t.hash);
    assert.ok(keptHashes.includes("tv"));
    assert.ok(!keptHashes.includes("recap"));
    assert.match(dropped[0].gateFailures.join(" | "), /recap_tag|short_release|format/);
});

test("filterByCanonical leaves everything kept when no gates fire", async () => {
    const torrents = [
        { title: "[SubsPlease] One Piece - 1100 [1080p].mkv", hash: "a" },
        { title: "[Erai-raws] One Piece - 1101 [720p].mkv", hash: "b" }
    ];
    const { kept, dropped } = await filterByCanonical({ canonical: ONE_PIECE, torrents });
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
});

test("filterByCanonical attaches matchScore + reasons to surviving torrents", async () => {
    const torrents = [
        { title: "[SubsPlease] Naruto - 01 [1080p].mkv", hash: "n" }
    ];
    const { kept } = await filterByCanonical({ canonical: NARUTO, torrents });
    assert.equal(kept.length, 1);
    assert.ok(Number.isFinite(kept[0]._matchScore));
    assert.ok(Array.isArray(kept[0]._matchReasons));
});

test("filterByCanonical returns input verbatim when canonical is missing", async () => {
    const torrents = [{ title: "anything", hash: "x" }];
    const { kept, dropped } = await filterByCanonical({ canonical: null, torrents });
    assert.equal(kept, torrents);
    assert.deepEqual(dropped, []);
});

test("filterByCanonical handles empty torrent list gracefully", async () => {
    const { kept, dropped } = await filterByCanonical({ canonical: NARUTO, torrents: [] });
    assert.deepEqual(kept, []);
    assert.deepEqual(dropped, []);
});

test("filterByCanonical keeps Chinese anime movie releases without title-distance drops", async () => {
    const canonicalMovie = {
        format: "MOVIE",
        year: 2025,
        episodeCount: 1,
        mainTitle: "Chainsaw Man: Reze-hen",
        englishTitle: "Chainsaw Man – The Movie: Reze Arc",
        altName: "Chainsaw Man – The Movie: Reze Arc",
        nativeName: "チェンソーマン レゼ篇",
        synonyms: [
            "剧场版 链锯人 蕾塞篇",
            "链锯人 蕾塞篇",
            "剧场版 电锯人 蕾塞篇",
            "电锯人 蕾塞篇",
            "電鋸人 蕾賽篇",
            "鏈鋸人 蕾潔篇"
        ]
    };
    const torrents = [
        { title: "[NEST] 剧场版 链锯人 蕾塞篇 / 剧场版 チェンソーマン レゼ篇 [MA WEB-DL 2160p HEVC DDP5.1 Atmos][简繁日内封]", hash: "nest2160" },
        { title: "[NEST] 剧场版 链锯人 蕾塞篇 / 剧场版 チェンソーマン レゼ篇 [MA WEB-DL 1080p AVC DDP5.1 Atmos][简繁日内封]", hash: "nest1080" },
        { title: "【豌豆字幕组&风之圣殿字幕组】★剧场版[电锯人 / 链锯人 蕾塞篇][简体][1080P][MP4]", hash: "wandou" },
        { title: "【幻樱字幕组】【剧场版】【电锯人剧场版蕾赛篇 Chainsaw Man The Movie Reze Arc】【GB_MP4】【1920X1080】", hash: "huanying" }
    ];
    const { kept, dropped } = await filterByCanonical({ canonical: canonicalMovie, torrents });
    assert.equal(dropped.length, 0, `unexpectedly dropped torrents: ${JSON.stringify(dropped.map(d => ({ title: d.torrent.title, gates: d.gateFailures })))}`);
    assert.equal(kept.length, 4);
    assert.ok(kept.every(t => t._matchScore >= 100));
});

test("filterByCanonical drops TV series releases when canonical is a MOVIE", async () => {
    const canonicalMugenTrainMovie = {
        format: "MOVIE",
        year: 2020,
        episodeCount: 1,
        mainTitle: "Kimetsu no Yaiba: Mugen Ressha-hen",
        englishTitle: "Demon Slayer: Kimetsu no Yaiba the Movie: Mugen Train",
        altName: "Demon Slayer: Kimetsu no Yaiba the Movie: Mugen Train",
        nativeName: "鬼滅の刃 無限列車編",
        synonyms: [
            "鬼灭之刃 剧场版 无限列车篇",
            "鬼灭之刃 无限列车篇",
            "劇場版 鬼滅之刃 無限列車篇"
        ]
    };

    const torrents = [
        { title: "【豌豆字幕组】鬼灭之刃 剧场版 无限列车篇 BDRip 1080p", hash: "movie1" },
        { title: "[Kamigami] Kimetsu no Yaiba - The Movie Mugen Ressha-hen [1080p]", hash: "movie2" },
        // TV arc episode releases with similar names that must be dropped
        { title: "【极影字幕社】鬼灭之刃 无限列车篇 第01话 720p", hash: "tv_ep1" },
        { title: "【喵萌奶茶屋】鬼灭之刃 无限列车篇 TV版 01-07 [1080p]", hash: "tv_batch" },
        { title: "[SubsPlease] Kimetsu no Yaiba: Mugen Ressha-hen - 01 [1080p].mkv", hash: "tv_subsp" }
    ];

    const { kept, dropped } = await filterByCanonical({ canonical: canonicalMugenTrainMovie, torrents });
    const keptHashes = kept.map(t => t.hash);
    const droppedHashes = dropped.map(d => d.torrent.hash);

    assert.deepEqual(keptHashes.sort(), ["movie1", "movie2"].sort());
    assert.deepEqual(droppedHashes.sort(), ["tv_batch", "tv_ep1", "tv_subsp"].sort());
});

test("filterByCanonical drops standalone movie releases when canonical is TV series", async () => {
    const canonicalDemonSlayerTV = {
        mainTitle: "Kimetsu no Yaiba",
        englishTitle: "Demon Slayer: Kimetsu no Yaiba",
        synonyms: ["鬼灭之刃"],
        format: "TV",
        year: 2019,
        episodeCount: 26
    };

    const torrents = [
        { title: "[SubsPlease] Kimetsu no Yaiba - 01 [1080p].mkv", hash: "tv_good" },
        { title: "【豌豆字幕组】鬼灭之刃 剧场版 无限列车篇 BDRip 1080p", hash: "movie_bad" }
    ];

    const { kept, dropped } = await filterByCanonical({ canonical: canonicalDemonSlayerTV, torrents });
    assert.equal(kept.length, 1);
    assert.equal(kept[0].hash, "tv_good");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].torrent.hash, "movie_bad");
});
