/**
 * FLH 出張精算 API（flh-shift Web App に相乗り）
 *
 * ポータルから { service: 'travel', token, action: 'salt'|'login'|'session'|'create'|'update', ... }
 *
 * 認証はサーバー側で行う。ログインすると署名付きセッショントークンを発行し、
 * 申請者名と経理権限は必ずそのトークン＋名簿から決定する。
 * クライアントから送られてきた applicant / actor / is_admin は一切信用しない。
 *
 * Script Properties:
 *   NOTION_TOKEN           … Notion Integration Secret
 *   GH_PAT                 … fine-grained PAT (flh-travel-expense-sync Contents:write)
 *   TRAVEL_USERS           … 利用者名簿 JSON（app-portal/users.js と同じ形）
 *                            [{ "username": "kajiwara", "display": "梶原",
 *                               "salt": "...", "password_hash": "...", "is_admin": true }, ...]
 *   TRAVEL_SESSION_SECRET  … セッション署名鍵。未設定なら初回に自動生成する
 */

var TRAVEL_RATE_DB_ID = 'ef5f7c2c-1c77-4c57-9b7e-57ab08749a6b';
var TRAVEL_LEDGER_DB_ID = '4b91f92f-4eea-43fc-b097-7aba4f66858a';
var TRAVEL_SYNC_REPO = 'hirunegao/flh-travel-expense-sync';
var TRAVEL_NOTION_VERSION = '2022-06-28';
var TRAVEL_FUEL_YEN_PER_KM = 20;
var TRAVEL_ROLES = { '役員': 1, '管理職': 1, '一般': 1 };
var TRAVEL_TRIP_TYPES = {
  '日帰り近': 1, '日帰り遠': 1, '宿泊': 1,
  '海外第1': 1, '海外第2': 1, '海外第3': 1
};

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
var TRAVEL_MAX_LOGIN_FAILS = 10;

function travelRoster_() {
  var raw = PropertiesService.getScriptProperties().getProperty('TRAVEL_USERS');
  if (!raw) throw new Error('TRAVEL_USERS が未設定です');
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

function travelIssueToken_(username) {
  var payload = Utilities.base64EncodeWebSafe(
    Utilities.newBlob(JSON.stringify({ u: username, exp: Date.now() + TRAVEL_SESSION_HOURS * 3600 * 1000 })).getBytes()
  );
  return payload + '.' + travelSign_(payload);
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
  if (!u) throw new Error('not_registered');
  return { username: u.username, display: u.display, is_admin: u.is_admin };
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
        hasNotion: !!props.getProperty('NOTION_TOKEN')
      });
    }
    if (action === 'salt') {
      return travelJson_({ ok: true, salt: travelSaltFor_(body.username) });
    }
    if (action === 'login') {
      var session = travelLogin_(body);
      return travelJson_({ ok: true, token: session.token, user: session.user });
    }

    var me = travelResolveUser_(body.token);
    if (action === 'session') {
      return travelJson_({ ok: true, user: me });
    }

    var notionToken = props.getProperty('NOTION_TOKEN');
    var ghPat = props.getProperty('GH_PAT');
    if (!notionToken) return travelJson_({ ok: false, error: 'NOTION_TOKEN not set' });

    var result;
    if (action === 'create') {
      result = travelCreateTrip_(notionToken, body.entry || {}, me);
    } else if (action === 'update') {
      result = travelUpdateTrip_(notionToken, body.update || {}, me);
    } else {
      return travelJson_({ ok: false, error: 'unknown action' });
    }

    var refresh = { ok: false };
    if (ghPat) refresh = travelTriggerRefresh_(ghPat);

    return travelJson_({ ok: true, trip: result, refresh: refresh });
  } catch (err) {
    return travelJson_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function travelJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

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

function travelFindRate_(token, role, tripType) {
  var pages = travelQueryAll_(token, TRAVEL_RATE_DB_ID);
  var best = null;
  var bestDate = '';
  for (var i = 0; i < pages.length; i++) {
    var p = pages[i].properties || {};
    if (travelSelect_(p['役職']) !== role) continue;
    if (travelSelect_(p['区分']) !== tripType) continue;
    var d = travelDate_(p['適用開始日']) || '1970-01-01';
    if (d >= bestDate) {
      bestDate = d;
      best = pages[i];
    }
  }
  return best;
}

function travelRich_(text) {
  return { rich_text: [{ text: { content: String(text || '').slice(0, 2000) } }] };
}

function travelTitle_(text) {
  return { title: [{ text: { content: String(text || '').slice(0, 200) } }] };
}

function travelNormKey_(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

function travelMakeIdem_(tripDate, applicant, destination) {
  return tripDate + '|' + travelNormKey_(applicant) + '|' + travelNormKey_(destination);
}

function travelToTrip_(page) {
  var p = page.properties || {};
  var transport = travelNumber_(p['交通費']) || 0;
  var fuel = travelNumber_(p['燃料費相当']) || 0;
  var daily = travelNumber_(p['日当']) || 0;
  var lodging = travelNumber_(p['宿泊料']) || 0;
  return {
    id: page.id,
    title: travelPlain_(p['タイトル']),
    trip_date: travelDate_(p['出張日']),
    applicant: travelPlain_(p['申請者']),
    destination: travelPlain_(p['行き先']),
    purpose: travelPlain_(p['用件']),
    trip_type: travelSelect_(p['区分']),
    role: travelSelect_(p['役職']),
    transport_cost: transport,
    fuel_allowance: fuel,
    daily_allowance: daily,
    lodging_cost: lodging,
    distance_km: travelNumber_(p['距離km']) || 0,
    distance_evidence: (p['距離根拠'] && p['距離根拠'].url) || '',
    receipt_url: (p['領収書URL'] && p['領収書URL'].url) || '',
    status: travelSelect_(p['ステータス']) || '下書',
    idempotency_key: travelPlain_(p['冪等キー']),
    total: transport + fuel + daily + lodging,
    url: 'https://www.notion.so/' + String(page.id).replace(/-/g, '')
  };
}

function travelCreateTrip_(token, entry, me) {
  var tripDate = String(entry.trip_date || '').trim();
  var applicant = me.display;   // 本人以外の名前では出せない
  var destination = String(entry.destination || '').trim();
  var role = String(entry.role || '').trim();
  var tripType = String(entry.trip_type || '').trim();
  var status = String(entry.status || '下書').trim();
  var isAdmin = me.is_admin;

  if (!tripDate || !applicant || !destination) throw new Error('出張日・申請者・行き先は必須です');
  if (!TRAVEL_ROLES[role]) throw new Error('役職が不正です');
  if (!TRAVEL_TRIP_TYPES[tripType]) throw new Error('区分が不正です');
  if (!isAdmin && status !== '下書' && status !== '提出') throw new Error('ステータス権限がありません');
  if (isAdmin && ['下書', '提出', '承認', '支払済'].indexOf(status) < 0) throw new Error('ステータスが不正です');

  var rate = travelFindRate_(token, role, tripType);
  if (!rate) throw new Error('規定マスタが見つかりません: ' + role + ' / ' + tripType);
  var rp = rate.properties || {};
  var daily = travelNumber_(rp['日当']) || 0;
  var lodgingCap = travelNumber_(rp['宿泊料上限']) || 0;
  var lodging = Number(entry.lodging_cost || 0);
  if (lodging < 0) throw new Error('宿泊料が不正です');
  if (lodgingCap && lodging > lodgingCap) throw new Error('宿泊料が上限を超えています');

  var distance = Number(entry.distance_km || 0);
  if (distance < 0) throw new Error('距離が不正です');
  var fuel = Math.round(distance * 2 * TRAVEL_FUEL_YEN_PER_KM);
  var transport = Number(entry.transport_cost || 0);
  if (transport < 0) throw new Error('交通費が不正です');

  var idem = travelMakeIdem_(tripDate, applicant, destination);
  var existing = travelQueryAll_(token, TRAVEL_LEDGER_DB_ID);
  for (var i = 0; i < existing.length; i++) {
    if (travelNormKey_(travelPlain_((existing[i].properties || {})['冪等キー'])) === travelNormKey_(idem)) {
      throw new Error('同じ出張が既にあります');
    }
  }

  var props = {
    'タイトル': travelTitle_(entry.title || (tripDate + ' ' + destination)),
    '出張日': { date: { start: tripDate } },
    '申請者': travelRich_(applicant),
    '行き先': travelRich_(destination),
    '用件': travelRich_(entry.purpose || ''),
    '区分': { select: { name: tripType } },
    '役職': { select: { name: role } },
    '規定マスタ': { relation: [{ id: rate.id }] },
    '交通費': { number: transport },
    '燃料費相当': { number: fuel },
    '日当': { number: daily },
    '宿泊料': { number: lodging },
    '距離km': { number: distance },
    'ステータス': { select: { name: status } },
    '冪等キー': travelRich_(idem)
  };
  if (entry.distance_evidence) props['距離根拠'] = { url: String(entry.distance_evidence) };
  if (entry.receipt_url) props['領収書URL'] = { url: String(entry.receipt_url) };

  var page = travelNotion_(token, 'post', '/pages', {
    parent: { database_id: TRAVEL_LEDGER_DB_ID },
    properties: props
  });
  return travelToTrip_(page);
}

function travelUpdateTrip_(token, update, me) {
  var pageId = update.id;
  if (!pageId) throw new Error('id が必要です');
  var current = travelNotion_(token, 'get', '/pages/' + pageId, null);
  var cur = current.properties || {};
  var isAdmin = me.is_admin;
  var actor = me.display;
  var applicant = travelPlain_(cur['申請者']);
  var currentStatus = travelSelect_(cur['ステータス']) || '下書';

  if (!isAdmin && actor !== applicant) {
    throw new Error('他人の申請は編集できません');
  }

  var props = {};
  if (update.status) {
    var status = String(update.status);
    if (!isAdmin && status !== '下書' && status !== '提出') throw new Error('ステータス権限がありません');
    if (!isAdmin && (currentStatus === '承認' || currentStatus === '支払済')) {
      throw new Error('承認済みの申請は変更できません');
    }
    props['ステータス'] = { select: { name: status } };
  }

  if (Object.keys(props).length === 0) throw new Error('更新項目がありません');
  var page = travelNotion_(token, 'patch', '/pages/' + pageId, { properties: props });
  return travelToTrip_(page);
}

function travelTriggerRefresh_(ghPat) {
  var res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + TRAVEL_SYNC_REPO + '/dispatches',
    {
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + ghPat,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'flh-travel-expense-gas'
      },
      payload: JSON.stringify({ event_type: 'refresh', client_payload: {} }),
      muteHttpExceptions: true
    }
  );
  return { ok: res.getResponseCode() === 204, status: res.getResponseCode() };
}
