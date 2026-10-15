/**
 * 空き時間の判定・共通の空き枠探索（純粋関数。Node からもテスト可能）。
 * 時刻はすべて epoch ミリ秒で扱う。
 */

var MINUTE_MS = 60 * 1000;
var DAY_MS = 24 * 60 * MINUTE_MS;

function overlapsAny_(start, end, busyList) {
  for (var i = 0; i < busyList.length; i++) {
    if (busyList[i].start < end && busyList[i].end > start) return true;
  }
  return false;
}

/**
 * 候補 1 件について参加者全員の空き状況を判定する。
 * @param {{start: number, end: number}} candidate
 * @param {Array<{email: string, name: string, busy?: Array, error?: string}>} people
 * @return {{status: 'free'|'busy'|'unknown', busy: string[], unknown: string[]}}
 */
function evaluateCandidate(candidate, people) {
  var busy = [];
  var unknown = [];
  people.forEach(function (p) {
    if (p.error) unknown.push(p.name || p.email);
    else if (overlapsAny_(candidate.start, candidate.end, p.busy || [])) busy.push(p.name || p.email);
  });
  return { status: busy.length ? 'busy' : unknown.length ? 'unknown' : 'free', busy: busy, unknown: unknown };
}

function ymdKey(date) {
  var d = new Date(date);
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

/**
 * 期間内で、全員の予定が空いている枠を探す。
 * @param {Array<{start: number, end: number}>} busy 全参加者の予定（統合済み）
 * @param {Object} opts
 *   rangeStart, rangeEnd: 期間の開始日・終了日（その日を含む。時刻部分は無視）
 *   dayStartMin, dayEndMin: 1 日の対象時間帯（0:00 からの分）
 *   durationMin: 所要時間, stepMin: 刻み（既定 30）, count: 候補数
 *   skipWeekends, holidays: ['yyyy-MM-dd'], notBefore: これより前の枠は除外
 *   excludeRanges: [{startMin, endMin}]（昼休みなど）
 * @return {Array<{start: number, end: number}>}
 */
function findFreeSlots(busy, opts) {
  var step = opts.stepMin || 30;
  var dur = opts.durationMin || 60;
  var count = opts.count || 3;
  var holidays = opts.holidays || [];
  var exclude = opts.excludeRanges || [];
  var notBefore = opts.notBefore || 0;

  var first = new Date(opts.rangeStart);
  var last = new Date(opts.rangeEnd);
  var lastKey = ymdKey(last);
  var days = [];
  for (var i = 0; i < 62; i++) {
    var day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    if (ymdKey(day) > lastKey) break;
    if (opts.skipWeekends && (day.getDay() === 0 || day.getDay() === 6)) continue;
    if (holidays.indexOf(ymdKey(day)) >= 0) continue;

    var slots = [];
    for (var t = opts.dayStartMin; t + dur <= opts.dayEndMin; t += step) {
      var s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, t).getTime();
      var e = s + dur * MINUTE_MS;
      if (s < notBefore) continue;
      var hitsExcluded = exclude.some(function (x) { return x.startMin < t + dur && x.endMin > t; });
      if (hitsExcluded) continue;
      if (overlapsAny_(s, e, busy)) continue;
      slots.push({ start: s, end: e, startMin: t });
    }
    if (slots.length) days.push(slots);
  }

  // まず 1 日 1 枠ずつ（午前・午後を交互に優先）選び、足りなければ同じ日から追加する
  var chosen = [];
  var conflictsChosen = function (slot) {
    return chosen.some(function (c) { return c.start < slot.end && c.end > slot.start; });
  };
  for (var pass = 0; pass < 10 && chosen.length < count; pass++) {
    for (var d = 0; d < days.length && chosen.length < count; d++) {
      var preferPm = (d + pass) % 2 === 1;
      var avail = days[d].filter(function (sl) { return !conflictsChosen(sl); });
      if (!avail.length) continue;
      var pick = preferPm
        ? avail.filter(function (sl) { return sl.startMin >= 13 * 60; })[0] || avail[0]
        : avail[0];
      chosen.push(pick);
    }
  }
  return chosen
    .map(function (c) { return { start: c.start, end: c.end }; })
    .sort(function (a, b) { return a.start - b.start; });
}
