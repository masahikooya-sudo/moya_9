// Teams 会議作成（Microsoft Graph）の結合テスト。Microsoft の API はモック。
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas_mocks');

const CONFIG = { TEAMS_TENANT_ID: 'tenant', TEAMS_CLIENT_ID: 'client', TEAMS_CLIENT_SECRET: 'secret' };
const OID = '11111111-2222-3333-4444-555555555555';
const MEETING = { joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/abc', joinMeetingIdSettings: { joinMeetingId: '123 456', passcode: 'xyz' } };

function graph(overrides = {}) {
  const calls = [];
  const fn = (url, params) => {
    calls.push(url);
    if (url.includes('/oauth2/v2.0/token')) return overrides.token || { code: 200, body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('?$select=id')) return overrides.user || { code: 200, body: { id: OID } };
    if (url.includes('/onlineMeetings')) return overrides.meeting || { code: 201, body: MEETING };
    throw new Error('unexpected ' + url);
  };
  return { fn, calls };
}

test('メールアドレスの主催者はオブジェクト ID に変換してから会議を作成する', () => {
  const g = graph();
  const { ctx } = makeEnv({ scriptProps: CONFIG, fetch: g.fn });
  const res = ctx.createTeamsMeeting_('件名', Date.now(), Date.now() + 3600000);
  assert.strictEqual(res.url, MEETING.joinWebUrl);
  assert.strictEqual(res.passcode, 'xyz');
  assert.match(g.calls[1], /\/users\/me%40our\.co\.jp\?\$select=id$/);
  assert.strictEqual(g.calls[2], `https://graph.microsoft.com/v1.0/users/${OID}/onlineMeetings`);
});

test('TEAMS_ORGANIZER_ID がオブジェクト ID なら検索しない', () => {
  const g = graph();
  const { ctx } = makeEnv({ scriptProps: { ...CONFIG, TEAMS_ORGANIZER_ID: OID }, fetch: g.fn });
  ctx.createTeamsMeeting_('件名', Date.now(), Date.now() + 3600000);
  assert.strictEqual(g.calls.length, 2);
  assert.match(g.calls[1], new RegExp(`/users/${OID}/onlineMeetings$`));
});

test('エラーは原因と対処を日本語で返す', () => {
  const cases = [
    [{ token: { code: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' } } }, /「値」/],
    [{ user: { code: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } } } }, /User\.Read\.All/],
    [{ user: { code: 404, body: { error: { code: 'Request_ResourceNotFound', message: 'not found' } } } }, /見つかりません/],
    [{ meeting: { code: 403, body: { error: { code: 'General', message: 'No application access policy found for this app.' } } } }, /アプリケーション アクセス ポリシー/],
  ];
  for (const [ov, re] of cases) {
    const { ctx } = makeEnv({ scriptProps: CONFIG, fetch: graph(ov).fn });
    assert.throws(() => ctx.createTeamsMeeting_('件名', Date.now(), Date.now() + 3600000), re);
  }
});
