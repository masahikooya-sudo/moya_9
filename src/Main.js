/**
 * エントリーポイント（トリガー）とボタンのアクション。
 *
 * 流れ:
 *  [メールから] 候補日の抽出 → 社内参加者の選択 → 空き状況を確認 → 仮押さえ＋返信下書き（調整中）
 *  [新規で作成] 条件入力 → 全員の空きから候補を探索 → 仮押さえ＋打診メール下書き（調整中）
 *  [日程確定]   先方の返信を開く → 確定日を検出 → カレンダー更新・会議URL発行・確定メール下書き（確定）
 */

/* ---------------- トリガー ---------------- */

function onHomepage(e) {
  return safeCard_(function () {
    return buildProposeCard_(initProposeSession_(e, null, false), e, listSessions_());
  });
}

function onGmailMessageOpen(e) {
  return safeCard_(function () {
    var msg = openMessage_(e);
    var session = findSessionForMessage_(e, msg);
    if (session) return renderSession_(session, e);
    return buildFromMailCard_(initMailSession_(e, msg, null), e);
  });
}

function onShowSessions(e) {
  return universal_(buildSessionsCard_(listSessions_()));
}

function onShowSettings(e) {
  return universal_(buildSettingsCard_());
}

/* ---------------- セッションの生成・読み込み ---------------- */

function defaultSearch_(settings) {
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return {
    rangeStart: start.getTime(),
    rangeEnd: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 13).getTime(),
    dayStartMin: Number(settings.dayStartMin),
    dayEndMin: Number(settings.dayEndMin),
    count: 3,
    skipWeekends: true,
    excludeLunch: !!settings.excludeLunch,
  };
}

function baseSession_(id, kind, settings) {
  return {
    id: id || newSessionId_(),
    kind: kind,
    status: SESSION_STATUS.EDITING,
    threadIds: [],
    to: '',
    external: false,
    info: { company: '', contact: '', role: settings.defaultRole, project: '', mode: 'web', location: '', durationMin: Number(settings.defaultDurationMin) },
    participants: [],
    memberOptions: favoriteMembers_(settings),
    candidates: [],
    search: defaultSearch_(settings),
    options: { hold: !!settings.holdByDefault, invite: !!settings.inviteMembersToHolds, cc: !!settings.ccMembers },
    createdAt: Date.now(),
  };
}

function prefillFromMessage_(s, e, msg, settings) {
  var from = senderOf_(msg);
  var guess = guessDealInfo(msg.getSubject(), messageText_(msg), from);
  s.threadIds = [e.gmail.threadId];
  s.sourceMessageId = e.gmail.messageId;
  s.to = isMyAddress_(from.email) ? msg.getTo() : msg.getReplyTo() || msg.getFrom();
  s.external = !isInternalEmail_(from.email, settings);
  s.info.company = guess.company;
  s.info.contact = guess.contact;
  s.info.project = guess.project;
  s.info.mode = guess.mode;
}

/** 開いているメール（先方からの候補日）を起点にしたセッション */
function initMailSession_(e, msg, id) {
  var settings = getSettings_();
  var s = baseSession_(id, 'reply', settings);
  prefillFromMessage_(s, e, msg, settings);
  s.candidates = parseCandidates(messageText_(msg), {
    referenceDate: msg.getDate(),
    defaultDurationMin: s.info.durationMin,
  }).map(function (c) {
    return { start: c.start.getTime(), end: c.end.getTime(), source: 'mail', selected: true };
  });
  return s;
}

/** こちらから候補日を提示するセッション（メールを開いていれば宛先などを引き継ぐ） */
function initProposeSession_(e, id, fromMail) {
  var settings = getSettings_();
  var s = baseSession_(id, 'propose', settings);
  if (fromMail && e && e.gmail) prefillFromMessage_(s, e, openMessage_(e), settings);
  return s;
}

function params_(e) {
  return (e && e.commonEventObject && e.commonEventObject.parameters) || {};
}

function loadSession_(e) {
  var p = params_(e);
  var s = getSession_(p.sid);
  if (s) return s;
  if (p.kind === 'propose') return initProposeSession_(e, p.sid, !!(e && e.gmail));
  return initMailSession_(e, openMessage_(e), p.sid);
}

/** スレッドに紐づくセッション。見つからなければ件名（会社名・案件名）で調整中のものを探す。 */
function findSessionForMessage_(e, msg) {
  var s = findSessionByThread_(e.gmail.threadId);
  if (s) return s;
  var subject = msg.getSubject() || '';
  var hit = listSessions_().filter(function (x) {
    return x.status === SESSION_STATUS.PENDING && x.info.company && x.info.project &&
      subject.indexOf(x.info.company) >= 0 && subject.indexOf(x.info.project) >= 0;
  })[0];
  if (hit) {
    hit.threadIds.push(e.gmail.threadId);
    saveSession_(hit);
  }
  return hit || null;
}

function renderSession_(s, e) {
  if (s.status === SESSION_STATUS.PENDING) return buildConfirmCard_(s, e, detectReply_(s, e));
  if (s.status === SESSION_STATUS.CONFIRMED) return buildConfirmedCard_(s, e);
  return s.kind === 'propose' ? buildProposeCard_(s, e) : buildFromMailCard_(s, e);
}

/** 先方の最新の返信から、確定した候補を推定する。 */
function detectReply_(s, e) {
  // 紐づくスレッド（元のスレッド・送信した下書きのスレッド）のうち、最も新しい先方からのメール
  var threadIds = [e && e.gmail ? e.gmail.threadId : null].concat(s.threadIds || []);
  var msg = null;
  threadIds.forEach(function (t, i) {
    if (!t || threadIds.indexOf(t) !== i) return;
    var m = lastIncomingMessage_(t);
    if (m && (!msg || m.getDate() > msg.getDate())) msg = m;
  });
  if (!msg || (s.proposedAt && msg.getDate().getTime() < s.proposedAt)) return null;
  var text = messageText_(msg);
  var det = detectConfirmation(text, s.candidates, { referenceDate: msg.getDate(), defaultDurationMin: s.info.durationMin });
  det.quote = extractQuote(text);
  return det;
}

/* ---------------- フォーム入力の反映 ---------------- */

function formValue_(e, name) {
  var f = (e.commonEventObject && e.commonEventObject.formInputs) || {};
  var x = f[name];
  if (!x) return undefined;
  if (x.stringInputs) return x.stringInputs.value;
  if (x.dateInput) return Number(x.dateInput.msSinceEpoch);
  if (x.dateTimeInput) return Number(x.dateTimeInput.msSinceEpoch);
  return undefined;
}

function formString_(e, name) {
  var v = formValue_(e, name);
  return Array.isArray(v) ? String(v[0] == null ? '' : v[0]).trim() : v == null ? undefined : String(v).trim();
}

function formList_(e, name) {
  var v = formValue_(e, name);
  return Array.isArray(v) ? v : v == null ? [] : [String(v)];
}

function localDateFromPicker_(ms) {
  var d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

function applyForm_(s, e) {
  var groups = String(params_(e).form || '').split(',');
  var has = function (g) { return groups.indexOf(g) >= 0; };

  if (has('info')) {
    ['company', 'contact', 'role', 'project', 'mode', 'location'].forEach(function (k) {
      var v = formString_(e, k);
      if (v !== undefined) s.info[k] = v;
    });
    var to = formString_(e, 'to');
    if (to !== undefined) s.to = to;
  }

  if (has('cands')) {
    s.candidates.forEach(function (c, i) { c.selected = formValue_(e, 'cand_' + i) !== undefined; });
  }

  if (has('members')) {
    var options = memberOptions_(s);
    var picked = formList_(e, 'members');
    s.participants = options.filter(function (m) { return picked.indexOf(m.email) >= 0; });
    parseAddressList(formString_(e, 'extraMembers')).forEach(function (m) {
      if (!s.participants.some(function (p) { return p.email === m.email; })) s.participants.push(m);
    });
  }

  if (has('search')) {
    var rs = formValue_(e, 'rangeStart');
    var re = formValue_(e, 'rangeEnd');
    if (rs) s.search.rangeStart = localDateFromPicker_(rs);
    if (re) s.search.rangeEnd = localDateFromPicker_(re);
    s.search.dayStartMin = Number(formString_(e, 'dayStart') || s.search.dayStartMin);
    s.search.dayEndMin = Number(formString_(e, 'dayEnd') || s.search.dayEndMin);
    s.search.count = Number(formString_(e, 'count') || s.search.count);
    s.info.durationMin = Number(formString_(e, 'duration') || s.info.durationMin);
    var so = formList_(e, 'searchOpts');
    s.search.skipWeekends = so.indexOf('skipWeekends') >= 0;
    s.search.excludeLunch = so.indexOf('excludeLunch') >= 0;
  }

  if (has('opts')) {
    var o = formList_(e, 'opts');
    s.options = { hold: o.indexOf('hold') >= 0, invite: o.indexOf('invite') >= 0, cc: o.indexOf('cc') >= 0 };
  }

  if (has('confirm')) {
    var co = formList_(e, 'confirmOpts');
    var idx = formString_(e, 'confirmIdx');
    s.confirmInput = {
      index: idx === undefined || idx === '' ? -1 : Number(idx),
      updateCal: co.indexOf('updateCal') >= 0,
      invite: co.indexOf('invite') >= 0,
      inviteExternal: co.indexOf('inviteExternal') >= 0,
      draft: co.indexOf('draft') >= 0,
      confType: formString_(e, 'confType') || 'none',
      confUrl: formString_(e, 'confUrl') || '',
    };
    var loc = formString_(e, 'location');
    if (loc !== undefined) s.info.location = loc;
  }
  return s;
}

/* ---------------- アクション ---------------- */

/** カード内の補助操作（候補の追加・社内検索）を行い、同じカードを描き直す。 */
function actRefresh(e) {
  return safeAction_(function () {
    var p = params_(e);
    var s = applyForm_(loadSession_(e), e);
    var note = null;
    if (p.op === 'addCand') {
      var added = parseCandidates(formString_(e, 'manualCand') || '', {
        referenceDate: new Date(),
        defaultDurationMin: s.info.durationMin,
      });
      if (!added.length) return notify_('日時を読み取れませんでした。例：9/18 14:00〜15:00');
      added.forEach(function (c) {
        var exists = s.candidates.some(function (x) { return x.start === c.start.getTime() && x.end === c.end.getTime(); });
        if (!exists) s.candidates.push({ start: c.start.getTime(), end: c.end.getTime(), source: 'manual', selected: true });
      });
      s.candidates.sort(function (a, b) { return a.start - b.start; });
      if (p.view === 'avail') checkCandidatesAvailability_(s);
      note = added.length + '件の候補を追加しました';
    } else if (p.op === 'dirSearch') {
      var q = formString_(e, 'dirQuery');
      if (!q) return notify_('検索する名前またはメールアドレスを入力してください');
      var found = searchDirectory_(q);
      var known = memberOptions_(s).map(function (m) { return m.email; });
      s.memberOptions = (s.memberOptions || []).concat(found.filter(function (m) { return known.indexOf(m.email) < 0; })).slice(-30);
      note = found.length ? found.length + '名が見つかりました。チェックして選択してください' : '該当する社内メンバーが見つかりませんでした';
    }
    saveSession_(s);
    var card = { mail: buildFromMailCard_, propose: buildProposeCard_, avail: buildAvailabilityCard_ }[p.view](s, e);
    var res = CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().updateCard(card));
    if (note) res.setNotification(CardService.newNotification().setText(note));
    return res.build();
  });
}

/** [メールから] 選択した候補について社内参加者の空きを確認する。 */
function actCheckAvailability(e) {
  return safeAction_(function () {
    var s = applyForm_(loadSession_(e), e);
    s.candidates = s.candidates.filter(function (c) { return c.selected; });
    if (!s.candidates.length) return notify_('候補日を1つ以上選択してください');
    checkCandidatesAvailability_(s);
    saveSession_(s);
    return push_(buildAvailabilityCard_(s, e));
  });
}

/** [新規で作成] 期間内で全員の空いている枠を探す。 */
function actFindSlots(e) {
  return safeAction_(function () {
    var s = applyForm_(loadSession_(e), e);
    if (!(s.threadIds || []).length && !parseAddressList(s.to).length) return notify_('宛先のメールアドレスを入力してください');
    if (s.search.dayEndMin - s.search.dayStartMin < s.info.durationMin) return notify_('時間帯が所要時間より短くなっています');
    findCandidateSlots_(s);
    if (!s.candidates.length) return notify_('条件に合う空き時間が見つかりませんでした。期間や時間帯を広げてください');
    saveSession_(s);
    return push_(buildAvailabilityCard_(s, e));
  });
}

/** 仮押さえ＋候補日打診メールの下書きを作成する。 */
function actSendCandidates(e) {
  return safeAction_(function () {
    var s = applyForm_(loadSession_(e), e);
    var selected = s.candidates.filter(function (c) { return c.selected; });
    if (!selected.length) return notify_('送る候補日を1つ以上選択してください');
    // 外した候補の仮押さえ（出し直しの場合）は削除する
    s.candidates.forEach(function (c) { if (!c.selected && c.eventId) removeEvent_(c.eventId); });
    s.candidates = selected;

    var settings = getSettings_();
    if (s.options.hold) createHolds_(s);
    saveSession_(s); // 仮押さえ済みの予定 ID を先に保存しておく

    var subject = buildSubject(s.info, 'pending', settings.subjectTemplate);
    var body = buildProposalBody({ kind: s.kind, info: s.info, slots: selected, participants: s.participants, settings: settings });
    var draft = createSessionDraft_(s, subject, body, e.gmail && e.gmail.threadId);
    s.draftId = draft.draftId;
    s.draftThreadId = draft.threadId;
    if (draft.threadId && s.threadIds.indexOf(draft.threadId) < 0) s.threadIds.push(draft.threadId);
    s.lastSubject = subject;
    s.status = SESSION_STATUS.PENDING;
    s.proposedAt = Date.now();
    saveSession_(s);
    return push_(buildSentCard_(s, e), '下書きを作成しました');
  });
}

/** 作成済みの下書きを作成画面で開く（compose アクション）。 */
function actOpenDraft(e) {
  return draftComposeResponse_(params_(e).draftId);
}

function actShowSession(e) {
  return safeAction_(function () {
    var s = getSession_(params_(e).sid);
    if (!s) return notify_('この日程調整は見つかりませんでした');
    return push_(renderSession_(s, e));
  });
}

function doConfirm_(s, e) {
  var input = s.confirmInput;
  var c = s.candidates[input.index];
  if (!c) throw new Error('確定する日時を選択してください。');
  var settings = getSettings_();

  var conference = createConference_(input.confType, s, c, input.confUrl);
  var eventInfo = {};
  if (input.updateCal || (conference && conference.type === 'meet')) {
    removeHolds_(s, input.index);
    eventInfo = upsertConfirmedEvent_(s, input.index, conference, input);
    if (conference && conference.type === 'meet') conference.url = eventInfo.meetUrl;
  }
  s.status = SESSION_STATUS.CONFIRMED;
  s.confirmed = {
    index: input.index, start: c.start, end: c.end,
    eventId: eventInfo.eventId || null, eventLink: eventInfo.eventLink || null,
    conference: conference,
  };
  saveSession_(s); // 下書き作成に失敗してもカレンダーの状態は保存しておく

  if (input.draft) {
    var subject = buildSubject(s.info, 'confirmed', settings.subjectTemplate);
    var body = buildConfirmationBody({ info: s.info, slot: c, conference: conference, participants: s.participants, settings: settings });
    var draft = createSessionDraft_(s, subject, body, e.gmail && e.gmail.threadId);
    s.confirmed.draftId = draft.draftId;
    s.confirmed.draftThreadId = draft.threadId;
    if (draft.threadId && s.threadIds.indexOf(draft.threadId) < 0) s.threadIds.push(draft.threadId);
    saveSession_(s);
  }
  return s;
}

/** 日程を確定する（カレンダー更新・会議URL発行・確定メールの下書き）。 */
function actConfirm(e) {
  return safeAction_(function () {
    var s = doConfirm_(applyForm_(loadSession_(e), e), e);
    return push_(buildConfirmedCard_(s, e), '日程を確定しました');
  });
}

/** 確定して、そのまま確定メールの下書きを作成画面で開く（compose アクション）。 */
function actConfirmCompose(e) {
  var s = applyForm_(loadSession_(e), e);
  s.confirmInput.draft = true;
  doConfirm_(s, e);
  return draftComposeResponse_(s.confirmed.draftId);
}

/** 候補日を出し直す（仮押さえを削除し、こちらから候補を提示する画面へ）。 */
function actReplan(e) {
  return safeAction_(function () {
    var s = loadSession_(e);
    removeHolds_(s, -1);
    s.candidates = [];
    s.kind = 'propose';
    s.status = SESSION_STATUS.EDITING;
    s.search = defaultSearch_(getSettings_());
    saveSession_(s);
    return push_(buildProposeCard_(s, e), '仮押さえを削除しました。新しい候補日を探してください');
  });
}

function actCancelSession(e) {
  return safeAction_(function () {
    var s = loadSession_(e);
    removeHolds_(s, -1);
    deleteSession_(s);
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().popToRoot().updateCard(buildSessionsCard_(listSessions_())))
      .setNotification(CardService.newNotification().setText('日程調整を中止し、仮押さえを削除しました'))
      .build();
  });
}

/** 確定済みのスレッドで、新しく日程調整を始める。 */
function actStartFresh(e) {
  return safeAction_(function () {
    return push_(buildFromMailCard_(initMailSession_(e, openMessage_(e), null), e));
  });
}

function actGoPropose(e) {
  return safeAction_(function () {
    var current = loadSession_(e);
    var s = initProposeSession_(e, null, params_(e).fromMail === '1');
    if (current && current.participants) s.participants = current.participants;
    saveSession_(s);
    return push_(buildProposeCard_(s, e));
  });
}

function actGoMail(e) {
  return safeAction_(function () {
    if (!e.gmail) return notify_('メールを開いた状態で使用してください');
    return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().popToRoot()).build();
  });
}

function actBack(e) {
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().popCard()).build();
}

function actSaveSettings(e) {
  return safeAction_(function () {
    var s = getSettings_();
    ['myCompany', 'myName', 'signature', 'internalDomains', 'favorites', 'defaultRole', 'defaultConference', 'subjectTemplate']
      .forEach(function (k) {
        var v = formString_(e, k);
        s[k] = v === undefined ? '' : v;
      });
    if (!s.subjectTemplate) s.subjectTemplate = DEFAULT_SUBJECT_TEMPLATE;
    ['defaultDurationMin', 'dayStartMin', 'dayEndMin'].forEach(function (k) {
      var v = formString_(e, k);
      if (v) s[k] = Number(v);
    });
    var flags = formList_(e, 'flags');
    ['excludeLunch', 'holdByDefault', 'inviteMembersToHolds', 'ccMembers'].forEach(function (k) { s[k] = flags.indexOf(k) >= 0; });
    saveSettings_(s);
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(buildSettingsCard_()))
      .setNotification(CardService.newNotification().setText('設定を保存しました'))
      .build();
  });
}

/* ---------------- 社内ディレクトリ検索 ---------------- */

function searchDirectory_(query) {
  var res = People.People.searchDirectoryPeople({
    query: query,
    readMask: 'names,emailAddresses',
    sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT'],
    pageSize: 10,
  });
  return (res.people || [])
    .map(function (p) {
      var email = p.emailAddresses && p.emailAddresses[0] ? p.emailAddresses[0].value.toLowerCase() : '';
      var name = p.names && p.names[0] ? p.names[0].displayName : '';
      return { name: name || email.split('@')[0], email: email };
    })
    .filter(function (p) { return p.email; });
}

/* ---------------- レスポンス ヘルパー ---------------- */

function push_(card, message) {
  var b = CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(card));
  if (message) b.setNotification(CardService.newNotification().setText(message));
  return b.build();
}

function notify_(message) {
  return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(message)).build();
}

function universal_(card) {
  return CardService.newUniversalActionResponseBuilder().displayAddOnCards([card]).build();
}

function safeAction_(fn) {
  try {
    return fn();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return notify_('エラー：' + (err && err.message ? err.message : err));
  }
}

function safeCard_(fn) {
  try {
    return fn();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return buildErrorCard_(err);
  }
}
