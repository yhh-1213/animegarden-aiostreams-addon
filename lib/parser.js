//===============
// HELLYADDON PARSING ENGINE
// Precision matching for Chinese & International anime releases.
// Features:
// - Exact Title Matching against multi-lingual canonical titles
// - Season Pack / Batch range compatibility
// - Absolute anime numbering & dual-numbering compatibility (e.g. 14 (23))
// - Broadcast month & date stripping (prevents "★01月新番★" false episode match)
// - Strict Season Gate (prevents wrong sequels / prequels)
// - Chinese subtitle detection (CHS, CHT, Dual, Fansub groups)
//===============

const CHINESE_FANSUB_GROUPS = [
    "ANi", "LoliHouse", "SweetSub", "喵萌奶茶屋", "桜都字幕组", "北宇治字幕组",
    "极影字幕社", "动漫国字幕组", "爱恋字幕社", "千夏字幕组", "幻樱字幕组",
    "悠哈璃羽字幕社", "银色子弹字幕组", "VCB-Studio", "DBD制作组", "诸神字幕组",
    "澄空学园", "雪飘工作室", "漫游字幕组", "猎户发布组", "豌豆字幕组",
    "天月動漫", "绿茶字幕组", "三明治摆烂组", "魔星字幕团", "拨雪寻春",
    "夜莺家族", "亿次研同好会", "风之圣殿", "云歌字幕组", "离谱Sub",
    "MingYSub", "H-Enc", "PorterRAWS", "Kirara Fantasia", "百冬練習組",
    "TSDM字幕組", "GMTeam", "丸子家族", "黑白字幕组", "驯兽师联盟", "星空字幕组",
    "Lilith-Raws", "NC-Raws", "Nix-Raws", "Shiniori-Raws"
];

const CHINESE_NUM_MAP = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    "十一": 11, "十二": 12, "十三": 13, "十四": 14, "十五": 15, "十六": 16, "十七": 17, "十八": 18, "十九": 19, "二十": 20
};

function parseChineseNumber(str) {
    if (!str) return null;
    str = String(str).trim();
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    if (CHINESE_NUM_MAP[str]) return CHINESE_NUM_MAP[str];
    return null;
}

//===============
// SANITIZE FILENAME
// Strips codecs, resolutions, date stamps, broadcast tags (★01月新番★), and metadata.
//===============
function sanitizeFilename(filename) {
    if (!filename) return "";
    return filename
        .replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "")
        // Strip release month e.g. ★01月新番★, [10月新番], 4月新番
        .replace(/[★☆\[【]\s*\d{1,2}月新番\s*[★☆\]】]/gi, " ")
        .replace(/\b\d{1,2}月新番\b/gi, " ")
        // Strip dates e.g. [2024.01.15], 2023-10-05, 2024/01/01
        .replace(/\[?\b20\d{2}[.\-\/]\d{1,2}[.\-\/]\d{1,2}\b\]?/g, " ")
        // Strip resolutions and codecs
        .replace(/\b(?:\d{3,4}x\d{3,4})\b/gi, " ")
        .replace(/(?<![全第共])\b(?:2160|1080|810|720|576|540|480|360)(?:[pix]+|\b(?![集话話期部回]))/gi, " ")
        .replace(/\b(?:x|h)26[45]\b/gi, " ")
        .replace(/\b(?:HEVC|AVC|AV1|FHD|HD|SD|10-?bits?|8-?bits?|12-?bits?|Hi10P|Hi444P)\b/gi, " ")
        .replace(/\b(?:BD|BDRip|Blu-?ray|WEB-?DL|WEB-?Rip|DVD|DVDRip|TVRip|HDTV|CAM)\b/gi, " ")
        .replace(/\b(?:FLAC|AAC|AC3|DTS|DTS-HD|TrueHD|Vorbis|Opus|MP3|PCM)\b/gi, " ")
        .replace(/\b(?:Uncensored|Censored|Decensored|Uncen|Dual-?Audio|Multi-?Subs|RAW|Hentai)\b/gi, " ")
        .replace(/\b(?:5\.1|2\.0|7\.1|2\.1)\b/g, " ")
        .replace(/\[[a-fA-F0-9]{8}\]/g, " ") // CRC checksums
        .replace(/\b(?:NC)?(?:OP|ED|Opening|Ending)\s*\d*\b/gi, " ")
        .replace(/\b(?:v\d)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

//===============
// NORMALIZE TITLE
// Translates Roman Numerals and normalizes punctuation for string comparison.
//===============
function normalizeTitle(text) {
    if (!text) return "";
    return String(text).toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\u3000]/g, " ")
        .replace(/[ⅰⅠ]/g, "i").replace(/[ⅱⅡ]/g, "ii").replace(/[ⅲⅢ]/g, "iii")
        .replace(/[ⅳⅣ]/g, "iv").replace(/[ⅴⅤ]/g, "v").replace(/[ⅵⅥ]/g, "vi")
        .replace(/[ⅶⅦ]/g, "vii").replace(/[ⅷⅧ]/g, "viii").replace(/[ⅸⅨ]/g, "ix").replace(/[ⅹⅩ]/g, "x")
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—–～〜♥♡★☆♪\u2013\u2014]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

//===============
// EXTRACT SEASON NUMBER
// Detects season specifications in Chinese (第二季, 第2期) and English (Season 2, S2).
//===============
const ROMAN_MAP = {
    "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8,
    "ⅱ": 2, "ⅲ": 3, "ⅳ": 4, "ⅴ": 5, "ⅵ": 6, "ⅶ": 7, "ⅷ": 8
};

//===============
// EXTRACT SEASON RANGE
// Detects multi-season ranges: S1-S3, S01-S03, Season 1-3, 第1-3季, 第1~3期, 1-3期, 第一季~第三季
//===============
function extractSeasonRange(filename) {
    if (!filename) return null;
    const clean = sanitizeFilename(filename);

    // 1. S1-S3, S01-S03, S1~S3
    const sRange = clean.match(/\bs0*(\d+)\s*(?:-|~|～|至|到|to)\s*s?0*(\d+)\b/i);
    if (sRange) {
        const start = parseInt(sRange[1], 10);
        const end = parseInt(sRange[2], 10);
        if (end > start && end - start < 20) return { start, end };
    }

    // 2. Season 1-3, Season 01-03
    const seasonWordRange = clean.match(/\bseason\s*0*(\d+)\s*(?:-|~|～|至|到|to)\s*0*(\d+)\b/i);
    if (seasonWordRange) {
        const start = parseInt(seasonWordRange[1], 10);
        const end = parseInt(seasonWordRange[2], 10);
        if (end > start && end - start < 20) return { start, end };
    }

    // 3. 第1-3季, 第1~3期, 1-3季, 1-3期, 第一季-第三季
    const cnRange = clean.match(/(?:第\s*)?([0-9一二三四五六七八九十]+)\s*(?:季|期|部)?\s*[-~～至到to]\s*(?:第\s*)?([0-9一二三四五六七八九十]+)\s*(?:季|期|部)/i);
    if (cnRange) {
        const start = parseChineseNumber(cnRange[1]);
        const end = parseChineseNumber(cnRange[2]);
        if (start && end && end > start && end - start < 20) return { start, end };
    }

    return null;
}

function extractSeasonNumber(filename) {
    if (!filename) return null;

    // 1. The Final Season / 最终季 (sentinel 999)
    if (/\b(?:the\s+)?final\s+(?:season|act)\b|最终季/i.test(filename)) {
        return 999;
    }

    // Strip total episode count markers: 全12话, 全24集, 全12期
    const seasonTarget = filename.replace(/[全共]\s*[0-9一二三四五六七八九十]+\s*(?:季|期|部|集|话|話)/g, " ");

    // 2. Chinese & Japanese seasons: 第2季, 第二季, 第2期, 第二期, 第二部, 第2部, 3期, 2期, 3季
    const cnSeasonMatch = seasonTarget.match(/(?:第\s*)?([0-9一二三四五六七八九十]+)\s*(?:季|期|部)/);
    if (cnSeasonMatch) {
        const num = parseChineseNumber(cnSeasonMatch[1]);
        if (num && num <= 15) return num;
    }

    // 3. Title bracket season numbers: 【进击的巨人 3】, [Shingeki no Kyojin 3], 【进击的巨人3】
    // Exclude slashes and video codecs like [MP4], [H264]
    const cnBracket = filename.match(/[【\[](?:[^\d\]】\/]*[\u4e00-\u9fa5]{2,}[^\d\]】\/]*)\s*([2-9])[】\]]/);
    if (cnBracket) return parseInt(cnBracket[1], 10);

    const enBracket = filename.match(/[【\[](?:[A-Za-z0-9\s]{3,})\s+([2-9])[】\]]/);
    if (enBracket) {
        const inner = enBracket[0].slice(1, -1).trim();
        if (!/^(?:mp|h|x|avc|hevc)\d+/i.test(inner)) {
            return parseInt(enBracket[1], 10);
        }
    }

    // 4. Bracket Roman numerals: 【进击的巨人 III】, [Overlord IV] (excluding 'vi' to avoid Vietnamese lang tag)
    const bracketRoman = filename.match(/[【\[](?:[^\d\]】\/]{2,})\s*(ii|iii|iv|vii|viii|[ⅱⅲⅳⅴⅵⅶⅷ])[】\]]/i);
    if (bracketRoman) {
        const val = bracketRoman[1].toLowerCase();
        if (ROMAN_MAP[val]) return ROMAN_MAP[val];
    }

    const text = filename.toLowerCase();

    // 5. English nth season: 2nd Season, 3rd Season
    const nthMatch = text.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/i);
    if (nthMatch) return parseInt(nthMatch[1], 10);

    // 6. Explicit Season + word / roman: Season 2, Season II, Second Season
    const wordSeasonMatch = text.match(/\b(?:season\s+(?:0*(\d+)|(ii|iii|iv|v|vi|vii|viii))|(second|third|fourth|fifth|sixth|ii|iii|iv|v|vi|vii|viii)\s+season)\b/i);
    if (wordSeasonMatch) {
        if (wordSeasonMatch[1]) return parseInt(wordSeasonMatch[1], 10);
        const val = (wordSeasonMatch[2] || wordSeasonMatch[3]).toLowerCase();
        if (ROMAN_MAP[val]) return ROMAN_MAP[val];
        if (val === "second") return 2;
        if (val === "third") return 3;
        if (val === "fourth") return 4;
        if (val === "fifth") return 5;
        if (val === "sixth") return 6;
    }

    // 7. Standard S2, S02, Season 2
    const sMatch = text.match(/\b(?:s|season)\s*0*(\d+)\b/i);
    if (sMatch) return parseInt(sMatch[1], 10);

    // 8. Standalone Roman numerals (II, III, IV, VII, VIII - excluding VI to avoid Vietnamese subtitle collision)
    const standaloneRoman = text.match(/\b(ii|iii|iv|vii|viii)\b/i);
    if (standaloneRoman) {
        const val = standaloneRoman[1].toLowerCase();
        if (ROMAN_MAP[val]) return ROMAN_MAP[val];
    }

    // 9. Standalone Unicode Roman numerals
    const unicodeRoman = filename.match(/([ⅡⅢⅣⅤⅥⅦⅧⅱⅲⅳⅴⅵⅶⅷ])/);
    if (unicodeRoman) {
        const val = unicodeRoman[1].toLowerCase();
        if (ROMAN_MAP[val]) return ROMAN_MAP[val];
    }

    return null;
}

//===============
// IS WRONG SEASON
// Strict verification mechanism: drops torrents meant for other seasons.
//===============
function isWrongSeason(filename, expectedSeason = 1) {
    const isFinal = /\b(?:the\s+)?final\s+(?:season|act)\b|最终季/i.test(filename);
    if (isFinal) {
        // If user is searching for Season 1, 2, or 3, Final Season is ALWAYS wrong season
        if (expectedSeason < 4) return true;
        return false;
    }

    const seasonRange = extractSeasonRange(filename);
    if (seasonRange) {
        // If it's a season range, check if expectedSeason is within that range
        if (expectedSeason >= seasonRange.start && expectedSeason <= seasonRange.end) {
            return false;
        }
        return true;
    }

    const foundSeason = extractSeasonNumber(filename);
    if (foundSeason !== null) {
        if (foundSeason === 999) {
            return expectedSeason < 4;
        }
        return foundSeason !== expectedSeason;
    }
    return false;
}

//===============
// EXTRACT EPISODES
// Extracts candidate episode numbers, including dual notation: 14 (23) or 25 (01).
//===============
function extractEpisodes(filename, expectedSeason = 1) {
    const clean = sanitizeFilename(filename);
    const results = [];

    // Strip season indicator before searching for episodes
    const seasonStripped = clean
        .replace(/\b(?:the\s+)?final\s+(?:season|act)\b|最终季/ig, " ")
        .replace(/第\s*[0-9一二三四五六七八九十]+\s*(?:季|期|部)/g, " ")
        .replace(/\b\d+(?:st|nd|rd|th)\s+(?:Season|Part|Cour)\b/ig, " ")
        .replace(/\b(?:s|season|part|cour)\s*0*\d+\b/ig, " ");

    // 1. Dual episode notation: e.g. "14 (23)", "25 (01)", "第25话(第01话)"
    const dualMatch = seasonStripped.match(/(?:^|\s|-|第)0*(\d+)(?:\s*(?:话|話|集|回))?\s*[\(\[（]\s*(?:第)?0*(\d+)(?:\s*(?:话|話|集|回))?\s*[\)\]）]/);
    if (dualMatch) {
        const ep1 = parseInt(dualMatch[1], 10);
        const ep2 = parseInt(dualMatch[2], 10);
        results.push(ep1, ep2);
        return results;
    }

    // 2. Explicit Chinese episode format: 第01话, 第12集, 第5回
    const cnEpMatch = seasonStripped.match(/第\s*0*(\d+)\s*(?:话|話|集|回)/i);
    if (cnEpMatch) {
        results.push(parseInt(cnEpMatch[1], 10));
        return results;
    }

    // 3. Explicit standard format: S01E05, EP05, Ep 05, E05
    const explicitRegex = /(?:ep(?:isode)?\.?\s*|\be\s*|ova\s*|oad\s*|special\s*|round\s*|act\s*|chapter\s*|part\s*|vol(?:ume)?\.?\s*|#\s*|s(\d+)\s*e|season\s*(\d+)\s*ep(?:isode)?\s*)0*(\d+)(?:\s*(?:巻|話|话|集|화|회|편|v\d+))?(?:\D|$)/i;
    const explicitMatch = seasonStripped.match(explicitRegex);
    if (explicitMatch) {
        const fileSeason = explicitMatch[1] || explicitMatch[2];
        if (fileSeason !== undefined && parseInt(fileSeason, 10) !== expectedSeason) {
            return [];
        }
        results.push(parseInt(explicitMatch[3], 10));
        return results;
    }

    // 4. Dash format: " - 01 "
    const dashMatch = seasonStripped.match(/(?:^|\s)\-\s+0*(\d+)(?:\D|$)/i);
    if (dashMatch) {
        results.push(parseInt(dashMatch[1], 10));
        return results;
    }

    // 5. Isolated bracket number: [01], 【01】
    const bracketMatches = [...seasonStripped.matchAll(/[\[【\(（]0*(\d+)[\]】\)）]/g)];
    for (const bm of bracketMatches) {
        const val = parseInt(bm[1], 10);
        if (val > 0 && val < 2000) {
            results.push(val);
        }
    }
    if (results.length > 0) return results;

    // 6. Isolated number tokens at end or middle
    const tokens = seasonStripped.replace(/[\[\]\(\)\{\}_\-\+~,#]/g, " ").trim().split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        const numMatch = token.match(/^e?0*(\d+)(?:v\d+)?$/i);
        if (numMatch) {
            const val = parseInt(numMatch[1], 10);
            if (val > 0 && val < 2000) {
                results.push(val);
                break;
            }
        }
    }

    return results;
}

function extractEpisodeNumber(filename, expectedSeason = 1) {
    const eps = extractEpisodes(filename, expectedSeason);
    return eps.length > 0 ? eps[0] : null;
}

function extractLooseEpisode(filename) {
    let clean = sanitizeFilename(filename);
    clean = clean.replace(/\b(?:S|Season|Part|Cour)\s*0*\d+\b/ig, "");
    clean = clean.replace(/(?:第|시즌\s*)?0*\d+\s*(?:季|期|기|部)/ig, "");
    clean = clean.replace(/\b\d+(?:st|nd|rd|th)\s+(?:Season|Part|Cour)\b/ig, "");

    const regex = /(?:^|[\s\[\]\(\)\{\}_\-\+~,#])0*(\d+)(?:v\d+)?(?:\s|$)/ig;
    let match;
    while ((match = regex.exec(clean)) !== null) {
        const num = parseInt(match[1], 10);
        if (num < 2000 && num > 0) return num;
    }
    return null;
}

//===============
// GET BATCH RANGE
// Identifies if a string is a range like "01-12", "01~28", or "全12话" (season batch).
//===============
function getBatchRange(filename) {
    if (!filename) return null;
    let clean = sanitizeFilename(filename);

    // Strip broadcast year ranges like [2002-2017] or (1999-2005)
    clean = clean.replace(/(?:^|\D)(?:19|20)\d{2}\s*[-~至到to]\s*(?:19|20)\d{2}(?:\D|$)/g, " ");

    // Strip season ranges like S01-S02
    clean = clean.replace(/\b(?:s|season|part|cour)\s*0*\d+\s*(?:-|~|to|a|&|\+)\s*(?:s|season|part|cour)?\s*0*\d+\b/ig, "");
    clean = clean.replace(/(?:第|시즌\s*)?0*\d+\s*(?:-|~|to|a|&|\+)\s*(?:第|시즌\s*)?0*\d+\s*(?:季|期|기|部)/ig, "");

    // 1. Explicit full count: 全12话, 全24集, 全28話, 全720集
    const fullMatch = clean.match(/全\s*0*(\d+)\s*(?:话|話|集|回)/) || filename.match(/全\s*0*(\d+)\s*(?:话|話|集|回)/);
    if (fullMatch) {
        const count = parseInt(fullMatch[1], 10);
        if (count > 0 && count < 3000) return { start: 1, end: count };
    }

    // 2. Range match: 01-12, 01~28, 第01-12话, 01至12集
    const batchMatch = clean.match(/(?:^|\D)(?:第\s*|vol(?:ume)?\.?\s*|e?p?\.?\s*)?0*(\d+)\s*(?:-|~|～|至|到|to|a|&|\+)\s*(?:e?p?\.?\s*)?0*(\d+)(?:\s*(?:巻|話|话|集|화|회|편))?(?:\D|$)/i);
    if (batchMatch) {
        const start = parseInt(batchMatch[1], 10);
        const end = parseInt(batchMatch[2], 10);
        if (end > start && end - start < 3000) return { start, end };
    }

    return null;
}

//===============
// IS SEASON BATCH
// Verifies if the torrent covers an entire season or batch of episodes.
//===============
function isSeasonBatch(filename, expectedSeason = 1, requestedEp = null, absoluteEp = null) {
    if (isWrongSeason(filename, expectedSeason)) return false;

    const clean = filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i, "");
    const batchRange = getBatchRange(filename);
    const foundSeason = extractSeasonNumber(filename);
    const seasonRange = extractSeasonRange(filename);
    const seasonMatchesExplicitly = (foundSeason !== null && foundSeason === expectedSeason) ||
                                   (seasonRange !== null && expectedSeason >= seasonRange.start && expectedSeason <= seasonRange.end);

    if (batchRange && batchRange.end > batchRange.start) {
        if (requestedEp !== null && requestedEp !== undefined) {
            const epNum = parseInt(requestedEp, 10);
            const absNum = absoluteEp ? parseInt(absoluteEp, 10) : null;

            if (expectedSeason > 1) {
                // If expectedSeason > 1:
                // Case A: The torrent explicitly matches the season (e.g. S3 [01-12]), so relative epNum is valid
                if (seasonMatchesExplicitly) {
                    const inRange = (epNum >= batchRange.start && epNum <= batchRange.end) ||
                                    (absNum && absNum >= batchRange.start && absNum <= batchRange.end);
                    if (!inRange) return false;
                    return true;
                }
                // Case B: Unlabelled torrent (foundSeason === null)
                // Relative epNum CANNOT be trusted to belong to Season > 1.
                // It can ONLY match if the batch covers the absolute episode number (e.g. absNum=26 in [01-36])
                if (absNum && absNum >= batchRange.start && absNum <= batchRange.end) {
                    return true;
                }
                return false;
            } else {
                // expectedSeason === 1
                const inRange = (epNum >= batchRange.start && epNum <= batchRange.end) ||
                                (absNum && absNum >= batchRange.start && absNum <= batchRange.end);
                if (!inRange) return false;
                return true;
            }
        }
        if (expectedSeason > 1 && !seasonMatchesExplicitly) {
            return false;
        }
        return true;
    }

    const hasBatchWord = /\b(batch|complete|collection|boxset|box-set|box\b|bd-box|dvd-box|all episodes|all eps)\b|合集|全集|全套|TV全集/i.test(clean);
    if (hasBatchWord) {
        if (expectedSeason > 1 && !seasonMatchesExplicitly) {
            return false;
        }
        return true;
    }

    return false;
}

//===============
// IS MOVIE RELEASE
// Identifies if a release title explicitly indicates a theatrical / movie release.
//===============
function isMovieRelease(filename) {
    if (!filename) return false;
    return /\b(Movie|Gekijouban|Gekijou-?ban|Theatrical|The\s+Movie|Film)\b|剧场版|劇場版|电影|電影|映画/i.test(filename);
}

//===============
// IS TV SERIES RELEASE
// Detects if a torrent corresponds to an episodic TV broadcast series or season batch.
//===============
function isTVSeriesRelease(filename) {
    if (!filename) return false;
    const clean = filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i, "");

    // 1. Explicit TV version / broadcast markers: TV版, (TV), [TV], TV Series, TV全集
    if (/\b(?:TV\s*(?:Series|Rip|Ver(?:sion)?)|TV版)\b|TV全集|全\d+集|全\d+话|[\[\(（【]\s*TV\s*[\]\)）】]/i.test(clean)) {
        return true;
    }

    // 2. Batch ranges: 01-12, 01~24, 全12话
    const batch = getBatchRange(clean);
    if (batch && batch.end > batch.start) {
        return true;
    }

    // 3. Batch words: 全集, 合集, 全套 (excluding movie collections)
    if (/\b(batch|complete|boxset|box-set|bd-box|dvd-box|all episodes)\b|合集|全集|全套/i.test(clean)) {
        if (!/\b(movie\s*(?:box|collection)|剧场版合集)\b/i.test(clean)) {
            return true;
        }
    }

    // 4. Explicit Season markers: Season 2, S02, 第二季, 最终季 (unless it's explicitly a movie like "银魂 剧场版 完结篇")
    const season = extractSeasonNumber(clean);
    if (season !== null) {
        if (!isMovieRelease(clean) || season !== 999) {
            return true;
        }
    }

    // 5. Explicit Episode notation: 第01话, 第12集, EP01, Ep.05, S01E03
    if (/第\s*0*\d+\s*(?:话|話|集|回)/i.test(clean)) return true;
    if (/\b(?:ep|episode)\.?\s*0*\d+\b/i.test(clean)) return true;
    if (/\bS\d+\s*E\d+\b/i.test(clean)) return true;

    // 6. Dash episode: " - 01 ", " - 12 ", " - 01 [", " - 01.mkv"
    if (/(?:^|\s)\-\s+0*\d+(?:\s|$|\[|\.|\()/i.test(clean)) {
        return true;
    }

    // 7. Isolated bracket episode number: [01], 【01】, [12]
    const bracketMatches = [...clean.matchAll(/[\[【\(（]\s*0*(\d{1,4})\s*[\]】\)）]/g)];
    for (const bm of bracketMatches) {
        const val = parseInt(bm[1], 10);
        if (val === 480 || val === 576 || val === 720 || val === 1080 || val === 2160) continue;
        if (val >= 1950 && val <= 2050) continue; // Years
        if (val === 8 || val === 10) continue; // Bit depth
        if (bm[1].startsWith("0") || (val >= 1 && val <= 300)) {
            const index = bm.index + bm[0].length;
            const following = clean.slice(index, index + 5).toLowerCase();
            if (/^(?:fps|bit|k|hz)/.test(following)) continue;
            return true;
        }
    }

    // 8. TV seasonal broadcast tags: 2013春, 2024秋, 10月新番, 4月番
    if (/\b\d{4}\s*(?:春|夏|秋|冬)|(?:1|4|7|10)月\s*(?:新?番|期)|\b新番\b/i.test(clean)) {
        return true;
    }

    // 9. Slash-bounded episode numbers: // 13 //, / 01 /, // 01-12 //
    const slashMatch = clean.match(/(?:^|\s|\/)\/\s*0*(\d{1,4})(?:v\d+)?\s*\/(?:\s|$|\/)/);
    if (slashMatch) {
        const val = parseInt(slashMatch[1], 10);
        if (val > 0 && val < 2000 && val !== 1080 && val !== 720 && val !== 480 && val !== 2160) {
            return true;
        }
    }

    return false;
}

//===============
// IS EPISODE MATCH
// Accurately checks if a torrent/file matches the requested season, episode, or absolute episode.
//===============
function isEpisodeMatch(name, requestedEp, expectedSeason = 1, absoluteEp = null) {
    if (isWrongSeason(name, expectedSeason)) return false;

    const hasVideoExt = /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i.test(name);
    const parts = name.split(/[/\\]/);
    const filename = hasVideoExt ? parts[parts.length - 1] : name;
    const epNum = parseInt(requestedEp, 10);
    const absNum = absoluteEp ? parseInt(absoluteEp, 10) : null;

    const foundSeason = extractSeasonNumber(name);
    const seasonRange = extractSeasonRange(name);
    const seasonMatchesExplicitly = (foundSeason !== null && foundSeason === expectedSeason) ||
                                   (seasonRange !== null && expectedSeason >= seasonRange.start && expectedSeason <= seasonRange.end);

    // 1. Check Batch Range (check both filename and full name in case slashes exist in torrent title)
    const batch = getBatchRange(filename) || getBatchRange(name);
    if (batch) {
        if (expectedSeason > 1) {
            if (seasonMatchesExplicitly && epNum >= batch.start && epNum <= batch.end) return true;
            if (absNum && absNum >= batch.start && absNum <= batch.end) return true;
            return false;
        } else {
            if (epNum >= batch.start && epNum <= batch.end) return true;
            if (absNum && absNum >= batch.start && absNum <= batch.end) return true;
            return false;
        }
    }

    // 2. Check Candidate Episodes (supports dual numbering: e.g. 14 (23))
    const candidates = [...new Set([...extractEpisodes(filename, expectedSeason), ...extractEpisodes(name, expectedSeason)])];
    for (const ep of candidates) {
        if (absNum && ep === absNum) {
            return true;
        }
        if (ep === epNum) {
            // If Season > 1, relative episode MUST explicitly match expected season
            if (expectedSeason > 1) {
                if (seasonMatchesExplicitly) return true;
                return false;
            }
            return true;
        }
    }

    // 3. Fallback loose matching
    const loose = extractLooseEpisode(filename) !== null ? extractLooseEpisode(filename) : extractLooseEpisode(name);
    if (loose !== null) {
        if (absNum && loose === absNum) return true;
        if (loose === epNum) {
            if (expectedSeason > 1) {
                if (seasonMatchesExplicitly) return true;
                return false;
            }
            return true;
        }
    }

    return false;
}

//===============
// CHINESE CHARACTER NORMALIZATION (SIMPLIFIED / TRADITIONAL)
//===============
const S_TO_T = {
    "与": "與", "于": "於", "驰": "馳", "恋": "戀", "爱": "愛", "谈": "談", "场": "場",
    "见": "見", "无": "無", "战": "戰", "门": "門", "间": "間", "时": "時", "国": "國",
    "头": "頭", "东": "東", "车": "車", "话": "話", "录": "錄", "传": "傳", "变": "變",
    "剧": "劇", "电": "電", "视": "視", "声": "聲", "双": "雙", "语": "語", "简": "簡",
    "繁": "繁", "乐": "樂", "风": "風", "学": "學", "宝": "寶", "龙": "龍", "机": "機",
    "动": "動", "斩": "斬", "进": "進", "击": "擊", "转": "轉", "异": "異", "从": "從",
    "灵": "靈", "兽": "獸", "银": "銀", "剑": "劍", "魔": "魔", "师": "師", "后": "後",
    "归": "歸", "来": "來", "约": "約", "会": "會", "险": "險", "终": "終", "结": "結",
    "总": "總", "链": "鏈", "锯": "鋸", "点": "點", "线": "線", "体": "體", "实": "實",
    "开": "開", "关": "關", "两": "兩", "并": "並", "发": "發", "现": "現", "长": "長",
    "过": "過", "对": "對", "给": "給", "还": "還", "这": "這", "么": "麼", "样": "樣"
};

const T_TO_S = {};
for (const [s, t] of Object.entries(S_TO_T)) {
    T_TO_S[t] = s;
}

function toTraditionalChinese(str) {
    if (!str || typeof str !== "string") return "";
    return str.split("").map(ch => S_TO_T[ch] || ch).join("");
}

function toSimplifiedChinese(str) {
    if (!str || typeof str !== "string") return "";
    return str.split("").map(ch => T_TO_S[ch] || ch).join("");
}

//===============
// EXACT TITLE MATCHING ENGINE
// Matches torrent title against multi-lingual canonical titles with anti-slop gating.
//===============
function verifyExactTitleMatch(filename, canonicalTitles, options = {}) {
    if (!canonicalTitles || canonicalTitles.length === 0) return true;

    const cleanInput = normalizeTitle(filename);
    if (!cleanInput) return false;

    // Check if filename contains any canonical title
    for (const title of canonicalTitles) {
        if (!title) continue;
        const cleanTitle = normalizeTitle(title);
        if (!cleanTitle || cleanTitle.length < 2) continue;

        // Exact substring boundary check
        const escaped = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(?:^|\\s|[\\/\\[【\(])${escaped}(?:\\s|$|[\\/\\]】\)])`, "i");
        if (regex.test(cleanInput)) {
            return true;
        }

        // For CJK characters (without spaces and S/T normalization)
        if (/[^\x00-\x7F]/.test(cleanTitle)) {
            const noSpaceInput = cleanInput.replace(/\s+/g, "");
            const noSpaceTitle = cleanTitle.replace(/\s+/g, "");
            if (noSpaceInput.includes(noSpaceTitle)) {
                return true;
            }
            const simpInput = toSimplifiedChinese(noSpaceInput);
            const simpTitle = toSimplifiedChinese(noSpaceTitle);
            if (simpInput.includes(simpTitle)) {
                return true;
            }
        }
    }

    return false;
}

// Alias for backwards compatibility
function verifyTitleMatch(filename, searchTitles) {
    return verifyExactTitleMatch(filename, searchTitles);
}

//===============
// CHINESE SUBTITLE DETECTION
// Identifies Simplified (CHS), Traditional (CHT), and Dual/Bilingual subtitles.
//===============
function detectChineseSubtitle(title, fansub = null) {
    const t = String(title || "");
    const lower = t.toLowerCase();

    const hasSimp = /\b(chs|gb|sc|zh-cn|zh-hans|schinese)\b|简|简体|简中|简日|内嵌简中/i.test(t);
    const hasTrad = /\b(cht|big5|tc|zh-tw|zh-hk|zh-hant|tchinese)\b|繁|繁体|繁中|繁日|内嵌繁中/i.test(t);
    const hasDual = /双语|雙語|简繁|簡繁|中日|中字|中文字幕|中文内嵌|内嵌中字/i.test(t);
    const hasGroup = CHINESE_FANSUB_GROUPS.some(g => t.includes(g) || (fansub && fansub.includes(g)));

    if (hasSimp && hasTrad) return { hasChinese: true, type: "CHI_DUAL", label: "简繁" };
    if (hasDual) return { hasChinese: true, type: "CHI_DUAL", label: "双语" };
    if (hasSimp) return { hasChinese: true, type: "CHI_SIMP", label: "简中" };
    if (hasTrad) return { hasChinese: true, type: "CHI_TRAD", label: "繁中" };
    if (hasGroup) return { hasChinese: true, type: "CHI_DUAL", label: "中文" };

    if (/\b(chi|chinese|mandarin|zh)\b/i.test(lower)) {
        return { hasChinese: true, type: "CHI_SIMP", label: "中文" };
    }

    return { hasChinese: false, type: null, label: null };
}

function detectChineseFansubGroup(title) {
    if (!title) return null;
    const t = String(title);
    for (const group of CHINESE_FANSUB_GROUPS) {
        if (t.includes(group)) return group;
    }
    return null;
}

//===============
// INSPECT CHINESE SUBTITLE TYPE & MODE
// Distinguishes hardcoded (内嵌), muxed container (内封), and external (外挂) subtitles.
// Inspects file lists when available from debrid cache.
//===============
function inspectChineseSubtitle(title, fansub = null, files = []) {
    const t = String(title || "");
    const lower = t.toLowerCase();

    let hasExternalSub = false;
    let externalSubLang = null;
    if (Array.isArray(files) && files.length > 0) {
        for (const f of files) {
            const name = (f.name || f.path || "").toLowerCase();
            if (/\.(ass|ssa|srt|vtt|sub)$/i.test(name)) {
                if (/简|chs|sc|zh-cn|zh-hans/i.test(name)) {
                    hasExternalSub = true;
                    externalSubLang = "简中外挂";
                    break;
                } else if (/繁|cht|tc|zh-tw|zh-hk|zh-hant/i.test(name)) {
                    hasExternalSub = true;
                    externalSubLang = "繁中外挂";
                    break;
                } else if (/chi|chinese|zh|中字|字幕/i.test(name)) {
                    hasExternalSub = true;
                    externalSubLang = "中字外挂";
                    break;
                }
            }
        }
    }

    const hasHardcodedTag = /内嵌|双语内嵌|简日内嵌|繁日內嵌|中字内嵌|hardsub/i.test(t);
    const hasMuxedTag = /内封|简繁内封|简日内封|繁日内封|简繁日内封|内封简繁|内封字幕|softsub|mux/i.test(t);
    const isBaha = /baha|巴哈/i.test(t);
    const isBilibili = /bilibili|b-global/i.test(t);

    const baseSub = detectChineseSubtitle(title, fansub);
    if (!baseSub.hasChinese && !hasExternalSub) {
        return { hasChinese: false, mode: null, badge: null, type: null };
    }

    let mode = "muxed";
    let badge = "内封";

    if (hasHardcodedTag || isBaha || (isBilibili && /\.mp4$/i.test(t))) {
        mode = "hardcoded";
        badge = baseSub.label ? `${baseSub.label}内嵌` : "内嵌中字";
    } else if (hasMuxedTag) {
        mode = "muxed";
        badge = baseSub.label ? `${baseSub.label}内封` : "内封中字";
    } else if (hasExternalSub) {
        mode = "external";
        badge = externalSubLang || "外挂字幕";
    } else if (/\.mp4$/i.test(t) || /\[MP4\]/i.test(t)) {
        mode = "hardcoded";
        badge = baseSub.label ? `${baseSub.label}内嵌` : "内嵌中字";
    } else {
        mode = "muxed";
        badge = baseSub.label ? `${baseSub.label}内封` : "内封中字";
    }

    return {
        hasChinese: true,
        mode,
        badge,
        type: baseSub.type || "CHI_SIMP"
    };
}

//===============
// SELECT BEST VIDEO FILE
// Deep inspection of torrent files in season packs to pick the exact MKV/MP4 for the episode.
//===============
function selectBestVideoFile(files, requestedEp, expectedSeason = 1, isMovie = false, absoluteEp = null, torrentTitle = "") {
    if (!files || files.length === 0) return null;
    let videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i.test(f.name || f.path || ""));
    if (videoFiles.length === 0) return null;

    const epNum = parseInt(requestedEp, 10);
    const absNum = absoluteEp ? parseInt(absoluteEp, 10) : null;

    if (epNum > 1) {
        isMovie = false;
    }

    if (!isMovie) {
        videoFiles = videoFiles.filter(f => {
            const size = f.size !== undefined ? f.size : (f.bytes || 0);
            if (size === 0) return true;
            const MIN_SIZE = 30 * 1024 * 1024; // 30 MB
            const MAX_SIZE = 25.0 * 1024 * 1024 * 1024; // 25 GB
            return size >= MIN_SIZE && size <= MAX_SIZE;
        });
    }

    if (videoFiles.length === 0) return null;

    // Filter out files that are explicitly for the WRONG season
    // e.g. "Season 1/Episode 02.mkv" when expectedSeason = 3 MUST be rejected!
    const nonWrongSeasonFiles = videoFiles.filter(f => {
        const fullPath = f.name || f.path || "";
        return !isWrongSeason(fullPath, expectedSeason);
    });
    if (nonWrongSeasonFiles.length === 0) {
        return null;
    }
    videoFiles = nonWrongSeasonFiles;

    // In multi-season folders (e.g. "Season 3/02.mkv" alongside "Season 1/02.mkv" or unlabelled files),
    // prioritize files explicitly matching expectedSeason
    if (expectedSeason > 1) {
        const explicitSeasonFiles = videoFiles.filter(f => {
            const fullPath = f.name || f.path || "";
            const sn = extractSeasonNumber(fullPath);
            const sr = extractSeasonRange(fullPath);
            return (sn !== null && sn === expectedSeason) ||
                   (sr !== null && expectedSeason >= sr.start && expectedSeason <= sr.end);
        });
        if (explicitSeasonFiles.length > 0) {
            videoFiles = explicitSeasonFiles;
        } else if (torrentTitle) {
            if (isWrongSeason(torrentTitle, expectedSeason)) {
                return null;
            }
            const tSeason = extractSeasonNumber(torrentTitle);
            const tRange = extractSeasonRange(torrentTitle);
            const tMatches = (tSeason !== null && tSeason === expectedSeason) ||
                             (tRange !== null && expectedSeason >= tRange.start && expectedSeason <= tRange.end);
            if (!tMatches && (!absNum || !isSeasonBatch(torrentTitle, expectedSeason, epNum, absNum))) {
                return null;
            }
        }
    }

    if (isMovie) {
        // A movie release must not be a season pack containing multiple episode files
        const episodeVideos = videoFiles.filter(f => {
            const name = (f.name || f.path || "").split(/[/\\]/).pop();
            return isTVSeriesRelease(name);
        });
        if (episodeVideos.length >= 2) {
            return null;
        }

        // Return the largest MKV/MP4 for movies (filtering out trailers)
        const nonTrailers = videoFiles.filter(f => !/trailer|promo|menu|teaser|ncop|nced|sample/i.test(f.name || f.path || ""));
        const candidates = nonTrailers.length > 0 ? nonTrailers : videoFiles;
        return candidates.sort((a, b) => {
            const aMkv = (a.name || a.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
            const bMkv = (b.name || b.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
        })[0];
    }

    // 1. Direct match on relative episode or absolute episode
    let matches = videoFiles.filter(f => {
        const parts = (f.name || f.path || "").split(/[/\\]/);
        const filename = parts[parts.length - 1];
        const eps = extractEpisodes(filename, expectedSeason);
        return eps.includes(epNum) || (absNum && eps.includes(absNum));
    });

    // 2. Check batch range inside individual files
    if (matches.length === 0) {
        matches = videoFiles.filter(f => {
            const parts = (f.name || f.path || "").split(/[/\\]/);
            const filename = parts[parts.length - 1];
            const batch = getBatchRange(filename);
            return batch && (
                (epNum >= batch.start && epNum <= batch.end) ||
                (absNum && absNum >= batch.start && absNum <= batch.end)
            );
        });
    }

    // 3. Fallback loose match
    if (matches.length === 0) {
        matches = videoFiles.filter(f => {
            const parts = (f.name || f.path || "").split(/[/\\]/);
            const filename = parts[parts.length - 1];
            const loose = extractLooseEpisode(filename);
            return loose === epNum || (absNum && loose === absNum);
        });
    }

    if (matches.length > 0) {
        return matches.sort((a, b) => {
            const nameA = (a.name || a.path || "").toLowerCase();
            const nameB = (b.name || b.path || "").toLowerCase();
            const aMkv = nameA.endsWith(".mkv") ? 1 : 0;
            const bMkv = nameB.endsWith(".mkv") ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
        })[0];
    }

    // If Episode 1 and nothing matched, filter out trailers/extras only if there is a single candidate left
    if (epNum === 1) {
        const cleanVideos = videoFiles.filter(f => {
            const name = (f.name || f.path || "");
            return !/trailer|promo|menu|teaser|ncop|nced|extra|interview|greeting|credit|making|sample/i.test(name);
        });
        if (cleanVideos.length === 1) {
            return cleanVideos[0];
        }
    }

    if (videoFiles.length === 1) {
        return videoFiles[0];
    }

    return null;
}

module.exports = {
    CHINESE_FANSUB_GROUPS,
    detectChineseFansubGroup,
    detectChineseSubtitle,
    extractEpisodeNumber,
    extractEpisodes,
    extractSeasonNumber,
    extractSeasonRange,
    getBatchRange,
    inspectChineseSubtitle,
    isEpisodeMatch,
    isMovieRelease,
    isSeasonBatch,
    isTVSeriesRelease,
    isWrongSeason,
    normalizeTitle,
    sanitizeFilename,
    selectBestVideoFile,
    toSimplifiedChinese,
    toTraditionalChinese,
    verifyExactTitleMatch,
    verifyTitleMatch
};
