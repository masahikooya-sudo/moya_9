/**
 * Google カレンダー連携（空き状況の確認・仮押さえ・確定）。
 * 高度なサービス「Calendar API (v3)」を使用する。
 */

var JP_HOLIDAY_CALENDAR_ID = 'ja.japanese#holiday@group.v.calendar.google.com';

function tz_() {
  return Session.getScriptTimeZone() || 'Asia/Tokyo';
}

/** 空き状況を確認する対象（自分＋社内参加者）。 */
function availabilityPeople_(session) {
  var me = myEmail_();
  var settings = getSettings_();
  var people = [{ email: me, name: settings.myName || '自分' }];
  (session.participants || []).forEach(function (p) {
    if (p.email !== me) people.push({ email: p.email, name: p.name || p.email });
  });
  return people;
}

/**
 * Freebusy API で各参加者の予定（busy）を取得する。
 * 共有されていないカレンダーは error がセットされる。
 */
function fetchBusy_(people, timeMin, timeMax) {
  var res = Calendar.Freebusy.query({
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    timeZone: tz_(),
    items: people.map(function (p) { return { id: p.email }; }),
  });
  var cals = res.calendars || {};
  return people.map(function (p) {
    var cal = cals[p.email] || cals[p.email.toLowerCase()] || {};
    if (cal.errors && cal.errors.length) {
      return { email: p.email, name: p.name, error: cal.errors[0].reason || 'error' };
    }
    return {
      email: p.email,
      name: p.name,
      busy: (cal.busy || []).map(function (b) {
        return { start: new Date(b.start).getTime(), end: new Date(b.end).getTime() };
      }),
    };
  });
}

/** 候補ごとに参加者全員の空き状況を判定して session.candidates[].availability に格納する。 */
function checkCandidatesAvailability_(session) {
  var cands = session.candidates;
  if (!cands.length) return;
  var min = Math.min.apply(null, cands.map(function (c) { return c.start; }));
  var max = Math.max.apply(null, cands.map(function (c) { return c.end; }));
  var people = fetchBusy_(availabilityPeople_(session), min, max);
  cands.forEach(function (c) {
    // このセッション自身の仮押さえは「予定あり」扱いにしない
    var filtered = people.map(function (p) {
      if (!p.busy || !c.eventId) return p;
      return {
        email: p.email, name: p.name,
        busy: p.busy.filter(function (b) { return !(b.start === c.start && b.end === c.end); }),
      };
    });
    c.availability = evaluateCandidate(c, filtered);
    c.selected = c.availability.status === 'free';
  });
}

function holidaysBetween_(from, to) {
  try {
    var cal = CalendarApp.getCalendarById(JP_HOLIDAY_CALENDAR_ID);
    if (!cal) return [];
    return cal.getEvents(new Date(from), new Date(to)).map(function (ev) { return ymdKey(ev.getAllDayStartDate()); });
  } catch (err) {
    console.warn('祝日カレンダーを取得できませんでした: ' + err);
    return [];
  }
}

/** こちらから候補を出す場合: 期間内で全員が空いている枠を探して candidates にセットする。 */
function findCandidateSlots_(session) {
  var sr = session.search;
  var from = new Date(sr.rangeStart);
  var to = new Date(sr.rangeEnd);
  var timeMin = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  var timeMax = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime();
  if (timeMax - timeMin > 45 * DAY_MS) throw new Error('検索期間は 45 日以内で指定してください。');
  if (timeMax <= timeMin) throw new Error('期間の終了日は開始日以降を指定してください。');

  var people = fetchBusy_(availabilityPeople_(session), timeMin, timeMax);
  var unknown = people.filter(function (p) { return p.error; });
  var busy = [];
  people.forEach(function (p) { busy = busy.concat(p.busy || []); });

  var slots = findFreeSlots(busy, {
    rangeStart: timeMin,
    rangeEnd: to.getTime(),
    dayStartMin: sr.dayStartMin,
    dayEndMin: sr.dayEndMin,
    durationMin: session.info.durationMin,
    count: sr.count,
    skipWeekends: sr.skipWeekends,
    holidays: holidaysBetween_(timeMin, timeMax),
    excludeRanges: sr.excludeLunch ? [{ startMin: 12 * 60, endMin: 13 * 60 }] : [],
    notBefore: Date.now() + 60 * MINUTE_MS,
  });

  session.candidates = slots.map(function (s) {
    return {
      start: s.start, end: s.end, source: 'auto', selected: true,
      availability: {
        status: unknown.length ? 'unknown' : 'free',
        busy: [],
        unknown: unknown.map(function (p) { return p.name; }),
      },
    };
  });
}

function eventDescription_(session, extra) {
  var lines = [
    '日程調整アシスタントで作成した予定です。',
    '先方：' + [session.info.company, session.info.contact ? session.info.contact + '様' : ''].filter(Boolean).join(' '),
    '案件：' + (session.info.project || ''),
    '形式：' + (MODE_DESCRIPTIONS[session.info.mode] || ''),
  ];
  if (session.info.location) lines.push('場所：' + session.info.location);
  return lines.concat(extra || []).join('\n');
}

function internalAttendees_(session) {
  var me = myEmail_();
  return (session.participants || [])
    .filter(function (p) { return p.email !== me; })
    .map(function (p) { return { email: p.email }; });
}

/** 選択した候補を【調整中】としてカレンダーに仮押さえする。 */
function createHolds_(session) {
  var selected = session.candidates.filter(function (c) { return c.selected; });
  var invite = session.options && session.options.invite;
  selected.forEach(function (c, i) {
    if (c.eventId) return;
    var ev = Calendar.Events.insert(
      {
        summary: buildEventTitle(session.info, 'pending', i, selected.length),
        description: eventDescription_(session, ['', '※仮押さえ中です。確定後に他の候補は自動で削除されます。']),
        location: session.info.mode !== 'web' ? session.info.location || '' : '',
        start: { dateTime: new Date(c.start).toISOString(), timeZone: tz_() },
        end: { dateTime: new Date(c.end).toISOString(), timeZone: tz_() },
        attendees: invite ? internalAttendees_(session) : [],
        transparency: 'opaque',
        colorId: '5', // バナナ（黄色）: 仮押さえの目印
        reminders: { useDefault: false, overrides: [] },
        extendedProperties: { private: { schedulingSessionId: session.id } },
      },
      'primary',
      { sendUpdates: 'none' }
    );
    c.eventId = ev.id;
    c.eventLink = ev.htmlLink;
  });
}

function removeEvent_(eventId) {
  try {
    Calendar.Events.remove('primary', eventId, { sendUpdates: 'none' });
  } catch (err) {
    console.warn('予定を削除できませんでした (' + eventId + '): ' + err);
  }
}

/** 確定した候補以外の仮押さえを削除する。exceptIndex に -1 を渡すと全て削除。 */
function removeHolds_(session, exceptIndex) {
  session.candidates.forEach(function (c, i) {
    if (i === exceptIndex || !c.eventId) return;
    removeEvent_(c.eventId);
    c.eventId = null;
    c.eventLink = null;
  });
}

/**
 * 確定した日時で予定を確定（作成または更新）する。
 * conference.type === 'meet' の場合は Google Meet のリンクもここで発行する。
 * @return {{eventId, eventLink, meetUrl}}
 */
function upsertConfirmedEvent_(session, index, conference, opts) {
  var c = session.candidates[index];
  var extra = [];
  if (conference && conference.url) {
    extra.push('', 'Web会議（' + CONFERENCE_LABELS[conference.type] + '）：' + conference.url);
    if (conference.meetingId) extra.push('ミーティングID：' + conference.meetingId);
    if (conference.passcode) extra.push('パスコード：' + conference.passcode);
  }
  var attendees = opts.invite ? internalAttendees_(session) : [];
  if (opts.inviteExternal) {
    parseAddressList(session.to).forEach(function (a) { attendees.push({ email: a.email }); });
  }
  var location = session.info.mode !== 'web' ? session.info.location || '' : '';
  if (!location && conference && conference.url && conference.type !== 'meet') location = conference.url;

  var resource = {
    summary: buildEventTitle(session.info, 'confirmed'),
    description: eventDescription_(session, extra),
    location: location,
    start: { dateTime: new Date(c.start).toISOString(), timeZone: tz_() },
    end: { dateTime: new Date(c.end).toISOString(), timeZone: tz_() },
    attendees: attendees,
    transparency: 'opaque',
    colorId: '10', // バジル（緑）: 確定
    reminders: { useDefault: true },
    extendedProperties: { private: { schedulingSessionId: session.id } },
  };
  if (conference && conference.type === 'meet') {
    resource.conferenceData = {
      createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }
  var params = { conferenceDataVersion: 1, sendUpdates: attendees.length ? 'all' : 'none' };
  var ev = c.eventId
    ? Calendar.Events.patch(resource, 'primary', c.eventId, params)
    : Calendar.Events.insert(resource, 'primary', params);
  c.eventId = ev.id;
  c.eventLink = ev.htmlLink;

  var meetUrl = null;
  if (conference && conference.type === 'meet') {
    for (var i = 0; i < 6 && !meetUrl; i++) {
      meetUrl = ev.hangoutLink ||
        ((ev.conferenceData && ev.conferenceData.entryPoints) || [])
          .filter(function (p) { return p.entryPointType === 'video'; })
          .map(function (p) { return p.uri; })[0];
      if (!meetUrl) {
        Utilities.sleep(1000);
        ev = Calendar.Events.get('primary', ev.id);
      }
    }
    if (!meetUrl) throw new Error('Google Meet のリンクを発行できませんでした。時間をおいて再度お試しください。');
  }
  return { eventId: ev.id, eventLink: ev.htmlLink, meetUrl: meetUrl };
}
