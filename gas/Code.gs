/**
 * FLHシフト希望提出システム — バックエンド (Google Apps Script Web App)
 *
 * Script Properties（必須）:
 *   SPREADSHEET_ID      : データ保存用スプレッドシートのID
 *   OAUTH_CLIENT_ID     : Google Cloud の OAuth クライアントID
 *   OAUTH_CLIENT_SECRET : Google Cloud の OAuth クライアントシークレット
 *   SLACK_WEBHOOK_URL   : Slack Incoming Webhook URL（任意）
 *   SHARED_CALENDAR_ID  : 管理者用共有カレンダーのID（任意）
 *
 * 初回セットアップ: setup() を実行 → シートが自動作成される
 * リマインダー: setupTriggers() を実行 → 毎朝10時のトリガーが登録される
 */

var TZ = 'Asia/Tokyo';

// OAuthクライアントID（公開情報のためコードに埋め込み。スクリプトプロパティでも上書き可）
var DEFAULT_OAUTH_CLIENT_ID = '890658818529-dq6uuj1hp3vos399ifqbu3ljdjv2gh8o.apps.googleusercontent.com';

var SHEETS = {
  Staff: ['email', 'name', 'isAdmin', 'locationIds', 'active'],
  Locations: ['id', 'name', 'active'],
  Patterns: ['id', 'name', 'startTime', 'endTime', 'locationId', 'active'],
  Shifts: ['id', 'staffEmail', 'periodKey', 'date', 'patternId', 'startTime', 'endTime', 'locationId', 'eventId', 'sharedEventId', 'updatedAt'],
  Submissions: ['id', 'staffEmail', 'periodKey', 'status', 'comment', 'late', 'submittedAt', 'approvedAt', 'approvedBy', 'rejectReason', 'updatedAt'],
  ChangeRequests: ['id', 'staffEmail', 'periodKey', 'reason', 'status', 'createdAt', 'resolvedAt', 'resolvedBy'],
  Settings: ['key', 'value'],
  AuditLog: ['timestamp', 'actor', 'action', 'detail']
};

var DEFAULT_SETTINGS = {
  deadlineDayA: '25', // 前半（1〜15日）: 前月◯日締切
  deadlineDayB: '10'  // 後半（16〜末日）: 当月◯日締切
};

// ==================== エントリーポイント ====================

function doGet(e) {
  // 診断用: /exec?diag=1 で設定状況を確認（秘密情報そのものは返さない）
  if (e && e.parameter && e.parameter.diag === '1') {
    // 自動修復: 管理者が未登録なら登録する（setup途中失敗の救済）
    try {
      if (readAll('Staff').length === 0) {
        appendRows('Staff', [{ email: 'flontlifehack@gmail.com', name: '管理者', isAdmin: 'true', locationIds: '', active: 'true' }]);
        log('system', 'auto_admin_registered', 'flontlifehack@gmail.com');
      }
    } catch (err) { /* 診断結果に表示される */ }
    var p = PropertiesService.getScriptProperties();
    var cid = p.getProperty('OAUTH_CLIENT_ID') || '';
    var staff = [];
    try {
      staff = readAll('Staff').map(function (s) {
        var em = s.email || '';
        return em.slice(0, 3) + '***' + em.slice(em.indexOf('@')) + ' admin=' + s.isAdmin + ' active=' + s.active;
      });
    } catch (err) {
      staff = ['ERROR: ' + String(err)];
    }
    return jsonOut({
      ok: true,
      data: {
        clientIdProp: cid ? (cid === oauthClientId() ? 'set_and_match' : 'set_but_DIFFERENT') : 'not_set(using_default)',
        effectiveClientId: oauthClientId().slice(0, 12) + '...',
        secretSet: !!p.getProperty('OAUTH_CLIENT_SECRET'),
        slackSet: !!p.getProperty('SLACK_WEBHOOK_URL'),
        sharedCalendarSet: !!p.getProperty('SHARED_CALENDAR_ID'),
        staff: staff,
        triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); })
      }
    });
  }
  return jsonOut({ ok: true, data: { service: 'flh-shift API', time: new Date().toISOString() } });
}

/** スクリプトプロパティ優先、なければコード埋め込みのデフォルトを使用 */
function oauthClientId() {
  var v = props('OAUTH_CLIENT_ID');
  return v ? v.trim() : DEFAULT_OAUTH_CLIENT_ID;
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: 'invalid_request' });
  }
  try {
    var result = route(req);
    return jsonOut({ ok: true, data: result });
  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    // 内部情報を返さない: 既知のエラーコードのみそのまま返す
    var known = ['auth_failed', 'token_expired', 'not_registered', 'forbidden', 'locked', 'not_found', 'calendar_not_connected', 'invalid_request'];
    var code = known.indexOf(msg) >= 0 ? msg : 'server_error';
    if (code === 'server_error') {
      log('system', 'error', msg + ' action=' + (req && req.action));
    }
    return jsonOut({ ok: false, error: code });
  }
}

function route(req) {
  var action = req.action;
  var payload = req.payload || {};

  // 認証必須（全アクション）
  var user = verifyIdToken(req.idToken); // { email, name }
  var staff = findStaff(user.email);
  if (!staff || String(staff.active) === 'false') throw new Error('not_registered');
  var isAdmin = String(staff.isAdmin) === 'true';

  switch (action) {
    case 'login':
      return apiLogin(staff);
    case 'oauthExchange':
      return apiOauthExchange(staff, payload);
    case 'getMyPeriod':
      return apiGetMyPeriod(staff, payload);
    case 'saveDraft':
      return apiSaveShifts(staff, payload, false);
    case 'submit':
      return apiSaveShifts(staff, payload, true);
    case 'getApprovedShifts':
      return apiGetApprovedShifts(staff, payload);
    case 'createChangeRequest':
      return apiCreateChangeRequest(staff, payload);
  }

  // ここから管理者専用
  if (!isAdmin) throw new Error('forbidden');
  switch (action) {
    case 'adminGetPeriod':
      return apiAdminGetPeriod(payload);
    case 'adminApprove':
      return apiAdminApprove(staff, payload);
    case 'adminReject':
      return apiAdminReject(staff, payload);
    case 'adminSaveShifts':
      return apiAdminSaveShifts(staff, payload);
    case 'adminResolveChangeRequest':
      return apiAdminResolveChangeRequest(staff, payload);
    case 'adminSaveMaster':
      return apiAdminSaveMaster(staff, payload);
    case 'adminGetStaff':
      return readAll('Staff');
    case 'adminSaveStaff':
      return apiAdminSaveStaff(staff, payload);
    case 'adminRunReminder':
      return dailyReminder();
  }
  throw new Error('invalid_request');
}

// ==================== 認証 ====================

function verifyIdToken(idToken) {
  if (!idToken) throw new Error('auth_failed');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('token_expired');
  var info = JSON.parse(res.getContentText());
  var clientId = oauthClientId();
  if (info.aud !== clientId) throw new Error('auth_failed');
  if (info.iss !== 'https://accounts.google.com' && info.iss !== 'accounts.google.com') throw new Error('auth_failed');
  if (Number(info.exp) * 1000 < Date.now()) throw new Error('token_expired');
  if (String(info.email_verified) !== 'true') throw new Error('auth_failed');
  return { email: info.email.toLowerCase(), name: info.name || info.email };
}

// ==================== API 実装 ====================

function apiLogin(staff) {
  // シークレット未設定時は「招待方式」: 個別のカレンダー連携操作は不要
  var inviteMode = !props('OAUTH_CLIENT_SECRET');
  return {
    staff: {
      email: staff.email,
      name: staff.name,
      isAdmin: String(staff.isAdmin) === 'true',
      locationIds: splitCsv(staff.locationIds)
    },
    inviteMode: inviteMode,
    calendarConnected: inviteMode ? true : !!getUserProp('RT_' + staff.email),
    masters: {
      locations: readAll('Locations').filter(function (r) { return String(r.active) !== 'false'; }),
      patterns: readAll('Patterns').filter(function (r) { return String(r.active) !== 'false'; })
    },
    settings: getSettings()
  };
}

function apiOauthExchange(staff, payload) {
  if (!payload.code) throw new Error('invalid_request');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      code: payload.code,
      client_id: oauthClientId(),
      client_secret: props('OAUTH_CLIENT_SECRET'),
      redirect_uri: 'postmessage',
      grant_type: 'authorization_code'
    },
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200 || !body.refresh_token) {
    log(staff.email, 'oauth_exchange_failed', String(res.getResponseCode()));
    throw new Error('invalid_request');
  }
  setUserProp('RT_' + staff.email, body.refresh_token);
  log(staff.email, 'calendar_connected', '');
  return { connected: true };
}

function apiGetMyPeriod(staff, payload) {
  var pk = payload.periodKey;
  var submission = findSubmission(staff.email, pk);
  var shifts = readAll('Shifts').filter(function (r) {
    return r.staffEmail === staff.email && r.periodKey === pk;
  });
  return { submission: submission, shifts: shifts, deadline: deadlineFor(pk), locked: isLocked(submission) };
}

/**
 * 下書き保存 / 提出（完了ボタン）共通
 * payload: { periodKey, shifts: [{date, patternId, startTime, endTime, locationId}], comment }
 */
function apiSaveShifts(staff, payload, isSubmit) {
  var pk = payload.periodKey;
  if (!pk || !Array.isArray(payload.shifts)) throw new Error('invalid_request');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var submission = findSubmission(staff.email, pk);
    if (isLocked(submission)) throw new Error('locked');

    // 旧シフト（＋カレンダーイベント）を削除してから作り直す（二重登録防止）
    deleteShiftsAndEvents(staff.email, pk);

    var now = nowStr();
    var rows = payload.shifts.map(function (s) {
      return {
        id: uid(), staffEmail: staff.email, periodKey: pk, date: s.date,
        patternId: s.patternId || '', startTime: s.startTime, endTime: s.endTime,
        locationId: s.locationId || '', eventId: '', sharedEventId: '', updatedAt: now
      };
    });
    appendRows('Shifts', rows);

    var status = isSubmit ? 'submitted' : 'draft';
    var late = isSubmit && new Date() > deadlineFor(pk).dateObj;
    var sub = {
      id: submission ? submission.id : uid(),
      staffEmail: staff.email, periodKey: pk, status: status,
      comment: payload.comment || '',
      late: submission && String(submission.late) === 'true' ? 'true' : String(!!late),
      submittedAt: isSubmit ? now : (submission ? submission.submittedAt : ''),
      approvedAt: '', approvedBy: '',
      rejectReason: '',
      updatedAt: now
    };
    upsertSubmission(sub);

    if (isSubmit) {
      // 本人カレンダーに【未確定】で登録
      var calResult = syncPersonalCalendar(staff.email, pk, false);
      notifySlack('📝 *' + staff.name + '* さんが ' + periodLabel(pk) + ' のシフト希望を提出しました' + (late ? '（締切超過）' : ''));
      mailAdmins('[シフト] ' + staff.name + ' さんが提出しました',
        staff.name + ' さんが ' + periodLabel(pk) + ' のシフト希望を提出しました。\n承認画面: ' + appUrl() + '#/admin');
      log(staff.email, 'submit', pk + ' shifts=' + rows.length + (late ? ' LATE' : ''));
      return { saved: rows.length, status: status, late: late, calendar: calResult };
    }
    log(staff.email, 'save_draft', pk + ' shifts=' + rows.length);
    return { saved: rows.length, status: status };
  } finally {
    lock.releaseLock();
  }
}

function apiGetApprovedShifts(staff, payload) {
  var pk = payload.periodKey;
  var subs = readAll('Submissions').filter(function (s) { return s.periodKey === pk && s.status === 'approved'; });
  var approvedEmails = {};
  subs.forEach(function (s) { approvedEmails[s.staffEmail] = true; });
  var shifts = readAll('Shifts').filter(function (r) { return r.periodKey === pk && approvedEmails[r.staffEmail]; });
  var staffList = readAll('Staff').map(function (s) { return { email: s.email, name: s.name }; });
  return { shifts: shifts, staff: staffList };
}

function apiCreateChangeRequest(staff, payload) {
  var pk = payload.periodKey;
  if (!pk || !payload.reason) throw new Error('invalid_request');
  var submission = findSubmission(staff.email, pk);
  if (!isLocked(submission)) throw new Error('invalid_request');
  var row = {
    id: uid(), staffEmail: staff.email, periodKey: pk, reason: payload.reason,
    status: 'pending', createdAt: nowStr(), resolvedAt: '', resolvedBy: ''
  };
  appendRows('ChangeRequests', [row]);
  notifySlack('🔓 *' + staff.name + '* さんから ' + periodLabel(pk) + ' の変更リクエスト:「' + payload.reason + '」');
  mailAdmins('[シフト] 変更リクエスト: ' + staff.name,
    staff.name + ' さんから変更リクエストが届きました。\n期間: ' + periodLabel(pk) + '\n理由: ' + payload.reason + '\n管理画面: ' + appUrl() + '#/admin');
  log(staff.email, 'change_request', pk);
  return { requested: true };
}

// ---------- 管理者API ----------

function apiAdminGetPeriod(payload) {
  var pk = payload.periodKey;
  return {
    submissions: readAll('Submissions').filter(function (s) { return s.periodKey === pk; }),
    shifts: readAll('Shifts').filter(function (r) { return r.periodKey === pk; }),
    staff: readAll('Staff').filter(function (s) { return String(s.active) !== 'false'; }),
    changeRequests: readAll('ChangeRequests').filter(function (c) { return c.status === 'pending'; }),
    deadline: deadlineFor(pk)
  };
}

function apiAdminApprove(admin, payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var submission = findSubmission(payload.staffEmail, payload.periodKey);
    if (!submission || submission.status !== 'submitted') throw new Error('not_found');
    submission.status = 'approved';
    submission.approvedAt = nowStr();
    submission.approvedBy = admin.email;
    submission.updatedAt = nowStr();
    upsertSubmission(submission);
  } finally {
    lock.releaseLock();
  }
  // カレンダー: 本人→確定表記に更新、共有カレンダー→追加
  var personal = syncPersonalCalendar(payload.staffEmail, payload.periodKey, true);
  var shared = syncSharedCalendar(payload.staffEmail, payload.periodKey, true);
  var st = findStaff(payload.staffEmail);
  notifySlack('✅ *' + st.name + '* さんの ' + periodLabel(payload.periodKey) + ' のシフトが承認されました');
  log(admin.email, 'approve', payload.staffEmail + ' ' + payload.periodKey);
  return { approved: true, personal: personal, shared: shared };
}

function apiAdminReject(admin, payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var submission = findSubmission(payload.staffEmail, payload.periodKey);
    if (!submission) throw new Error('not_found');
    var wasApproved = submission.status === 'approved';
    submission.status = 'rejected';
    submission.rejectReason = payload.reason || '';
    submission.updatedAt = nowStr();
    upsertSubmission(submission);
    if (wasApproved) {
      syncSharedCalendar(payload.staffEmail, payload.periodKey, false); // 共有カレンダーから削除
      syncPersonalCalendar(payload.staffEmail, payload.periodKey, false); // 【未確定】に戻す
    }
  } finally {
    lock.releaseLock();
  }
  var st = findStaff(payload.staffEmail);
  notifySlack('↩️ *' + st.name + '* さんの ' + periodLabel(payload.periodKey) + ' が差し戻されました' + (payload.reason ? ':「' + payload.reason + '」' : ''));
  log(admin.email, 'reject', payload.staffEmail + ' ' + payload.periodKey);
  return { rejected: true };
}

/** 管理者による直接修正（修正後そのまま承認も可能） */
function apiAdminSaveShifts(admin, payload) {
  var pk = payload.periodKey;
  var email = payload.staffEmail;
  if (!pk || !email || !Array.isArray(payload.shifts)) throw new Error('invalid_request');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var submission = findSubmission(email, pk);
    var wasApproved = submission && submission.status === 'approved';
    if (wasApproved) syncSharedCalendar(email, pk, false);
    deleteShiftsAndEvents(email, pk);

    var now = nowStr();
    var rows = payload.shifts.map(function (s) {
      return {
        id: uid(), staffEmail: email, periodKey: pk, date: s.date,
        patternId: s.patternId || '', startTime: s.startTime, endTime: s.endTime,
        locationId: s.locationId || '', eventId: '', sharedEventId: '', updatedAt: now
      };
    });
    appendRows('Shifts', rows);

    var approve = !!payload.approve;
    var sub = {
      id: submission ? submission.id : uid(),
      staffEmail: email, periodKey: pk,
      status: approve ? 'approved' : 'submitted',
      comment: submission ? submission.comment : '(管理者入力)',
      late: submission ? submission.late : 'false',
      submittedAt: submission && submission.submittedAt ? submission.submittedAt : now,
      approvedAt: approve ? now : '',
      approvedBy: approve ? admin.email : '',
      rejectReason: '',
      updatedAt: now
    };
    upsertSubmission(sub);

    syncPersonalCalendar(email, pk, approve);
    if (approve) syncSharedCalendar(email, pk, true);
  } finally {
    lock.releaseLock();
  }
  var st = findStaff(email);
  notifySlack('✏️ 管理者が *' + st.name + '* さんの ' + periodLabel(pk) + ' のシフトを修正しました' + (payload.approve ? '（承認済み）' : ''));
  log(admin.email, 'admin_edit', email + ' ' + pk);
  return { saved: true };
}

function apiAdminResolveChangeRequest(admin, payload) {
  var reqs = readAll('ChangeRequests');
  var target = null;
  reqs.forEach(function (r) { if (r.id === payload.requestId) target = r; });
  if (!target || target.status !== 'pending') throw new Error('not_found');

  var approve = !!payload.approve;
  target.status = approve ? 'approved' : 'denied';
  target.resolvedAt = nowStr();
  target.resolvedBy = admin.email;
  updateRowById('ChangeRequests', target);

  if (approve) {
    var submission = findSubmission(target.staffEmail, target.periodKey);
    if (submission) {
      var wasApproved = submission.status === 'approved';
      submission.status = 'draft'; // ロック解除 → 再編集可能
      submission.updatedAt = nowStr();
      upsertSubmission(submission);
      if (wasApproved) {
        syncSharedCalendar(target.staffEmail, target.periodKey, false);
        syncPersonalCalendar(target.staffEmail, target.periodKey, false);
      }
    }
  }
  var st = findStaff(target.staffEmail);
  notifySlack((approve ? '🔓 変更リクエストが承認され、*' + st.name + '* さんの ' + periodLabel(target.periodKey) + ' が再編集可能になりました' : '🔒 *' + st.name + '* さんの変更リクエストは却下されました'));
  log(admin.email, 'resolve_change_request', target.id + ' ' + target.status);
  return { resolved: true };
}

/** 拠点・パターンのマスタ保存 payload: { type: 'Locations'|'Patterns', rows: [...] } */
function apiAdminSaveMaster(admin, payload) {
  var type = payload.type;
  if (type !== 'Locations' && type !== 'Patterns') throw new Error('invalid_request');
  replaceAll(type, payload.rows || []);
  log(admin.email, 'save_master', type);
  return { saved: true };
}

function apiAdminSaveStaff(admin, payload) {
  var rows = (payload.rows || []).map(function (r) {
    return {
      email: String(r.email || '').toLowerCase().trim(),
      name: r.name || '',
      isAdmin: String(r.isAdmin) === 'true' ? 'true' : 'false',
      locationIds: r.locationIds || '',
      active: String(r.active) === 'false' ? 'false' : 'true'
    };
  }).filter(function (r) { return r.email; });
  replaceAll('Staff', rows);
  log(admin.email, 'save_staff', 'count=' + rows.length);
  return { saved: rows.length };
}

// ==================== カレンダー同期 ====================

/**
 * 本人のGoogleカレンダーと同期。
 * confirmed=false → 「【未確定】出勤」 / confirmed=true → 「出勤」
 * 方式1: OAuth連携済みなら本人カレンダーへ直接書き込み
 * 方式2: 未連携（またはシークレット未設定）なら「招待方式」
 *        （システム所有のカレンダーにイベントを作成し本人を招待→本人のカレンダーに自動表示）
 */
function syncPersonalCalendar(email, periodKey, confirmed) {
  var rt = getUserProp('RT_' + email);
  if (!rt || !props('OAUTH_CLIENT_SECRET')) {
    return syncPersonalCalendarInvite(email, periodKey, confirmed);
  }
  var token = refreshAccessToken(rt, email);
  if (!token) return { skipped: 'token_refresh_failed' };

  var shifts = readAll('Shifts').filter(function (r) { return r.staffEmail === email && r.periodKey === periodKey; });
  var locations = mapById(readAll('Locations'));
  var title = (confirmed ? '' : '【未確定】') + '出勤';
  var updated = 0;

  shifts.forEach(function (s) {
    var body = {
      summary: title,
      description: 'FLHシフト' + (s.locationId && locations[s.locationId] ? ' / ' + locations[s.locationId].name : ''),
      start: { dateTime: s.date + 'T' + pad(s.startTime) + ':00+09:00' },
      end: { dateTime: shiftEndDateTime(s) }
    };
    try {
      if (s.eventId) {
        // タイトル・時間を更新
        calFetch(token, 'PATCH', 'primary/events/' + s.eventId, body);
      } else {
        var res = calFetch(token, 'POST', 'primary/events', body);
        if (res && res.id) {
          s.eventId = res.id;
          updateRowById('Shifts', s);
        }
      }
      updated++;
    } catch (e) {
      log(email, 'calendar_sync_error', s.date + ' ' + String(e));
    }
  });
  return { updated: updated, total: shifts.length };
}

/** 招待方式: 配信用カレンダー（システム所有）を取得。なければ作成 */
function inviteCalendar() {
  var id = props('INVITE_CALENDAR_ID');
  var cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar('FLHシフト配信', { timeZone: TZ });
    PropertiesService.getScriptProperties().setProperty('INVITE_CALENDAR_ID', cal.getId());
  }
  return cal;
}

/** 招待方式での本人カレンダー同期（eventIdは 'inv:' プレフィックスで保存） */
function syncPersonalCalendarInvite(email, periodKey, confirmed) {
  var cal = inviteCalendar();
  var shifts = readAll('Shifts').filter(function (r) { return r.staffEmail === email && r.periodKey === periodKey; });
  var locations = mapById(readAll('Locations'));
  var title = (confirmed ? '' : '【未確定】') + '出勤';
  var updated = 0;

  shifts.forEach(function (s) {
    try {
      if (s.eventId && s.eventId.indexOf('inv:') === 0) {
        var ev = cal.getEventById(s.eventId.slice(4));
        if (ev) {
          ev.setTitle(title);
          updated++;
          return;
        }
      }
      var locName = s.locationId && locations[s.locationId] ? locations[s.locationId].name : '';
      var created = cal.createEvent(
        title,
        new Date(s.date + 'T' + pad(s.startTime) + ':00+09:00'),
        new Date(shiftEndDateTime(s)),
        { guests: email, sendInvites: false, description: 'FLHシフト' + (locName ? ' / ' + locName : '') }
      );
      s.eventId = 'inv:' + created.getId();
      updateRowById('Shifts', s);
      updated++;
    } catch (e) {
      log(email, 'calendar_invite_error', s.date + ' ' + String(e));
    }
  });
  return { updated: updated, total: shifts.length, mode: 'invite' };
}

/** 共有カレンダー（管理者用・全拠点共通1つ）: add=trueで追加、falseで削除 */
function syncSharedCalendar(email, periodKey, add) {
  var calId = props('SHARED_CALENDAR_ID');
  if (!calId) return { skipped: 'no_shared_calendar' };
  var cal = CalendarApp.getCalendarById(calId);
  if (!cal) return { skipped: 'shared_calendar_not_found' };

  var st = findStaff(email);
  var locations = mapById(readAll('Locations'));
  var shifts = readAll('Shifts').filter(function (r) { return r.staffEmail === email && r.periodKey === periodKey; });
  var count = 0;

  shifts.forEach(function (s) {
    try {
      if (add) {
        if (s.sharedEventId) return;
        var locName = s.locationId && locations[s.locationId] ? locations[s.locationId].name : '';
        var ev = cal.createEvent(
          st.name + (locName ? '（' + locName + '）' : ''),
          new Date(s.date + 'T' + pad(s.startTime) + ':00+09:00'),
          new Date(shiftEndDateTime(s))
        );
        s.sharedEventId = ev.getId();
        updateRowById('Shifts', s);
      } else {
        if (!s.sharedEventId) return;
        var old = cal.getEventById(s.sharedEventId);
        if (old) old.deleteEvent();
        s.sharedEventId = '';
        updateRowById('Shifts', s);
      }
      count++;
    } catch (e) {
      log(email, 'shared_calendar_error', s.date + ' ' + String(e));
    }
  });
  return { synced: count };
}

/** シフト行とそれに紐づく本人・共有カレンダーイベントを削除 */
function deleteShiftsAndEvents(email, periodKey) {
  var shifts = readAll('Shifts').filter(function (r) { return r.staffEmail === email && r.periodKey === periodKey; });
  if (shifts.length === 0) return;

  // 本人カレンダーのイベント削除
  var rt = getUserProp('RT_' + email);
  var token = (rt && props('OAUTH_CLIENT_SECRET')) ? refreshAccessToken(rt, email) : null;
  var calId = props('SHARED_CALENDAR_ID');
  var sharedCal = calId ? CalendarApp.getCalendarById(calId) : null;

  shifts.forEach(function (s) {
    if (s.eventId && s.eventId.indexOf('inv:') === 0) {
      // 招待方式のイベント削除（本人のカレンダーからも消える）
      try {
        var invEv = inviteCalendar().getEventById(s.eventId.slice(4));
        if (invEv) invEv.deleteEvent();
      } catch (e) { /* 削除済み等は無視 */ }
    } else if (token && s.eventId) {
      try { calFetch(token, 'DELETE', 'primary/events/' + s.eventId, null); } catch (e) { /* 手動削除済み等は無視 */ }
    }
    if (sharedCal && s.sharedEventId) {
      try {
        var ev = sharedCal.getEventById(s.sharedEventId);
        if (ev) ev.deleteEvent();
      } catch (e) { /* ignore */ }
    }
  });
  deleteRowsWhere('Shifts', function (r) { return r.staffEmail === email && r.periodKey === periodKey; });
}

function refreshAccessToken(refreshToken, email) {
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      refresh_token: refreshToken,
      client_id: oauthClientId(),
      client_secret: props('OAUTH_CLIENT_SECRET'),
      grant_type: 'refresh_token'
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    log(email, 'token_refresh_failed', String(res.getResponseCode()));
    return null;
  }
  return JSON.parse(res.getContentText()).access_token;
}

function calFetch(token, method, path, body) {
  var options = {
    method: method.toLowerCase(),
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  var res = UrlFetchApp.fetch('https://www.googleapis.com/calendar/v3/calendars/' + path, options);
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) {
    var text = res.getContentText();
    return text ? JSON.parse(text) : {};
  }
  if (method === 'DELETE' && (code === 404 || code === 410)) return {}; // 既に削除済み
  throw new Error('calendar_api_' + code);
}

/** 終了時刻が開始より前なら翌日跨ぎとして扱う */
function shiftEndDateTime(s) {
  var endDate = s.date;
  if (pad(s.endTime) <= pad(s.startTime)) {
    var d = new Date(s.date + 'T00:00:00+09:00');
    d.setDate(d.getDate() + 1);
    endDate = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  }
  return endDate + 'T' + pad(s.endTime) + ':00+09:00';
}

// ==================== 期間・締切 ====================

/**
 * periodKey: "2026-08-A"（1〜15日） / "2026-08-B"（16〜末日）
 * 締切: A→前月deadlineDayA日 23:59 / B→当月deadlineDayB日 23:59（JST）
 */
function deadlineFor(periodKey) {
  var m = periodKey.match(/^(\d{4})-(\d{2})-([AB])$/);
  if (!m) throw new Error('invalid_request');
  var year = Number(m[1]), month = Number(m[2]), half = m[3];
  var settings = getSettings();
  var d;
  if (half === 'A') {
    var prevYear = month === 1 ? year - 1 : year;
    var prevMonth = month === 1 ? 12 : month - 1;
    d = new Date(prevYear + '-' + pad2(prevMonth) + '-' + pad2(Number(settings.deadlineDayA)) + 'T23:59:59+09:00');
  } else {
    d = new Date(year + '-' + pad2(month) + '-' + pad2(Number(settings.deadlineDayB)) + 'T23:59:59+09:00');
  }
  return { dateObj: d, iso: d.toISOString(), label: Utilities.formatDate(d, TZ, 'M月d日 HH:mm') };
}

function periodLabel(periodKey) {
  var m = periodKey.match(/^(\d{4})-(\d{2})-([AB])$/);
  if (!m) return periodKey;
  return Number(m[2]) + '月' + (m[3] === 'A' ? '前半（1〜15日）' : '後半（16〜末日）');
}

// ==================== リマインダー（時間主導トリガー） ====================

/** setupTriggers() で毎朝10時に登録される */
function dailyReminder() {
  var now = new Date();
  var targets = upcomingPeriods(now); // 提出対象となる直近の期間
  var messages = [];

  targets.forEach(function (pk) {
    var dl = deadlineFor(pk);
    var daysLeft = Math.ceil((dl.dateObj - now) / 86400000);
    if (daysLeft !== 3 && daysLeft !== 1) return;

    var staffList = readAll('Staff').filter(function (s) { return String(s.active) !== 'false'; });
    var subs = readAll('Submissions').filter(function (s) { return s.periodKey === pk; });
    var done = {};
    subs.forEach(function (s) {
      if (s.status === 'submitted' || s.status === 'approved') done[s.staffEmail] = true;
    });
    var pending = staffList.filter(function (s) { return !done[s.email]; });
    if (pending.length === 0) return;

    var names = pending.map(function (s) { return s.name; }).join('、');
    messages.push('⏰ ' + periodLabel(pk) + ' のシフト希望 締切まであと' + daysLeft + '日（' + dl.label + '締切）\n未提出: ' + names + '\n' + appUrl());
  });

  messages.forEach(function (msg) { notifySlack(msg); });
  return { sent: messages.length };
}

/** 現時点で提出受付中（締切がまだ先 or 数日以内）の期間キーを返す */
function upcomingPeriods(now) {
  var result = [];
  for (var offset = 0; offset <= 2; offset++) {
    var d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    var pkA = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-A';
    var pkB = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-B';
    [pkA, pkB].forEach(function (pk) {
      var dl = deadlineFor(pk).dateObj;
      if (dl > now && (dl - now) / 86400000 <= 14) result.push(pk);
    });
  }
  return result;
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyReminder') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyReminder').timeBased().atHour(10).everyDays(1).inTimezone(TZ).create();
}

// ==================== 通知 ====================

function notifySlack(text) {
  var url = props('SLACK_WEBHOOK_URL');
  if (!url) return;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true
    });
  } catch (e) {
    log('system', 'slack_error', String(e));
  }
}

function mailAdmins(subject, body) {
  try {
    var admins = readAll('Staff').filter(function (s) {
      return String(s.isAdmin) === 'true' && String(s.active) !== 'false';
    });
    admins.forEach(function (a) {
      MailApp.sendEmail(a.email, subject, body);
    });
  } catch (e) {
    log('system', 'mail_error', String(e));
  }
}

// ==================== スプレッドシート ユーティリティ ====================

function ss() {
  // コンテナバインド型ならアクティブなスプレッドシートを使用（SPREADSHEET_ID設定不要）
  var id = props('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('server_error');
  return active;
}

function sheet(name) {
  var sh = ss().getSheetByName(name);
  if (!sh) {
    // 初回アクセス時に自動作成
    sh = ss().insertSheet(name);
    var headers = SHEETS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  }
  return sh;
}

function readAll(name) {
  var sh = sheet(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = SHEETS[name];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    var empty = true;
    for (var j = 0; j < headers.length; j++) {
      var v = values[i][j];
      if (v instanceof Date) {
        // セルが日付/時刻型に自動変換された場合の復元（基本は書式'@'で防止）
        var h = headers[j];
        if (h === 'startTime' || h === 'endTime') {
          v = Utilities.formatDate(v, TZ, 'HH:mm');
        } else if (h === 'date') {
          v = Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
        } else {
          v = Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
        }
      }
      row[headers[j]] = String(v);
      if (String(v) !== '') empty = false;
    }
    if (!empty) {
      row._rowIndex = i + 1;
      out.push(row);
    }
  }
  return out;
}

function appendRows(name, rows) {
  if (rows.length === 0) return;
  var headers = SHEETS[name];
  var sh = sheet(name);
  var values = rows.map(function (r) {
    return headers.map(function (h) { return r[h] !== undefined ? r[h] : ''; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
}

function updateRowById(name, row) {
  var headers = SHEETS[name];
  var idKey = headers[0] === 'email' ? 'email' : 'id';
  var all = readAll(name);
  for (var i = 0; i < all.length; i++) {
    if (all[i][idKey] === row[idKey]) {
      var values = [headers.map(function (h) { return row[h] !== undefined ? row[h] : ''; })];
      sheet(name).getRange(all[i]._rowIndex, 1, 1, headers.length).setValues(values);
      return true;
    }
  }
  return false;
}

function deleteRowsWhere(name, predicate) {
  var all = readAll(name);
  var toDelete = all.filter(predicate).map(function (r) { return r._rowIndex; });
  toDelete.sort(function (a, b) { return b - a; }); // 下から削除
  var sh = sheet(name);
  toDelete.forEach(function (idx) { sh.deleteRow(idx); });
}

function replaceAll(name, rows) {
  var headers = SHEETS[name];
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, headers.length).clearContent();
  appendRows(name, rows);
}

function findStaff(email) {
  var all = readAll('Staff');
  for (var i = 0; i < all.length; i++) {
    if (all[i].email.toLowerCase() === email.toLowerCase()) return all[i];
  }
  return null;
}

function findSubmission(email, periodKey) {
  var all = readAll('Submissions');
  for (var i = 0; i < all.length; i++) {
    if (all[i].staffEmail === email && all[i].periodKey === periodKey) return all[i];
  }
  return null;
}

function upsertSubmission(sub) {
  if (!updateRowById('Submissions', sub)) appendRows('Submissions', [sub]);
}

function isLocked(submission) {
  return !!submission && (submission.status === 'submitted' || submission.status === 'approved');
}

function getSettings() {
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
  readAll('Settings').forEach(function (r) { if (r.key) out[r.key] = r.value; });
  return out;
}

function mapById(rows) {
  var out = {};
  rows.forEach(function (r) { out[r.id] = r; });
  return out;
}

// ==================== 汎用ユーティリティ ====================

function props(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function getUserProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function setUserProp(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

function appUrl() {
  return props('APP_URL') || 'https://hirunegao.github.io/flh-shift/';
}

function uid() {
  return Utilities.getUuid().slice(0, 8) + Date.now().toString(36);
}

function nowStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function pad(t) {
  // "9:00" → "09:00"
  var parts = String(t).split(':');
  return pad2(Number(parts[0])) + ':' + pad2(Number(parts[1] || 0));
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function log(actor, action, detail) {
  try {
    sheet('AuditLog').appendRow([nowStr(), actor, action, detail]);
  } catch (e) { /* ログ失敗は無視 */ }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ==================== 初回セットアップ ====================

/**
 * 一度だけ手動実行: シート作成・権限承認・リマインダートリガー登録・共有カレンダー作成
 * をまとめて行う。実行後に表示される権限確認はすべて「許可」してください。
 */
function setup() {
  var spreadsheet = ss();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = spreadsheet.getSheetByName(name);
    if (!sh) sh = spreadsheet.insertSheet(name);
    var headers = SHEETS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    // 全セルを書式なしテキストに（"09:00"や日付が勝手に型変換されるのを防ぐ）
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  });
  // 最初に自動作成される「シート1」は削除
  var default1 = spreadsheet.getSheetByName('シート1') || spreadsheet.getSheetByName('Sheet1');
  if (default1 && spreadsheet.getSheets().length > Object.keys(SHEETS).length) {
    spreadsheet.deleteSheet(default1);
  }
  // 締切のデフォルト設定
  var settings = readAll('Settings');
  if (settings.length === 0) {
    appendRows('Settings', [
      { key: 'deadlineDayA', value: DEFAULT_SETTINGS.deadlineDayA },
      { key: 'deadlineDayB', value: DEFAULT_SETTINGS.deadlineDayB }
    ]);
  }
  // リマインダートリガー登録
  setupTriggers();
  // 共有カレンダー作成（未作成の場合のみ）
  if (!props('SHARED_CALENDAR_ID')) {
    var cal = CalendarApp.createCalendar('FLHシフト（全体）', { timeZone: TZ });
    PropertiesService.getScriptProperties().setProperty('SHARED_CALENDAR_ID', cal.getId());
  }
  // 実行者を管理者として自動登録（Staffが空の場合のみ）
  if (readAll('Staff').length === 0) {
    var me = Session.getEffectiveUser().getEmail();
    appendRows('Staff', [{ email: me.toLowerCase(), name: '管理者', isAdmin: 'true', locationIds: '', active: 'true' }]);
  }
  Logger.log('セットアップ完了。共有カレンダー「FLHシフト（全体）」の作成と管理者登録も完了しました。');
}
