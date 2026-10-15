/**
 * Gmail 連携（開いているメールの読み取り・下書きの作成）。
 * 下書きは件名を自由に設定し、かつ元のスレッドへの返信とするため、
 * 高度なサービス「Gmail API (v1)」で MIME を組み立てて作成する。
 */

function openMessage_(e) {
  if (!e || !e.gmail || !e.gmail.messageId) return null;
  if (e.gmail.accessToken) GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  return GmailApp.getMessageById(e.gmail.messageId);
}

function isMyAddress_(email) {
  email = String(email || '').toLowerCase();
  if (email === myEmail_()) return true;
  try {
    return GmailApp.getAliases().some(function (a) { return a.toLowerCase() === email; });
  } catch (err) {
    return false;
  }
}

function senderOf_(msg) {
  return parseAddressList(msg.getFrom())[0] || { name: '', email: '' };
}

/** スレッド内で、相手から届いた最新のメッセージ（なければ null）。 */
function lastIncomingMessage_(threadId) {
  if (!threadId) return null;
  var thread = GmailApp.getThreadById(threadId);
  if (!thread) return null;
  var msgs = thread.getMessages();
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i].isDraft() && !isMyAddress_(senderOf_(msgs[i]).email)) return msgs[i];
  }
  return null;
}

function messageText_(msg) {
  return stripQuotedText(msg.getPlainBody());
}

/* ---------------- MIME ---------------- */

function encodeMimeWord_(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : '=?UTF-8?B?' + Utilities.base64Encode(text, Utilities.Charset.UTF_8) + '?=';
}

function encodeAddressList_(text) {
  return parseAddressList(text)
    .map(function (a) {
      return a.name && a.name !== a.email.split('@')[0] ? encodeMimeWord_(a.name) + ' <' + a.email + '>' : a.email;
    })
    .join(', ');
}

function buildMime_(h) {
  var lines = ['MIME-Version: 1.0', 'To: ' + encodeAddressList_(h.to)];
  if (h.cc) lines.push('Cc: ' + encodeAddressList_(h.cc));
  lines.push('Subject: ' + encodeMimeWord_(h.subject));
  if (h.inReplyTo) {
    lines.push('In-Reply-To: ' + h.inReplyTo);
    lines.push('References: ' + ((h.references ? h.references + ' ' : '') + h.inReplyTo).trim());
  }
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Utilities.base64Encode(h.body, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n'));
  return lines.join('\r\n');
}

function mergeAddresses_(lists, excludeEmails) {
  var seen = {};
  (excludeEmails || []).forEach(function (e) { seen[String(e).toLowerCase()] = true; });
  var out = [];
  lists.forEach(function (text) {
    parseAddressList(text).forEach(function (a) {
      if (seen[a.email] || isMyAddress_(a.email)) return;
      seen[a.email] = true;
      out.push(a.name && a.name !== a.email.split('@')[0] ? a.name + ' <' + a.email + '>' : a.email);
    });
  });
  return out.join(', ');
}

/**
 * セッションの先方宛てに下書きを作成する。相手からのメールがあればそのスレッドへの返信にする。
 * @param {Object} session
 * @param {string} subject
 * @param {string} body
 * @param {string=} preferredThreadId いま開いているスレッド
 * @return {{draftId: string, threadId: string}}
 */
function createSessionDraft_(session, subject, body, preferredThreadId) {
  var threadIds = [preferredThreadId].concat((session.threadIds || []).slice().reverse()).filter(Boolean);
  var replyTo = null;
  for (var i = 0; i < threadIds.length && !replyTo; i++) replyTo = lastIncomingMessage_(threadIds[i]);

  var to = session.to;
  var cc = '';
  var header = { subject: subject, body: body };
  if (replyTo) {
    to = replyTo.getReplyTo() || replyTo.getFrom();
    cc = replyTo.getCc();
    header.inReplyTo = replyTo.getHeader('Message-ID');
    header.references = replyTo.getHeader('References');
  }
  if (!to) throw new Error('宛先が分かりません。宛先メールアドレスを入力してください。');
  var toEmails = parseAddressList(to).map(function (a) { return a.email; });
  var memberCc = session.options && session.options.cc
    ? (session.participants || []).map(function (p) { return p.name + ' <' + p.email + '>'; }).join(', ')
    : '';
  header.to = to;
  header.cc = mergeAddresses_([cc, memberCc], toEmails);

  var raw = Utilities.base64EncodeWebSafe(buildMime_(header));
  var draft;
  var threadId = replyTo ? replyTo.getThread().getId() : null;
  try {
    draft = Gmail.Users.Drafts.create({ message: { raw: raw, threadId: threadId || undefined } }, 'me');
  } catch (err) {
    if (!threadId) throw err;
    // 件名の変更などでスレッドに入れられない場合は、新しいスレッドとして作成する
    console.warn('スレッドへの返信として下書きを作成できませんでした: ' + err);
    draft = Gmail.Users.Drafts.create({ message: { raw: raw } }, 'me');
  }
  return { draftId: draft.id, threadId: draft.message && draft.message.threadId };
}

function draftComposeResponse_(draftId) {
  return CardService.newComposeActionResponseBuilder().setGmailDraft(GmailApp.getDraft(draftId)).build();
}
