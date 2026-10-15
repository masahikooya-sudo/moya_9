const test = require('node:test');
const assert = require('node:assert');
const { loadGas } = require('./load');

const g = loadGas();
const ref = new Date(2026, 8, 8, 10, 24); // 2026/9/8

const sampleMail = `田中です。

来週の打ち合わせについて、下記の候補でいかがでしょうか。

・9/15（月）13:00〜14:00
・9/16（火）10:00〜11:00
・9/17（水）15:00〜16:00

お忙しいところ恐れ入りますが、ご確認いただけますと幸いです。
`;

const plain = (x) => JSON.parse(JSON.stringify(x));
const fmt = (c) => g.formatSlot(c.start, c.end);

test('箇条書きの候補日を抽出する', () => {
  const r = g.parseCandidates(sampleMail, { referenceDate: ref });
  assert.deepStrictEqual(plain(r.map(fmt)), ['9/15（火）13:00〜14:00', '9/16（水）10:00〜11:00', '9/17（木）15:00〜16:00']);
});

test('全角数字・「時」表記・終了時刻なし・1行に複数枠', () => {
  const text = '９月２０日（日） １４時～１５時半\n10月1日 午後1時から\n10/2(金) 10:00-11:00、14:00-15:00';
  const r = g.parseCandidates(text, { referenceDate: ref, defaultDurationMin: 30 });
  assert.deepStrictEqual(plain(r.map(fmt)), [
    '9/20（日）14:00〜15:30',
    '10/1（木）13:00〜13:30',
    '10/2（金）10:00〜11:00',
    '10/2（金）14:00〜15:00',
  ]);
});

test('「1時〜2時」は午後とみなし、「1時間」は時刻として扱わない', () => {
  const r = g.parseCandidates('9/18 1時〜2時（1時間程度）', { referenceDate: ref });
  assert.deepStrictEqual(plain(r.map(fmt)), ['9/18（金）13:00〜14:00']);
});

test('年をまたぐ日付は翌年と解釈する', () => {
  const r = g.parseCandidates('1/12 10:00〜11:00', { referenceDate: new Date(2026, 11, 20) });
  assert.strictEqual(r[0].start.getFullYear(), 2027);
});

test('日付の次の行の時刻も拾う', () => {
  const r = g.parseCandidates('9/21(月)\n  10:00〜11:30\n', { referenceDate: ref });
  assert.deepStrictEqual(plain(r.map(fmt)), ['9/21（月）10:00〜11:30']);
});

test('引用部分を除去する', () => {
  const body = '9/16でお願いします。\n\n2026年9月10日(木) 10:24 田中 太郎 <tanaka@abc-corp.co.jp>:\n> 9/15 13:00〜14:00\n';
  assert.strictEqual(g.stripQuotedText(body).trim(), '9/16でお願いします。');
});

test('確定連絡の検出（日付のみ・日時・日・曜日）', () => {
  const cands = g.parseCandidates(sampleMail, { referenceDate: ref }).map((c) => ({ start: c.start.getTime(), end: c.end.getTime() }));
  let r = g.detectConfirmation('「9/16でお願いします。」', cands, { referenceDate: ref });
  assert.strictEqual(r.index, 1);
  assert.strictEqual(r.confident, true);
  r = g.detectConfirmation('9月17日 15時からで問題ございません', cands, { referenceDate: ref });
  assert.strictEqual(r.index, 2);
  r = g.detectConfirmation('15日でお願いいたします', cands, { referenceDate: ref });
  assert.strictEqual(r.index, 0);
  r = g.detectConfirmation('水曜日でお願いします', cands, { referenceDate: ref });
  assert.strictEqual(r.index, 1);
  r = g.detectConfirmation('いずれの日程も難しく、別の候補をいただけますか', cands, { referenceDate: ref });
  assert.strictEqual(r.confident, false);
});

test('アドレス一覧の解析', () => {
  const r = g.parseAddressList('山田 花子 <Yamada@example.com>\nsato@example.com, "鈴木 一郎" <suzuki@example.com>');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), [
    { name: '山田 花子', email: 'yamada@example.com' },
    { name: 'sato', email: 'sato@example.com' },
    { name: '鈴木 一郎', email: 'suzuki@example.com' },
  ]);
});

test('案件情報の推定', () => {
  const body = 'いつもお世話になっております。\nABC商事の田中です。\n\n来週の打ち合わせについてWebで...\n---\n田中 太郎\nABC商事 株式会社\nバイヤー';
  const r = g.guessDealInfo('Re: 来週の打ち合わせ候補について', body, { name: '田中 太郎', email: 'tanaka@abc-corp.co.jp' });
  assert.strictEqual(r.company, 'ABC商事');
  assert.strictEqual(r.contact, '田中');
  assert.strictEqual(r.project, '来週の打ち合わせ候補について');
  assert.strictEqual(r.mode, 'web');
  const r2 = g.guessDealInfo('件名', 'ご来社いただく形で\n---\n株式会社XYZ\n佐藤', { name: '佐藤', email: 'sato@xyz.jp' });
  assert.strictEqual(r2.company, '株式会社XYZ');
  assert.strictEqual(r2.mode, 'visit');
});
