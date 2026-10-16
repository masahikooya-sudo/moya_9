/**
 * ユーザーごとの設定（UserProperties）と、管理者が設定する API 資格情報（ScriptProperties）。
 */

var SETTINGS_KEY = 'SETTINGS';

function myEmail_() {
  return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase();
}

function defaultSettings_() {
  var email = myEmail_();
  return {
    myCompany: '',
    myName: '',
    signature: '',
    internalDomains: email.split('@')[1] || '',
    favorites: '',
    defaultDurationMin: 60,
    dayStartMin: 10 * 60,
    dayEndMin: 18 * 60,
    excludeLunch: true,
    defaultRole: 'バイヤー',
    defaultConference: 'meet',
    subjectTemplate: DEFAULT_SUBJECT_TEMPLATE,
    holdByDefault: true,
    inviteMembersToHolds: true,
    ccMembers: false,
  };
}

function getSettings_() {
  var raw = userProps_().getProperty(SETTINGS_KEY);
  var saved = raw ? JSON.parse(raw) : {};
  var s = defaultSettings_();
  Object.keys(saved).forEach(function (k) { s[k] = saved[k]; });
  return s;
}

function saveSettings_(settings) {
  userProps_().setProperty(SETTINGS_KEY, JSON.stringify(settings));
}

function favoriteMembers_(settings) {
  return parseAddressList(settings.favorites);
}

function isInternalEmail_(email, settings) {
  var domain = String(email || '').toLowerCase().split('@')[1];
  if (!domain) return false;
  return String(settings.internalDomains || '')
    .split(/[\s,、]+/)
    .filter(Boolean)
    .some(function (d) {
      d = d.toLowerCase().replace(/^@/, '');
      return domain === d || domain.slice(-(d.length + 1)) === '.' + d;
    });
}

/** Zoom / Teams の資格情報（スクリプト プロパティ）。README の「ビデオ会議の設定」を参照。 */
function scriptConfig_(key) {
  // 貼り付け時に紛れ込みやすい前後の空白・改行・全角スペースを除去する
  return String(PropertiesService.getScriptProperties().getProperty(key) || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

function isZoomConfigured_() {
  return !!(scriptConfig_('ZOOM_ACCOUNT_ID') && scriptConfig_('ZOOM_CLIENT_ID') && scriptConfig_('ZOOM_CLIENT_SECRET'));
}

function isTeamsConfigured_() {
  return !!(scriptConfig_('TEAMS_TENANT_ID') && scriptConfig_('TEAMS_CLIENT_ID') && scriptConfig_('TEAMS_CLIENT_SECRET'));
}
