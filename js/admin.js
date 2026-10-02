// ============================================================
// 管理者画面 — 承認 / グリッド / カレンダー / リクエスト / マスタ
// ============================================================

var Admin = (function () {
  var esc = function (s) { return App.esc(s); };
  var current = { pk: null, tab: 'approve', data: null };
  // Notionから取得した時給 { loaded, configured, map: {正規化名: 時給|null}, fetchedAt, error }
  var wageState = { loaded: false, configured: true, map: {}, fetchedAt: '', error: false };

  async function render(params) {
    // #/admin/:tab?/:pk?
    current.tab = (params && params[0]) || current.tab || 'approve';
    // デフォルトは提出受付中の期間（これから開始する期間）。カレンダー上の現在期間ではない点に注意
    current.pk = (params && params[1] && decodeURIComponent(params[1])) || current.pk || App.collectingPeriodKey();

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
    await ensureWages();
    draw();
  }

  async function ensureWages(force) {
    if (wageState.loaded && !force) return;
    try {
      var res = await Api.call('adminGetWages', force ? { refresh: true } : {});
      wageState = {
        loaded: true,
        configured: res.configured !== false,
        map: res.wages || {},
        fetchedAt: res.fetchedAt || '',
        error: false
      };
    } catch (e) {
      wageState.loaded = true;
      wageState.error = true;
    }
  }

  async function refreshWages() {
    App.showLoading('Notionから時給を取得中...');
    wageState.loaded = false;
    await ensureWages(true);
    App.toast(wageState.error ? '時給を取得できませんでした' : '時給を更新しました', wageState.error ? 'error' : 'success');
    if (current.tab === 'master') drawMaster(); else draw();
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
      { id: 'report', label: 'レポート' },
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
      case 'report': body = reportView(); break;
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
    // レポートタブに戻ってきたとき、エラー状態なら再読込させる
    if (tab === 'report') {
      if (reportState.monthly && reportState.monthly.error) reportState.monthly = null;
      if (reportState.trends && reportState.trends.error) reportState.trends = null;
    }
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
      var hrs = hoursOf(st.email);
      var wage = wageOf(st.name);
      var hoursLine = hrs > 0
        ? '<div class="approve-hours">🕐 実働 合計 <b>' + fmtH(hrs) + '</b>' +
          (wage == null
            ? ' <span class="chip chip-gray">時給未設定</span>'
            : ' <span class="chip chip-blue">予測 ' + fmtYen(hrs * wage) + '</span> <span class="muted">（' + fmtYen(wage) + '/h）</span>') +
          '</div>'
        : '';
      return '<div class="card approve-card status-border-' + status + '">' +
        '<div class="approve-card-top">' +
        '  <b>' + esc(st.name) + '</b>' +
        App.statusChip(status) +
        (late ? '<span class="chip chip-orange">締切超過</span>' : '') +
        '</div>' +
        '<div class="muted">' + (shiftCount[st.email] || 0) + '件の希望' +
        (sub && sub.submittedAt ? ' ・ 提出 ' + esc(sub.submittedAt).slice(5, 16) : '') + '</div>' +
        hoursLine +
        workloadWarnHtml(st.email) +
        (sub && sub.comment ? '<div class="comment-box">💬 ' + esc(sub.comment) + '</div>' : '') +
        '<div class="approve-buttons">' + buttons + '</div>' +
        '</div>';
    }).join('');

    var submittedCount = current.data.submissions.filter(function (s) { return s.status === 'submitted'; }).length;
    var bulkBar = submittedCount > 0
      ? '<button class="btn btn-primary btn-block" onclick="Admin.bulkApprove()">✓ 承認待ち' + submittedCount + '名をまとめて承認</button>'
      : '';
    return summaryHtml() + '<p class="muted">承認待ち: ' + submittedCount + '名</p>' + bulkBar + cards +
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

  // ---------- 勤務負荷の警告 ----------

  var WARN_CONSECUTIVE_DAYS = 6; // この日数以上の連続勤務で警告
  var WARN_DAY_HOURS = 8;        // 1日の実働がこの時間を超えたら警告

  /** スタッフの勤務負荷: { consecutive: 期間内の最大連続勤務日数, longDays: 長時間勤務の日数 } */
  function workloadOf(email) {
    var hoursByDate = {};
    current.data.shifts.forEach(function (s) {
      if (s.staffEmail !== email) return;
      hoursByDate[s.date] = (hoursByDate[s.date] || 0) + shiftHours(s);
    });
    var maxConsec = 0, run = 0, longDays = 0;
    App.periodDates(current.pk).forEach(function (d) {
      var h = hoursByDate[d] || 0;
      if (h > 0) { run++; if (run > maxConsec) maxConsec = run; } else { run = 0; }
      if (h > WARN_DAY_HOURS) longDays++;
    });
    return { consecutive: maxConsec, longDays: longDays };
  }

  /** 勤務負荷の警告チップ（閾値未満なら空文字） */
  function workloadWarnHtml(email) {
    var w = workloadOf(email);
    var chips = [];
    if (w.consecutive >= WARN_CONSECUTIVE_DAYS) {
      chips.push('<span class="chip chip-orange">⚠ 連続' + w.consecutive + '日勤務</span>');
    }
    if (w.longDays > 0) {
      chips.push('<span class="chip chip-orange">⚠ ' + WARN_DAY_HOURS + 'h超 ' + w.longDays + '日</span>');
    }
    return chips.length > 0 ? '<div class="workload-warn">' + chips.join(' ') + '</div>' : '';
  }

  // ---------- 実働時間・時給 ----------

  function parseTime(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  /** 1枠の実働時間（時間単位）。終了<=開始は日跨ぎとみなす */
  function shiftHours(s) {
    var st = parseTime(s.startTime), en = parseTime(s.endTime);
    if (st == null || en == null) return 0;
    if (en <= st) en += 24 * 60;
    return (en - st) / 60;
  }

  /** その期間のスタッフの合計実働時間 */
  function hoursOf(email) {
    var sum = 0;
    current.data.shifts.forEach(function (s) {
      if (s.staffEmail === email) sum += shiftHours(s);
    });
    return sum;
  }

  function nameKey(s) { return String(s || '').replace(/[\s　]/g, ''); }

  /** Notion時給。見つからない/未設定は null */
  function wageOf(name) {
    var w = wageState.map[nameKey(name)];
    return (typeof w === 'number') ? w : null;
  }

  function fmtH(h) {
    var r = Math.round(h * 10) / 10;
    return (r % 1 === 0 ? String(r) : r.toFixed(1)) + 'h';
  }

  function fmtYen(n) {
    return '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 期間サマリー（合計時間・予測人件費）のカード */
  function summaryHtml() {
    var totalHours = 0, totalCost = 0, noWage = 0;
    current.data.staff.forEach(function (st) {
      var h = hoursOf(st.email);
      totalHours += h;
      var w = wageOf(st.name);
      if (w == null) { if (h > 0) noWage++; } else { totalCost += h * w; }
    });
    var warn = '';
    if (!wageState.configured) {
      warn = '<br><span class="muted">⚠️ Notion未連携のため時給を表示できません（GASのスクリプトプロパティに NOTION_TOKEN を設定してください）</span>';
    } else if (wageState.error) {
      warn = '<br><span class="muted">⚠️ Notionから時給を取得できませんでした。時間のみ表示しています。</span>';
    } else if (noWage > 0) {
      warn = '<br><span class="muted">※ 時給未設定 ' + noWage + '名は人件費に含まれていません（Notionの「名前」とシフトのスタッフ名を一致させてください）</span>';
    }

    // 日毎の内訳（全員分の合計時間・予測人件費）
    var dayRows = App.periodDates(current.pk).map(function (d) {
      var h = 0, c = 0;
      current.data.shifts.forEach(function (s) {
        if (s.date !== d) return;
        var sh = shiftHours(s);
        h += sh;
        var w = wageOf(nameOf(s.staffEmail));
        if (w != null) c += sh * w;
      });
      return '<tr>' +
        '<td>' + esc(App.dateLabel(d)) + '</td>' +
        '<td class="num">' + (h > 0 ? fmtH(h) : '—') + '</td>' +
        '<td class="num">' + (c > 0 ? fmtYen(c) : '—') + '</td>' +
        '</tr>';
    }).join('');
    var detail =
      '<details class="summary-detail"><summary>📅 日毎の内訳（全員分）</summary>' +
      '<table class="summary-table"><thead><tr><th>日付</th><th>合計時間</th><th>予測人件費</th></tr></thead>' +
      '<tbody>' + dayRows +
      '<tr class="summary-total-row"><td>期間合計</td><td class="num">' + fmtH(totalHours) + '</td><td class="num">' + fmtYen(totalCost) + '</td></tr>' +
      '</tbody></table></details>';

    return '<div class="card summary-card">' +
      '📊 ' + esc(App.periodLabelShort(current.pk)) + ' の希望: 合計 <b>' + fmtH(totalHours) + '</b> ・ 予測人件費 <b class="summary-cost">' + fmtYen(totalCost) + '</b>' +
      ' <button class="btn-mini" onclick="Admin.refreshWages()" title="Notionから時給を再取得">🔄 時給</button>' +
      warn +
      detail +
      (wageState.configured && wageState.fetchedAt ? '<div class="muted summary-fetched">時給: Notionから ' + esc(wageState.fetchedAt) + ' 取得</div>' : '') +
      '</div>';
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
      var hrs = hoursOf(st.email);
      var wage = wageOf(st.name);
      var totalLine = hrs > 0
        ? '<br><span class="grid-total">' + fmtH(hrs) + (wage == null ? '' : ' ' + fmtYen(hrs * wage)) + '</span>'
        : '';
      return '<tr><th class="grid-name">' + esc(st.name) + '<br>' + App.statusChip(status) + totalLine + workloadWarnHtml(st.email) + '</th>' + tds + '</tr>';
    }).join('');

    // 日毎人数集計
    var countCols = dates.map(function (d) {
      var emails = {};
      current.data.shifts.forEach(function (s) { if (s.date === d) emails[s.staffEmail] = true; });
      var n = Object.keys(emails).length;
      return '<td class="grid-count' + (n === 0 ? ' zero' : '') + '">' + n + '</td>';
    }).join('');

    // 日毎の合計実働時間
    var hourCols = dates.map(function (d) {
      var sum = 0;
      current.data.shifts.forEach(function (s) { if (s.date === d) sum += shiftHours(s); });
      return '<td class="grid-count' + (sum === 0 ? ' zero' : '') + '">' + (sum > 0 ? fmtH(sum) : '0') + '</td>';
    }).join('');

    // 日毎の予測人件費（時給未設定のスタッフは除く）
    var costCols = dates.map(function (d) {
      var sum = 0;
      current.data.shifts.forEach(function (s) {
        if (s.date !== d) return;
        var w = wageOf(nameOf(s.staffEmail));
        if (w != null) sum += shiftHours(s) * w;
      });
      return '<td class="grid-count' + (sum === 0 ? ' zero' : '') + '">' + (sum > 0 ? fmtYen(sum) : '-') + '</td>';
    }).join('');

    return summaryHtml() +
      '<div class="grid-wrap"><table class="grid-table">' +
      '<thead><tr><th class="grid-name">スタッフ</th>' + headCols + '</tr></thead>' +
      '<tbody>' + bodyRows +
      '<tr class="grid-count-row"><th class="grid-name">👥 人数</th>' + countCols + '</tr>' +
      '<tr class="grid-count-row"><th class="grid-name">🕐 時間</th>' + hourCols + '</tr>' +
      '<tr class="grid-count-row"><th class="grid-name">💴 予測</th>' + costCols + '</tr>' +
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

  // ---------- レポートタブ ----------

  var reportState = { month: null, monthly: null, trends: null, loading: false };

  function setReportMonth(month) {
    reportState.month = month;
    reportState.monthly = null;
    draw();
  }

  async function ensureReportData() {
    if (reportState.loading) return;
    var month = reportState.month || current.pk.slice(0, 7);
    var needMonthly = !reportState.monthly || reportState.monthly.month !== month;
    var needTrends = !reportState.trends;
    if (!needMonthly && !needTrends) return;
    reportState.loading = true;
    try {
      if (needMonthly) {
        var res = await Api.call('adminGetMonthly', { month: month });
        reportState.monthly = { month: month, data: res };
      }
      if (needTrends) {
        reportState.trends = await Api.call('adminGetTrends', {});
      }
    } catch (e) {
      App.toast(e.message, 'error');
      // 自動再試行ループを防ぐためエラー状態を保持（再読込はタブ切替で）
      if (needMonthly) reportState.monthly = { month: month, data: null, error: true };
      if (needTrends) reportState.trends = { error: true };
    }
    reportState.loading = false;
    if (current.tab === 'report') draw();
  }

  function reportView() {
    ensureReportData();
    return monthlyReportHtml() + trendsReportHtml() + diffReportHtml();
  }

  /** 月次集計: 前後半を合算したスタッフ別の時間・予測人件費 */
  function monthlyReportHtml() {
    var month = reportState.month || current.pk.slice(0, 7);
    var base = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
    var opts = [];
    for (var i = -3; i <= 1; i++) {
      var d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      var mv = d.getFullYear() + '-' + App.pad2(d.getMonth() + 1);
      opts.push('<option value="' + mv + '"' + (mv === month ? ' selected' : '') + '>' +
        d.getFullYear() + '年' + (d.getMonth() + 1) + '月</option>');
    }
    var body;
    if (!reportState.monthly) {
      body = '<p class="muted">読み込み中...</p>';
    } else if (reportState.monthly.error || !reportState.monthly.data) {
      body = '<p class="muted">読み込みに失敗しました。タブを切り替えると再試行します。</p>';
    } else {
      var data = reportState.monthly.data;
      var pkA = data.periods[0], pkB = data.periods[1];
      var sumA = 0, sumB = 0, sumCost = 0;
      var rows = data.staff.map(function (st) {
        var hA = 0, hB = 0;
        data.shifts.forEach(function (s) {
          if (s.staffEmail !== st.email) return;
          if (s.periodKey === pkA) hA += shiftHours(s);
          else if (s.periodKey === pkB) hB += shiftHours(s);
        });
        var total = hA + hB;
        var wage = wageOf(st.name);
        var cost = wage == null ? null : total * wage;
        sumA += hA; sumB += hB;
        if (cost != null) sumCost += cost;
        return '<tr>' +
          '<td>' + esc(st.name) + '</td>' +
          '<td class="num">' + (hA > 0 ? fmtH(hA) : '—') + '</td>' +
          '<td class="num">' + (hB > 0 ? fmtH(hB) : '—') + '</td>' +
          '<td class="num"><b>' + (total > 0 ? fmtH(total) : '—') + '</b></td>' +
          '<td class="num">' + (cost != null && total > 0 ? fmtYen(cost) : '—') + '</td>' +
          '</tr>';
      }).join('');
      body = '<table class="summary-table report-table"><thead><tr>' +
        '<th>スタッフ</th><th>前半</th><th>後半</th><th>月合計</th><th>予測人件費</th>' +
        '</tr></thead><tbody>' + rows +
        '<tr class="summary-total-row"><td>合計</td><td class="num">' + fmtH(sumA) + '</td><td class="num">' + fmtH(sumB) + '</td>' +
        '<td class="num">' + fmtH(sumA + sumB) + '</td><td class="num">' + fmtYen(sumCost) + '</td></tr>' +
        '</tbody></table>' +
        '<p class="muted">※ 全ステータスの希望を集計（時給未設定のスタッフは人件費に含まれません）</p>';
    }
    return '<div class="card"><h3>📊 月次集計</h3>' +
      '<select class="report-month-select" onchange="Admin.setReportMonth(this.value)">' + opts.join('') + '</select>' +
      body + '</div>';
  }

  /** 提出率・勤務傾向: 直近6期間の提出率バーと期間ごとの時間バー */
  function trendsReportHtml() {
    var inner;
    if (!reportState.trends) {
      inner = '<p class="muted">読み込み中...</p>';
    } else if (reportState.trends.error) {
      inner = '<p class="muted">読み込みに失敗しました。タブを切り替えると再試行します。</p>';
    } else {
      var t = reportState.trends;
      var rows = t.staff.map(function (st) {
        var submitted = 0;
        var hoursByPeriod = t.periods.map(function () { return 0; });
        t.submissions.forEach(function (s) {
          if (s.staffEmail === st.email && (s.status === 'submitted' || s.status === 'approved')) submitted++;
        });
        t.shifts.forEach(function (s) {
          if (s.staffEmail !== st.email) return;
          var idx = t.periods.indexOf(s.periodKey);
          if (idx >= 0) hoursByPeriod[idx] += shiftHours(s);
        });
        var rate = Math.round(submitted / t.periods.length * 100);
        var maxH = Math.max.apply(null, hoursByPeriod.concat([1]));
        var bars = hoursByPeriod.map(function (h, i) {
          var px = Math.max(2, Math.round(h / maxH * 28));
          return '<span class="trend-bar" style="height:' + px + 'px" title="' + esc(t.periods[i]) + ': ' + fmtH(h) + '"></span>';
        }).join('');
        return '<tr>' +
          '<td>' + esc(st.name) + '</td>' +
          '<td class="report-rate"><div class="rate-bar-wrap"><div class="rate-bar" style="width:' + rate + '%"></div></div>' +
          '<span class="muted"> ' + rate + '%（' + submitted + '/' + t.periods.length + '）</span></td>' +
          '<td><span class="trend-bars">' + bars + '</span></td>' +
          '</tr>';
      }).join('');
      inner = '<table class="summary-table report-table"><thead><tr>' +
        '<th>スタッフ</th><th>提出率</th><th>期間ごとの実働（古→新）</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    }
    return '<div class="card"><h3>📈 提出率・勤務傾向（直近6期間）</h3>' + inner + '</div>';
  }

  /** 修正差分: 提出時点のスナップショットと現在のシフトを比較 */
  function diffReportHtml() {
    var snaps = current.data.snapshots || [];
    var inner;
    if (snaps.length === 0) {
      inner = '<p class="muted">この期間のスナップショットはまだありません（今後の提出から自動記録されます）。</p>';
    } else {
      var rows = [];
      snaps.forEach(function (sn) {
        var before;
        try { before = JSON.parse(sn.snapshotJson); } catch (e) { return; }
        var beforeByDate = {};
        (before || []).forEach(function (s) {
          if (!beforeByDate[s.date]) beforeByDate[s.date] = [];
          beforeByDate[s.date].push(s);
        });
        var afterByDate = {};
        current.data.shifts.forEach(function (s) {
          if (s.staffEmail !== sn.staffEmail) return;
          if (!afterByDate[s.date]) afterByDate[s.date] = [];
          afterByDate[s.date].push(s);
        });
        var dates = {};
        Object.keys(beforeByDate).forEach(function (d) { dates[d] = true; });
        Object.keys(afterByDate).forEach(function (d) { dates[d] = true; });
        var changes = Object.keys(dates).sort().map(function (d) {
          var b = normEntries(beforeByDate[d]);
          var a = normEntries(afterByDate[d]);
          if (b === a) return null;
          return '<tr><td>' + esc(App.dateLabel(d)) + '</td>' +
            '<td>' + esc(entriesLabel(beforeByDate[d])) + '</td>' +
            '<td>' + esc(entriesLabel(afterByDate[d])) + '</td></tr>';
        }).filter(Boolean);
        if (changes.length > 0) {
          rows.push('<tr class="report-diff-staff"><td colspan="3"><b>' + esc(nameOf(sn.staffEmail)) + '</b>（' + changes.length + '日変更）</td></tr>');
          rows = rows.concat(changes);
        }
      });
      inner = rows.length === 0
        ? '<p class="muted">提出時点からの変更はありません。</p>'
        : '<table class="summary-table report-table"><thead><tr><th>日付</th><th>提出時</th><th>現在</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }
    return '<div class="card"><h3>📝 修正差分（' + esc(App.periodLabelShort(current.pk)) + '）</h3>' + inner + '</div>';
  }

  function normEntries(list) {
    return (list || []).map(function (s) {
      return s.startTime + '-' + s.endTime + '-' + (s.locationId || '');
    }).sort().join('|');
  }

  function entriesLabel(list) {
    if (!list || list.length === 0) return '休';
    return list.map(function (s) { return s.startTime + '〜' + s.endTime; }).join('+');
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
    lines.push(['スタッフ', 'ステータス'].concat(dates.map(function (d) { return d.slice(5); }))
      .concat(['合計時間(h)', '時給', '予測人件費']).join(','));
    current.data.staff.forEach(function (st) {
      var sub = subByEmail[st.email];
      var status = sub ? (App.STATUS_INFO[sub.status] || {}).label || sub.status : '未入力';
      var hrs = Math.round(hoursOf(st.email) * 10) / 10;
      var wage = wageOf(st.name);
      var row = [st.name, status].concat(dates.map(function (d) {
        return '"' + ((cell[st.email + '|' + d] || []).join(' / ') || '休') + '"';
      })).concat([hrs, wage == null ? '' : wage, wage == null ? '' : Math.round(hrs * wage)]);
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
    await ensureWages();
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
      var w = wageOf(st.name);
      var wageChip = !wageState.loaded ? ''
        : '<span class="chip ' + (w == null ? 'chip-gray' : 'chip-green') + '" title="NotionのスタッフDBから取得">' +
          (w == null ? '時給未設定' : fmtYen(w) + '/h') + '</span>';
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
        wageChip +
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
      '<div class="card"><h3>📅 共有カレンダー</h3>' +
      '  <p class="muted">承認済みシフトが集約される「FLHシフト（全体）」カレンダーを、有効なスタッフ全員のGoogleカレンダーで見られるようにします（閲覧のみ）。新たに共有されたスタッフにはメールでお知らせします。<br>※ スタッフ保存時にも自動で共有されます。</p>' +
      '  <button class="btn btn-primary btn-block" onclick="Admin.shareCalendar()">全スタッフに共有する</button>' +
      '</div>' +
      '<div class="card"><h3>📣 締切リマインド（Slack）</h3>' +
      '  <p class="muted">締切3日前と締切当日の朝10時に、未提出者の一覧をSlackへ自動送信します。「テスト送信」で今すぐSlackに届くか確認できます。</p>' +
      '  <button class="btn btn-outline btn-block" onclick="Admin.testReminder()">Slackにテスト送信する</button>' +
      '  <div id="reminder-status"></div>' +
      '</div>' +
      '</div>' +
      App.tabbar('admin')
    );
  }

  async function testReminder() {
    App.showLoading('Slackにテスト送信中...');
    var r = null, err = null;
    try {
      r = await Api.call('adminTestReminder');
    } catch (e) {
      err = e;
    }
    drawMaster();
    var el = document.getElementById('reminder-status');
    if (err) {
      App.toast(err.message, 'error');
      return;
    }
    var html = r.slackSet
      ? '<p class="muted">✅ テスト送信しました。Slackを確認してください。</p>'
      : '<p class="muted">⚠️ SLACK_WEBHOOK_URL が未設定です（GASのスクリプトプロパティに設定してください）</p>';
    html += '<p class="muted">自動送信トリガー: ' +
      (r.triggers.indexOf('dailyReminder') >= 0
        ? '✅ 登録済み（毎朝10時）'
        : '⚠️ 未登録 — GASエディタで関数 setupTriggers を実行してください') +
      (r.lastReminderAt ? '<br>最後の自動送信チェック: ' + esc(r.lastReminderAt) : '') +
      '</p>';
    if (el) el.innerHTML = html;
    App.toast(r.sent ? 'Slackにテスト送信しました' : 'Slackが未設定です', r.sent ? 'success' : 'error');
  }

  async function shareCalendar() {
    App.showLoading('共有カレンダーを共有中...');
    try {
      var r = await Api.call('adminSyncCalendarShare');
      var msg = '新たに共有: ' + r.shared.length + '名';
      if (r.already.length) msg += ' / 共有済み: ' + r.already.length + '名';
      if (r.failed.length) msg += ' / 失敗: ' + r.failed.length + '名（' + r.failed.join('、') + '）';
      App.toast(msg, r.failed.length ? 'error' : 'success');
    } catch (e) {
      App.toast(e.message, 'error');
    }
    drawMaster();
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
    refreshWages: refreshWages,
    setReportMonth: setReportMonth,
    shareCalendar: shareCalendar,
    testReminder: testReminder,
    mLoc: mLoc, mLocAdd: mLocAdd, mLocDel: mLocDel,
    mPat: mPat, mPatAdd: mPatAdd, mPatDel: mPatDel,
    mStaff: mStaff, mStaffAdd: mStaffAdd, mStaffLoc: mStaffLoc,
    saveMaster: saveMaster, saveStaff: saveStaff
  };
})();
