/**
 * 日程調整セッションの保存（UserProperties）。
 *
 * セッションの構造:
 * {
 *   id, kind: 'reply'|'propose', status: 'editing'|'pending'|'confirmed',
 *   threadIds: [...],            // 元のスレッド＋作成した下書きのスレッド
 *   sourceMessageId,             // 起点となったメール
 *   to, cc,                      // 先方の宛先
 *   info: {company, contact, role, project, mode, location, durationMin},
 *   participants: [{name, email}], memberOptions: [{name, email}],
 *   candidates: [{start, end, source, selected, availability, eventId}],
 *   search: {rangeStart, rangeEnd, dayStartMin, dayEndMin, count, skipWeekends, excludeLunch},
 *   options: {hold, invite, cc},
 *   draftId, draftThreadId, confirmed: {index, start, end, eventId, eventLink, conference},
 *   createdAt, updatedAt
 * }
 */

var SESSION_STATUS = { EDITING: 'editing', PENDING: 'pending', CONFIRMED: 'confirmed' };
var SESSION_PREFIX = 'S:';
var THREAD_PREFIX = 'T:';

function userProps_() {
  return PropertiesService.getUserProperties();
}

function newSessionId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function getSession_(id) {
  if (!id) return null;
  var raw = userProps_().getProperty(SESSION_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

function saveSession_(s) {
  s.updatedAt = Date.now();
  var props = {};
  props[SESSION_PREFIX + s.id] = JSON.stringify(s);
  (s.threadIds || []).forEach(function (t) {
    if (t) props[THREAD_PREFIX + t] = s.id;
  });
  userProps_().setProperties(props);
}

function deleteSession_(s) {
  var p = userProps_();
  p.deleteProperty(SESSION_PREFIX + s.id);
  (s.threadIds || []).forEach(function (t) {
    if (t && p.getProperty(THREAD_PREFIX + t) === s.id) p.deleteProperty(THREAD_PREFIX + t);
  });
}

function findSessionByThread_(threadId) {
  if (!threadId) return null;
  return getSession_(userProps_().getProperty(THREAD_PREFIX + threadId));
}

/** 保存済みセッションの一覧（新しい順）。古い編集途中・確定済みのものはここで掃除する。 */
function listSessions_() {
  var all = userProps_().getProperties();
  var now = Date.now();
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(SESSION_PREFIX) !== 0) return;
    var s;
    try {
      s = JSON.parse(all[k]);
    } catch (err) {
      userProps_().deleteProperty(k);
      return;
    }
    var age = now - (s.updatedAt || 0);
    if ((s.status === SESSION_STATUS.EDITING && age > 14 * DAY_MS) ||
        (s.status === SESSION_STATUS.CONFIRMED && age > 90 * DAY_MS)) {
      deleteSession_(s);
      return;
    }
    out.push(s);
  });
  return out.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
}
