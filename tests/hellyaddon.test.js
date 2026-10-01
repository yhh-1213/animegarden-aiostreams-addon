const test = require("node:test");
const assert = require("node:assert/strict");

const {
    extractInfoHash,
    base32ToHex
} = require("../lib/animegarden");

const {
    extractSeasonNumber,
    isWrongSeason,
    extractEpisodes,
    getBatchRange,
    isSeasonBatch,
    isEpisodeMatch,
    detectChineseSubtitle,
    detectChineseFansubGroup,
    inspectChineseSubtitle,
    selectBestVideoFile,
    toSimplifiedChinese,
    toTraditionalChinese,
    verifyExactTitleMatch
} = require("../lib/parser");

const {
    generateRomajiVariants,
    resolveAnimeMetaFromTitle
} = require("../lib/anilist");

const {
    encodeConfigPayload,
    parseConfig
} = require("../lib/config");

//=============================================================================
// 1. Anime Garden Base32 & Hash Conversion
//=============================================================================
test("Anime Garden extractInfoHash converts Base32 magnet hashes to 40-character hex", () => {
    // 32-char Base32 hash from Anime Garden
    const base32Hash = "7BSRIRFCYCZ767R5UPF5OXNFR327BHQZ";
    const magnet = `magnet:?xt=urn:btih:${base32Hash}&dn=Example`;
    const hexHash = extractInfoHash(magnet);

    assert.equal(hexHash.length, 40);
    assert.match(hexHash, /^[0-9a-f]{40}$/);
    assert.equal(hexHash, base32ToHex(base32Hash));
});

test("Anime Garden extractInfoHash preserves standard 40-character hex hashes", () => {
    const standardHex = "3e5a557343e82d3b24bb09e51c86518179b00759";
    const magnet = `magnet:?xt=urn:btih:${standardHex}&dn=Example`;
    const result = extractInfoHash(magnet);

    assert.equal(result, standardHex.toLowerCase());
});

//=============================================================================
// 2. Parser: Broadcast Month Stripping & Episode Extraction
//=============================================================================
test("Parser strips broadcast month tags and extracts correct episode", () => {
    // Month tag "★01月新番★" should NOT be matched as Episode 1
    const title = "【喵萌奶茶屋】★01月新番★[葬送的芙莉莲 / Sousou no Frieren][28][1080p][简日双语][招募翻译]";
    const eps = extractEpisodes(title);

    assert.deepEqual(eps, [28]);
    assert.equal(isEpisodeMatch(title, 28, 1), true);
    assert.equal(isEpisodeMatch(title, 1, 1), false);
});

test("Parser extracts dual episode notation like 14 (23) or 25 (01)", () => {
    const dualTitle = "[NC-Raws] 呪術廻戦 懐玉・玉折 / 渋谷事变 - 25 (01) [WEB-DL 1080p]";
    const eps = extractEpisodes(dualTitle);

    assert.ok(eps.includes(25) || eps.includes(1));
    // Should match requested relative episode 1
    assert.equal(isEpisodeMatch(dualTitle, 1, 2, 25), true);
    // Should match absolute episode 25
    assert.equal(isEpisodeMatch(dualTitle, 25, 2, 25), true);
});

//=============================================================================
// 3. Parser: Chinese Season Extraction & Wrong Season Gating
//=============================================================================
test("Parser correctly extracts Chinese season numbers", () => {
    assert.equal(extractSeasonNumber("【ANi】咒术回战 第二季 - 01 [1080P]"), 2);
    assert.equal(extractSeasonNumber("【喵萌奶茶屋】关于我转生变成史莱姆这档事 第3期 [49]"), 3);
    assert.equal(extractSeasonNumber("【豌豆字幕组】鬼灭之刃 柱训练篇 S04 [01]"), 4);
    // When no explicit season is present, returns null (treated as implicit S1)
    assert.equal(extractSeasonNumber("【桜都字幕组】葬送的芙莉莲 [01]"), null);
    assert.equal(isWrongSeason("【桜都字幕组】葬送的芙莉莲 [01]", 1), false);
});

test("Parser rejects wrong season releases", () => {
    const s2Title = "【ANi】咒术回战 第二季 - 01 [1080P]";
    // When requesting Season 1, S2 release must be rejected
    assert.equal(isWrongSeason(s2Title, 1), true);
    // When requesting Season 2, S2 release is accepted
    assert.equal(isWrongSeason(s2Title, 2), false);

    const s1Title = "【ANi】咒术回战 第一季 - 01 [1080P]";
    assert.equal(isWrongSeason(s1Title, 2), true);
});

//=============================================================================
// 4. Parser: Season Batch Range & File Selection
//=============================================================================
test("Parser detects season batch ranges and matches requested episode", () => {
    const batch1 = "【喵萌奶茶屋】[葬送的芙莉莲 / Frieren][01-28全集][1080p][简繁双语]";
    assert.equal(isSeasonBatch(batch1, 1), true);
    const range1 = getBatchRange(batch1);
    assert.deepEqual(range1, { start: 1, end: 28 });

    const batch2 = "【桜都字幕组】鬼灭之刃 柱训练篇 [01~08] [1080p]";
    assert.equal(isSeasonBatch(batch2, 1), true);
    const range2 = getBatchRange(batch2);
    assert.deepEqual(range2, { start: 1, end: 8 });
});

test("selectBestVideoFile picks the exact requested episode inside a season pack", () => {
    const size = 500 * 1024 * 1024; // 500 MB
    const files = [
        { id: "f1", name: "[Group] Frieren - 01 [1080p].mkv", size },
        { id: "f2", name: "[Group] Frieren - 02 [1080p].mkv", size },
        { id: "f3", name: "[Group] Frieren - 03 [1080p].mkv", size },
        { id: "f4", name: "[Group] Frieren - NCED.mkv", size: 20 * 1024 * 1024 }
    ];

    const selectedEp2 = selectBestVideoFile(files, 2, 1);
    assert.ok(selectedEp2);
    assert.equal(selectedEp2.id, "f2");

    const selectedEp3 = selectBestVideoFile(files, 3, 1);
    assert.ok(selectedEp3);
    assert.equal(selectedEp3.id, "f3");
});

test("selectBestVideoFile supports absolute episode matching inside season pack", () => {
    const size = 500 * 1024 * 1024; // 500 MB
    const files = [
        { id: "f25", name: "[ANi] Jujutsu Kaisen - 25 [1080P].mp4", size },
        { id: "f26", name: "[ANi] Jujutsu Kaisen - 26 [1080P].mp4", size }
    ];

    // Requested relative episode 1 of Season 2 (absolute ep 25)
    const selected = selectBestVideoFile(files, 1, 2, false, 25);
    assert.ok(selected);
    assert.equal(selected.id, "f25");
});

test("selectBestVideoFile handles Windows backslash paths without falling back to largest file", () => {
    const files = [
        { id: "e1", name: "\\Seihantai na Kimi to Boku 2026 S01E01-[1080p][BDRIP][x265.OPUS].mkv", size: 500 * 1024 * 1024 },
        { id: "e2", name: "\\Seihantai na Kimi to Boku 2026 S01E02-[1080p][BDRIP][x265.OPUS].mkv", size: 800 * 1024 * 1024 }
    ];

    const selected = selectBestVideoFile(files, 1, 1, false);
    assert.ok(selected);
    assert.equal(selected.id, "e1");
});

//=============================================================================
// 5. Parser: Chinese Subtitle & Fansub Group Detection
//=============================================================================
test("inspectChineseSubtitle identifies hardcoded vs muxed subtitles and external subtitle tracks", () => {
    const hardcoded = inspectChineseSubtitle("[Prejudice-Studio] 正相反的你与我 Seihantai na Kimi to Boku - 01 [Bilibili WEB-DL 1080P AVC 8bit AAC MP4][简日内嵌]");
    assert.equal(hardcoded.hasChinese, true);
    assert.equal(hardcoded.mode, "hardcoded");
    assert.equal(hardcoded.badge, "简中内嵌");

    const muxed = inspectChineseSubtitle("[7³ACG] 相反的你和我/Seihantai na Kimi to Boku S01 | 01-12 [简繁字幕] BDrip 1080p x265 OPUS 2.0");
    assert.equal(muxed.hasChinese, true);
    assert.equal(muxed.mode, "muxed");
    assert.equal(muxed.badge, "简繁内封");

    const external = inspectChineseSubtitle("Raw Show - 01", null, [
        { name: "video.mkv" },
        { name: "subs/ep01.chs.ass" }
    ]);
    assert.equal(external.hasChinese, true);
    assert.equal(external.mode, "external");
    assert.equal(external.badge, "简中外挂");

    const nonChinese = inspectChineseSubtitle("[SubsPlease] Show - 01 (1080p).mkv");
    assert.equal(nonChinese.hasChinese, false);
});
test("detectChineseSubtitle correctly categorizes Simplified, Traditional, and Dual subtitles", () => {
    const subDual = detectChineseSubtitle("【极影字幕社】[简日双语][1080P]");
    assert.equal(subDual.hasChinese, true);
    assert.equal(subDual.type, "CHI_DUAL");

    const subSimp = detectChineseSubtitle("【LoliHouse】[CHS][1080p]");
    assert.equal(subSimp.hasChinese, true);
    assert.equal(subSimp.type, "CHI_SIMP");

    const subTrad = detectChineseSubtitle("【ANi】[Baha][CHT][1080P]");
    assert.equal(subTrad.hasChinese, true);
    assert.equal(subTrad.type, "CHI_TRAD");

    const subEng = detectChineseSubtitle("[English-Subbed] Title 01");
    assert.equal(subEng.hasChinese, false);
});

test("detectChineseFansubGroup recognizes top Chinese fansub groups", () => {
    assert.equal(detectChineseFansubGroup("【喵萌奶茶屋】葬送的芙莉莲 [01]"), "喵萌奶茶屋");
    assert.equal(detectChineseFansubGroup("[ANi] 咒术回战 - 01 [1080P]"), "ANi");
    assert.equal(detectChineseFansubGroup("【LoliHouse】轻音少女 [01]"), "LoliHouse");
    assert.equal(detectChineseFansubGroup("【桜都字幕组】我推的孩子 [01]"), "桜都字幕组");
});

//=============================================================================
// 6. HellyAddon Config Parsing & Defaults
//=============================================================================
test("parseConfig decodes HellyAddon payload with Chinese options", () => {
    const raw = {
        debridServices: [
            { service: "pikpak", apiKey: "user@example.com:password" },
            { service: "torbox", apiKey: "tb-api-key" }
        ],
        strictChinese: true,
        preferChinese: true,
        enableAnimeGarden: true,
        enableNyaa: false
    };

    const payload = encodeConfigPayload(raw);
    const parsed = parseConfig({ HellyAddon: payload });

    assert.equal(parsed.strictChinese, true);
    assert.equal(parsed.preferChinese, true);
    assert.equal(parsed.enableAnimeGarden, true);
    assert.equal(parsed.enableNyaa, false);
    assert.deepEqual(parsed.debridServices, raw.debridServices);
    // Default language ordering prioritizes Chinese
    assert.deepEqual(parsed.language, ["CHI_SIMP", "CHI_TRAD", "CHI_DUAL", "ENG"]);
});

//=============================================================================
// 7. Chinese Simplified/Traditional Normalization & Romaji Smart Matching
//=============================================================================
test("toSimplifiedChinese and toTraditionalChinese convert bidirectional anime titles", () => {
    const simp = "与奔驰于透明之夜的你，谈一场看不见的恋爱。";
    const trad = "與奔馳於透明之夜的你，談一場看不見的戀愛。";

    assert.equal(toTraditionalChinese(simp), trad);
    assert.equal(toSimplifiedChinese(trad), simp);
});

test("generateRomajiVariants generates Hepburn vowel expansion variants", () => {
    const variants = generateRomajiVariants("Tomei na Yoru ni Kakeru Kimi to, Me ni Mienai Koi wo Shita");
    // Must produce "Toumei" variant for AniList compatibility
    assert.ok(variants.some(v => v.includes("Toumei")));
    // Must include clean stripped punctuation variant
    assert.ok(variants.some(v => !v.includes(",")));
});

test("verifyExactTitleMatch matches Traditional Chinese releases against Simplified canonical", () => {
    const rawTrad = "[黒ネズミたち] 與奔馳於透明之夜的你，談一場看不見的戀愛。 / Kakekoi - 12 (ABEMA 1920x1080 AVC AAC MKV)";
    const canonicalSimp = ["与奔驰于透明之夜的你，谈一场看不见的恋爱。"];

    assert.equal(verifyExactTitleMatch(rawTrad, canonicalSimp), true);
});

test("resolveAnimeMetaFromTitle resolves western Cinemeta title with Romaji variance", async () => {
    const meta = await resolveAnimeMetaFromTitle("Tomei na Yoru ni Kakeru Kimi to, Me ni Mienai Koi wo Shita");

    assert.ok(meta);
    assert.match(meta.name, /Toumei na Yoru/i);
    assert.ok(Array.isArray(meta.chineseTitles));
    assert.ok(meta.chineseTitles.some(t => t.includes("透明之夜")));
    assert.equal(meta.subjectId, 607340);
});
