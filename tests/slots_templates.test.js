const test = require('node:test');
const assert = require('node:assert');
const { loadGas } = require('./load');

const g = loadGas();
const at = (d, h, m = 0) => new Date(2026, 8, d, h, m).getTime();

test('全員の空き判定', () => {
  const people = [
    { email: 'a@x', name: '山田', busy: [{ start: at(15, 13), end: at(15, 14) }] },
    { email: 'b@x', name: '佐藤', busy: [] },
    { email: 'c@x', name: '外部', error: 'notFound' },
  ];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.evaluateCandidate({ start: at(15, 13, 30), end: at(15, 14, 30) }, people))), {
    status: 'busy', busy: ['山田'], unknown: ['外部'],
  });
  assert.strictEqual(g.evaluateCandidate({ start: at(15, 14), end: at(15, 15) }, people.slice(0, 2)).status, 'free');
});

test('共通の空き枠を土日・祝日・昼休み・予定を避けて探す', () => {
  const busy = [{ start: at(14, 10), end: at(14, 12) }]; // 9/14(月) 午前は予定あり
  const slots = g.findFreeSlots(busy, {
    rangeStart: new Date(2026, 8, 12), // 土曜
    rangeEnd: new Date(2026, 8, 22),
    dayStartMin: 10 * 60, dayEndMin: 18 * 60, durationMin: 60, count: 4,
    skipWeekends: true, holidays: ['2026-09-21'],
    excludeRanges: [{ startMin: 12 * 60, endMin: 13 * 60 }],
  });
  assert.deepStrictEqual([...slots.map((s) => g.formatSlot(s.start, s.end))], [
    '9/14（月）13:00〜14:00',
    '9/15（火）13:00〜14:00',
    '9/16（水）10:00〜11:00',
    '9/17（木）13:00〜14:00',
  ]);
});

test('枠が足りなければ同じ日から追加する', () => {
  const slots = g.findFreeSlots([], {
    rangeStart: new Date(2026, 8, 14), rangeEnd: new Date(2026, 8, 14),
    dayStartMin: 10 * 60, dayEndMin: 13 * 60, durationMin: 60, count: 3,
  });
  assert.strictEqual(slots.length, 3);
  assert.ok(slots.every((s, i) => i === 0 || s.start >= slots[i - 1].end));
});

test('件名の組み立て', () => {
  const info = { company: 'ABC商事', project: '新製品案件', contact: '田中', role: 'バイヤー', mode: 'web' };
  assert.strictEqual(g.buildSubject(info, 'pending'), '【調整中】【Web】ABC商事｜新製品案件｜田中バイヤー');
  assert.strictEqual(g.buildSubject({ ...info, mode: 'hybrid' }, 'confirmed'), '【確定】【訪問・一部Web】ABC商事｜新製品案件｜田中バイヤー');
  assert.strictEqual(g.buildSubject({ ...info, project: '', contact: '' }, 'pending'), '【調整中】【Web】ABC商事');
});

test('打診・確定メール本文', () => {
  const info = { company: 'ABC商事', project: '新製品案件', contact: '田中', role: 'バイヤー', mode: 'web' };
  const settings = { myCompany: '自社', myName: '大谷 太郎' };
  const body = g.buildProposalBody({
    kind: 'reply', info, settings,
    slots: [{ start: at(15, 13), end: at(15, 14) }],
    participants: [{ name: '山田 花子', email: 'y@x' }],
  });
  assert.match(body, /^ABC商事\n田中様\n/);
  assert.match(body, /・9\/15（火）13:00〜14:00/);
  assert.match(body, /■ 弊社参加者\n大谷、山田/);
  const conf = g.buildConfirmationBody({
    info, settings, slot: { start: at(16, 10), end: at(16, 11) },
    conference: { type: 'zoom', url: 'https://zoom.us/j/1', meetingId: '1', passcode: 'abc' },
  });
  assert.match(conf, /9\/16（水）10:00〜11:00/);
  assert.match(conf, /■ Web会議（Zoom）\nhttps:\/\/zoom.us\/j\/1\nミーティングID：1\nパスコード：abc/);
});
