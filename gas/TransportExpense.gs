/**
 * FLH 交通費精算 API（flh-shift Web App 相乗り）
 * POST { service: 'transport', action: '...', ... }
 *
 * Script Properties: NOTION_TOKEN, GH_PAT, YAHOO_APP_ID（任意）
 */

var TX_STAFF_DB = 'bc79978a-288d-46be-a971-6607d26dd4c2';
var TX_CLAIM_DB = '782801bd-90bf-469a-b727-e909d960c849';
var TX_SEGMENT_DB = 'f867527f-42f5-4efe-a475-b200627f1cd5';
var TX_FAVORITE_DB = '020b61e3-df81-43a4-b892-29a394dcff62';
var TX_SYNC_REPO = 'hirunegao/flh-travel-expense-sync';
var TX_NOTION_VER = '2022-06-28';
var TX_FUEL = 20;
var TX_RECEIPT_MIN = 3000;
var TX_DEADLINE_DAY = 15;
var TX_MODES = { '電車・バス': 1, 'タクシー': 1, '駐車場・高速': 1, '社用車': 1, '飛行機・新幹線': 1 };
var TX_DEDUCT = { '電車・バス': 1, 'タクシー': 1, '駐車場・高速': 1, '飛行機・新幹線': 1 };
var TX_PURPOSE = { '商談': 1, '打合せ': 1, '納品・配送': 1, '展示会': 1, '採用': 1, 'その他': 1 };
var TX_TAXI = { '終電後': 1, '荷物運搬': 1, '時間制約': 1, '天候・体調': 1, 'その他': 1 };

function transportHandlePost(body, e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('NOTION_TOKEN');
    if (!token) return txJson_({ ok: false, error: 'NOTION_TOKEN not set' });
    var action = body.action || '';
    var result;
    if (action === 'ping') {
      return txJson_({ ok: true, service: 'flh-transport-expense', hasNotion: true, hasYahoo: !!props.getProperty('YAHOO_APP_ID') });
    }
    if (action === 'fareLookup') {
      return txJson_(txFareLookup_(props, body.from || '', body.to || ''));
    }
    if (action === 'create') {
      result = txCreateClaim_(token, body.entry || {});
    } else if (action === 'update') {
      result = txUpdateClaim_(token, body.update || {});
    } else if (action === 'saveFavorite') {
      result = txSaveFavorite_(token, body.favorite || {});
    } else if (action === 'deleteFavorite') {
      result = txDeleteFavorite_(token, body.id);
    } else {
      return txJson_({ ok: false, error: 'unknown action' });
    }
    var gh = props.getProperty('GH_PAT');
    var refresh = { ok: false };
    if (gh) refresh = txRefresh_(gh);
    return txJson_({ ok: true, claim: result.claim || result, favorite: result.favorite, refresh: refresh });
  } catch (err) {
    return txJson_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function txJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function txNotion_(token, method, path, payload) {
  var opts = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': TX_NOTION_VER,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload) opts.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, opts);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('Notion HTTP ' + code + ' ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

function txQueryAll_(token, dbId) {
  var rows = [];
  var cursor = null;
  do {
    var body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    var data = txNotion_(token, 'post', '/databases/' + dbId + '/query', body);
    rows = rows.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

function txPlain_(prop) {
  if (!prop) return '';
  var parts = prop.rich_text || prop.title || [];
  var s = '';
  for (var i = 0; i < parts.length; i++) s += parts[i].plain_text || '';
  return s.trim();
}
function txSelect_(prop) { return prop && prop.select ? prop.select.name : null; }
function txNumber_(prop) { return prop && prop.number != null ? prop.number : null; }
function txDate_(prop) { return prop && prop.date ? prop.date.start : null; }
function txCheck_(prop) { return !!(prop && prop.checkbox); }
function txRich_(t) { return { rich_text: [{ text: { content: String(t || '').slice(0, 2000) } }] }; }
function txTitle_(t) { return { title: [{ text: { content: String(t || '').slice(0, 200) } }] }; }

function txFindStaff_(token, username) {
  var pages = txQueryAll_(token, TX_STAFF_DB);
  for (var i = 0; i < pages.length; i++) {
    var p = pages[i].properties || {};
    if (txPlain_(p['username']) === username && txCheck_(p['有効'])) return pages[i];
  }
  return null;
}

function txCalcPayable_(segments, homeFare) {
  var gross = 0;
  var deductLegs = 0;
  for (var i = 0; i < segments.length; i++) {
    var s = segments[i];
    var fare = Number(s.fare || 0);
    if (s.mode === '社用車') {
      fare = Math.round(Number(s.distance_km || 0) * TX_FUEL);
      s.fare = fare;
    }
    if (fare < 0) throw new Error('運賃が不正です');
    gross += fare;
    if (TX_DEDUCT[s.mode]) {
      if (s.home_start) deductLegs++;
      if (s.home_end) deductLegs++;
    }
  }
  var deduction = Math.round(Number(homeFare || 0) * deductLegs);
  var payable = gross - deduction;
  return { gross: gross, deduction: deduction, payable: payable, deductLegs: deductLegs };
}

function txIsLate_(claimDateStr) {
  // claimDate YYYY-MM-DD → deadline = next month TX_DEADLINE_DAY
  var parts = String(claimDateStr).split('-');
  if (parts.length < 3) return false;
  var y = Number(parts[0]);
  var m = Number(parts[1]);
  var nextY = m === 12 ? y + 1 : y;
  var nextM = m === 12 ? 1 : m + 1;
  var deadline = new Date(nextY, nextM - 1, TX_DEADLINE_DAY, 23, 59, 59);
  return new Date() > deadline;
}

function txValidateEntry_(token, entry, staffPage, forSubmit) {
  var date = String(entry.claim_date || '').trim();
  var applicant = String(entry.applicant || '').trim();
  var purposeType = String(entry.purpose_type || '').trim();
  var segments = entry.segments || [];
  if (!date || !applicant) throw new Error('申請日と申請者は必須です');
  if (!TX_PURPOSE[purposeType]) throw new Error('目的区分が不正です');
  if (!segments.length) throw new Error('区間が1件以上必要です');
  // 提出時のみマスタ必須・支給額>0・証憑チェック（下書は許可）
  if (forSubmit && !staffPage) {
    throw new Error('スタッフ交通マスタ未登録です。管理者に登録を依頼してください');
  }
  var homeFare = staffPage ? (txNumber_((staffPage.properties || {})['自宅駅定額']) || 0) : 0;
  var manager = staffPage ? txPlain_((staffPage.properties || {})['上長username']) : '';
  for (var i = 0; i < segments.length; i++) {
    var s = segments[i];
    if (!TX_MODES[s.mode]) throw new Error('手段が不正です: ' + s.mode);
    if (s.mode === '社用車') {
      s.home_start = false;
      s.home_end = false;
    }
    if (forSubmit && s.mode === 'タクシー' && !TX_TAXI[s.taxi_reason]) {
      throw new Error('タクシー事由が必須です');
    }
    if (!s.from || !s.to) throw new Error('出発・到着は必須です');
  }
  var calc = txCalcPayable_(segments, homeFare);
  var hasReceipt = !!(entry.receipt_url);
  for (var j = 0; j < segments.length; j++) {
    if (segments[j].receipt_url) hasReceipt = true;
  }
  if (forSubmit) {
    if (calc.payable <= 0) throw new Error('支給額が0円以下のため提出できません（自宅〜駅控除後）');
    if (calc.payable >= TX_RECEIPT_MIN && !hasReceipt) {
      throw new Error('支給額3,000円以上は証憑URLが必須です');
    }
    if (!manager) throw new Error('上長がマスタ未設定です');
  }
  var late = txIsLate_(date);
  return { calc: calc, manager: manager, late: late, homeFare: homeFare };
}

function txArchiveSegments_(token, claimId) {
  var pages = txQueryAll_(token, TX_SEGMENT_DB);
  for (var i = 0; i < pages.length; i++) {
    var rel = (pages[i].properties || {})['申請'];
    var ids = [];
    if (rel && rel.relation) {
      for (var j = 0; j < rel.relation.length; j++) ids.push(rel.relation[j].id);
    }
    if (ids.indexOf(claimId) >= 0) {
      txNotion_(token, 'patch', '/pages/' + pages[i].id, { archived: true });
    }
  }
}

function txFindByIdem_(token, idem) {
  var existing = txQueryAll_(token, TX_CLAIM_DB);
  for (var i = 0; i < existing.length; i++) {
    if (txPlain_((existing[i].properties || {})['冪等キー']).toLowerCase() === idem) {
      return existing[i];
    }
  }
  return null;
}

function txToClaim_(page, segments) {
  var p = page.properties || {};
  return {
    id: page.id,
    title: txPlain_(p['タイトル']),
    claim_date: txDate_(p['申請日']),
    applicant: txPlain_(p['申請者']),
    purpose_type: txSelect_(p['目的区分']),
    purpose_detail: txPlain_(p['目的詳細']),
    gross: txNumber_(p['総額']) || 0,
    deduction: txNumber_(p['控除額']) || 0,
    payable: txNumber_(p['支給額']) || 0,
    status: txSelect_(p['ステータス']) || '下書',
    late: txCheck_(p['遅延']),
    reject_reason: txPlain_(p['差戻し理由']),
    manager: txPlain_(p['上長']),
    idempotency_key: txPlain_(p['冪等キー']),
    receipt_url: (p['証憑URL'] && p['証憑URL'].url) || '',
    segments: segments || [],
    url: 'https://www.notion.so/' + String(page.id).replace(/-/g, '')
  };
}

function txCreateSegments_(token, claimId, segments) {
  var out = [];
  for (var i = 0; i < segments.length; i++) {
    var s = segments[i];
    var fare = Number(s.fare || 0);
    if (s.mode === '社用車') fare = Math.round(Number(s.distance_km || 0) * TX_FUEL);
    var props = {
      '名称': txTitle_((s.from || '') + '→' + (s.to || '')),
      '申請': { relation: [{ id: claimId }] },
      '手段': { select: { name: s.mode } },
      '出発': txRich_(s.from),
      '到着': txRich_(s.to),
      '自宅起点': { checkbox: !!s.home_start },
      '自宅終点': { checkbox: !!s.home_end },
      '運賃': { number: fare },
      '距離km': { number: Number(s.distance_km || 0) },
      '順序': { number: i + 1 }
    };
    if (s.mode === 'タクシー' && s.taxi_reason) props['タクシー事由'] = { select: { name: s.taxi_reason } };
    if (s.receipt_url) props['証憑URL'] = { url: String(s.receipt_url) };
    var page = txNotion_(token, 'post', '/pages', { parent: { database_id: TX_SEGMENT_DB }, properties: props });
    out.push({
      id: page.id, mode: s.mode, from: s.from, to: s.to,
      home_start: !!s.home_start, home_end: !!s.home_end,
      fare: fare, distance_km: Number(s.distance_km || 0),
      taxi_reason: s.taxi_reason || null, receipt_url: s.receipt_url || '', order: i + 1
    });
  }
  return out;
}

function txWriteClaimProps_(entry, v, status, idem) {
  var date = String(entry.claim_date).trim();
  var props = {
    'タイトル': txTitle_(date + ' ' + entry.applicant),
    '申請日': { date: { start: date } },
    '申請者': txRich_(entry.applicant),
    '目的区分': { select: { name: entry.purpose_type } },
    '目的詳細': txRich_(entry.purpose_detail || ''),
    '総額': { number: v.calc.gross },
    '控除額': { number: v.calc.deduction },
    '支給額': { number: v.calc.payable },
    'ステータス': { select: { name: status } },
    '遅延': { checkbox: !!v.late },
    '上長': txRich_(v.manager),
    '冪等キー': txRich_(idem),
    '差戻し理由': txRich_('')
  };
  if (entry.receipt_url) props['証憑URL'] = { url: String(entry.receipt_url) };
  else props['証憑URL'] = { url: null };
  return props;
}

function txCreateClaim_(token, entry) {
  var applicant = String(entry.applicant || '').trim();
  var staff = txFindStaff_(token, applicant);
  var status = String(entry.status || '下書');
  if (status !== '下書' && status !== '提出') throw new Error('ステータス権限がありません');
  var forSubmit = status === '提出';
  var v = txValidateEntry_(token, entry, staff, forSubmit);
  var date = String(entry.claim_date).trim();
  var idem = String(entry.idempotency_key || (date + '|' + applicant)).toLowerCase();

  // 同日の下書があれば上書き（差戻し再提出・下書→提出）
  var existing = txFindByIdem_(token, idem);
  if (existing) {
    var curStatus = txSelect_((existing.properties || {})['ステータス']) || '下書';
    if (curStatus !== '下書') throw new Error('同じ日の申請が既にあります（' + curStatus + '）');
    return txReplaceDraft_(token, existing.id, entry, v, status, idem);
  }

  var props = txWriteClaimProps_(entry, v, status, idem);
  var page = txNotion_(token, 'post', '/pages', { parent: { database_id: TX_CLAIM_DB }, properties: props });
  var segs = txCreateSegments_(token, page.id, entry.segments || []);
  return { claim: txToClaim_(page, segs) };
}

function txReplaceDraft_(token, claimId, entry, v, status, idem) {
  txArchiveSegments_(token, claimId);
  var props = txWriteClaimProps_(entry, v, status, idem);
  var page = txNotion_(token, 'patch', '/pages/' + claimId, { properties: props });
  var segs = txCreateSegments_(token, claimId, entry.segments || []);
  return { claim: txToClaim_(page, segs) };
}

function txUpdateClaim_(token, update) {
  var pageId = update.id;
  if (!pageId) throw new Error('id が必要です');
  var current = txNotion_(token, 'get', '/pages/' + pageId, null);
  var cur = current.properties || {};
  var actor = String(update.actor || '');
  var isAdmin = !!update.is_admin;
  var applicant = txPlain_(cur['申請者']);
  var manager = txPlain_(cur['上長']);
  var statusNow = txSelect_(cur['ステータス']) || '下書';

  // 内容つき更新（下書の編集／再提出）
  if (update.entry && update.entry.segments) {
    if (actor !== applicant && !isAdmin) throw new Error('本人のみ編集できます');
    if (statusNow !== '下書') throw new Error('下書のみ内容編集できます');
    var status = String(update.entry.status || update.status || '下書');
    if (status !== '下書' && status !== '提出') throw new Error('ステータス権限がありません');
    var staff = txFindStaff_(token, applicant);
    var entry = update.entry;
    entry.applicant = applicant;
    if (!entry.claim_date) entry.claim_date = txDate_(cur['申請日']);
    var v = txValidateEntry_(token, entry, staff, status === '提出');
    var idem = txPlain_(cur['冪等キー']) || (entry.claim_date + '|' + applicant).toLowerCase();
    return txReplaceDraft_(token, pageId, entry, v, status, idem);
  }

  var props = {};
  if (update.status) {
    var next = String(update.status);
    if (next === '下書') {
      // 差戻し: 提出→上長/経理、上長承認済・経理承認済→経理のみ
      if (statusNow !== '提出' && statusNow !== '上長承認済' && statusNow !== '経理承認済') {
        throw new Error('この状態からは差戻しできません');
      }
      if (!update.reject_reason) throw new Error('差戻し理由は必須です');
      if (statusNow === '提出') {
        if (!isAdmin && actor !== manager) throw new Error('上長または経理のみ差戻しできます');
      } else if (!isAdmin) {
        throw new Error('経理（管理者）のみ差戻しできます');
      }
      props['ステータス'] = { select: { name: '下書' } };
      props['差戻し理由'] = txRich_(update.reject_reason);
    } else if (next === '提出') {
      if (actor !== applicant && !isAdmin) throw new Error('本人のみ提出できます');
      if (statusNow !== '下書') throw new Error('下書のみ提出できます');
      // 既存金額で提出時検証
      var staff2 = txFindStaff_(token, applicant);
      if (!staff2) throw new Error('スタッフ交通マスタ未登録です');
      var payable = txNumber_(cur['支給額']) || 0;
      if (payable <= 0) throw new Error('支給額が0円以下のため提出できません');
      var receipt = (cur['証憑URL'] && cur['証憑URL'].url) || '';
      if (payable >= TX_RECEIPT_MIN && !receipt) throw new Error('支給額3,000円以上は証憑URLが必須です');
      var claimDate = txDate_(cur['申請日']);
      props['ステータス'] = { select: { name: '提出' } };
      props['遅延'] = { checkbox: txIsLate_(claimDate) };
      props['差戻し理由'] = txRich_('');
    } else if (next === '上長承認済') {
      if (actor !== manager && !isAdmin) throw new Error('上長のみ承認できます');
      if (statusNow !== '提出') throw new Error('提出状態のみ上長承認できます');
      props['ステータス'] = { select: { name: '上長承認済' } };
    } else if (next === '経理承認済') {
      if (!isAdmin) throw new Error('経理（管理者）のみ操作できます');
      if (statusNow !== '上長承認済') throw new Error('上長承認後に経理承認できます');
      props['ステータス'] = { select: { name: '経理承認済' } };
    } else if (next === '支払済') {
      if (!isAdmin) throw new Error('経理（管理者）のみ操作できます');
      if (statusNow !== '経理承認済') throw new Error('経理承認後に支払済にできます');
      props['ステータス'] = { select: { name: '支払済' } };
    } else {
      throw new Error('ステータスが不正です');
    }
  }

  if (Object.keys(props).length === 0) throw new Error('更新項目がありません');
  var page = txNotion_(token, 'patch', '/pages/' + pageId, { properties: props });
  return { claim: txToClaim_(page, []) };
}

function txSaveFavorite_(token, fav) {
  var applicant = String(fav.applicant || '').trim();
  var name = String(fav.name || '').trim();
  if (!applicant || !name) throw new Error('名称と申請者は必須です');
  var page = txNotion_(token, 'post', '/pages', {
    parent: { database_id: TX_FAVORITE_DB },
    properties: {
      '名称': txTitle_(name),
      '申請者': txRich_(applicant),
      '区間JSON': txRich_(JSON.stringify(fav.segments || []))
    }
  });
  return { favorite: { id: page.id, name: name, applicant: applicant, segments: fav.segments || [] } };
}

function txDeleteFavorite_(token, id) {
  if (!id) throw new Error('id が必要です');
  txNotion_(token, 'patch', '/pages/' + id, { archived: true });
  return { favorite: { id: id, archived: true } };
}

function txFareLookup_(props, from, to) {
  var appId = props.getProperty('YAHOO_APP_ID');
  if (!appId) {
    return { ok: false, error: 'YAHOO_APP_ID 未設定。運賃は手入力してください', manual: true };
  }
  if (!from || !to) throw new Error('出発・到着が必要です');
  var url = 'https://map.yahooapis.jp/search/transit/V1/route'
    + '?appid=' + encodeURIComponent(appId)
    + '&from=' + encodeURIComponent(from)
    + '&to=' + encodeURIComponent(to)
    + '&output=json';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) {
    return { ok: false, error: '運賃API HTTP ' + code, manual: true };
  }
  var data = JSON.parse(text);
  // Best-effort parse of Yahoo transit JSON
  var fare = null;
  try {
    var feat = data.Feature || data.ResultInfo && data.Feature;
    if (data.Result && data.Result[0]) {
      var r0 = data.Result[0];
      if (r0.Fare != null) fare = Number(r0.Fare);
      if (fare == null && r0.Course && r0.Course[0] && r0.Course[0].Fare != null) fare = Number(r0.Course[0].Fare);
    }
    if (fare == null && data.Feature && data.Feature[0]) {
      var f0 = data.Feature[0];
      var det = f0.Property || {};
      if (det.Fare != null) fare = Number(det.Fare);
    }
  } catch (ignore) {}
  if (fare == null || isNaN(fare)) {
    return { ok: false, error: '運賃を解析できませんでした。手入力してください', manual: true, raw_keys: Object.keys(data || {}) };
  }
  return { ok: true, fare: fare, from: from, to: to };
}

function txRefresh_(ghPat) {
  var res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + TX_SYNC_REPO + '/dispatches',
    {
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + ghPat,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'flh-transport-expense-gas'
      },
      payload: JSON.stringify({ event_type: 'refresh-transport', client_payload: {} }),
      muteHttpExceptions: true
    }
  );
  return { ok: res.getResponseCode() === 204, status: res.getResponseCode() };
}
