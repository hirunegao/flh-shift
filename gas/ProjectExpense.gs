/**
 * FLH プロジェクト経費・売上 入力 API（flh-shift Web App に相乗り）
 *
 * ポータルの「プロジェクト経費」画面（app-portal/project-expense/）から
 *   POST { service: 'project', token, action: ..., ... }
 * で呼ばれ、Notion の「経費明細（仮）」「売上明細（仮）」に 1 行ずつ書き込む。
 *
 * 認証の方式は出張精算（TravelExpense.gs）と同じだが、名簿と署名鍵はこの画面専用。
 *   出張精算の TRAVEL_USERS / TRAVEL_SESSION_SECRET は読みも書きもしない。
 *   salt / login / session … pxSaltFor_ / pxLogin_ / pxResolveUser_
 *   入力者名は必ずセッションから決める（クライアントの申告は使わない）
 *
 * Script Properties:
 *   NOTION_TOKEN            … Notion Integration Secret（出張精算と共用。経費明細/売上明細/Project List/商品原価マスタ に接続済みのもの）
 *   PROJECT_USERS           … この画面専用の利用者名簿 JSON（app-portal/users.js と同じ形）
 *                             [{ "username": "...", "display": "...", "salt": "...", "password_hash": "...", "is_admin": false }, ...]
 *                             各ユーザーに "notion_user_id": "xxxxxxxx-..." を足すと「入力者」(人物)にも紐づく
 *   PROJECT_SESSION_SECRET  … セッション署名鍵。未設定なら初回に自動生成する
 *   PROJECT_NOTION_USERS    … （任意）{ "username": "notion user id", ... } の JSON。PROJECT_USERS に書けないときの別マップ
 *
 * アクション:
 *   ping                 … 疎通（認証不要）
 *   salt / login / session
 *   bootstrap            … プロジェクト一覧・商品一覧・選択肢・自分の情報（画面初期化用）
 *   create_cost  {entry} … 経費明細に 1 行追加
 *   create_sales {entry} … 売上明細に 1 行追加
 *   mine                 … 自分が入力した直近の明細（経費・売上）
 *   summary {month?}     … プロジェクト別の売上・変動費・その他経費・限界利益（月指定は任意）
 */

var PX_COST_DB = '8c7067e0-600a-4c84-a57c-48fd29b83316';     // 経費明細（仮）
var PX_SALES_DB = 'bdee2d1d-0a06-42ff-b10a-82626c4d90bc';    // 売上明細（仮）
var PX_PROJECT_DB = '4c5e4610-60c8-437e-adbc-e6bf0489cc3a';  // Project List（施策一覧・既存）
var PX_PRODUCT_DB = '32b9bf67-f071-81ab-b8f2-ebaf9549ea60';  // 商品原価マスタ
var PX_NOTION_VERSION = '2022-06-28';
var PX_CACHE_SEC = 300;

var PX_COST_ITEMS = ['広告費', '外注費', '仕入・製造', '送料・物流', '決済手数料', 'イベント・出展', '交通・出張', 'ツール・システム', 'その他'];
var PX_VARIABLE_ITEMS = { '仕入・製造': 1, '送料・物流': 1, '広告費': 1, '決済手数料': 1 }; // 限界利益の控除対象
var PX_CHANNELS = ['自社EC', 'Amazon', '楽天', '卸・B2B', 'POPUP・催事', 'ライブコマース', 'その他'];

/** flh-shift の doPost から呼ばれる */
function projectHandlePost(body, e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var action = body.action || '';

    if (action === 'ping') {
      return pxJson_({ ok: true, service: 'flh-project-expense', hasNotion: !!props.getProperty('NOTION_TOKEN') });
    }
    if (action === 'salt') {
      return pxJson_({ ok: true, salt: pxSaltFor_(body.username) });
    }
    if (action === 'login') {
      var session = pxLogin_(body);
      return pxJson_({ ok: true, token: session.token, user: session.user });
    }

    var me = pxResolveUser_(body.token);
    if (action === 'session') {
      return pxJson_({ ok: true, user: me });
    }

    var token = props.getProperty('NOTION_TOKEN');
    if (!token) return pxJson_({ ok: false, error: 'NOTION_TOKEN not set' });

    switch (action) {
      case 'bootstrap':
        return pxJson_({ ok: true, data: pxBootstrap_(token, me) });
      case 'create_cost':
        return pxJson_({ ok: true, row: pxCreateCost_(token, body.entry || {}, me) });
      case 'create_sales':
        return pxJson_({ ok: true, row: pxCreateSales_(token, body.entry || {}, me) });
      case 'mine':
        return pxJson_({ ok: true, data: pxMine_(token, me) });
      case 'summary':
        return pxJson_({ ok: true, data: pxSummary_(token, body.month || '') });
      default:
        return pxJson_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return pxJson_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function pxJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ==================== 認証（この画面専用の名簿・署名鍵） ====================

var PX_SESSION_HOURS = 12;
var PX_MAX_LOGIN_FAILS = 10;

function pxRoster_() {
  var raw = PropertiesService.getScriptProperties().getProperty('PROJECT_USERS');
  if (!raw) throw new Error('PROJECT_USERS が未設定です');
  var list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error('PROJECT_USERS の JSON が不正です');
  }
  if (!list || !list.length) throw new Error('PROJECT_USERS が空です');
  return list.map(function (u) {
    return {
      username: String(u.username || '').trim(),
      display: String(u.display || u.username || '').trim(),
      salt: String(u.salt || ''),
      password_hash: String(u.password_hash || '').toLowerCase(),
      is_admin: !!u.is_admin,
      notion_user_id: u.notion_user_id ? String(u.notion_user_id) : null
    };
  });
}

function pxFindUser_(username) {
  var uname = String(username || '').trim();
  if (!uname) return null;
  var roster = pxRoster_();
  for (var i = 0; i < roster.length; i++) {
    if (roster[i].username === uname) return roster[i];
  }
  return null;
}

function pxSessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('PROJECT_SESSION_SECRET');
  if (!s) {
    s = Utilities.getUuid() + '|' + Utilities.getUuid();
    props.setProperty('PROJECT_SESSION_SECRET', s);
  }
  return s;
}

function pxSign_(text) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(String(text), pxSessionSecret_())
  );
}

/** 長さも内容も一定時間で比較する（早期 return しない） */
function pxEqual_(a, b) {
  a = String(a);
  b = String(b);
  var diff = a.length ^ b.length;
  var n = Math.min(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** ユーザー名の存在を漏らさないため、未登録でも安定した salt を返す */
function pxSaltFor_(username) {
  var u = null;
  try {
    u = pxFindUser_(username);
  } catch (e) {
    u = null;
  }
  if (u && u.salt) return u.salt;
  return pxSign_('salt|' + String(username || '')).slice(0, 16);
}

function pxIssueToken_(username) {
  var payload = Utilities.base64EncodeWebSafe(
    Utilities.newBlob(JSON.stringify({ u: username, exp: Date.now() + PX_SESSION_HOURS * 3600 * 1000 })).getBytes()
  );
  return payload + '.' + pxSign_(payload);
}

/** セッショントークンから利用者を確定する（入力者名はここでしか決まらない） */
function pxResolveUser_(token) {
  if (!token) throw new Error('auth_failed');
  var parts = String(token).split('.');
  if (parts.length !== 2) throw new Error('auth_failed');
  if (!pxEqual_(parts[1], pxSign_(parts[0]))) throw new Error('auth_failed');
  var payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (e) {
    throw new Error('auth_failed');
  }
  if (!payload.exp || Number(payload.exp) < Date.now()) throw new Error('token_expired');
  var u = pxFindUser_(payload.u);
  if (!u) throw new Error('not_registered');
  return { username: u.username, display: u.display, is_admin: u.is_admin };
}

/** ログイン。クライアントが salt で PBKDF2 したハッシュを名簿と突き合わせる */
function pxLogin_(body) {
  var username = String(body.username || '').trim();
  var hash = String(body.hash || '').toLowerCase();
  var cache = CacheService.getScriptCache();
  var failKey = 'px_fail_' + username;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= PX_MAX_LOGIN_FAILS) throw new Error('too_many_attempts');

  var u = pxFindUser_(username);
  if (!u || !hash || !pxEqual_(hash, u.password_hash)) {
    cache.put(failKey, String(fails + 1), 600);
    throw new Error('bad_credentials');
  }
  cache.remove(failKey);
  return {
    token: pxIssueToken_(u.username),
    user: { username: u.username, display: u.display, is_admin: u.is_admin }
  };
}

// ==================== Notion 共通 ====================

function pxNotion_(token, method, path, payload) {
  var opts = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': PX_NOTION_VERSION,
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

function pxQueryAll_(token, databaseId, filter, sorts) {
  var rows = [];
  var cursor = null;
  do {
    var body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    var data = pxNotion_(token, 'post', '/databases/' + databaseId + '/query', body);
    rows = rows.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

function pxPlain_(prop) {
  if (!prop) return '';
  var parts = prop.rich_text || prop.title || [];
  var s = '';
  for (var i = 0; i < parts.length; i++) s += parts[i].plain_text || '';
  return s.trim();
}
function pxSelect_(prop) { return prop && prop.select ? prop.select.name : null; }
function pxNumber_(prop) { return prop && prop.number != null ? prop.number : null; }
function pxDate_(prop) { return prop && prop.date ? prop.date.start : null; }
function pxRelationIds_(prop) {
  var out = [];
  var rel = prop && prop.relation ? prop.relation : [];
  for (var i = 0; i < rel.length; i++) out.push(rel[i].id);
  return out;
}
function pxFormula_(prop) {
  if (!prop || !prop.formula) return null;
  var f = prop.formula;
  if (f.type === 'number') return f.number;
  if (f.type === 'string') return f.string;
  if (f.type === 'boolean') return f.boolean;
  return null;
}
function pxRollupNumber_(prop) {
  if (!prop || !prop.rollup) return null;
  var r = prop.rollup;
  if (r.type === 'number') return r.number;
  return null;
}
function pxPeopleNames_(prop) {
  var out = [];
  var people = prop && prop.people ? prop.people : [];
  for (var i = 0; i < people.length; i++) out.push(people[i].name || '');
  return out;
}
function pxRich_(text) { return { rich_text: [{ text: { content: String(text || '').slice(0, 2000) } }] }; }
function pxTitle_(text) { return { title: [{ text: { content: String(text || '').slice(0, 200) } }] }; }
function pxNormKey_(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
function pxPageUrl_(id) { return 'https://www.notion.so/' + String(id).replace(/-/g, ''); }

function pxCacheGet_(key) {
  var raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function pxCachePut_(key, value) {
  var s = JSON.stringify(value);
  if (s.length < 95000) CacheService.getScriptCache().put(key, s, PX_CACHE_SEC);
}

// ==================== マスタ読み込み ====================

/** Project List（施策一覧）。全件を更新が新しい順に返す（Status List は参照しない） */
function pxProjects_(token) {
  var cached = pxCacheGet_('px_projects');
  if (cached) return cached;
  var rows = pxQueryAll_(token, PX_PROJECT_DB, null, [{ timestamp: 'last_edited_time', direction: 'descending' }]);
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var p = rows[i].properties || {};
    var name = pxPlain_(p['project name']);
    if (!name) continue;
    list.push({
      id: rows[i].id,
      name: name,
      type: pxSelect_(p['💰損益種別']) || '',
      owners: pxPeopleNames_(p['担当']),
      limit: pxDate_(p['limit'])
    });
  }
  pxCachePut_('px_projects', list);
  return list;
}

/**
 * 商品原価マスタ。Integration が未接続（404）なら null を返し、画面は原価の手入力だけで動く。
 * 失敗はキャッシュしないので、後から接続すれば次の読み込みで自動入力に切り替わる。
 */
function pxProducts_(token) {
  var cached = pxCacheGet_('px_products_v2');
  if (cached) return cached;
  var rows;
  try {
    rows = pxQueryAll_(token, PX_PRODUCT_DB);
  } catch (err) {
    if (/Notion HTTP 404/.test(String(err && err.message))) return null;
    throw err;
  }
  // 原価は商品原価マスタの「原価合計」を使わない（仕入ロットの合計になっており、
  // API からはリレーション先未接続で 0 に見える）。「商品マスタ」リレーション先の
  // OEM原価表ロットのうち日付が最新のものの @総原価 を採る（ec-notion-sync cost_sync.py と同じ規則）。
  var lotIds = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var rel = pxRelationIds_((rows[i].properties || {})['商品マスタ']);
    for (var j = 0; j < rel.length; j++) {
      if (!seen[rel[j]]) { seen[rel[j]] = true; lotIds.push(rel[j]); }
    }
  }
  var lots = pxFetchLots_(token, lotIds);

  var list = [];
  for (i = 0; i < rows.length; i++) {
    var p = rows[i].properties || {};
    var name = pxPlain_(p['商品名']);
    if (!name) continue;
    var best = null;
    var ids = pxRelationIds_(p['商品マスタ']);
    for (j = 0; j < ids.length; j++) {
      var lot = lots.byId[ids[j]];
      if (!lot || !(lot.cost > 0)) continue;
      if (!best || (lot.date || '') >= (best.date || '')) best = lot;
    }
    list.push({
      id: rows[i].id,
      name: name,
      sku: pxPlain_(p['SKU']),
      price: pxNumber_(p['販売価格']),
      cost: best ? best.cost : null,
      cost_lot: best ? best.name : null,
      cost_date: best ? best.date : null
    });
  }
  list.sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
  // Notion API は未接続DBへのリレーションを空配列で返す（404 にならない）。
  // 商品があるのにロットが1件も見えない＝OEM原価表に未接続とみなす。
  var unreachable = lots.unreachable || (rows.length > 0 && lotIds.length === 0);
  var result = { list: list, lots_available: !unreachable, lot_count: lotIds.length };
  // OEM原価表に届かない間はキャッシュしない（接続後の次の読み込みで切り替わる）
  if (result.lots_available) pxCachePut_('px_products_v2', result);
  return result;
}

/** OEM原価表のロットページをまとめて取得: { byId: {id: {name, date, cost}}, unreachable } */
function pxFetchLots_(token, ids) {
  var out = { byId: {}, unreachable: false };
  var headers = { Authorization: 'Bearer ' + token, 'Notion-Version': PX_NOTION_VERSION };
  var pending = ids.slice();
  for (var attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt > 0) Utilities.sleep(1500);
    var retry = [];
    for (var s = 0; s < pending.length; s += 10) {
      var chunk = pending.slice(s, s + 10);
      var reqs = chunk.map(function (id) {
        return { url: 'https://api.notion.com/v1/pages/' + id, method: 'get', headers: headers, muteHttpExceptions: true };
      });
      var res = UrlFetchApp.fetchAll(reqs);
      for (var k = 0; k < res.length; k++) {
        var code = res[k].getResponseCode();
        if (code === 429 || code >= 500) { retry.push(chunk[k]); continue; }
        if (code === 404) { out.unreachable = true; continue; }
        if (code < 200 || code >= 300) throw new Error('Notion HTTP ' + code + ' ' + res[k].getContentText().slice(0, 300));
        var page = JSON.parse(res[k].getContentText());
        var pp = page.properties || {};
        var cost = pxFormula_(pp['@総原価']);
        if (!(typeof cost === 'number' && cost > 0)) cost = pxFormula_(pp['総原価（手数料込）']);
        var title = '';
        for (var key in pp) { if (pp[key] && pp[key].type === 'title') { title = pxPlain_(pp[key]); break; } }
        out.byId[chunk[k]] = { name: title, date: pxDate_(pp['日付']), cost: typeof cost === 'number' ? cost : null };
      }
    }
    pending = retry;
  }
  if (pending.length) throw new Error('OEM原価表の読み込みが混み合っています。少し待って「最新を読み込み」を押してください');
  return out;
}

/** ポータルのユーザー名 → Notion ユーザーID（未設定なら null） */
function pxNotionUserId_(username) {
  var props = PropertiesService.getScriptProperties();
  try {
    var roster = JSON.parse(props.getProperty('PROJECT_USERS') || '[]');
    for (var i = 0; i < roster.length; i++) {
      if (roster[i].username === username && roster[i].notion_user_id) return String(roster[i].notion_user_id);
    }
  } catch (e) { /* 名簿が壊れていても入力は止めない */ }
  try {
    var map = JSON.parse(props.getProperty('PROJECT_NOTION_USERS') || '{}');
    if (map[username]) return String(map[username]);
  } catch (e2) { /* 同上 */ }
  return null;
}

function pxBootstrap_(token, me) {
  var products = pxProducts_(token);
  return {
    me: { username: me.username, display: me.display, is_admin: me.is_admin, notion_linked: !!pxNotionUserId_(me.username) },
    projects: pxProjects_(token),
    products: products ? products.list : [],
    products_available: products !== null,
    lots_available: products ? products.lots_available : false,
    cost_items: PX_COST_ITEMS,
    variable_items: Object.keys(PX_VARIABLE_ITEMS),
    channels: PX_CHANNELS,
    notion: { cost_db: pxPageUrl_(PX_COST_DB), sales_db: pxPageUrl_(PX_SALES_DB) }
  };
}

// ==================== 書き込み ====================

function pxRequireProject_(token, projectId) {
  var id = String(projectId || '').trim();
  if (!id) throw new Error('プロジェクトを選んでください');
  var list = pxProjects_(token);
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  // キャッシュが古いだけかもしれないので、Notion に直接確認する
  var page = pxNotion_(token, 'get', '/pages/' + id, null);
  if (!page || !page.parent || String(page.parent.database_id || '').replace(/-/g, '') !== PX_PROJECT_DB.replace(/-/g, '')) {
    throw new Error('Project List にないプロジェクトです');
  }
  return { id: id, name: pxPlain_((page.properties || {})['project name']) };
}

function pxRequireDate_(s, label) {
  var v = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(label + 'を YYYY-MM-DD で入力してください');
  return v;
}

function pxRequireAmount_(v, label) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0) throw new Error(label + 'は 1 円以上の数値で入力してください');
  return Math.round(n);
}

function pxDuplicate_(token, databaseId, idem) {
  var rows = pxQueryAll_(token, databaseId, { property: '冪等キー', rich_text: { equals: idem } });
  return rows.length > 0;
}

function pxEnteredBy_(me) {
  var props = { '入力者名': pxRich_(me.display) };
  var uid = pxNotionUserId_(me.username);
  if (uid) props['入力者'] = { people: [{ object: 'user', id: uid }] };
  return props;
}

function pxCreateCost_(token, entry, me) {
  var project = pxRequireProject_(token, entry.project_id);
  var item = String(entry.item || '').trim();
  if (PX_COST_ITEMS.indexOf(item) < 0) throw new Error('費目が不正です');
  var amount = pxRequireAmount_(entry.amount, '金額（税抜）');
  var paidOn = pxRequireDate_(entry.paid_on, '支払日');
  var subject = String(entry.subject || '').trim();
  if (!subject) throw new Error('件名を入力してください');
  var payee = String(entry.payee || '').trim();
  var memo = String(entry.memo || '').trim();
  var evidence = String(entry.evidence_url || '').trim();
  if (evidence && !/^https?:\/\//.test(evidence)) throw new Error('証憑URLは http(s):// から入力してください');

  var idem = [paidOn, pxNormKey_(me.display), project.id.replace(/-/g, ''), item, amount, pxNormKey_(subject)].join('|');
  if (pxDuplicate_(token, PX_COST_DB, idem)) throw new Error('同じ内容の経費が既に登録されています（件名・金額・支払日・プロジェクト・費目・入力者が同一）');

  var props = {
    '件名': pxTitle_(subject),
    'プロジェクト': { relation: [{ id: project.id }] },
    '費目': { select: { name: item } },
    '金額（税抜）': { number: amount },
    '支払日': { date: { start: paidOn } },
    '冪等キー': pxRich_(idem)
  };
  if (payee) props['支払先'] = pxRich_(payee);
  if (memo) props['メモ'] = pxRich_(memo);
  if (evidence) props['証憑URL'] = { url: evidence };
  var by = pxEnteredBy_(me);
  for (var k in by) props[k] = by[k];

  var page = pxNotion_(token, 'post', '/pages', { parent: { database_id: PX_COST_DB }, properties: props });
  return pxCostRow_(page, project.name);
}

function pxCreateSales_(token, entry, me) {
  var project = pxRequireProject_(token, entry.project_id);
  var channel = String(entry.channel || '').trim();
  if (PX_CHANNELS.indexOf(channel) < 0) throw new Error('チャネルが不正です');
  var amount = pxRequireAmount_(entry.amount, '販売額（税抜）');
  var soldOn = pxRequireDate_(entry.sold_on, '売上日');
  var subject = String(entry.subject || '').trim();
  if (!subject) throw new Error('件名を入力してください');
  var qty = entry.quantity === '' || entry.quantity == null ? null : Number(entry.quantity);
  if (qty != null && (!isFinite(qty) || qty < 0)) throw new Error('数量が不正です');
  var unitCost = entry.unit_cost === '' || entry.unit_cost == null ? null : Number(entry.unit_cost);
  if (unitCost != null && (!isFinite(unitCost) || unitCost < 0)) throw new Error('原価単価（手入力）が不正です');
  var productId = String(entry.product_id || '').trim();
  var memo = String(entry.memo || '').trim();

  // 商品を選んだ場合: 原価単価は OEM原価表の最新ロットから GAS が確定して書き込む（手入力があればそれを優先）。
  // Notion 側のロールアップ「原価単価（マスタ）」はロット合計で誤るため、空のまま残さない。
  if (productId) {
    var prodRes = pxProducts_(token);
    var prod = null;
    var plist = prodRes ? prodRes.list : [];
    for (var pi = 0; pi < plist.length; pi++) if (plist[pi].id === productId) { prod = plist[pi]; break; }
    if (!prod) throw new Error('商品が商品原価マスタに見つかりません。「最新を読み込み」を押してください');
    if (qty == null) throw new Error('商品を選んだときは数量を入力してください');
    if (unitCost == null) {
      if (typeof prod.cost !== 'number') throw new Error('この商品は原価が取得できません。原価単価を手入力してください');
      unitCost = prod.cost;
    }
  }

  var idem = [soldOn, pxNormKey_(me.display), project.id.replace(/-/g, ''), channel, amount, pxNormKey_(subject)].join('|');
  if (pxDuplicate_(token, PX_SALES_DB, idem)) throw new Error('同じ内容の売上が既に登録されています（件名・金額・売上日・プロジェクト・チャネル・入力者が同一）');

  var props = {
    '件名': pxTitle_(subject),
    'プロジェクト': { relation: [{ id: project.id }] },
    'チャネル': { select: { name: channel } },
    '販売額（税抜）': { number: amount },
    '売上日': { date: { start: soldOn } },
    '冪等キー': pxRich_(idem)
  };
  if (qty != null) props['数量'] = { number: qty };
  if (unitCost != null) props['原価単価（手入力）'] = { number: unitCost };
  if (productId) props['商品'] = { relation: [{ id: productId }] };
  if (memo) props['メモ'] = pxRich_(memo);
  var by = pxEnteredBy_(me);
  for (var k in by) props[k] = by[k];

  var page = pxNotion_(token, 'post', '/pages', { parent: { database_id: PX_SALES_DB }, properties: props });
  return pxSalesRow_(page, project.name);
}

// ==================== 読み出し ====================

function pxCostRow_(page, projectName) {
  var p = page.properties || {};
  var rel = pxRelationIds_(p['プロジェクト']);
  return {
    kind: 'cost',
    id: page.id,
    subject: pxPlain_(p['件名']),
    project_id: rel[0] || '',
    project: projectName || '',
    item: pxSelect_(p['費目']) || '',
    cost_class: pxFormula_(p['費用区分']) || '',
    amount: pxNumber_(p['金額（税抜）']) || 0,
    date: pxDate_(p['支払日']),
    payee: pxPlain_(p['支払先']),
    entered_by: pxPlain_(p['入力者名']),
    created: page.created_time,
    url: pxPageUrl_(page.id)
  };
}

function pxSalesRow_(page, projectName) {
  var p = page.properties || {};
  var rel = pxRelationIds_(p['プロジェクト']);
  var cost = pxFormula_(p['原価計']);
  return {
    kind: 'sales',
    id: page.id,
    subject: pxPlain_(p['件名']),
    project_id: rel[0] || '',
    project: projectName || '',
    channel: pxSelect_(p['チャネル']) || '',
    amount: pxNumber_(p['販売額（税抜）']) || 0,
    quantity: pxNumber_(p['数量']),
    cost_total: typeof cost === 'number' ? cost : null,
    date: pxDate_(p['売上日']),
    entered_by: pxPlain_(p['入力者名']),
    created: page.created_time,
    url: pxPageUrl_(page.id)
  };
}

function pxProjectNameMap_(token) {
  var list = pxProjects_(token);
  var map = {};
  for (var i = 0; i < list.length; i++) map[list[i].id] = list[i].name;
  return map;
}

function pxMine_(token, me) {
  var names = pxProjectNameMap_(token);
  var filter = { property: '入力者名', rich_text: { equals: me.display } };
  var sorts = [{ timestamp: 'created_time', direction: 'descending' }];
  var costs = pxQueryAll_(token, PX_COST_DB, filter, sorts).slice(0, 100);
  var sales = pxQueryAll_(token, PX_SALES_DB, filter, sorts).slice(0, 100);
  var rows = [];
  var i;
  for (i = 0; i < costs.length; i++) {
    var c = pxCostRow_(costs[i]);
    c.project = names[c.project_id] || '';
    rows.push(c);
  }
  for (i = 0; i < sales.length; i++) {
    var s = pxSalesRow_(sales[i]);
    s.project = names[s.project_id] || '';
    rows.push(s);
  }
  rows.sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
  return rows;
}

/** month = 'YYYY-MM'（空なら全期間）。プロジェクト別に 売上・変動費・その他経費・限界利益 を返す */
function pxSummary_(token, month) {
  var m = String(month || '').trim();
  if (m && !/^\d{4}-\d{2}$/.test(m)) throw new Error('対象月は YYYY-MM で指定してください');
  var names = pxProjectNameMap_(token);
  var costFilter = null;
  var salesFilter = null;
  if (m) {
    var start = m + '-01';
    var y = Number(m.slice(0, 4));
    var mo = Number(m.slice(5, 7));
    var next = mo === 12 ? (y + 1) + '-01-01' : y + '-' + ('0' + (mo + 1)).slice(-2) + '-01';
    costFilter = { and: [{ property: '支払日', date: { on_or_after: start } }, { property: '支払日', date: { before: next } }] };
    salesFilter = { and: [{ property: '売上日', date: { on_or_after: start } }, { property: '売上日', date: { before: next } }] };
  }
  var costs = pxQueryAll_(token, PX_COST_DB, costFilter);
  var sales = pxQueryAll_(token, PX_SALES_DB, salesFilter);
  var by = {};
  function bucket(pid) {
    if (!by[pid]) by[pid] = { project_id: pid, project: names[pid] || '(Project List 外)', sales: 0, cogs: 0, variable: 0, other: 0, sales_count: 0, cost_count: 0 };
    return by[pid];
  }
  var i;
  for (i = 0; i < sales.length; i++) {
    var s = pxSalesRow_(sales[i]);
    var bs = bucket(s.project_id || '-');
    bs.sales += s.amount;
    bs.cogs += s.cost_total || 0;
    bs.sales_count += 1;
  }
  for (i = 0; i < costs.length; i++) {
    var c = pxCostRow_(costs[i]);
    var bc = bucket(c.project_id || '-');
    if (PX_VARIABLE_ITEMS[c.item]) bc.variable += c.amount; else bc.other += c.amount;
    bc.cost_count += 1;
  }
  var out = [];
  for (var k in by) {
    var b = by[k];
    b.marginal_profit = b.sales - b.cogs - b.variable;      // 限界利益 = 売上 − 商品原価 − 変動費
    b.profit_after_other = b.marginal_profit - b.other;     // その他経費まで引いた額（人件費は含まない）
    out.push(b);
  }
  out.sort(function (a, b) { return b.sales - a.sales; });
  return { month: m, rows: out, generated_at: new Date().toISOString() };
}
