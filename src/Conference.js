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
    console.error('API エラー ' + url.split('?')[0] + ' (' + code + '): ' + text);
    var err = new Error('API エラー (' + code + '): ' + text.slice(0, 300));
    err.httpCode = code;
    err.body = text;
    throw err;
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

var GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Microsoft のエラー応答から、原因と対処を日本語で説明する。 */
function explainTeamsError_(stage, err) {
  var body = err && err.body ? err.body : '';
  var code = err && err.httpCode;
  var detail = '';
  try {
    var json = JSON.parse(body);
    detail = (json.error && (json.error.code || json.error)) + ' ' + ((json.error && json.error.message) || json.error_description || '');
  } catch (e) {
    detail = body;
  }
  var hint;
  if (stage === 'token') {
    if (/AADSTS7000215/.test(detail)) hint = 'クライアント シークレットが正しくありません。「シークレット ID」ではなく「値」を TEAMS_CLIENT_SECRET に設定してください。';
    else if (/AADSTS7000222/.test(detail)) hint = 'クライアント シークレットの有効期限が切れています。新しいシークレットを発行してください。';
    else if (/AADSTS700016/.test(detail)) hint = 'TEAMS_CLIENT_ID のアプリがテナントに見つかりません。クライアント ID とテナント ID を確認してください。';
    else if (/AADSTS90002|AADSTS900023/.test(detail) || code === 404) hint = 'TEAMS_TENANT_ID が正しくありません。Entra 管理センターの「概要」にある「ディレクトリ (テナント) ID」を設定してください（「アプリケーション (クライアント) ID」やオブジェクト ID と取り違えやすいので注意）。';
    else hint = 'Microsoft へのサインイン（トークン取得）に失敗しました。テナント ID・クライアント ID・シークレットを確認してください。';
  } else if (stage === 'user') {
    if (code === 404) hint = '主催者のユーザーが Microsoft 365 に見つかりません。TEAMS_ORGANIZER_ID に、Microsoft 365 に存在するユーザーのオブジェクト ID を設定してください。';
    else if (code === 403 || code === 401) hint = '主催者のオブジェクト ID を調べる権限がありません。TEAMS_ORGANIZER_ID にオブジェクト ID（xxxxxxxx-xxxx-…の形式）を直接設定するか、アプリに「User.Read.All（アプリケーションの許可）」を追加して管理者の同意を与えてください。';
    else hint = '主催者のユーザー情報を取得できませんでした。';
  } else {
    if (/application access policy/i.test(detail)) hint = 'アプリケーション アクセス ポリシーが主催者に付与されていません（Grant-CsApplicationAccessPolicy）。付与後、反映まで最大30分ほどかかります。';
    else if (code === 403) hint = 'Teams 会議を作成する権限がありません。OnlineMeetings.ReadWrite.All（アプリケーションの許可）への管理者の同意と、アプリケーション アクセス ポリシーを確認してください。';
    else if (code === 404) hint = '主催者が見つからないか、Teams のライセンスがありません。主催者のオブジェクト ID とライセンスを確認してください。';
    else hint = 'Teams 会議を作成できませんでした。';
  }
  return new Error('Teams 連携エラー：' + hint + '（HTTP ' + (code || '-') + ' ' + String(detail).slice(0, 120).trim() + '）');
}

/**
 * TEAMS_TENANT_ID を検証して、サインイン URL に使えるテナント ID を返す。
 * 管理画面の URL（エンドポイント）をそのまま貼った場合も、中の ID を取り出して使う。
 */
function teamsTenantId_() {
  var raw = scriptConfig_('TEAMS_TENANT_ID');
  var guid = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (guid) return guid[0];
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(raw)) return raw; // contoso.onmicrosoft.com 形式
  throw new Error('Teams 連携エラー：TEAMS_TENANT_ID の形式が正しくありません。Entra 管理センターの「概要」にある' +
    '「ディレクトリ (テナント) ID」（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx の形式）を設定してください。（現在の値：' +
    (raw.length > 40 ? raw.slice(0, 40) + '…' : raw || '空') + '）');
}

function teamsAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('teams_token');
  if (cached) return cached;
  var tenantId = teamsTenantId_();
  var json;
  try {
    json = fetchJson_(
      'https://login.microsoftonline.com/' + encodeURIComponent(tenantId) + '/oauth2/v2.0/token',
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
  } catch (err) {
    throw explainTeamsError_('token', err);
  }
  cache.put('teams_token', json.access_token, Math.max(60, (json.expires_in || 3600) - 300));
  return json.access_token;
}

/**
 * 会議の主催者のオブジェクト ID。
 * onlineMeetings API はメールアドレス（UPN）を受け付けないため、オブジェクト ID に変換する。
 * TEAMS_ORGANIZER_ID にオブジェクト ID を設定していればそれを使い、
 * メールアドレスの場合（未設定時は利用者のアドレス）は Graph で検索する（User.Read.All が必要）。
 */
function teamsOrganizerObjectId_(token) {
  var organizer = (scriptConfig_('TEAMS_ORGANIZER_ID') || myEmail_()).trim();
  if (GUID_RE.test(organizer)) return organizer;
  var cache = CacheService.getScriptCache();
  var key = 'teams_oid_' + Utilities.base64EncodeWebSafe(organizer).slice(0, 200);
  var cached = cache.get(key);
  if (cached) return cached;
  var json;
  try {
    json = fetchJson_('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(organizer) + '?$select=id', {
      headers: { Authorization: 'Bearer ' + token },
    });
  } catch (err) {
    throw explainTeamsError_('user', err);
  }
  cache.put(key, json.id, 6 * 60 * 60);
  return json.id;
}

function createTeamsMeeting_(subject, start, end) {
  if (!isTeamsConfigured_()) throw new Error('Microsoft Teams の連携が設定されていません（README「ビデオ会議の設定」参照）。');
  var token = teamsAccessToken_();
  var organizerId = teamsOrganizerObjectId_(token);
  var json;
  try {
    json = fetchJson_('https://graph.microsoft.com/v1.0/users/' + organizerId + '/onlineMeetings', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        subject: subject,
        startDateTime: new Date(start).toISOString(),
        endDateTime: new Date(end).toISOString(),
      }),
    });
  } catch (err) {
    throw explainTeamsError_('meeting', err);
  }
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
  if (type && !isConferenceEnabled_(type)) throw new Error(CONFERENCE_LABELS[type] + ' は現在利用できません。Google Meet または URL の手入力を選んでください。');
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

/**
 * 【設定確認用】Apps Script エディタでこの関数を選んで「実行」すると、
 * 1 時間後に 30 分のテスト会議を Teams に作成し、結果をログに出す。
 */
function testTeamsConnection() {
  var start = Date.now() + 60 * 60 * 1000;
  var res = createTeamsMeeting_('【接続テスト】日程調整アシスタント', start, start + 30 * 60 * 1000);
  console.log('Teams の会議を作成できました: ' + JSON.stringify(res));
}
