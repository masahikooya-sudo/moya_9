/**
 * ビデオ会議リンクの発行（Zoom / Microsoft Teams）。
 * Google Meet はカレンダー予定の conferenceData で発行する（CalendarService.js）。
 *
 * 資格情報はスクリプト プロパティに保存する（README「ビデオ会議の設定」参照）。
 */

function fetchJson_(url, params) {
  params = params || {};
  params.muteHttpExceptions = true;
  var res = UrlFetchApp.fetch(url, params);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('API エラー (' + code + '): ' + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : {};
}

/* ---------------- Zoom（Server-to-Server OAuth アプリ） ---------------- */

function zoomAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('zoom_token');
  if (cached) return cached;
  var basic = Utilities.base64Encode(scriptConfig_('ZOOM_CLIENT_ID') + ':' + scriptConfig_('ZOOM_CLIENT_SECRET'));
  var json = fetchJson_(
    'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' +
      encodeURIComponent(scriptConfig_('ZOOM_ACCOUNT_ID')),
    { method: 'post', headers: { Authorization: 'Basic ' + basic } }
  );
  cache.put('zoom_token', json.access_token, Math.max(60, (json.expires_in || 3600) - 300));
  return json.access_token;
}

function createZoomMeeting_(topic, start, end) {
  if (!isZoomConfigured_()) throw new Error('Zoom の連携が設定されていません（README「ビデオ会議の設定」参照）。');
  // ZOOM_USER_ID 未設定時は、利用者の Google アカウントのメールアドレスを Zoom ユーザーとして使う
  var userId = scriptConfig_('ZOOM_USER_ID') || myEmail_();
  var json = fetchJson_('https://api.zoom.us/v2/users/' + encodeURIComponent(userId) + '/meetings', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + zoomAccessToken_() },
    payload: JSON.stringify({
      topic: topic,
      type: 2,
      start_time: Utilities.formatDate(new Date(start), tz_(), "yyyy-MM-dd'T'HH:mm:ss"),
      timezone: tz_(),
      duration: Math.round((end - start) / 60000),
      settings: { join_before_host: false, waiting_room: true },
    }),
  });
  return {
    type: 'zoom',
    url: json.join_url,
    meetingId: json.id ? String(json.id).replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1 $2 $3') : '',
    passcode: json.password || '',
  };
}

/* ---------------- Microsoft Teams（Microsoft Graph / アプリケーション権限） ---------------- */

function teamsAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('teams_token');
  if (cached) return cached;
  var json = fetchJson_(
    'https://login.microsoftonline.com/' + encodeURIComponent(scriptConfig_('TEAMS_TENANT_ID')) + '/oauth2/v2.0/token',
    {
      method: 'post',
      payload: {
        client_id: scriptConfig_('TEAMS_CLIENT_ID'),
        client_secret: scriptConfig_('TEAMS_CLIENT_SECRET'),
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      },
    }
  );
  cache.put('teams_token', json.access_token, Math.max(60, (json.expires_in || 3600) - 300));
  return json.access_token;
}

function createTeamsMeeting_(subject, start, end) {
  if (!isTeamsConfigured_()) throw new Error('Microsoft Teams の連携が設定されていません（README「ビデオ会議の設定」参照）。');
  // 主催者: TEAMS_ORGANIZER_ID（Entra ID のユーザー ID または UPN）。未設定時は利用者のメールアドレス
  var organizer = scriptConfig_('TEAMS_ORGANIZER_ID') || myEmail_();
  var json = fetchJson_('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(organizer) + '/onlineMeetings', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + teamsAccessToken_() },
    payload: JSON.stringify({
      subject: subject,
      startDateTime: new Date(start).toISOString(),
      endDateTime: new Date(end).toISOString(),
    }),
  });
  var idSettings = json.joinMeetingIdSettings || {};
  return {
    type: 'teams',
    url: json.joinWebUrl || json.joinUrl,
    meetingId: idSettings.joinMeetingId || '',
    passcode: idSettings.passcode || '',
  };
}

/**
 * Meet 以外の会議リンクを発行する。Meet は予定作成時に発行するため type だけ返す。
 * @param {'meet'|'zoom'|'teams'|'manual'|'none'} type
 */
function createConference_(type, session, slot, manualUrl) {
  var topic = buildEventTitle(session.info, 'confirmed');
  switch (type) {
    case 'zoom':
      return createZoomMeeting_(topic, slot.start, slot.end);
    case 'teams':
      return createTeamsMeeting_(topic, slot.start, slot.end);
    case 'manual':
      if (!manualUrl) throw new Error('会議URLを入力してください。');
      return { type: 'manual', url: manualUrl };
    case 'meet':
      return { type: 'meet' };
    default:
      return null;
  }
}
