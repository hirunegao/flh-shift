// ============================================================
// 管理者画面 — 承認 / グリッド / カレンダー / リクエスト / マスタ
// ============================================================

var Admin = (function () {
  var esc = function (s) { return App.esc(s); };
  var current = { pk: null, tab: 'approve', data: null };

  async function render(params) {
    // #/admin/:tab?/:pk?
    current.tab = (params && params[0]) || current.tab || 'approve';
    current.pk = (params && params[1] && decodeURIComponent(params[1])) || current.pk || App.currentPeriodKey();

    if (current.tab === 'master') {
      renderMaster();
      return;
    }

    App.showLoading();
    try {
      current.data = await Api.call('adminGetPeriod', { periodKey: current.pk });
    } catch (e) {
      App.toast(e.message, 'error');
      current.data = { submissions: [], shifts: [], staff: [], changeRequests: [] };
    }
    draw();
  }

  function nav(tab, pk) {
    location.hash = '#/admin/' + (tab || current.tab) + '/' + (pk || current.pk);
  }

  function draw() {
    var pendingCR = current.data.changeRequests.length;
    var tabs = [
      { id: 'approve', label: '承認' },
      { id: 'grid', label: 'グリッド' },
      { id: 'calendar', label: 'カレンダー' },
      { id: 'requests', label: 'リクエスト' + (pendingCR ? ' <span class="badge">' + pendingCR + '</span>' : '') },
      { id: 'master', label: 'マスタ' }
    ];
    var tabHtml = '<div class="admin-tabs">' + tabs.map(function (t) {
      return '<button class="admin-tab' + (current.tab === t.id ? ' active' : '') + '" onclick="Admin.switchTab(\'' + t.id + '\')">' + t.label + '</button>';
    }).join('') + '</div>';

    var body;
    switch (current.tab) {
      case 'grid': body = gridView(); break;
      case 'calendar': body = calendarView(); break;
      case 'requests': body = requestsView(); break;
      default: body = approveView();
    }

    App.setView(
      App.header('管理') +
      '<div class="page admin-page">' +
      Staff.periodNav(current.pk, '#/admin/' + current.tab + '/') +
      tabHtml +
      body +
      '</div>' +
      App.tabbar('admin')
    );
  }

  function switchTab(tab) {
    current.tab = tab;
    nav(tab);
  }

  // ---------- 承認タブ ----------

  function approveView() {
    var subByEmail = {};
    current.data.submissions.forEach(function (s) { subByEmail[s.staffEmail] = s; });
    var shiftCount = {};
    current.data.shifts.forEach(function (s) {
      shiftCount[s.staffEmail] = (shiftCount[s.staffEmail] || 0) + 1;
    });

    var order = { submitted: 0, rejected: 1, draft: 2, approved: 3, none: 4 };
    var staffSorted = current.data.staff.slice().sort(function (a, b) {
      var sa = subByEmail[a.email] ? subByEmail[a.email].status : 'none';
      var sb = subByEmail[b.email] ? subByEmail[b.email].status : 'none';
      return (order[sa] || 9) - (order[sb] || 9);
    });

    var cards = staffSorted.map(function (st) {
      var sub = subByEmail[st.email];
      var status = sub ? sub.status : 'none';
      var late = sub && String(sub.late) === 'true';
      var buttons = '';
      if (status === 'submitted') {
        buttons =
          '<button class="btn btn-primary" onclick="Admin.approve(\'' + st.email + '\')">✓ 承認</button>' +
          '<button class="btn btn-outline" onclick="Admin.reject(\'' + st.email + '\')">差し戻し</button>' +
          '<button class="btn btn-outline" onclick="Admin.edit(\'' + st.email + '\')">修正</button>';
      } else if (status === 'approved') {
        buttons =
          '<button class="btn btn-outline" onclick="Admin.reject(\'' + st.email + '\')">承認取消（差し戻し）</button>' +
          '<button class="btn btn-outline" onclick="Admin.edit(\'' + st.email + '\')">修正</button>';
      } else {
        buttons = '<button class="btn btn-outline" onclick="Admin.edit(\'' + st.email + '\')">代理入力</button>';
      }
      return '<div class="card approve-card status-border-' + status + '">' +
        '<div class="approve-card-top">' +
        '  <b>' + esc(st.name) + '</b>' +
        App.statusChip(status) +
        (late ? '<span class="chip chip-orange">締切超過</span>' : '') +
        '</div>' +
        '<div class="muted">' + (shiftCount[st.email] || 0) + '件の希望' +
        (sub && sub.submittedAt ? ' ・ 提出 ' + esc(sub.submittedAt).slice(5, 16) : '') + '</div>' +
        (sub && sub.comment ? '<div class="comment-box">💬 ' + esc(sub.comment) + '</div>' : '') +
        '<div class="approve-buttons">' + buttons + '</div>' +
        '</div>';
    }).join('');

    var submittedCount = current.data.submissions.filter(function (s) { return s.status === 'submitted'; }).length;
    var bulkBar = submittedCount > 0
      ? '<button class="btn btn-primary btn-block" onclick="Admin.bulkApprove()">✓ 承認待ち' + submittedCount + '名をまとめて承認</button>'
      : '';
    return '<p class="muted">承認待ち: ' + submittedCount + '名</p>' + bulkBar + cards +
      '<button class="btn btn-outline btn-block" onclick="Admin.exportCsv()">📄 CSVダウンロード</button>';
  }

  async function approve(email) {
    var yes = await App.confirmModal('承認', '<p>' + esc(nameOf(email)) + ' さんのシフトを承認しますか？<br><span class="muted">本人のカレンダーが確定表記になり、共有カレンダーにも登録されます。</span></p>', '承認する');
    if (!yes) return;
    App.showLoading('承認中...（カレンダー更新）');
    try {
      var result = await Api.call('adminApprove', { staffEmail: email, periodKey: current.pk });
      App.toast('承認しました', 'success');
      if (result && result.personal && result.personal.skipped) {
        App.toast('カレンダー同期に注意: ' + result.personal.skipped, 'info');
      }
    } catch (e) {
      App.toast(e.message, 'error');
    }
    render([current.tab, current.pk]);
  }

  async function bulkApprove() {
    var emails = current.data.submissions
      .filter(function (s) { return s.status === 'submitted'; })
      .map(function (s) { return s.staffEmail; });
    if (emails.length === 0) {
      App.toast('承認待ちのスタッフがいません', 'info');
      return;
    }
    var names = emails.map(nameOf).join('、');
    var yes = await App.confirmModal(
      '一括承認',
      '<p>承認待ち <b>' + emails.length + '名</b> をまとめて承認しますか？</p>' +
      '<p class="muted">' + esc(names) + '</p>' +
      '<p class="muted">各人のカレンダー更新を順に行うため、人数が多いと時間がかかります。</p>',
      emails.length + '名を承認する'
    );
    if (!yes) return;
    App.showLoading('一括承認中...（' + emails.length + '名・カレンダー更新）');
    try {
      var result = await Api.call('adminBulkApprove', { periodKey: current.pk, staffEmails: emails });
      var fail = (result.results || []).filter(function (r) { return !r.ok; });
      if (fail.length === 0) {
        App.toast(result.approved + '名を承認しました', 'success');
      } else {
        App.toast(result.approved + '名承認 / ' + fail.length + '名失敗', 'error');
      }
    } catch (e) {
      App.toast(e.message, 'error');
    }
    render([current.tab, current.pk]);
  }

  var REJECT_PRESETS = [
    '人数不足のため調整をお願いします',
    '希望時間が他のスタッフと重なっています',
    '別日での出勤をお願いします',
    '提出内容を確認のうえ再提出してください'
  ];

  async function reject(email) {
    var chips = REJECT_PRESETS.map(function (t, i) {
      return '<button type="button" class="reason-chip" onclick="document.getElementById(\'modal-input\').value=' +
        JSON.stringify(t) + '">' + esc(t) + '</button>';
    }).join('');
    var reason = await App.promptModal(
      '差し戻し',
      '<p>' + esc(nameOf(email)) + ' さんに差し戻します。理由を入力してください。</p>' +
      '<div class="reason-chips">' + chips + '</div>',
      '例: 20日の人数が足りないため調整をお願いします',
      '差し戻す'
    );
    if (!reason) return;
    App.showLoading('差し戻し中...');
    try {
      await Api.call('adminReject', { staffEmail: email, periodKey: current.pk, reason: reason });
      App.toast('差し戻しました', 'success');
    } catch (e) {
      App.toast(e.message, 'error');
    }
    render([current.tab, current.pk]);
  }

  function edit(email) {
    var shifts = current.data.shifts.filter(function (s) { return s.staffEmail === email; });
    var sub = current.data.submissions.filter(function (s) { return s.staffEmail === email; })[0];
    Staff.renderAdminEdit(email, nameOf(email), current.pk, shifts, sub || null);
  }

  function nameOf(email) {
    var st = current.data.staff.filter(function (s) { return s.email === email; })[0];
    return st ? st.name : email;
  }

  // ---------- グリッドタブ ----------

  function gridView() {
    var dates = App.periodDates(current.pk);
    var subByEmail = {};
    current.data.submissions.forEach(function (s) { subByEmail[s.staffEmail] = s; });
    var cell = {}; // email -> date -> [shifts]
    current.data.shifts.forEach(function (s) {
      if (!cell[s.staffEmail]) cell[s.staffEmail] = {};
      if (!cell[s.staffEmail][s.date]) cell[s.staffEmail][s.date] = [];
      cell[s.staffEmail][s.date].push(s);
    });

    var headCols = dates.map(function (d) {
      var day = new Date(d + 'T00:00:00');
      return '<th class="' + App.weekdayClass(d) + '">' + (day.getMonth() + 1) + '/' + day.getDate() +
        '<br><small>' + ['日', '月', '火', '水', '木', '金', '土'][day.getDay()] + '</small></th>';
    }).join('');

    var bodyRows = current.data.staff.map(function (st) {
      var sub = subByEmail[st.email];
      var status = sub ? sub.status : 'none';
      var tds = dates.map(function (d) {
        var list = (cell[st.email] && cell[st.email][d]) || [];
        var content = list.map(function (s) {
          return '<div class="grid-shift">' + esc(s.startTime) + '<br>' + esc(s.endTime) + '</div>';
        }).join('');
        return '<td class="' + App.weekdayClass(d) + '">' + (content || '<span class="grid-off">·</span>') + '</td>';
      }).join('');
      return '<tr><th class="grid-name">' + esc(st.name) + '<br>' + App.statusChip(status) + '</th>' + tds + '</tr>';
    }).join('');

    // 日毎人数集計
    var countCols = dates.map(function (d) {
      var emails = {};
      current.data.shifts.forEach(function (s) { if (s.date === d) emails[s.staffEmail] = true; });
      var n = Object.keys(emails).length;
      return '<td class="grid-count' + (n === 0 ? ' zero' : '') + '">' + n + '</td>';
    }).join('');

    return '<div class="grid-wrap"><table class="grid-table">' +
      '<thead><tr><th class="grid-name">スタッフ</th>' + headCols + '</tr></thead>' +
      '<tbody>' + bodyRows +
      '<tr class="grid-count-row"><th class="grid-name">👥 人数</th>' + countCols + '</tr>' +
      '</tbody></table></div>' +
      '<p class="muted center">全ステータスの希望を表示しています（横スクロールできます）</p>' +
      '<button class="btn btn-outline btn-block" onclick="Admin.exportCsv()">📄 CSVダウンロード</button>';
  }

  // ---------- カレンダータブ ----------

  function calendarView() {
    var p = App.parsePeriod(current.pk);
    var dates = App.periodDates(current.pk);
    var byDate = {};
    current.data.shifts.forEach(function (s) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    });
    var subByEmail = {};
    current.data.submissions.forEach(function (s) { subByEmail[s.staffEmail] = s; });

    var firstDate = new Date(dates[0] + 'T00:00:00');
    var startPad = firstDate.getDay();
    var cells = [];
    for (var i = 0; i < startPad; i++) cells.push('<div class="cal-cell empty"></div>');
    dates.forEach(function (d) {
      var day = new Date(d + 'T00:00:00');
      var list = (byDate[d] || []).sort(function (a, b) { return a.startTime < b.startTime ? -1 : 1; });
      var items = list.map(function (s) {
        var sub = subByEmail[s.staffEmail];
        var approved = sub && sub.status === 'approved';
        return '<div class="cal-item' + (approved ? ' approved' : '') + '">' +
          esc(nameOf(s.staffEmail).slice(0, 5)) + ' ' + esc(s.startTime) + '</div>';
      }).join('');
      cells.push('<div class="cal-cell ' + App.weekdayClass(d) + '">' +
        '<div class="cal-date">' + day.getDate() + '</div>' + items + '</div>');
    });

    return '<div class="cal-legend"><span class="cal-item approved">承認済み</span><span class="cal-item">未承認</span></div>' +
      '<div class="cal-week">' + ['日', '月', '火', '水', '木', '金', '土'].map(function (w) { return '<div>' + w + '</div>'; }).join('') + '</div>' +
      '<div class="cal-grid">' + cells.join('') + '</div>';
  }

  // ---------- 変更リクエストタブ ----------

  function requestsView() {
    var reqs = current.data.changeRequests;
    if (reqs.length === 0) return '<p class="muted center" style="padding:40px 0">保留中の変更リクエストはありません</p>';
    return reqs.map(function (r) {
      return '<div class="card">' +
        '<div class="approve-card-top"><b>' + esc(nameOf(r.staffEmail)) + '</b>' +
        '<span class="chip chip-blue">' + esc(App.periodLabelShort(r.periodKey)) + '</span></div>' +
        '<div class="comment-box">💬 ' + esc(r.reason) + '</div>' +
        '<div class="muted">' + esc(r.createdAt).slice(0, 16) + '</div>' +
        '<div class="approve-buttons">' +
        '  <button class="btn btn-primary" onclick="Admin.resolveRequest(\'' + r.id + '\', true)">🔓 承認（ロック解除）</button>' +
        '  <button class="btn btn-outline" onclick="Admin.resolveRequest(\'' + r.id + '\', false)">却下</button>' +
        '</div>' +
        '</div>';
    }).join('');
  }

  async function resolveRequest(id, approve) {
    var yes = await App.confirmModal(
      approve ? 'ロック解除' : 'リクエスト却下',
      approve
        ? '<p>承認するとこのスタッフのシフトが再編集可能になります。<br><span class="muted">承認済みだった場合、共有カレンダーからも一旦削除されます。</span></p>'
        : '<p>この変更リクエストを却下しますか？</p>',
      approve ? '承認する' : '却下する'
    );
    if (!yes) return;
    App.showLoading('処理中...');
    try {
      await Api.call('adminResolveChangeRequest', { requestId: id, approve: approve });
      App.toast(approve ? 'ロックを解除しました' : '却下しました', 'success');
    } catch (e) {
      App.toast(e.message, 'error');
    }
    render([current.tab, current.pk]);
  }

  // ---------- CSVエクスポート ----------

  function exportCsv() {
    var dates = App.periodDates(current.pk);
    var subByEmail = {};
    current.data.submissions.forEach(function (s) { subByEmail[s.staffEmail] = s; });
    var cell = {};
    current.data.shifts.forEach(function (s) {
      var key = s.staffEmail + '|' + s.date;
      if (!cell[key]) cell[key] = [];
      cell[key].push(s.startTime + '-' + s.endTime);
    });

    var lines = [];
    lines.push(['スタッフ', 'ステータス'].concat(dates.map(function (d) { return d.slice(5); })).join(','));
    current.data.staff.forEach(function (st) {
      var sub = subByEmail[st.email];
      var status = sub ? (App.STATUS_INFO[sub.status] || {}).label || sub.status : '未入力';
      var row = [st.name, status].concat(dates.map(function (d) {
        return '"' + ((cell[st.email + '|' + d] || []).join(' / ') || '休') + '"';
      }));
      lines.push(row.join(','));
    });

    var bom = '\uFEFF';
    var blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shift_' + current.pk + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- マスタ管理タブ ----------

  var masterData = null; // { locations, patterns, staff }

  async function renderMaster() {
    App.showLoading();
    try {
      var staffRows = await Api.call('adminGetStaff');
      masterData = {
        locations: App.state.masters.locations.map(function (r) { return Object.assign({}, r); }),
        patterns: App.state.masters.patterns.map(function (r) { return Object.assign({}, r); }),
        staff: staffRows.map(function (r) { return Object.assign({}, r); })
      };
    } catch (e) {
      App.toast(e.message, 'error');
      location.hash = '#/admin/approve';
      return;
    }
    drawMaster();
  }

  function drawMaster() {
    var locRows = masterData.locations.map(function (l, i) {
      return '<div class="master-row">' +
        '<input type="text" value="' + esc(l.name) + '" onchange="Admin.mLoc(' + i + ',\'name\',this.value)" placeholder="拠点名">' +
        '<button class="btn-mini danger" onclick="Admin.mLocDel(' + i + ')">削除</button>' +
        '</div>';
    }).join('');

    var locOptions = function (selected) {
      return '<option value="">全拠点共通</option>' + masterData.locations.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (selected === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>';
      }).join('');
    };

    var patRows = masterData.patterns.map(function (p, i) {
      return '<div class="master-row master-row-pattern">' +
        '<input type="text" value="' + esc(p.name) + '" onchange="Admin.mPat(' + i + ',\'name\',this.value)" placeholder="パターン名">' +
        '<input type="time" value="' + esc(p.startTime) + '" onchange="Admin.mPat(' + i + ',\'startTime\',this.value)">' +
        '<input type="time" value="' + esc(p.endTime) + '" onchange="Admin.mPat(' + i + ',\'endTime\',this.value)">' +
        '<select onchange="Admin.mPat(' + i + ',\'locationId\',this.value)">' + locOptions(p.locationId) + '</select>' +
        '<button class="btn-mini danger" onclick="Admin.mPatDel(' + i + ')">削除</button>' +
        '</div>';
    }).join('');

    var locChecks = function (st, idx) {
      var selected = String(st.locationIds || '').split(',').filter(Boolean);
      return masterData.locations.map(function (l) {
        var checked = selected.indexOf(l.id) >= 0 ? ' checked' : '';
        return '<label class="loc-check"><input type="checkbox"' + checked +
          ' onchange="Admin.mStaffLoc(' + idx + ',\'' + esc(l.id) + '\',this.checked)">' + esc(l.name) + '</label>';
      }).join('');
    };

    var staffRows = masterData.staff.map(function (st, i) {
      return '<div class="master-card' + (String(st.active) === 'false' ? ' inactive' : '') + '">' +
        '<div class="master-row">' +
        '  <input type="text" value="' + esc(st.name) + '" onchange="Admin.mStaff(' + i + ',\'name\',this.value)" placeholder="名前">' +
        '  <input type="email" value="' + esc(st.email) + '" onchange="Admin.mStaff(' + i + ',\'email\',this.value)" placeholder="Gmailアドレス">' +
        '</div>' +
        '<div class="master-row">' +
        '  <label class="loc-check"><input type="checkbox"' + (String(st.isAdmin) === 'true' ? ' checked' : '') +
        '    onchange="Admin.mStaff(' + i + ',\'isAdmin\',this.checked?\'true\':\'false\')">管理者</label>' +
        '  <label class="loc-check"><input type="checkbox"' + (String(st.active) !== 'false' ? ' checked' : '') +
        '    onchange="Admin.mStaff(' + i + ',\'active\',this.checked?\'true\':\'false\')">有効</label>' +
        locChecks(st, i) +
        '</div>' +
        '</div>';
    }).join('');

    App.setView(
      App.header('マスタ管理', '#/admin/approve') +
      '<div class="page admin-page">' +
      '<div class="card"><h3>🏢 拠点</h3>' + locRows +
      '  <button class="btn-mini" onclick="Admin.mLocAdd()">＋ 拠点を追加</button>' +
      '  <button class="btn btn-primary btn-block" onclick="Admin.saveMaster(\'Locations\')">拠点を保存</button>' +
      '</div>' +
      '<div class="card"><h3>⏰ シフトパターン</h3>' + patRows +
      '  <button class="btn-mini" onclick="Admin.mPatAdd()">＋ パターンを追加</button>' +
      '  <button class="btn btn-primary btn-block" onclick="Admin.saveMaster(\'Patterns\')">パターンを保存</button>' +
      '</div>' +
      '<div class="card"><h3>👤 スタッフ</h3>' + staffRows +
      '  <button class="btn-mini" onclick="Admin.mStaffAdd()">＋ スタッフを追加</button>' +
      '  <button class="btn btn-primary btn-block" onclick="Admin.saveStaff()">スタッフを保存</button>' +
      '</div>' +
      '</div>' +
      App.tabbar('admin')
    );
  }

  // マスタ編集ハンドラ
  function mLoc(i, k, v) { masterData.locations[i][k] = v; }
  function mLocAdd() { masterData.locations.push({ id: 'loc' + Date.now().toString(36), name: '', active: 'true' }); drawMaster(); }
  function mLocDel(i) { masterData.locations.splice(i, 1); drawMaster(); }
  function mPat(i, k, v) { masterData.patterns[i][k] = v; }
  function mPatAdd() { masterData.patterns.push({ id: 'pat' + Date.now().toString(36), name: '', startTime: '09:00', endTime: '18:00', locationId: '', active: 'true' }); drawMaster(); }
  function mPatDel(i) { masterData.patterns.splice(i, 1); drawMaster(); }
  function mStaff(i, k, v) { masterData.staff[i][k] = v; }
  function mStaffAdd() { masterData.staff.push({ email: '', name: '', isAdmin: 'false', locationIds: '', active: 'true' }); drawMaster(); }
  function mStaffLoc(i, locId, checked) {
    var cur = String(masterData.staff[i].locationIds || '').split(',').filter(Boolean);
    if (checked && cur.indexOf(locId) < 0) cur.push(locId);
    if (!checked) cur = cur.filter(function (x) { return x !== locId; });
    masterData.staff[i].locationIds = cur.join(',');
  }

  async function saveMaster(type) {
    var rows = type === 'Locations' ? masterData.locations : masterData.patterns;
    rows = rows.filter(function (r) { return r.name; });
    App.showLoading('保存中...');
    try {
      await Api.call('adminSaveMaster', { type: type, rows: rows });
      if (type === 'Locations') App.state.masters.locations = rows;
      else App.state.masters.patterns = rows;
      App.toast('保存しました', 'success');
    } catch (e) {
      App.toast(e.message, 'error');
    }
    drawMaster();
  }

  async function saveStaff() {
    var rows = masterData.staff.filter(function (r) { return r.email; });
    var admins = rows.filter(function (r) { return String(r.isAdmin) === 'true' && String(r.active) !== 'false'; });
    if (admins.length === 0) {
      App.toast('管理者が0人になる保存はできません', 'error');
      return;
    }
    App.showLoading('保存中...');
    try {
      await Api.call('adminSaveStaff', { rows: rows });
      App.toast('保存しました', 'success');
    } catch (e) {
      App.toast(e.message, 'error');
    }
    renderMaster();
  }

  return {
    render: render,
    switchTab: switchTab,
    approve: approve,
    bulkApprove: bulkApprove,
    reject: reject,
    edit: edit,
    resolveRequest: resolveRequest,
    exportCsv: exportCsv,
    mLoc: mLoc, mLocAdd: mLocAdd, mLocDel: mLocDel,
    mPat: mPat, mPatAdd: mPatAdd, mPatDel: mPatDel,
    mStaff: mStaff, mStaffAdd: mStaffAdd, mStaffLoc: mStaffLoc,
    saveMaster: saveMaster, saveStaff: saveStaff
  };
})();
