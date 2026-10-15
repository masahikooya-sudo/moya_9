/**
 * 件名・メール本文・表示文字列の組み立て（純粋関数。Node からもテスト可能）。
 */

var MODE_LABELS = { visit: '訪問', hybrid: '訪問・一部Web', web: 'Web' };
var MODE_DESCRIPTIONS = {
  visit: 'ご訪問（対面）',
  hybrid: 'ご訪問（一部の参加者はWebで参加）',
  web: 'Web会議',
};
var ROLE_OPTIONS = ['バイヤー', 'サプライヤー', '様'];
var CONFERENCE_LABELS = {
  meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  manual: 'その他（URLを手入力）',
  none: '作成しない',
};
var STATUS_LABELS = { pending: '調整中', confirmed: '確定' };
var DEFAULT_SUBJECT_TEMPLATE = '【{status}】【{mode}】{company}｜{project}｜{contact}{role}';

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function formatTime(date) {
  var d = new Date(date);
  return d.getHours() + ':' + pad2_(d.getMinutes());
}

/** 9/15（月） */
function formatDateJa(date) {
  var d = new Date(date);
  return d.getMonth() + 1 + '/' + d.getDate() + '（' + WEEKDAYS_JA[d.getDay()] + '）';
}

/** 9/15（月）13:00〜14:00 */
function formatSlot(start, end) {
  return formatDateJa(start) + formatTime(start) + '〜' + formatTime(end);
}

function durationMinutes(slot) {
  return Math.round((new Date(slot.end) - new Date(slot.start)) / 60000);
}

/**
 * 件名を作る。例: 【調整中】【Web】ABC商事｜新製品案件｜田中バイヤー
 * @param {{company, project, contact, role, mode}} info
 * @param {'pending'|'confirmed'} status
 */
function buildSubject(info, status, template) {
  var vals = {
    status: STATUS_LABELS[status] || status,
    mode: MODE_LABELS[info.mode] || info.mode || '',
    company: info.company || '',
    project: info.project || '',
    contact: info.contact || '',
    role: info.contact ? info.role || '' : '',
  };
  return String(template || DEFAULT_SUBJECT_TEMPLATE)
    .replace(/\{(\w+)\}/g, function (_, k) { return vals[k] != null ? vals[k] : ''; })
    .replace(/【】/g, '')
    .replace(/｜{2,}/g, '｜')
    .replace(/^｜|｜$/g, '')
    .replace(/】｜/g, '】')
    .trim();
}

function participantNames_(participants, settings) {
  var names = [];
  if (settings.myName) names.push(familyName(settings.myName));
  (participants || []).forEach(function (p) {
    var n = familyName(p.name || p.email);
    if (names.indexOf(n) < 0) names.push(n);
  });
  return names.join('、');
}

function greeting_(info, settings) {
  var lines = [];
  if (info.company) lines.push(info.company);
  lines.push((info.contact || 'ご担当者') + '様');
  lines.push('');
  lines.push('いつもお世話になっております。');
  if (settings.myCompany || settings.myName) {
    lines.push((settings.myCompany ? settings.myCompany + 'の' : '') + (settings.myName ? familyName(settings.myName) : '') + 'です。');
  }
  lines.push('');
  return lines;
}

function signature_(settings) {
  var sig = settings.signature;
  if (!sig) sig = [settings.myCompany, settings.myName].filter(Boolean).join('\n');
  return sig ? ['', '---', sig] : [];
}

function formatLines_(info) {
  var lines = ['■ 形式', MODE_DESCRIPTIONS[info.mode] || ''];
  if (info.mode !== 'web' && info.location) lines.push('場所：' + info.location);
  if (info.mode !== 'visit') lines.push('※Web会議のURLは日程確定後にお送りいたします。');
  return lines;
}

/**
 * 候補日を打診するメール本文。
 * @param {Object} p
 *   kind: 'reply'（先方提示の候補から回答）| 'propose'（こちらから提示）
 *   info, slots: [{start, end}], participants, settings
 */
function buildProposalBody(p) {
  var info = p.info;
  var settings = p.settings || {};
  var lines = greeting_(info, settings);
  var title = info.project ? info.project + 'のお打ち合わせ' : 'お打ち合わせ';

  if (p.kind === 'reply') {
    lines.push('ご連絡いただきありがとうございます。');
    lines.push(title + 'につきまして、ご提示いただいた候補のうち、');
    lines.push('下記の日程であれば弊社参加者の都合がつきます。');
  } else {
    lines.push(title + 'につきまして、下記の候補日でいかがでしょうか。');
  }
  lines.push('');
  lines.push('■ 候補日時');
  p.slots.forEach(function (s) { lines.push('・' + formatSlot(s.start, s.end)); });
  lines.push('');
  lines = lines.concat(formatLines_(info));
  var names = participantNames_(p.participants, settings);
  if (names) {
    lines.push('');
    lines.push('■ 弊社参加者');
    lines.push(names);
  }
  lines.push('');
  lines.push('ご都合の良い日時をご教示いただけますと幸いです。');
  lines.push('いずれも難しい場合は、お手数ですがご都合の良い候補をお知らせください。');
  lines.push('');
  lines.push('引き続き、よろしくお願いいたします。');
  return lines.concat(signature_(settings)).join('\n');
}

/**
 * 日程確定のメール本文。
 * @param {Object} p info, slot, conference: {type, url, meetingId, passcode}, participants, settings
 */
function buildConfirmationBody(p) {
  var info = p.info;
  var settings = p.settings || {};
  var conf = p.conference || {};
  var lines = greeting_(info, settings);
  lines.push('ご調整いただきありがとうございます。');
  lines.push('下記の日程にて確定とさせていただきます。');
  lines.push('');
  lines.push('■ 日時');
  lines.push(formatSlot(p.slot.start, p.slot.end));
  lines.push('');
  lines.push('■ 形式');
  lines.push(MODE_DESCRIPTIONS[info.mode] || '');
  if (info.mode !== 'web' && info.location) lines.push('場所：' + info.location);
  if (conf.url) {
    lines.push('');
    lines.push('■ Web会議（' + (CONFERENCE_LABELS[conf.type] || 'Web会議') + '）');
    lines.push(conf.url);
    if (conf.meetingId) lines.push('ミーティングID：' + conf.meetingId);
    if (conf.passcode) lines.push('パスコード：' + conf.passcode);
  }
  var names = participantNames_(p.participants, settings);
  if (names) {
    lines.push('');
    lines.push('■ 弊社参加者');
    lines.push(names);
  }
  lines.push('');
  lines.push('当日はどうぞよろしくお願いいたします。');
  return lines.concat(signature_(settings)).join('\n');
}

/** カレンダー予定のタイトル */
function buildEventTitle(info, status, index, total) {
  var head = status === 'confirmed' ? '【確定】' : '【調整中】';
  var body = [info.company, info.project].filter(Boolean).join('｜') || '打ち合わせ';
  var mode = MODE_LABELS[info.mode] ? '（' + MODE_LABELS[info.mode] + '）' : '';
  var suffix = status === 'confirmed' || !total ? '' : ' 候補' + (index + 1) + '/' + total;
  return head + body + mode + suffix;
}
