// アドオン全体の流れ（抽出 → 空き確認 → 仮押さえ＋下書き → 確定）をモック環境で通しで実行する
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv, fakeMessage } = require('./gas_mocks');

const plain = (x) => JSON.parse(JSON.stringify(x));
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime(); // 2026年10月

function event(params, formInputs = {}, gmail) {
  const fi = {};
  for (const [k, v] of Object.entries(formInputs)) {
    fi[k] = typeof v === 'number' ? { dateInput: { msSinceEpoch: String(v) } } : { stringInputs: { value: [].concat(v) } };
  }
  return { commonEventObject: { parameters: params, formInputs: fi }, gmail };
}

test('先方提示の候補 → 空き確認 → 仮押さえ＋返信下書き → 返信から確定 → Meet発行＋確定メール', () => {
  const threads = {};
  const buyerMsg = fakeMessage({
    id: 'msg1', threadId: 'th1', threadsRef: threads,
    from: '田中 太郎 <tanaka@abc-corp.co.jp>',
    subject: '来週の打ち合わせ候補について',
    date: new Date(2026, 9, 8, 10, 24),
    body: 'いつもお世話になっております。\nABC商事の田中です。\n\nWebでの打ち合わせについて、下記の候補でいかがでしょうか。\n\n・10/20（火）13:00〜14:00\n・10/21（水）10:00〜11:00\n・10/22（木）15:00〜16:00\n\nよろしくお願いいたします。\n',
  });
  threads.th1 = { getId: () => 'th1', getMessages: () => [buyerMsg] };
  const env = makeEnv({
    messages: { msg1: buyerMsg },
    threads,
    busy: { 'yamada@our.co.jp': [[at(22, 15), at(22, 16)]] },
  });
  const g = env.ctx;
  const gmail = { messageId: 'msg1', threadId: 'th1', accessToken: 'x' };

  // 1. メールを開く
  const card = g.onGmailMessageOpen({ gmail, commonEventObject: {} });
  assert.match(card.text, /10\/20（火）13:00〜14:00/);
  assert.match(card.text, /【調整中】【Web】ABC商事｜来週の打ち合わせ候補について｜田中バイヤー/);
  const sid = JSON.stringify(card.calls).match(/"sid":"([^"]+)"/)[1];

  // 2. 参加者を選んで空き状況を確認
  const r2 = g.actCheckAvailability(event(
    { sid, kind: 'reply', form: 'info,cands,members' },
    { cand_0: '0', cand_1: '1', cand_2: '2', extraMembers: '山田 花子 <yamada@our.co.jp>', project: '新製品案件', company: 'ABC商事', contact: '田中', role: 'バイヤー', mode: 'web', location: '' },
    gmail,
  ));
  const availCard = JSON.stringify(r2);
  assert.match(availCard, /全員空き/);
  assert.match(availCard, /1名が予定あり：山田 花子/);
  let s = g.getSession_(sid);
  assert.deepStrictEqual(plain(s.candidates.map((c) => c.selected)), [true, true, false]);

  // 3. 候補日を送る（仮押さえ＋下書き）
  g.actSendCandidates(event({ sid, kind: 'reply', form: 'cands,opts' }, { cand_0: '0', cand_1: '1', opts: ['hold', 'invite'] }, gmail));
  s = g.getSession_(sid);
  assert.strictEqual(s.status, 'pending');
  assert.strictEqual(Object.keys(env.events).length, 2);
  const hold = Object.values(env.events)[0];
  assert.match(hold.summary, /^【調整中】ABC商事｜新製品案件（Web） 候補1\/2$/);
  assert.deepStrictEqual(plain(hold.attendees), [{ email: 'yamada@our.co.jp' }]);
  const d1 = env.drafts[s.draftId];
  assert.strictEqual(d1.subject, '【調整中】【Web】ABC商事｜新製品案件｜田中バイヤー');
  assert.match(d1.mime, /In-Reply-To: <msg1@mail>/);
  assert.match(d1.body, /ご提示いただいた候補のうち/);
  assert.match(d1.body, /・10\/20（火）13:00〜14:00\n・10\/21（水）10:00〜11:00\n\n/);

  // 4. 先方から「10/21でお願いします」と返信が届く
  const reply = fakeMessage({
    id: 'msg2', threadId: 'th1', threadsRef: threads, from: '田中 太郎 <tanaka@abc-corp.co.jp>',
    subject: 'Re: 【調整中】【Web】ABC商事｜新製品案件｜田中バイヤー', date: new Date(Date.now() + 60000),
    body: '田中です。\n10/21でお願いします。\n\n2026年10月9日(金) 9:00 me <me@our.co.jp>:\n> ・10/20（火）13:00〜14:00\n',
  });
  threads.th1.getMessages = () => [buyerMsg, reply];
  const confirmCard = g.onGmailMessageOpen({ gmail: { ...gmail, messageId: 'msg2' }, commonEventObject: {} });
  assert.match(confirmCard.text, /確定のご連絡を検出しました/);
  assert.match(confirmCard.text, /10\/21（水）10:00〜11:00/);

  // 5. Google Meet で確定
  g.actConfirm(event({ sid, kind: 'reply', form: 'confirm' },
    { confirmIdx: '1', confirmOpts: ['updateCal', 'invite', 'draft'], confType: 'meet', confUrl: '', location: '' },
    { ...gmail, messageId: 'msg2' }));
  s = g.getSession_(sid);
  assert.strictEqual(s.status, 'confirmed');
  const evs = Object.values(env.events);
  assert.strictEqual(evs.length, 1, '他の候補の仮押さえは削除される');
  assert.match(evs[0].summary, /^【確定】ABC商事｜新製品案件（Web）$/);
  const d2 = env.drafts[s.confirmed.draftId];
  assert.strictEqual(d2.subject, '【確定】【Web】ABC商事｜新製品案件｜田中バイヤー');
  assert.match(d2.body, /■ 日時\n10\/21（水）10:00〜11:00/);
  assert.match(d2.body, /■ Web会議（Google Meet）\nhttps:\/\/meet.google.com\//);
  assert.match(d2.mime, /In-Reply-To: <msg2@mail>/);
});

test('新規で作成: 全員の空きから候補を探して打診メールを作る', () => {
  const env = makeEnv({ busy: { 'me@our.co.jp': [[at(19, 0), at(19, 23, 59)]] } }); // 10/19(月) は終日予定あり
  const g = env.ctx;
  const home = g.onHomepage({ commonEventObject: {} });
  const sid = JSON.stringify(home.calls).match(/"sid":"([^"]+)"/)[1];
  g.actFindSlots(event({ sid, kind: 'propose', form: 'info,members,search' }, {
    to: '佐藤 健 <sato@supplier.jp>', company: 'XYZ工業', contact: '佐藤', role: 'サプライヤー', project: '部品調達', mode: 'visit', location: '貴社 本社',
    members: [], extraMembers: 'yamada@our.co.jp',
    rangeStart: Date.UTC(2026, 9, 17), rangeEnd: Date.UTC(2026, 9, 23),
    dayStart: '600', dayEnd: '1080', duration: '60', count: '3', searchOpts: ['skipWeekends', 'excludeLunch'],
  }));
  let s = g.getSession_(sid);
  assert.deepStrictEqual(plain(s.candidates.map((c) => g.formatSlot(c.start, c.end))), [
    '10/20（火）10:00〜11:00', '10/21（水）13:00〜14:00', '10/22（木）10:00〜11:00',
  ]);
  g.actSendCandidates(event({ sid, kind: 'propose', form: 'cands,opts' }, { cand_0: '0', cand_1: '1', cand_2: '2', opts: ['hold', 'cc'] }));
  s = g.getSession_(sid);
  const d = env.drafts[s.draftId];
  assert.strictEqual(d.subject, '【調整中】【訪問】XYZ工業｜部品調達｜佐藤サプライヤー');
  assert.match(d.mime, /^To: =\?UTF-8\?B\?.+\?= <sato@supplier.jp>$/m);
  assert.match(d.mime, /^Cc: yamada@our.co.jp$/m);
  assert.match(d.body, /下記の候補日でいかがでしょうか/);
  assert.match(d.body, /場所：貴社 本社/);
  assert.strictEqual(s.threadIds.length, 1, '下書きのスレッドが紐づく');
});
