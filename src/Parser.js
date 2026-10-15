/**
 * メール本文の解析（候補日時の抽出・確定連絡の検出・案件情報の推定）。
 *
 * このファイルは Apps Script のグローバル（GmailApp 等）に依存しない純粋関数のみで構成し、
 * Node.js からもテストできるようにしている（tests/ 参照）。
 * Date の生成はスクリプトのタイムゾーン（appsscript.json の timeZone）で行われる。
 */

var WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 全角英数・記号のゆれを吸収する。 */
function normalizeJaText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    })
    .replace(/：/g, ':')
    .replace(/／/g, '/')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[〜～∼~－−–—]/g, '~')
    .replace(/　/g, ' ');
}

/** 返信の引用部分（> で始まる行、「〜 wrote:」以降など）を取り除く。 */
function stripQuotedText(body) {
  var lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*>/.test(line)) continue;
    if (/^\s*-{2,}\s*(Original Message|元のメッセージ|Forwarded message|転送されたメッセージ)/i.test(line)) break;
    if (/^\s*On .+wrote:\s*$/.test(line)) break;
    // Gmail 日本語版の引用ヘッダ「2026年9月10日(木) 10:24 田中 太郎 <tanaka@example.com>:」
    if (/^\s*\d{4}年\d{1,2}月\d{1,2}日.*\d{1,2}:\d{2}/.test(line) &&
        (/<[^>]+>\s*:?\s*$/.test(line) || /<[^>]+>/.test(lines[i + 1] || '') || /:\s*$/.test(line))) break;
    if (/^\s*(From|差出人|送信者)\s*[:：]/.test(line) && /^\s*(Sent|送信日時|Date|日付)\s*[:：]/.test(lines[i + 1] || '')) break;
    out.push(line);
  }
  return out.join('\n');
}

var DATE_RE_SRC =
  '(?<![\\d/])(?:(\\d{4})\\s*[/年]\\s*)?(\\d{1,2})\\s*[/月]\\s*(\\d{1,2})(?![\\d/])\\s*日?' +
  '(?:\\s*\\(\\s*([日月火水木金土])[^)\\n]{0,3}\\))?';

var TIME_SRC =
  '(午前|午後|AM|PM|am|pm)?\\s*(\\d{1,2})\\s*(?::\\s*(\\d{2})|時(?!間)\\s*(?:(\\d{1,2})\\s*分|(半))?)';

var TIME_RANGE_RE_SRC = TIME_SRC + '(?:\\s*(?:~|-|から|より)\\s*' + TIME_SRC + ')?';

function toMinutes_(ampm, h, m1, m2, half, assumeAfternoon) {
  var hour = parseInt(h, 10);
  var min = m1 != null ? parseInt(m1, 10) : m2 != null ? parseInt(m2, 10) : half ? 30 : 0;
  if (isNaN(hour) || hour > 24 || min > 59) return null;
  var ap = ampm ? ampm.toUpperCase() : '';
  if ((ap === '午後' || ap === 'PM') && hour < 12) hour += 12;
  else if ((ap === '午前' || ap === 'AM') && hour === 12) hour = 0;
  else if (!ap && assumeAfternoon && hour >= 1 && hour <= 7) hour += 12; // 「1時〜2時」は 13時〜14時 とみなす
  return hour * 60 + min;
}

/** 1 行分のテキストから時刻範囲を抽出する。終了時刻が無ければ endMin は null。 */
function parseTimeRanges_(text) {
  var re = new RegExp(TIME_RANGE_RE_SRC, 'g');
  var out = [];
  var m;
  while ((m = re.exec(text))) {
    var start = toMinutes_(m[1], m[2], m[3], m[4], m[5], true);
    if (start == null) continue;
    var end = null;
    if (m[7] != null) {
      end = toMinutes_(m[6] || m[1], m[7], m[8], m[9], m[10], true);
      if (end != null && end <= start) end = null;
    }
    out.push({ startMin: start, endMin: end });
  }
  return out;
}

function resolveDate_(year, month, day, ref) {
  var y = year || ref.getFullYear();
  var d = new Date(y, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  // 年の記載がなく、基準日より 60 日以上前なら翌年とみなす（12月に「1/10」と書かれた場合など）
  if (!year && d.getTime() < ref.getTime() - 60 * 24 * 3600 * 1000) {
    d = new Date(y + 1, month - 1, day);
  }
  return d;
}

/** 本文中の日付の記載（時刻の有無を問わない）を位置情報つきで返す。 */
function extractDateMentions_(norm, ref) {
  var re = new RegExp(DATE_RE_SRC, 'g');
  var out = [];
  var m;
  while ((m = re.exec(norm))) {
    var month = parseInt(m[2], 10);
    var day = parseInt(m[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    var date = resolveDate_(m[1] ? parseInt(m[1], 10) : null, month, day, ref);
    if (!date) continue;
    out.push({ index: m.index, end: m.index + m[0].length, date: date });
  }
  return out;
}

/**
 * 本文から候補日時を抽出する。
 * @param {string} text 本文（引用は事前に stripQuotedText で除去しておくこと）
 * @param {{referenceDate?: Date, defaultDurationMin?: number}} options
 * @return {Array<{start: Date, end: Date}>} 開始時刻順・重複なし
 */
function parseCandidates(text, options) {
  options = options || {};
  var ref = options.referenceDate ? new Date(options.referenceDate) : new Date();
  var defDur = options.defaultDurationMin || 60;
  var norm = normalizeJaText(text);
  var mentions = extractDateMentions_(norm, ref);
  var seen = {};
  var results = [];

  mentions.forEach(function (dt, i) {
    var segEnd = i + 1 < mentions.length ? mentions[i + 1].index : norm.length;
    var seg = norm.slice(dt.end, segEnd);
    var nl = seg.indexOf('\n');
    var times = parseTimeRanges_(nl >= 0 ? seg.slice(0, nl) : seg);
    if (!times.length && nl >= 0) {
      // 日付の次の行に時刻だけが書かれているケース
      var rest = seg.slice(nl + 1);
      var nl2 = rest.indexOf('\n');
      var line2 = nl2 >= 0 ? rest.slice(0, nl2) : rest;
      if (/^\s*[・\-*]?\s*(午前|午後|AM|PM)?\s*\d{1,2}\s*[:時]/.test(line2)) times = parseTimeRanges_(line2);
    }
    times.forEach(function (t) {
      var d = dt.date;
      var start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, t.startMin);
      var end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, t.endMin != null ? t.endMin : t.startMin + defDur);
      var key = start.getTime() + '-' + end.getTime();
      if (seen[key]) return;
      seen[key] = true;
      results.push({ start: start, end: end });
    });
  });

  results.sort(function (a, b) { return a.start - b.start; });
  return results;
}

var CONFIRM_KEYWORDS_RE = /(お願い(いた)?し(ます|たく)|でお願い|確定|問題(ございません|ありません|ない)|大丈夫|伺います|お伺い|参加(いた)?します|承知|かしこまりました|了解|で結構|にて結構|希望します|させていただきます)/;
var DECLINE_KEYWORDS_RE = /(難しい|都合が(悪|つかな|合わな)|不可|NG|再調整|別の(候補|日程)|他の(候補|日程)|ご都合がつか|いずれも.*(難し|厳し))/;

function sameDay_(a, b) {
  a = new Date(a);
  b = new Date(b);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function uniqueIndex_(indices) {
  var u = indices.filter(function (v, i) { return indices.indexOf(v) === i; });
  return u.length === 1 ? u[0] : -1;
}

/**
 * 返信本文から、提示済み候補のうちどれで確定の連絡が来たかを推定する。
 * @param {string} text 返信本文（引用除去済み）
 * @param {Array<{start: number, end: number}>} candidates 提示した候補（epoch ms）
 * @return {{index: number, method: string, confirmWords: boolean, declineWords: boolean, confident: boolean}}
 */
function detectConfirmation(text, candidates, options) {
  options = options || {};
  var ref = options.referenceDate ? new Date(options.referenceDate) : new Date();
  var norm = normalizeJaText(text);
  var confirmWords = CONFIRM_KEYWORDS_RE.test(norm);
  var declineWords = DECLINE_KEYWORDS_RE.test(norm);
  var result = function (index, method) {
    return {
      index: index,
      method: method,
      confirmWords: confirmWords,
      declineWords: declineWords,
      confident: index >= 0 && confirmWords && !declineWords,
    };
  };

  // 1. 日時（日付＋時刻）が一致
  var parsed = parseCandidates(text, { referenceDate: ref, defaultDurationMin: options.defaultDurationMin });
  var hits = [];
  parsed.forEach(function (p) {
    candidates.forEach(function (c, i) {
      if (new Date(c.start).getTime() === p.start.getTime()) hits.push(i);
    });
  });
  var idx = uniqueIndex_(hits);
  if (idx >= 0) return result(idx, 'datetime');

  // 2. 日付のみ一致（その日の候補が 1 つだけ）
  hits = [];
  extractDateMentions_(norm, ref).forEach(function (m) {
    candidates.forEach(function (c, i) {
      if (sameDay_(c.start, m.date)) hits.push(i);
    });
  });
  idx = uniqueIndex_(hits);
  if (idx >= 0) return result(idx, 'date');

  // 3. 「16日」のような日のみの記載
  hits = [];
  var dayRe = /(?<![\d月/])(\d{1,2})\s*日(?![間程付以])/g;
  var m;
  while ((m = dayRe.exec(norm))) {
    var day = parseInt(m[1], 10);
    candidates.forEach(function (c, i) {
      if (new Date(c.start).getDate() === day) hits.push(i);
    });
  }
  idx = uniqueIndex_(hits);
  if (idx >= 0) return result(idx, 'day');

  // 4. 「火曜」「(火)」のような曜日のみの記載
  hits = [];
  var wdRe = /([日月火水木金土])曜|\(([日月火水木金土])\)/g;
  while ((m = wdRe.exec(norm))) {
    var wd = WEEKDAYS_JA.indexOf(m[1] || m[2]);
    candidates.forEach(function (c, i) {
      if (new Date(c.start).getDay() === wd) hits.push(i);
    });
  }
  idx = uniqueIndex_(hits);
  if (idx >= 0) return result(idx, 'weekday');

  return result(-1, 'none');
}

/** 確定連絡と思われる箇所（最初の数行）を抜き出す。カード表示用。 */
function extractQuote(text, maxLen) {
  maxLen = maxLen || 80;
  var lines = String(text || '').split(/\n/).map(function (l) { return l.trim(); }).filter(function (l) {
    return l && !/^(いつも|お世話|[^\s]+様$|-{2,})/.test(l);
  });
  var hit = lines.filter(function (l) { return CONFIRM_KEYWORDS_RE.test(normalizeJaText(l)); })[0] || lines[0] || '';
  return hit.length > maxLen ? hit.slice(0, maxLen) + '…' : hit;
}

/**
 * "山田 花子 <yamada@example.com>, sato@example.com" のようなアドレス一覧を分解する。
 * 改行区切りにも対応（設定の「よく使う社内メンバー」用）。
 */
function parseAddressList(text) {
  var out = [];
  var seen = {};
  String(text || '')
    .split(/[\n,;、]/)
    .forEach(function (part) {
      part = part.trim();
      if (!part) return;
      var m = part.match(/^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
      var name, email;
      if (m) {
        name = m[1].replace(/^["']|["']$/g, '').trim();
        email = m[2];
      } else {
        var m2 = part.match(/([^\s<>"]+@[^\s<>"]+)/);
        if (!m2) return;
        email = m2[1];
        name = part.replace(m2[1], '').replace(/[()（）"']/g, '').trim();
      }
      email = email.toLowerCase();
      if (seen[email]) return;
      seen[email] = true;
      out.push({ name: name || email.split('@')[0], email: email });
    });
  return out;
}

/** 表示名から姓を取り出す（「田中 太郎」→「田中」）。 */
function familyName(displayName) {
  var n = String(displayName || '').trim();
  if (!n) return '';
  if (/@/.test(n)) return n.split('@')[0];
  return n.split(/[\s　]+/)[0];
}

var COMPANY_RE = /(株式会社|有限会社|合同会社|\(株\)|（株）|㈱|商事|商会|物産|工業|製作所|Inc\.?|Co\.,?\s*Ltd\.?|Corporation|Corp\.?|K\.K\.)/i;

/**
 * 件名・本文・差出人から、会社名・担当者・案件名・形式を推定する（画面で修正可能な初期値）。
 * @return {{company: string, contact: string, project: string, mode: string}}
 */
function guessDealInfo(subject, body, from) {
  from = from || {};
  var norm = normalizeJaText(body);
  var contact = familyName(from.name || from.email || '');

  var company = '';
  var intro = norm.match(/(?:^|[\n。、\s])([^\s、。「」\n]{2,30}?)の([^\s、。\n]{1,10}?)(?:です|でございます|と申します)/);
  if (intro && !/(いつも|お世話|本日|先日|先般|弊社|私|わたし)/.test(intro[1])) company = intro[1];
  if (!company) {
    var lines = norm.split('\n').map(function (l) { return l.trim(); });
    for (var i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      if (COMPANY_RE.test(lines[i]) && lines[i].length <= 40) {
        company = lines[i];
        break;
      }
    }
  }
  if (!company && from.email) {
    company = (from.email.split('@')[1] || '').split('.')[0];
  }

  var project = String(subject || '')
    .replace(/^\s*((re|fw|fwd)\s*[:：]\s*)+/i, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();

  var mode = 'web';
  var hasWeb = /(Web|WEB|web|オンライン|リモート|Zoom|ZOOM|Teams|Meet|ビデオ会議)/.test(norm);
  var hasVisit = /(訪問|ご来社|来社|伺|対面|弊社にて|貴社にて|御社にて)/.test(norm);
  if (hasVisit && hasWeb) mode = 'hybrid';
  else if (hasVisit) mode = 'visit';

  return { company: company.trim(), contact: contact, project: project, mode: mode };
}
