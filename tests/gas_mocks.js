// Apps Script サービスの簡易モック（フロー全体の結合テスト用）
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function builder(kind, log) {
  const calls = [];
  const self = new Proxy({}, {
    get(_, prop) {
      if (prop === '__kind') return kind;
      if (prop === '__calls') return calls;
      if (prop === 'toJSON') return () => ({ kind, calls });
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'build') return () => ({ kind, calls, text: flatten(calls) });
      return (...args) => { calls.push([prop, args]); return self; };
    },
  });
  return self;
}

function flatten(calls) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v.__calls) v.__calls.forEach(([, args]) => walk(args));
    else if (v.calls) v.calls.forEach(([, args]) => walk(args));
  };
  walk(calls.map(([, a]) => a));
  return out.join('\n');
}

const CardService = new Proxy({}, {
  get(_, prop) {
    if (typeof prop === 'string' && prop.startsWith('new')) return () => builder(prop.slice(3));
    return new Proxy({}, { get: (_, k) => `${String(prop)}.${String(k)}` });
  },
});

function makeEnv({ me = 'me@our.co.jp', messages = {}, threads = {}, busy = {}, scriptProps = {}, fetch = null } = {}) {
  const props = {};
  const store = {
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    setProperties: (o) => Object.assign(props, o),
    deleteProperty: (k) => { delete props[k]; },
    getProperties: () => ({ ...props }),
  };
  const events = {};
  const drafts = {};
  let seq = 0;
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => console.error(...a) },
    CardService,
    PropertiesService: { getUserProperties: () => store, getScriptProperties: () => ({ getProperty: (k) => (k in scriptProps ? scriptProps[k] : null) }) },
    Session: { getActiveUser: () => ({ getEmail: () => me }), getEffectiveUser: () => ({ getEmail: () => me }), getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      getUuid: () => `uuid-${++seq}-0000-0000-000000000000`,
      base64Encode: (s) => Buffer.from(s, 'utf8').toString('base64'),
      base64EncodeWebSafe: (s) => Buffer.from(s, 'utf8').toString('base64url'),
      formatDate: (d) => d.toISOString(),
      sleep() {},
      Charset: { UTF_8: 'UTF-8' },
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    CalendarApp: { getCalendarById: () => null },
    Calendar: {
      Freebusy: {
        query: (req) => ({ calendars: Object.fromEntries(req.items.map(({ id }) => [id, busy[id] === 'error' ? { errors: [{ reason: 'notFound' }] } : { busy: (busy[id] || []).map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })) }])) }),
      },
      Events: {
        insert: (r) => { const id = `ev${++seq}`; events[id] = { ...r, id, htmlLink: `https://cal/${id}` }; if (r.conferenceData) events[id].hangoutLink = `https://meet.google.com/${id}`; return events[id]; },
        patch: (r, cal, id) => { Object.assign(events[id], r); if (r.conferenceData) events[id].hangoutLink = `https://meet.google.com/${id}`; return events[id]; },
        get: (cal, id) => events[id],
        remove: (cal, id) => { delete events[id]; },
      },
    },
    Gmail: {
      Users: {
        Drafts: {
          create: (res) => {
            const id = `d${++seq}`;
            const mime = Buffer.from(res.message.raw, 'base64url').toString('utf8');
            drafts[id] = { mime, threadId: res.message.threadId, body: decodeBody(mime), subject: decodeSubject(mime) };
            return { id, message: { id: `m${seq}`, threadId: res.message.threadId || `t-new-${seq}` } };
          },
        },
      },
    },
    GmailApp: {
      setCurrentMessageAccessToken() {},
      getAliases: () => [],
      getMessageById: (id) => messages[id],
      getThreadById: (id) => threads[id],
      getDraft: (id) => ({ draftId: id }),
    },
    People: { People: { searchDirectoryPeople: () => ({ people: [{ names: [{ displayName: '鈴木 一郎' }], emailAddresses: [{ value: 'suzuki@our.co.jp' }] }] }) } },
    UrlFetchApp: { fetch: (url, params) => { if (!fetch) throw new Error('no network in tests'); const r = fetch(url, params); return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }; } },
  };
  vm.createContext(ctx);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, props, events, drafts };
}

function decodeSubject(mime) {
  const m = mime.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : (mime.match(/^Subject: (.*)$/m) || [])[1];
}

function decodeBody(mime) {
  return Buffer.from(mime.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
}

function fakeMessage({ id, threadId, from, to = 'me@our.co.jp', cc = '', subject, body, date, threadsRef }) {
  return {
    getId: () => id,
    getFrom: () => from,
    getTo: () => to,
    getCc: () => cc,
    getReplyTo: () => '',
    getSubject: () => subject,
    getPlainBody: () => body,
    getDate: () => date,
    isDraft: () => false,
    getHeader: (h) => (h === 'Message-ID' ? `<${id}@mail>` : ''),
    getThread: () => threadsRef[threadId],
  };
}

module.exports = { makeEnv, fakeMessage };
