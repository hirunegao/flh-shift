/**
 * FLH 出張精算 API（flh-shift Web App に相乗り）
 *
 * ポータルから { service: 'travel', token, action, ... }
 *   認証: google（Google ログイン）/ salt / login（パスワード）/ session
 *   読み: bootstrap（本人分だけ返す。管理者は全員分）/ receipts
 *   書き: save / status / bulkStatus / remove / dismiss / linkStaff
 *
 * 認証はサーバー側で行う。ログインすると署名付きセッショントークンを発行し、
 * 申請者名と経理権限は必ずそのトークン＋名簿から決定する。
 * クライアントから送られてきた applicant / actor / is_admin は一切信用しない。
 *
 * Script Properties:
 *   NOTION_TOKEN           … Notion Integration Secret
 *   GH_PAT                 … fine-grained PAT (flh-travel-expense-sync Contents:write)
 *   TRAVEL_USERS           … 利用者名簿 JSON（app-portal/users.js と同じ形）。未設定なら PROJECT_USERS を使う
 *                            [{ "username": "kajiwara", "display": "梶原",
 *                               "salt": "...", "password_hash": "...", "is_admin": true }, ...]
 *   TRAVEL_SESSION_SECRET  … セッション署名鍵。未設定なら初回に自動生成する
 *   TRAVEL_EMAIL_MAP       … Google ログイン用。Google のメール → 名簿のユーザー名 JSON 例 {"a@gmail.com":"kajiwara"}
 *                            ここに無いメールでも、シフト名簿（Staff シート）で有効な人は Google でログインできる
 *   TRAVEL_ROLE_MAP        … 任意。役職の上書き JSON 例 {"kajiwara":"役員","hayashi":"管理職"}
 *                            未設定の人は「一般」（kajiwara のみ既定で「役員」）
 *
 * 一覧は Notion を直接読んで本人分だけ返す（公開の data.json には頼らない）。
 */

var TRAVEL_RATE_DB_ID = 'ef5f7c2c-1c77-4c57-9b7e-57ab08749a6b';
var TRAVEL_LEDGER_DB_ID = '4b91f92f-4eea-43fc-b097-7aba4f66858a';
var TRAVEL_SYNC_REPO = 'hirunegao/flh-travel-expense-sync';
var TRAVEL_NOTION_VERSION = '2022-06-28';
var TRAVEL_FUEL_YEN_PER_KM = 20;
var TRAVEL_ROLES = { '役員': 1, '管理職': 1, '一般': 1 };
var TRAVEL_DEFAULT_ROLES = { kajiwara: '役員' };
// 種別（画面で選ぶ）。日当が付くのは宿泊出張だけで、承認されて初めて支給対象になる
// 「日帰り出張」は当社には無いので種別に持たない（2026-11 決定）。日帰りの移動はすべて「交通費」
var TRAVEL_KINDS = { '交通費': 1, '宿泊出張': 1, '海外出張': 1 };
var TRAVEL_MODES = { '電車': 1, 'バス': 1, 'タクシー': 1, '新幹線': 1, '飛行機': 1, '車': 1, 'その他': 1 };
// 領収書の撮影が必須の移動手段（宿泊がある場合も必須）
var TRAVEL_RECEIPT_MODES = { 'タクシー': 1, '新幹線': 1, '飛行機': 1 };
var TRAVEL_FAR_KM = 50;
var TRAVEL_STATUSES = ['下書', '提出', '上長承認済', '経理承認済', '支払済'];
var TRAVEL_MAX_RECEIPTS = 6;
var TRAVEL_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var TRAVEL_CAND_PAST_DAYS = 62;
var TRAVEL_CAND_FUTURE_DAYS = 31;
var TRAVEL_KEYWORDS = /出張|訪問|往訪|展示会|視察|商談|納品/;

function travelSetupProperties(notionToken, ghPat, usersJson) {
  var props = PropertiesService.getScriptProperties();
  if (notionToken) props.setProperty('NOTION_TOKEN', String(notionToken));
  if (ghPat) props.setProperty('GH_PAT', String(ghPat));
  if (usersJson) {
    JSON.parse(usersJson); // 壊れた JSON を保存しない
    props.setProperty('TRAVEL_USERS', String(usersJson));
  }
  return {
    ok: true,
    hasNotion: !!props.getProperty('NOTION_TOKEN'),
    hasGh: !!props.getProperty('GH_PAT'),
    users: travelRoster_().length
  };
}

// ==================== 認証 ====================

var TRAVEL_SESSION_HOURS = 12;
var TRAVEL_GOOGLE_SESSION_HOURS = 24 * 7; // Google ログインは7日間保持（CS一元化ツールと同じ）
var TRAVEL_MAX_LOGIN_FAILS = 10;

function travelRoster_() {
  // 専用名簿 TRAVEL_USERS が無ければ、プロジェクト経費と同じ名簿（PROJECT_USERS）を使う
  var sp = PropertiesService.getScriptProperties();
  var raw = sp.getProperty('TRAVEL_USERS') || sp.getProperty('PROJECT_USERS');
  if (!raw) throw new Error('利用者名簿（TRAVEL_USERS / PROJECT_USERS）が未設定です');
  var list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error('TRAVEL_USERS の JSON が不正です');
  }
  if (!list || !list.length) throw new Error('TRAVEL_USERS が空です');
  return list.map(function (u) {
    return {
      username: String(u.username || '').trim(),
      display: String(u.display || u.username || '').trim(),
      salt: String(u.salt || ''),
      password_hash: String(u.password_hash || '').toLowerCase(),
      is_admin: !!u.is_admin
    };
  });
}

function travelFindUser_(username) {
  var uname = String(username || '').trim();
  if (!uname) return null;
  var roster = travelRoster_();
  for (var i = 0; i < roster.length; i++) {
    if (roster[i].username === uname) return roster[i];
  }
  return null;
}

function travelSessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TRAVEL_SESSION_SECRET');
  if (!s) {
    s = Utilities.getUuid() + '|' + Utilities.getUuid();
    props.setProperty('TRAVEL_SESSION_SECRET', s);
  }
  return s;
}

function travelSign_(text) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(String(text), travelSessionSecret_())
  );
}

/** 長さも内容も一定時間で比較する（早期 return しない） */
function travelEqual_(a, b) {
  a = String(a);
  b = String(b);
  var diff = a.length ^ b.length;
  var n = Math.min(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** ユーザー名の存在を漏らさないため、未登録でも安定した salt を返す */
function travelSaltFor_(username) {
  var u = null;
  try {
    u = travelFindUser_(username);
  } catch (e) {
    u = null;
  }
  if (u && u.salt) return u.salt;
  return travelSign_('salt|' + String(username || '')).slice(0, 16);
}

function travelIssueToken_(username, hours, viaGoogle) {
  var data = { u: username, exp: Date.now() + (hours || TRAVEL_SESSION_HOURS) * 3600 * 1000 };
  if (viaGoogle) data.g = 1;
  var payload = Utilities.base64EncodeWebSafe(Utilities.newBlob(JSON.stringify(data)).getBytes());
  return payload + '.' + travelSign_(payload);
}

/** シフト名簿（Staff シート）で有効な人をメールで探す */
function travelStaffByEmail_(email) {
  email = String(email || '').toLowerCase();
  if (!email) return null;
  var list = travelStaffList_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].email === email) return list[i];
  }
  return null;
}

/** Google のメールに対応する名簿のユーザー名（無ければ null）。同じ人がパスワードでも Google でも同じ申請者になるようにする */
function travelUsernameForEmail_(email) {
  var sp = PropertiesService.getScriptProperties();
  var map = {};
  try {
    map = JSON.parse(sp.getProperty('TRAVEL_EMAIL_MAP') || '{}') || {};
  } catch (e) {
    map = {};
  }
  var roster = travelRoster_();
  var i;
  for (var key in map) {
    if (String(key).toLowerCase() !== email) continue;
    for (i = 0; i < roster.length; i++) {
      if (roster[i].username === map[key]) return roster[i].username;
    }
  }
  // 本人がカレンダー連動で選んだメール
  for (i = 0; i < roster.length; i++) {
    var linked = String(sp.getProperty(travelUserProp_('TRAVEL_EMAIL_', roster[i].username)) || '').toLowerCase();
    if (linked && linked === email) return roster[i].username;
  }
  return null;
}

/**
 * Google ログイン。ID トークンは Google に問い合わせて検証する（flh-shift 本体の verifyIdToken）。
 * 入れるのは「名簿にメールがひも付いている人」か「シフト名簿で有効な人」だけ。
 */
function travelGoogleLogin_(body) {
  var g = verifyIdToken(String(body.id_token || ''));
  var staff = travelStaffByEmail_(g.email);
  var uname = travelUsernameForEmail_(g.email);
  if (!uname && !staff) throw new Error('not_registered');
  var user;
  if (uname) {
    var u = travelFindUser_(uname);
    user = { username: u.username, display: u.display, is_admin: u.is_admin };
  } else {
    // 名簿に無いスタッフ（新しく入った人など）はメールをそのまま利用者IDにする。承認権限は付かない
    user = { username: g.email, display: staff.name || g.name, is_admin: false };
  }
  // カレンダー連動（予定を精算待ちに並べる）も同じメールで自動設定する
  if (staff) {
    PropertiesService.getScriptProperties().setProperty(travelUserProp_('TRAVEL_EMAIL_', user.username), g.email);
  }
  return { token: travelIssueToken_(user.username, TRAVEL_GOOGLE_SESSION_HOURS, true), user: user };
}

/**
 * セッショントークンから利用者を確定する。
 * 申請者名・経理権限はここでしか決まらない（クライアントの申告は使わない）。
 */
function travelResolveUser_(token) {
  if (!token) throw new Error('auth_failed');
  var parts = String(token).split('.');
  if (parts.length !== 2) throw new Error('auth_failed');
  if (!travelEqual_(parts[1], travelSign_(parts[0]))) throw new Error('auth_failed');
  var payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (e) {
    throw new Error('auth_failed');
  }
  if (!payload.exp || Number(payload.exp) < Date.now()) throw new Error('token_expired');
  var u = travelFindUser_(payload.u);
  if (u) return { username: u.username, display: u.display, is_admin: u.is_admin };
  if (payload.g) {
    // Google でログインした、名簿に無いスタッフ。シフト名簿から外れたら使えなくなる
    var staff = travelStaffByEmail_(payload.u);
    if (staff) return { username: staff.email, display: staff.name || staff.email, is_admin: false };
  }
  throw new Error('not_registered');
}

/**
 * ログイン。パスワードそのものは受け取らず、クライアントが salt で
 * PBKDF2-SHA256(10万回) して作ったハッシュを名簿と突き合わせる。
 */
function travelLogin_(body) {
  var username = String(body.username || '').trim();
  var hash = String(body.hash || '').toLowerCase();
  var cache = CacheService.getScriptCache();
  var failKey = 'travel_fail_' + username;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= TRAVEL_MAX_LOGIN_FAILS) throw new Error('too_many_attempts');

  var u = travelFindUser_(username);
  if (!u || !hash || !travelEqual_(hash, u.password_hash)) {
    cache.put(failKey, String(fails + 1), 600);
    throw new Error('bad_credentials');
  }
  cache.remove(failKey);
  return {
    token: travelIssueToken_(u.username),
    user: { username: u.username, display: u.display, is_admin: u.is_admin }
  };
}

/** flh-shift の doPost から呼ばれる */
function travelHandlePost(body, e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var action = body.action || '';

    // 疎通確認のみ認証不要（秘密情報は返さない）
    if (action === 'ping') {
      return travelJson_({
        ok: true,
        service: 'flh-travel-expense',
        version: 3,
        google_client_id: oauthClientId(),
        hasNotion: !!props.getProperty('NOTION_TOKEN')
      });
    }
    if (action === 'salt') {
      return travelJson_({ ok: true, salt: travelSaltFor_(body.username) });
    }
    if (action === 'google') {
      var gs = travelGoogleLogin_(body);
      gs.user.role = travelRoleOf_(gs.user.username);
      return travelJson_({ ok: true, token: gs.token, user: gs.user });
    }
    if (action === 'login') {
      var session = travelLogin_(body);
      session.user.role = travelRoleOf_(session.user.username);
      return travelJson_({ ok: true, token: session.token, user: session.user });
    }

    var me = travelResolveUser_(body.token);
    me.role = travelRoleOf_(me.username);
    if (action === 'session') {
      return travelJson_({ ok: true, user: me });
    }
    if (action === 'dismiss') {
      return travelJson_({ ok: true, dismissed: travelDismiss_(me, body.event_id, body.undo) });
    }
    if (action === 'linkStaff') {
      return travelJson_({ ok: true, email: travelLinkStaff_(me, body.email) });
    }

    var notionToken = props.getProperty('NOTION_TOKEN');
    if (!notionToken) return travelJson_({ ok: false, error: 'NOTION_TOKEN not set' });

    if (action === 'bootstrap') {
      return travelJson_(travelBootstrap_(notionToken, me));
    }
    if (action === 'receipts') {
      return travelJson_({ ok: true, receipts: travelListReceipts_(notionToken, body.id, me) });
    }
    if (action === 'save' || action === 'create') {
      return travelJson_({ ok: true, trip: travelSaveTrip_(notionToken, body.entry || {}, me) });
    }
    if (action === 'status' || action === 'update') {
      var u = body.update || { id: body.id, status: body.status, reason: body.reason };
      return travelJson_({ ok: true, trip: travelSetStatus_(notionToken, u, me) });
    }
    if (action === 'bulkStatus') {
      return travelJson_({ ok: true, results: travelBulkStatus_(notionToken, body.ids, body.status, me) });
    }
    if (action === 'remove') {
      return travelJson_({ ok: true, removed: travelRemoveTrip_(notionToken, body.id, me) });
    }
    return travelJson_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return travelJson_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function travelJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function travelRoleOf_(username) {
  var map = {};
  try {
    map = JSON.parse(PropertiesService.getScriptProperties().getProperty('TRAVEL_ROLE_MAP') || '{}') || {};
  } catch (e) {
    map = {};
  }
  var role = map[username] || TRAVEL_DEFAULT_ROLES[username] || '一般';
  return TRAVEL_ROLES[role] ? role : '一般';
}

// ==================== Notion ====================

function travelNotion_(token, method, path, payload) {
  var opts = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': TRAVEL_NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload) opts.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, opts);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Notion HTTP ' + code + ' ' + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : {};
}

function travelQueryAll_(token, databaseId) {
  var rows = [];
  var cursor = null;
  do {
    var body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    var data = travelNotion_(token, 'post', '/databases/' + databaseId + '/query', body);
    rows = rows.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

function travelPlain_(prop) {
  if (!prop) return '';
  var parts = prop.rich_text || prop.title || [];
  var s = '';
  for (var i = 0; i < parts.length; i++) s += parts[i].plain_text || '';
  return s.trim();
}

function travelSelect_(prop) {
  return prop && prop.select ? prop.select.name : null;
}

function travelNumber_(prop) {
  return prop && prop.number != null ? prop.number : null;
}

function travelDate_(prop) {
  return prop && prop.date ? prop.date.start : null;
}

function travelDateEnd_(prop) {
  return prop && prop.date ? (prop.date.end || prop.date.start) : null;
}

function travelRich_(text) {
  return { rich_text: [{ text: { content: String(text || '').slice(0, 2000) } }] };
}

function travelTitle_(text) {
  return { title: [{ text: { content: String(text || '').slice(0, 200) } }] };
}

function travelToday_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function travelNow_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

function travelAddDays_(dateStr, n) {
  var p = String(dateStr).split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  return d.toISOString().slice(0, 10);
}

function travelIsDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

// ==================== 規定マスタ ====================

/** 規定マスタを { id, role, trip_type, daily_allowance, lodging_cap, effective_from } の配列で返す（5分キャッシュ） */
function travelRates_(token) {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get('travel_rates_v2');
    if (hit) return JSON.parse(hit);
  } catch (e) { /* ignore */ }
  var pages = travelQueryAll_(token, TRAVEL_RATE_DB_ID);
  var rates = pages.map(function (pg) {
    var p = pg.properties || {};
    return {
      id: pg.id,
      name: travelPlain_(p['名称']),
      role: travelSelect_(p['役職']),
      trip_type: travelSelect_(p['区分']),
      daily_allowance: travelNumber_(p['日当']) || 0,
      lodging_cap: travelNumber_(p['宿泊料上限']) || 0,
      effective_from: travelDate_(p['適用開始日']) || '1970-01-01',
      note: travelPlain_(p['メモ'])
    };
  }).filter(function (r) { return r.role && r.trip_type; });
  try { cache.put('travel_rates_v2', JSON.stringify(rates), 300); } catch (e) { /* ignore */ }
  return rates;
}

/** その日に有効な規定のうち、いちばん新しいもの */
function travelPickRate_(rates, role, tripType, onDate) {
  var best = null;
  for (var i = 0; i < rates.length; i++) {
    var r = rates[i];
    if (r.role !== role || r.trip_type !== tripType) continue;
    if (onDate && r.effective_from > onDate) continue;
    if (!best || r.effective_from >= best.effective_from) best = r;
  }
  return best;
}

/** 種別 → 規定マスタの区分 */
function travelTripType_(kind, distanceKm) {
  if (kind === '宿泊出張') return '宿泊';
  if (kind === '海外出張') return '海外第1';
  return null;
}

// ==================== 台帳 ====================

function travelToTrip_(page) {
  var p = page.properties || {};
  var transport = travelNumber_(p['交通費']) || 0;
  var fuel = travelNumber_(p['燃料費相当']) || 0;
  var daily = travelNumber_(p['日当']) || 0;
  var lodging = travelNumber_(p['宿泊料']) || 0;
  var other = travelNumber_(p['その他経費']) || 0;
  var tripType = travelSelect_(p['区分']);
  var kind = travelSelect_(p['種別']);
  if (!kind) kind = tripType === '宿泊' ? '宿泊出張' : (tripType && tripType.indexOf('海外') === 0 ? '海外出張' : '交通費');
  if (kind === '日帰り出張') kind = '交通費'; // 廃止した種別で残っている行
  var status = travelSelect_(p['ステータス']) || '下書';
  if (status === '承認') status = '経理承認済'; // 旧1段階承認の行
  return {
    id: page.id,
    title: travelPlain_(p['タイトル']),
    trip_date: travelDate_(p['出張日']),
    end_date: travelDateEnd_(p['出張日']),
    applicant: travelPlain_(p['申請者']),
    applicant_id: travelPlain_(p['申請者ID']),
    kind: kind,
    origin: travelPlain_(p['出発地']),
    destination: travelPlain_(p['行き先']),
    purpose: travelPlain_(p['用件']),
    memo: travelPlain_(p['メモ']),
    mode: travelSelect_(p['移動手段']) || '',
    round_trip: !!(p['往復'] && p['往復'].checkbox),
    trip_type: tripType,
    role: travelSelect_(p['役職']),
    nights: travelNumber_(p['泊数']) || 0,
    transport_cost: transport,
    fuel_allowance: fuel,
    daily_allowance: daily,
    lodging_cost: lodging,
    lodging_actual: travelNumber_(p['宿泊実費']) || lodging,
    other_cost: other,
    distance_km: travelNumber_(p['距離km']) || 0,
    receipt_count: travelNumber_(p['領収書枚数']) || 0,
    status: status,
    reject_reason: travelPlain_(p['差戻し理由']),
    submitted_on: travelDate_(p['申請日']),
    history: travelPlain_(p['承認履歴']),
    event_id: travelPlain_(p['予定ID']),
    idempotency_key: travelPlain_(p['冪等キー']),
    total: transport + fuel + daily + lodging + other,
    url: 'https://www.notion.so/' + String(page.id).replace(/-/g, '')
  };
}

function travelIsMine_(trip, me) {
  if (trip.applicant_id) return trip.applicant_id === me.username;
  return trip.applicant === me.display; // 申請者ID が無い旧行
}

function travelNum_(v, label) {
  var n = Number(v || 0);
  if (!isFinite(n) || n < 0) throw new Error(label + 'が不正です');
  return Math.round(n);
}

/**
 * 申請の保存（新規／本人の下書・差戻し分の修正）。
 * 金額のうち日当・宿泊の支給額はここで計算し直す。画面の計算結果は信用しない。
 */
function travelSaveTrip_(token, entry, me) {
  var status = String(entry.status || '下書').trim();
  if (status !== '下書' && status !== '提出') throw new Error('ステータスが不正です');

  var current = null;
  if (entry.id) {
    current = travelToTrip_(travelNotion_(token, 'get', '/pages/' + entry.id, null));
    if (!travelIsMine_(current, me)) throw new Error('他人の申請は編集できません');
    if (current.status !== '下書') throw new Error('提出済みの申請は修正できません。取り下げてから修正してください');
  }

  var kind = String(entry.kind || '').trim();
  if (!TRAVEL_KINDS[kind]) throw new Error('種別を選んでください');
  var tripDate = String(entry.trip_date || '').trim();
  if (!travelIsDate_(tripDate)) throw new Error('日付を入れてください');
  var destination = String(entry.destination || '').trim();
  if (!destination) throw new Error('行き先を入れてください');
  var mode = String(entry.mode || '').trim();
  if (mode && !TRAVEL_MODES[mode]) throw new Error('移動手段が不正です');
  if (status === '提出' && !mode) throw new Error('移動手段を選んでください');
  var purpose = String(entry.purpose || '').trim();
  if (status === '提出' && !purpose) throw new Error('目的を入れてください');

  var nights = 0;
  var endDate = tripDate;
  if (kind === '宿泊出張' || kind === '海外出張') {
    nights = travelNum_(entry.nights, '泊数');
    if (kind === '宿泊出張' && nights < 1) throw new Error('宿泊出張は泊数を1以上にしてください');
    if (nights > 60) throw new Error('泊数が多すぎます');
    endDate = travelAddDays_(tripDate, nights);
  }

  var distance = Number(entry.distance_km || 0);
  if (!isFinite(distance) || distance < 0 || distance > 20000) throw new Error('距離が不正です');
  var transport = travelNum_(entry.transport_cost, '交通費');
  var other = travelNum_(entry.other_cost, 'その他経費');
  var lodgingActual = nights > 0 ? travelNum_(entry.lodging_cost, '宿泊料') : 0;
  // 車の距離×単価による燃料費の支給はしない（2026-11 決定）。車でかかった費用は実費で入力する
  var fuel = 0;

  // 日当・宿泊上限（出張のみ。交通費は実費だけ）
  var role = me.role;
  var tripType = travelTripType_(kind, distance);
  var rate = tripType ? travelPickRate_(travelRates_(token), role, tripType, tripDate) : null;
  var daily = 0;
  var lodging = lodgingActual;
  if (rate) {
    daily = rate.daily_allowance * (nights + 1); // 出発日・帰着日を含む日数分
    if (rate.lodging_cap && nights > 0) lodging = Math.min(lodgingActual, rate.lodging_cap * nights);
  }

  if (status === '提出' && transport + fuel + daily + lodging + other <= 0) {
    throw new Error('金額が0円です。交通費などを入れてください');
  }

  // 領収書（今回追加する画像）
  var images = entry.receipts || [];
  if (images.length > TRAVEL_MAX_RECEIPTS) throw new Error('領収書は一度に' + TRAVEL_MAX_RECEIPTS + '枚までです');
  var haveReceipts = (current ? current.receipt_count : 0) + images.length;
  var needReceipt = !!TRAVEL_RECEIPT_MODES[mode] || lodgingActual > 0;
  if (status === '提出' && needReceipt && haveReceipts < 1) {
    throw new Error('タクシー・新幹線・飛行機・宿泊は領収書の写真が必要です');
  }

  // 二重送信を防ぐ鍵（画面が発行）。同じ鍵の行があればそれを返す
  var idem = current ? current.idempotency_key : String(entry.client_key || '').slice(0, 80);
  if (!current) {
    if (!idem) idem = tripDate + '|' + me.username + '|' + Utilities.getUuid();
    var dup = travelNotion_(token, 'post', '/databases/' + TRAVEL_LEDGER_DB_ID + '/query', {
      page_size: 1,
      filter: { property: '冪等キー', rich_text: { equals: idem } }
    });
    if (dup.results && dup.results.length) return travelToTrip_(dup.results[0]);
  }

  var eventId = String(entry.event_id || (current && current.event_id) || '').slice(0, 300);
  var props = {
    'タイトル': travelTitle_(tripDate + ' ' + me.display + ' ' + destination),
    '出張日': { date: endDate !== tripDate ? { start: tripDate, end: endDate } : { start: tripDate } },
    '申請者': travelRich_(me.display),
    '申請者ID': travelRich_(me.username),
    '種別': { select: { name: kind } },
    '出発地': travelRich_(entry.origin || ''),
    '行き先': travelRich_(destination),
    '用件': travelRich_(purpose),
    'メモ': travelRich_(entry.memo || ''),
    '移動手段': mode ? { select: { name: mode } } : { select: null },
    '往復': { checkbox: !!entry.round_trip },
    '区分': tripType ? { select: { name: tripType } } : { select: null },
    '役職': { select: { name: role } },
    '規定マスタ': { relation: rate ? [{ id: rate.id }] : [] },
    '泊数': { number: nights },
    '交通費': { number: transport },
    '燃料費相当': { number: fuel },
    '日当': { number: daily },
    '宿泊料': { number: lodging },
    '宿泊実費': { number: lodgingActual },
    'その他経費': { number: other },
    '距離km': { number: distance },
    '領収書枚数': { number: haveReceipts },
    'ステータス': { select: { name: status } },
    '予定ID': travelRich_(eventId),
    '冪等キー': travelRich_(idem)
  };
  if (status === '提出') {
    props['申請日'] = { date: { start: travelToday_() } };
    props['差戻し理由'] = travelRich_('');
    props['承認履歴'] = travelRich_(travelAppendHistory_(current ? current.history : '', '提出', me));
  }

  // 先に画像をアップロード（失敗したら行を作らない）
  var uploads = [];
  for (var i = 0; i < images.length; i++) {
    uploads.push(travelNotionUpload_(token, travelImageBlob_(images[i], 'receipt-' + tripDate + '-' + (i + 1) + '.jpg')));
  }

  var page;
  if (current) {
    page = travelNotion_(token, 'patch', '/pages/' + current.id, { properties: props });
  } else {
    page = travelNotion_(token, 'post', '/pages', {
      parent: { database_id: TRAVEL_LEDGER_DB_ID },
      properties: props
    });
  }
  if (uploads.length) {
    travelNotion_(token, 'patch', '/blocks/' + page.id + '/children', {
      children: uploads.map(function (id) {
        return { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: id } } };
      })
    });
  }
  return travelToTrip_(page);
}

function travelAppendHistory_(history, label, me) {
  var line = travelNow_() + ' ' + label + '（' + me.display + '）';
  var s = history ? history + '\n' + line : line;
  return s.length > 1900 ? s.slice(s.length - 1900) : s;
}

/**
 * ステータス変更。
 *   本人   : 下書→提出 / 提出→下書（取り下げ）
 *   管理者 : 提出→上長承認済→経理承認済→支払済、および差戻し（→下書・理由つき）
 */
function travelSetStatus_(token, update, me) {
  var pageId = update && update.id;
  var next = String((update && update.status) || '');
  if (!pageId) throw new Error('id が必要です');
  if (TRAVEL_STATUSES.indexOf(next) < 0) throw new Error('ステータスが不正です');
  var trip = travelToTrip_(travelNotion_(token, 'get', '/pages/' + pageId, null));
  var cur = trip.status;
  var mine = travelIsMine_(trip, me);
  if (!me.is_admin && !mine) throw new Error('他人の申請は変更できません');
  if (cur === next) return trip;

  var props = {};
  var label = next;
  var allowed = false;
  if (next === '下書') {
    if (cur === '支払済') throw new Error('支払済の申請は戻せません');
    if (me.is_admin && !(mine && cur === '提出' && !update.reason)) {
      var reason = String(update.reason || '').trim();
      if (!reason) throw new Error('差戻しの理由を入れてください');
      props['差戻し理由'] = travelRich_(reason);
      label = '差戻し: ' + reason;
      allowed = true;
    } else if (mine && cur === '提出') {
      label = '取り下げ';
      allowed = true;
    }
  } else if (next === '提出') {
    throw new Error('提出は申請フォームから行ってください');
  } else if (me.is_admin) {
    allowed = (cur === '提出' && next === '上長承認済') ||
      (cur === '上長承認済' && next === '経理承認済') ||
      (cur === '経理承認済' && next === '支払済');
    if (!allowed) throw new Error('「' + cur + '」から「' + next + '」には進められません');
  }
  if (!allowed) throw new Error('この操作はできません');

  props['ステータス'] = { select: { name: next } };
  props['承認履歴'] = travelRich_(travelAppendHistory_(trip.history, label, me));
  return travelToTrip_(travelNotion_(token, 'patch', '/pages/' + pageId, { properties: props }));
}

function travelBulkStatus_(token, ids, status, me) {
  if (!me.is_admin) throw new Error('権限がありません');
  ids = (ids || []).slice(0, 60);
  return ids.map(function (id) {
    try {
      return { id: id, ok: true, trip: travelSetStatus_(token, { id: id, status: status }, me) };
    } catch (err) {
      return { id: id, ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
}

/** 本人の下書だけ削除できる（Notion ではアーカイブ） */
function travelRemoveTrip_(token, pageId, me) {
  if (!pageId) throw new Error('id が必要です');
  var trip = travelToTrip_(travelNotion_(token, 'get', '/pages/' + pageId, null));
  if (!travelIsMine_(trip, me)) throw new Error('他人の申請は削除できません');
  if (trip.status !== '下書') throw new Error('下書だけ削除できます');
  travelNotion_(token, 'patch', '/pages/' + pageId, { archived: true });
  return pageId;
}

// ==================== 領収書 ====================

function travelImageBlob_(b64, name) {
  var bytes = Utilities.base64Decode(String(b64).replace(/^data:[^,]*,/, ''));
  if (bytes.length > TRAVEL_MAX_IMAGE_BYTES) throw new Error('画像が大きすぎます');
  return Utilities.newBlob(bytes, 'image/jpeg', name);
}

function travelNotionUpload_(token, blob) {
  var made = travelNotion_(token, 'post', '/file_uploads', { filename: blob.getName(), content_type: 'image/jpeg' });
  var res = UrlFetchApp.fetch('https://api.notion.com/v1/file_uploads/' + made.id + '/send', {
    method: 'post',
    muteHttpExceptions: true,
    payload: { file: blob }, // blob を渡すと multipart/form-data になる
    headers: { Authorization: 'Bearer ' + token, 'Notion-Version': TRAVEL_NOTION_VERSION }
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('領収書のアップロードに失敗しました (' + res.getResponseCode() + ')');
  }
  return made.id;
}

/** 領収書画像の一時URL（約1時間有効）。本人か管理者だけ */
function travelListReceipts_(token, pageId, me) {
  if (!pageId) throw new Error('id が必要です');
  var trip = travelToTrip_(travelNotion_(token, 'get', '/pages/' + pageId, null));
  if (!me.is_admin && !travelIsMine_(trip, me)) throw new Error('他人の申請は見られません');
  var data = travelNotion_(token, 'get', '/blocks/' + pageId + '/children?page_size=100', null);
  var out = [];
  (data.results || []).forEach(function (b) {
    if (b.type !== 'image' || !b.image) return;
    var url = (b.image.file && b.image.file.url) || (b.image.external && b.image.external.url) || '';
    if (url) out.push({ id: b.id, url: url });
  });
  return out;
}

// ==================== カレンダーの予定 → 精算候補 ====================

function travelUserProp_(prefix, username) {
  return prefix + String(username).replace(/[^a-zA-Z0-9_]/g, '_');
}

function travelStaffEmail_(me) {
  return String(PropertiesService.getScriptProperties().getProperty(travelUserProp_('TRAVEL_EMAIL_', me.username)) || '').toLowerCase();
}

/** ポータルのアカウントとシフト名簿（メール）をひも付ける。本人が一度だけ選ぶ */
function travelLinkStaff_(me, email) {
  email = String(email || '').toLowerCase().trim();
  var props = PropertiesService.getScriptProperties();
  var key = travelUserProp_('TRAVEL_EMAIL_', me.username);
  if (!email) {
    props.deleteProperty(key);
    return '';
  }
  var ok = travelStaffList_().some(function (s) { return s.email === email; });
  if (!ok) throw new Error('名簿にないメールアドレスです');
  props.setProperty(key, email);
  return email;
}

function travelStaffList_() {
  try {
    return getCachedStaffList().filter(function (s) { return s.email; });
  } catch (e) {
    return [];
  }
}

function travelDismissedList_(me) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(travelUserProp_('TRAVEL_SKIP_', me.username));
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function travelDismiss_(me, eventId, undo) {
  eventId = String(eventId || '').slice(0, 300);
  if (!eventId) throw new Error('event_id が必要です');
  var list = travelDismissedList_(me).filter(function (x) { return x !== eventId; });
  if (!undo) list.push(eventId);
  if (list.length > 150) list = list.slice(list.length - 150);
  PropertiesService.getScriptProperties().setProperty(travelUserProp_('TRAVEL_SKIP_', me.username), JSON.stringify(list));
  return list;
}

function travelLooksLikePlace_(s) {
  s = String(s || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false;
  return !/zoom|meet\.google|teams|オンライン|online|web会議|リモート/i.test(s);
}

/**
 * 精算候補になる予定を集める。対象は次のいずれか（本人が参加者のもの）:
 *   1. ポータルで登録した予定のうち、場所が入っているもの
 *   2. ポータルで登録した「営業商談」の予定
 *   3. タイトルに 出張・訪問・展示会 などが入った予定（ポータル登録分＋本人の Google カレンダー）
 */
function travelCandidates_(me) {
  var email = travelStaffEmail_(me);
  if (!email) return [];
  var today = travelToday_();
  var from = travelAddDays_(today, -TRAVEL_CAND_PAST_DAYS);
  var to = travelAddDays_(today, TRAVEL_CAND_FUTURE_DAYS);
  var out = [];
  var seen = {};

  function push(c) {
    var key = c.date + '|' + String(c.title).replace(/\s+/g, '');
    if (seen[key]) return;
    seen[key] = true;
    out.push(c);
  }

  try {
    readAll('Appointments').forEach(function (r) {
      if (!r.date || r.date < from || r.date > to) return;
      var a = serializeAppointment(r);
      var mine = a.attendeeEmails.map(function (x) { return String(x).toLowerCase(); }).indexOf(email) >= 0 ||
        String(a.createdBy || '').toLowerCase() === email;
      if (!mine) return;
      var place = travelLooksLikePlace_(a.location);
      if (!(place || a.kind === '営業商談' || TRAVEL_KEYWORDS.test(a.title))) return;
      push({
        event_id: 'appt:' + a.id,
        source: 'portal',
        date: a.date,
        start: a.startTime,
        end: a.endTime,
        title: a.title,
        kind: a.kind,
        location: place ? a.location : '',
        notes: a.notes || ''
      });
    });
  } catch (e) { /* 予定シートが読めなくても続行 */ }

  try {
    var cal = CalendarApp.getCalendarById(email);
    if (cal) {
      var p1 = from.split('-');
      var p2 = to.split('-');
      var events = cal.getEvents(
        new Date(Number(p1[0]), Number(p1[1]) - 1, Number(p1[2])),
        new Date(Number(p2[0]), Number(p2[1]) - 1, Number(p2[2]) + 1)
      );
      events.forEach(function (ev) {
        var title = String(ev.getTitle() || '');
        if (!TRAVEL_KEYWORDS.test(title)) return;
        var allDay = ev.isAllDayEvent();
        var st = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
        var loc = String(ev.getLocation() || '');
        push({
          event_id: 'gcal:' + ev.getId(),
          source: 'google',
          date: Utilities.formatDate(st, 'Asia/Tokyo', 'yyyy-MM-dd'),
          start: allDay ? '' : Utilities.formatDate(st, 'Asia/Tokyo', 'HH:mm'),
          end: allDay ? '' : Utilities.formatDate(ev.getEndTime(), 'Asia/Tokyo', 'HH:mm'),
          title: title,
          kind: '',
          location: travelLooksLikePlace_(loc) ? loc : '',
          notes: ''
        });
      });
    }
  } catch (e) { /* 共有されていないカレンダーは読めない。ポータル登録分だけで続行 */ }

  out.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
  });
  return out;
}

// ==================== 画面の初期データ ====================

function travelBootstrap_(token, me) {
  var rates = travelRates_(token);
  var trips = travelQueryAll_(token, TRAVEL_LEDGER_DB_ID).map(travelToTrip_);
  if (!me.is_admin) trips = trips.filter(function (t) { return travelIsMine_(t, me); });

  var dismissed = travelDismissedList_(me);
  var claimed = {};
  trips.forEach(function (t) { if (t.event_id && travelIsMine_(t, me)) claimed[t.event_id] = true; });
  var candidates = travelCandidates_(me).map(function (c) {
    c.dismissed = dismissed.indexOf(c.event_id) >= 0;
    return c;
  }).filter(function (c) { return !claimed[c.event_id]; });

  var email = travelStaffEmail_(me);
  var people = [];
  if (me.is_admin) {
    var roster = travelRoster_();
    people = roster.map(function (u) {
      return { username: u.username, display: u.display, role: travelRoleOf_(u.username) };
    });
  }
  return {
    ok: true,
    user: me,
    today: travelToday_(),
    rates: rates,
    trips: trips,
    candidates: candidates,
    staff_email: email,
    staff_options: email ? [] : travelStaffList_(),
    people: people,
    policy: {
      far_km: TRAVEL_FAR_KM,
      receipt_modes: Object.keys(TRAVEL_RECEIPT_MODES),
      max_receipts: TRAVEL_MAX_RECEIPTS,
      modes: Object.keys(TRAVEL_MODES),
      kinds: Object.keys(TRAVEL_KINDS),
      statuses: TRAVEL_STATUSES,
      keywords: '出張・訪問・往訪・展示会・視察・商談・納品'
    }
  };
}
