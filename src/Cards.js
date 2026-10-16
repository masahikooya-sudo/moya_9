/**
 * サイドバーのカード UI。
 * 各カードのアクションには、どの入力欄がカード上にあるかを示す `form` パラメータを付け、
 * Main.js の applyForm_ がその欄だけをセッションに反映する。
 */

var ADDON_TITLE = '日程調整アシスタント';
var ADDON_LOGO = 'https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png';

/* ---------------- 共通ヘルパー ---------------- */

function action_(fn, session, extra) {
  var params = { sid: session ? session.id : '', kind: session ? session.kind : '' };
  Object.keys(extra || {}).forEach(function (k) { params[k] = String(extra[k]); });
  return CardService.newAction().setFunctionName(fn).setParameters(params);
}

function button_(text, action, style) {
  var b = CardService.newTextButton().setText(text).setOnClickAction(action);
  if (style) b.setTextButtonStyle(style);
  return b;
}

function filledButton_(text, action) {
  return button_(text, action, CardService.TextButtonStyle.FILLED);
}

function linkButton_(text, url) {
  return CardService.newTextButton().setText(text).setOpenLink(CardService.newOpenLink().setUrl(url));
}

function composeButton_(text, action, isReply, filled) {
  var b = CardService.newTextButton()
    .setText(text)
    .setComposeAction(
      action,
      isReply ? CardService.ComposedEmailType.REPLY_AS_DRAFT : CardService.ComposedEmailType.STANDALONE_DRAFT
    );
  if (filled) b.setTextButtonStyle(CardService.TextButtonStyle.FILLED);
  return b;
}

function paragraph_(html) {
  return CardService.newTextParagraph().setText(html);
}

function esc_(text) {
  return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function colored_(text, color) {
  return '<font color="' + color + '">' + text + '</font>';
}

function header_(subtitle) {
  return CardService.newCardHeader().setTitle(ADDON_TITLE).setSubtitle(subtitle || '').setImageUrl(ADDON_LOGO);
}

function textInput_(name, title, value, hint, multiline) {
  var t = CardService.newTextInput().setFieldName(name).setTitle(title).setValue(value || '');
  if (hint) t.setHint(hint);
  if (multiline) t.setMultiline(true);
  return t;
}

function dropdown_(name, title, items, selected) {
  var d = CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName(name).setTitle(title);
  items.forEach(function (it) { d.addItem(it[0], String(it[1]), String(it[1]) === String(selected)); });
  return d;
}

function checkboxes_(name, title, items) {
  var c = CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName(name);
  if (title) c.setTitle(title);
  items.forEach(function (it) { c.addItem(it[0], String(it[1]), !!it[2]); });
  return c;
}

function timeOptions_() {
  var out = [];
  for (var m = 7 * 60; m <= 21 * 60; m += 30) out.push([Math.floor(m / 60) + ':' + pad2_(m % 60), m]);
  return out;
}

function toUtcMidnight_(ms) {
  var d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

function datePicker_(name, title, ms) {
  return CardService.newDatePicker().setFieldName(name).setTitle(title).setValueInMsSinceEpoch(toUtcMidnight_(ms));
}

function statusLabel_(availability) {
  if (!availability) return '';
  if (availability.status === 'free') return colored_('✅ 全員空き', '#188038');
  if (availability.status === 'busy') {
    return colored_('⚠️ ' + availability.busy.length + '名が予定あり：' + esc_(availability.busy.join('、')), '#e37400');
  }
  return colored_('❔ 確認できない参加者：' + esc_(availability.unknown.join('、')), '#5f6368');
}

function candidateToggle_(c, i, showStatus) {
  var w = CardService.newDecoratedText()
    .setText(formatSlot(c.start, c.end))
    .setWrapText(true)
    .setSwitchControl(
      CardService.newSwitch()
        .setFieldName('cand_' + i)
        .setValue(String(i))
        .setSelected(c.selected !== false)
        .setControlType(CardService.SwitchControlType.CHECK_BOX)
    );
  if (showStatus && c.availability) w.setBottomLabel(statusLabel_(c.availability));
  return w;
}

function tabs_(session, current) {
  var mail = button_('メールから', action_('actGoMail', session),
    current === 'mail' ? CardService.TextButtonStyle.FILLED : CardService.TextButtonStyle.OUTLINED);
  var propose = button_('新規で作成', action_('actGoPropose', session, { fromMail: '1' }),
    current === 'propose' ? CardService.TextButtonStyle.FILLED : CardService.TextButtonStyle.OUTLINED);
  return CardService.newButtonSet().addButton(mail).addButton(propose);
}

/* ---------------- 入力欄のまとまり ---------------- */

function infoSection_(session, title, withTo) {
  var info = session.info;
  var sec = CardService.newCardSection().setHeader(title);
  if (withTo) sec.addWidget(textInput_('to', '宛先（先方のメールアドレス）', session.to, '田中 太郎 <tanaka@example.co.jp>'));
  sec.addWidget(textInput_('company', '会社名', info.company))
    .addWidget(textInput_('contact', '担当者（姓）', info.contact))
    .addWidget(dropdown_('role', '先方の立場（件名に表示）', ROLE_OPTIONS.map(function (r) { return [r, r]; }), info.role))
    .addWidget(textInput_('project', '案件名', info.project))
    .addWidget(dropdown_('mode', '形式', [['Web', 'web'], ['訪問', 'visit'], ['訪問（一部Web参加含む）', 'hybrid']], info.mode))
    .addWidget(textInput_('location', '場所（訪問の場合）', info.location, '例：貴社 本社 3F会議室'));
  sec.addWidget(paragraph_('件名：<b>' + esc_(buildSubject(info, 'pending', getSettings_().subjectTemplate)) + '</b>'));
  return sec;
}

function memberOptions_(session) {
  var seen = {};
  var out = [];
  (session.participants || []).concat(session.memberOptions || []).forEach(function (m) {
    if (seen[m.email]) return;
    seen[m.email] = true;
    out.push(m);
  });
  return out;
}

function membersSection_(session, title, view) {
  var sec = CardService.newCardSection().setHeader(title);
  var options = memberOptions_(session);
  var selected = {};
  (session.participants || []).forEach(function (p) { selected[p.email] = true; });
  if (options.length) {
    sec.addWidget(checkboxes_('members', '', options.map(function (m) {
      return [m.name + '（' + m.email + '）', m.email, selected[m.email]];
    })));
  } else {
    sec.addWidget(paragraph_(colored_('設定の「よく使う社内メンバー」に登録すると、ここに選択肢が表示されます。', '#5f6368')));
  }
  sec.addWidget(textInput_('extraMembers', 'メールアドレスで追加', '', 'yamada@example.co.jp, 佐藤 健 <sato@example.co.jp>'))
    .addWidget(textInput_('dirQuery', '名前やメールアドレスで社内検索', ''))
    .addWidget(button_('社内ディレクトリを検索', action_('actRefresh', session, { view: view, op: 'dirSearch', form: formOf_(view) })));
  return sec;
}

function formOf_(view) {
  return { mail: 'info,cands,members', propose: 'info,members,search', avail: 'cands,opts', confirm: 'confirm' }[view] || '';
}

/* ---------------- ① メールから（先方提示の候補） ---------------- */

function buildFromMailCard_(session, e) {
  var card = CardService.newCardBuilder().setName('mail')
    .setHeader(header_(session.external ? '外部からのメール' : 'メールから'));
  card.addSection(CardService.newCardSection().addWidget(tabs_(session, 'mail')));

  var sec = CardService.newCardSection().setHeader('① 候補日の抽出');
  if (session.candidates.length) {
    sec.addWidget(paragraph_('このメールから以下の候補日を抽出しました。'));
    session.candidates.forEach(function (c, i) { sec.addWidget(candidateToggle_(c, i, false)); });
  } else {
    sec.addWidget(paragraph_(colored_('このメールから候補日が見つかりませんでした。', '#e37400') +
      '<br>下で手入力するか、「新規で作成」でこちらから候補日を提示できます。'));
  }
  sec.addWidget(textInput_('manualCand', '候補を手入力で追加', '', '例：9/18 14:00〜15:00、9/19(金) 10時〜11時'))
    .addWidget(button_('候補を追加', action_('actRefresh', session, { view: 'mail', op: 'addCand', form: formOf_('mail') })));
  card.addSection(sec);

  card.addSection(infoSection_(session, '② 案件情報（件名に使用）', false).setCollapsible(true).setNumUncollapsibleWidgets(2));
  card.addSection(membersSection_(session, '③ 社内の参加者を選択', 'mail'));
  card.setFixedFooter(CardService.newFixedFooter().setPrimaryButton(
    filledButton_('空き状況を確認', action_('actCheckAvailability', session, { form: formOf_('mail') }))));
  return card.build();
}

/* ---------------- 新規で作成（こちらから候補を提示） ---------------- */

function buildProposeCard_(session, e, sessions) {
  var card = CardService.newCardBuilder().setName('propose').setHeader(header_('新規で作成'));
  if (e && e.gmail) card.addSection(CardService.newCardSection().addWidget(tabs_(session, 'propose')));

  var hasThread = (session.threadIds || []).length > 0;
  card.addSection(infoSection_(session, '① 案件情報', !hasThread));
  card.addSection(membersSection_(session, '② 社内の参加者を選択', 'propose'));

  var sr = session.search;
  var sec = CardService.newCardSection().setHeader('③ 候補日の検索条件')
    .addWidget(datePicker_('rangeStart', '期間（開始日）', sr.rangeStart))
    .addWidget(datePicker_('rangeEnd', '期間（終了日）', sr.rangeEnd))
    .addWidget(dropdown_('dayStart', '時間帯（開始）', timeOptions_(), sr.dayStartMin))
    .addWidget(dropdown_('dayEnd', '時間帯（終了）', timeOptions_(), sr.dayEndMin))
    .addWidget(dropdown_('duration', '所要時間', [['30分', 30], ['45分', 45], ['1時間', 60], ['1時間30分', 90], ['2時間', 120]], session.info.durationMin))
    .addWidget(dropdown_('count', '候補の数', [['1件', 1], ['2件', 2], ['3件', 3], ['4件', 4], ['5件', 5]], sr.count))
    .addWidget(checkboxes_('searchOpts', '', [
      ['土日・祝日を除く', 'skipWeekends', sr.skipWeekends],
      ['昼休み（12:00〜13:00）を除く', 'excludeLunch', sr.excludeLunch],
    ]));
  card.addSection(sec);

  if (sessions && sessions.length) card.addSection(sessionsSection_(sessions.slice(0, 5)).setCollapsible(true).setNumUncollapsibleWidgets(1));

  card.setFixedFooter(CardService.newFixedFooter().setPrimaryButton(
    filledButton_('全員の空きから候補日を探す', action_('actFindSlots', session, { form: formOf_('propose') }))));
  return card.build();
}

/* ---------------- 空き状況の確認結果 → 送信準備 ---------------- */

function buildAvailabilityCard_(session, e) {
  var card = CardService.newCardBuilder().setName('avail').setHeader(header_('空き状況の確認'));
  var cands = session.candidates;
  var free = cands.filter(function (c) { return c.availability && c.availability.status === 'free'; }).length;
  var people = availabilityPeople_(session).map(function (p) { return familyName(p.name); }).join('、');

  var sec = CardService.newCardSection();
  if (free === cands.length) sec.addWidget(paragraph_(colored_('<b>✅ 全員が参加可能な候補です</b>', '#188038')));
  else if (free > 0) sec.addWidget(paragraph_(colored_('<b>⚠️ 一部の候補で予定が重なっています</b>', '#e37400')));
  else sec.addWidget(paragraph_(colored_('<b>⚠️ 全員が空いている候補がありません</b>', '#d93025')));
  sec.addWidget(paragraph_(colored_('参加者のカレンダーを確認しました（' + esc_(people) + '）', '#5f6368')));
  cands.forEach(function (c, i) { sec.addWidget(candidateToggle_(c, i, true)); });
  sec.addWidget(textInput_('manualCand', '候補を追加', '', '例：9/18 14:00〜15:00'))
    .addWidget(button_('＋ 候補を追加して確認', action_('actRefresh', session, { view: 'avail', op: 'addCand', form: formOf_('avail') })));
  card.addSection(sec);

  var o = session.options || {};
  card.addSection(CardService.newCardSection().setHeader('④ 実行するアクション')
    .addWidget(checkboxes_('opts', '', [
      ['選択した候補をカレンダーに仮押さえ（タイトルに【調整中】を付与）', 'hold', o.hold],
      ['社内参加者も仮押さえに招待（参加者の予定もブロック）', 'invite', o.invite],
      ['社内参加者をメールのCCに追加', 'cc', o.cc],
    ]))
    .addWidget(paragraph_('件名：<b>' + esc_(buildSubject(session.info, 'pending', getSettings_().subjectTemplate)) + '</b>')));

  card.setFixedFooter(CardService.newFixedFooter()
    .setPrimaryButton(filledButton_('候補日を送る（下書きを作成）', action_('actSendCandidates', session, { form: formOf_('avail') })))
    .setSecondaryButton(button_('戻る', action_('actBack', session))));
  return card.build();
}

/* ---------------- 下書き作成完了 ---------------- */

function isCurrentThread_(e, threadId) {
  return !!(e && e.gmail && threadId && e.gmail.threadId === threadId);
}

function buildSentCard_(session, e) {
  var card = CardService.newCardBuilder().setName('sent').setHeader(header_('候補日を送る準備ができました'));
  var sec = CardService.newCardSection()
    .addWidget(paragraph_(colored_('<b>✅ メールの下書きを作成しました</b>', '#188038')))
    .addWidget(CardService.newDecoratedText().setTopLabel('件名').setText(esc_(session.lastSubject || '')).setWrapText(true));
  session.candidates.forEach(function (c) {
    var w = CardService.newDecoratedText().setText(formatSlot(c.start, c.end))
      .setBottomLabel(c.eventId ? '【調整中】で仮押さえ済み' : '仮押さえなし');
    if (c.eventLink) w.setOpenLink(CardService.newOpenLink().setUrl(c.eventLink));
    sec.addWidget(w);
  });
  sec.addWidget(composeButton_('下書きを開いて編集・送信', action_('actOpenDraft', session, { draftId: session.draftId }),
    isCurrentThread_(e, session.draftThreadId), true));
  sec.addWidget(linkButton_('下書きフォルダを開く', 'https://mail.google.com/mail/u/0/#drafts'));
  sec.addWidget(paragraph_(colored_('先方から返信が届いたら、そのメールを開くと「日程確定」の操作ができます。', '#5f6368')));
  card.addSection(sec);
  return card.build();
}

/* ---------------- 日程確定 ---------------- */

function buildConfirmCard_(session, e, detection) {
  var card = CardService.newCardBuilder().setName('confirm').setHeader(header_('日程確定'));
  var cands = session.candidates;
  var det = detection || { index: -1 };
  var settings = getSettings_();

  var top = CardService.newCardSection();
  if (det.index >= 0 && det.confident) {
    top.addWidget(paragraph_(colored_('<b>✅ このメールから確定のご連絡を検出しました</b>', '#188038')))
      .addWidget(paragraph_('<b>' + formatSlot(cands[det.index].start, cands[det.index].end) + '</b>'));
  } else if (det.index >= 0) {
    top.addWidget(paragraph_(colored_('<b>このメールに次の候補日の記載があります</b>', '#1a73e8')))
      .addWidget(paragraph_('<b>' + formatSlot(cands[det.index].start, cands[det.index].end) + '</b>'));
  } else if (det.quote) {
    top.addWidget(paragraph_(colored_('返信から確定日を特定できませんでした。下から選択してください。', '#e37400')));
  } else {
    top.addWidget(paragraph_('先方からの返信待ちです。確定した日時を選択して確定できます。'));
  }
  if (det.quote) top.addWidget(paragraph_(colored_('「' + esc_(det.quote) + '」', '#5f6368')));
  if (det.declineWords) {
    top.addWidget(paragraph_(colored_('⚠️ 候補日が合わなかった可能性があります。', '#d93025')))
      .addWidget(button_('候補日を出し直す', action_('actReplan', session)));
  }
  card.addSection(top);

  var pick = CardService.newSelectionInput().setType(CardService.SelectionInputType.RADIO_BUTTON)
    .setFieldName('confirmIdx').setTitle('確定する日時');
  var defIdx = det.index >= 0 ? det.index : cands.length === 1 ? 0 : -1;
  cands.forEach(function (c, i) { pick.addItem(formatSlot(c.start, c.end), String(i), i === defIdx); });
  card.addSection(CardService.newCardSection().addWidget(pick));

  var defaultConf = session.info.mode === 'visit' ? 'none' : defaultConference_(settings);
  var confItems = ENABLED_CONFERENCES.map(function (k) { return [CONFERENCE_LABELS[k], k]; });
  var act = CardService.newCardSection().setHeader('実行するアクション')
    .addWidget(checkboxes_('confirmOpts', '', [
      ['確定した日時でカレンダーを更新（他の候補は削除）', 'updateCal', true],
      ['社内参加者にカレンダー招待を送信', 'invite', (session.participants || []).length > 0],
      ['先方もカレンダー招待に追加', 'inviteExternal', false],
      ['返信メールの下書きを作成', 'draft', true],
    ]))
    .addWidget(dropdown_('confType', 'ビデオ会議リンクを作成', confItems, defaultConf))
    .addWidget(textInput_('confUrl', '会議URL（手入力の場合）', '', 'https://...'))
    .addWidget(textInput_('location', '場所（訪問の場合）', session.info.location));
  card.addSection(act);

  var more = CardService.newCardSection();
  var buttons = CardService.newButtonSet();
  if (e && e.gmail) {
    buttons.addButton(composeButton_('確定して下書きを開く', action_('actConfirmCompose', session, { form: 'confirm' }), true, false));
  }
  buttons.addButton(button_('候補日を出し直す', action_('actReplan', session)));
  buttons.addButton(button_('調整を中止', action_('actCancelSession', session)));
  more.addWidget(buttons);
  card.addSection(more);

  card.setFixedFooter(CardService.newFixedFooter().setPrimaryButton(
    filledButton_('日程を確定する', action_('actConfirm', session, { form: 'confirm' }))));
  return card.build();
}

function buildConfirmedCard_(session, e) {
  var card = CardService.newCardBuilder().setName('confirmed').setHeader(header_('日程確定済み'));
  var cf = session.confirmed || {};
  var sec = CardService.newCardSection()
    .addWidget(paragraph_(colored_('<b>✅ 日程が確定しています</b>', '#188038')))
    .addWidget(CardService.newDecoratedText().setTopLabel('日時').setText('<b>' + formatSlot(cf.start, cf.end) + '</b>'))
    .addWidget(CardService.newDecoratedText().setTopLabel('案件').setText(esc_(buildSubject(session.info, 'confirmed', getSettings_().subjectTemplate))).setWrapText(true));
  if (cf.conference && cf.conference.url) {
    sec.addWidget(CardService.newDecoratedText().setTopLabel(CONFERENCE_LABELS[cf.conference.type] || 'Web会議')
      .setText(esc_(cf.conference.url)).setWrapText(true)
      .setOpenLink(CardService.newOpenLink().setUrl(cf.conference.url)));
  }
  var buttons = CardService.newButtonSet();
  if (cf.eventLink) buttons.addButton(linkButton_('カレンダーで開く', cf.eventLink));
  if (cf.draftId) {
    buttons.addButton(composeButton_('確定メールの下書きを開く', action_('actOpenDraft', session, { draftId: cf.draftId }),
      isCurrentThread_(e, cf.draftThreadId), false));
  }
  sec.addWidget(buttons);
  card.addSection(sec);
  if (e && e.gmail) {
    card.addSection(CardService.newCardSection().addWidget(button_('このメールで新しく日程調整を始める', action_('actStartFresh', session))));
  }
  return card.build();
}

/* ---------------- 進行中の調整一覧 ---------------- */

function sessionsSection_(sessions) {
  var sec = CardService.newCardSection().setHeader('進行中の日程調整');
  if (!sessions.length) return sec.addWidget(paragraph_('進行中の日程調整はありません。'));
  sessions.forEach(function (s) {
    var label = s.status === SESSION_STATUS.CONFIRMED ? '確定' : s.status === SESSION_STATUS.PENDING ? '調整中' : '作成途中';
    var detail = s.status === SESSION_STATUS.CONFIRMED && s.confirmed
      ? formatSlot(s.confirmed.start, s.confirmed.end)
      : (s.candidates || []).map(function (c) { return formatDateJa(c.start); }).join('、');
    sec.addWidget(CardService.newDecoratedText()
      .setTopLabel(label)
      .setText(esc_([s.info.company, s.info.project].filter(Boolean).join('｜') || '（無題）'))
      .setBottomLabel(esc_(detail))
      .setWrapText(true)
      .setOnClickAction(action_('actShowSession', s)));
  });
  return sec;
}

function buildSessionsCard_(sessions) {
  var active = sessions.filter(function (s) { return s.status !== SESSION_STATUS.EDITING; });
  return CardService.newCardBuilder().setName('sessions').setHeader(header_('進行中の日程調整'))
    .addSection(sessionsSection_(active))
    .build();
}

/* ---------------- 設定 ---------------- */

function buildSettingsCard_() {
  var s = getSettings_();
  var mins = [['30分', 30], ['45分', 45], ['1時間', 60], ['1時間30分', 90], ['2時間', 120]];
  var card = CardService.newCardBuilder().setName('settings').setHeader(header_('設定'));
  card.addSection(CardService.newCardSection().setHeader('差出人情報（メール本文に使用）')
    .addWidget(textInput_('myCompany', '自社名', s.myCompany, '例：株式会社〇〇'))
    .addWidget(textInput_('myName', '自分の氏名', s.myName, '例：大谷 雅彦'))
    .addWidget(textInput_('signature', '署名', s.signature, '空欄の場合は自社名と氏名を使用', true)));
  card.addSection(CardService.newCardSection().setHeader('社内メンバー')
    .addWidget(textInput_('internalDomains', '社内ドメイン（カンマ区切り）', s.internalDomains, 'example.co.jp'))
    .addWidget(textInput_('favorites', 'よく使う社内メンバー（1行に1人）', s.favorites, '山田 花子 <yamada@example.co.jp>', true)));
  card.addSection(CardService.newCardSection().setHeader('既定値')
    .addWidget(dropdown_('defaultDurationMin', '所要時間', mins, s.defaultDurationMin))
    .addWidget(dropdown_('dayStartMin', '候補の時間帯（開始）', timeOptions_(), s.dayStartMin))
    .addWidget(dropdown_('dayEndMin', '候補の時間帯（終了）', timeOptions_(), s.dayEndMin))
    .addWidget(dropdown_('defaultRole', '先方の立場', ROLE_OPTIONS.map(function (r) { return [r, r]; }), s.defaultRole))
    .addWidget(dropdown_('defaultConference', 'ビデオ会議',
      ENABLED_CONFERENCES.filter(function (k) { return k !== 'manual'; }).map(function (k) { return [CONFERENCE_LABELS[k], k]; }),
      defaultConference_(s)))
    .addWidget(textInput_('subjectTemplate', '件名テンプレート', s.subjectTemplate,
      '{status} {mode} {company} {project} {contact} {role} が使えます'))
    .addWidget(checkboxes_('flags', '', [
      ['昼休み（12:00〜13:00）を候補から除く', 'excludeLunch', s.excludeLunch],
      ['候補をカレンダーに仮押さえする', 'holdByDefault', s.holdByDefault],
      ['社内参加者も仮押さえに招待する', 'inviteMembersToHolds', s.inviteMembersToHolds],
      ['社内参加者をメールのCCに入れる', 'ccMembers', s.ccMembers],
    ])));
  card.addSection(CardService.newCardSection().setHeader('ビデオ会議')
    .addWidget(paragraph_('Google Meet：✅ 利用可能<br>' +
      colored_('先方指定の Zoom・Teams などの会議は、確定時に「その他（URLを手入力）」で URL を入力してください。', '#5f6368'))));
  card.setFixedFooter(CardService.newFixedFooter().setPrimaryButton(filledButton_('保存', action_('actSaveSettings', null))));
  return card.build();
}

function buildErrorCard_(err) {
  return CardService.newCardBuilder().setHeader(header_('エラー'))
    .addSection(CardService.newCardSection().addWidget(paragraph_(colored_(esc_(err && err.message ? err.message : err), '#d93025'))))
    .build();
}
