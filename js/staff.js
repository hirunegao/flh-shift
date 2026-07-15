// ============================================================
// スタッフ画面 — ホーム / シフト入力 / みんなのシフト
// ============================================================

var Staff = (function () {
  var esc = function (s) { return App.esc(s); };

  // ---------- ホーム ----------

  async function renderHome() {
    App.showLoading();
    var periods = App.selectablePeriods();
    var results;
    try {
      results = await Promise.all(periods.map(function (pk) {
        return Api.call('getMyPeriod', { periodKey: pk });
      }));
    } catch (e) {
      App.toast(e.message, 'error');
      results = periods.map(function () { return { submission: null, shifts: [] }; });
    }

    var cards = periods.map(function (pk, i) {
      var sub = results[i].submission;
      var status = sub ? sub.status : 'none';
      var deadline = App.deadlineFor(pk);
      var now = new Date();
      var overdue = now > deadline && (status === 'none' || status === 'draft' || status === 'rejected');
      var daysLeft = Math.ceil((deadline - now) / 86400000);
      var deadlineHtml = overdue
        ? '<span class="deadline over">締切超過（提出は可能です）</span>'
        : '<span class="deadline' + (daysLeft <= 3 ? ' soon' : '') + '">締切: ' + App.fmtDeadline(deadline) +
          (daysLeft >= 0 && daysLeft <= 7 ? '（あと' + daysLeft + '日）' : '') + '</span>';

      return '<a class="period-card status-' + status + '" href="#/input/' + pk + '">' +
        '<div class="period-card-top">' +
        '  <span class="period-name">' + esc(App.periodLabel(pk)) + '</span>' +
        App.statusChip(status) +
        '</div>' +
        '<div class="period-card-bottom">' +
        '  <span>' + results[i].shifts.length + '日分入力済み</span>' + deadlineHtml +
        '</div>' +
        (sub && sub.status === 'rejected' && sub.rejectReason
          ? '<div class="reject-reason">差し戻し理由: ' + esc(sub.rejectReason) + '</div>' : '') +
        '</a>';
    }).join('');

    App.setView(
      App.header('シフト希望') +
      '<div class="page">' +
      '  <p class="greeting">こんにちは、' + esc(App.state.profile.name) + ' さん</p>' +
      (!App.state.calendarConnected
        ? '<div class="notice-banner" onclick="App.connectCalendar()">📅 Googleカレンダー未連携です。タップして連携（シフトが自動でカレンダーに入ります）</div>'
        : '') +
      '  <h2 class="section-title">提出する期間を選択</h2>' +
      cards +
      '</div>' +
      App.tabbar('home')
    );
  }

  // ---------- シフト入力 ----------

  var editor = null; // { pk, entries, comment, selectedChip, locked, submission, saving }

  async function renderInput(pk) {
    App.showLoading();
    var data;
    try {
      data = await Api.call('getMyPeriod', { periodKey: pk });
    } catch (e) {
      App.toast(e.message, 'error');
      location.hash = '#/home';
      return;
    }

    var entries = {};
    data.shifts.forEach(function (s) {
      if (!entries[s.date]) entries[s.date] = [];
      entries[s.date].push({
        patternId: s.patternId, startTime: s.startTime, endTime: s.endTime, locationId: s.locationId
      });
    });

    editor = {
      pk: pk,
      entries: entries,
      comment: data.submission ? data.submission.comment : '',
      selectedChip: null,
      selectedDays: {},
      templates: null,
      locked: data.locked,
      submission: data.submission,
      saving: false,
      adminFor: null
    };
    drawEditor();
  }

  /** 管理者による直接修正モード（Admin画面から呼ばれる） */
  function renderAdminEdit(staffEmail, staffName, pk, shifts, submission) {
    var entries = {};
    shifts.forEach(function (s) {
      if (!entries[s.date]) entries[s.date] = [];
      entries[s.date].push({
        patternId: s.patternId, startTime: s.startTime, endTime: s.endTime, locationId: s.locationId
      });
    });
    editor = {
      pk: pk,
      entries: entries,
      comment: submission ? submission.comment : '',
      selectedChip: null,
      selectedDays: {},
      templates: null,
      locked: false,
      submission: submission,
      saving: false,
      adminFor: { email: staffEmail, name: staffName }
    };
    drawEditor();
  }

  async function adminSave(approve) {
    if (editor.saving) return;
    var label = approve ? '保存して承認しますか？' : '保存しますか？（状態は「提出済み」になります）';
    var yes = await App.confirmModal('管理者修正', '<p>' + esc(editor.adminFor.name) + ' さんのシフトを' + label + '</p>', approve ? '保存して承認' : '保存');
    if (!yes) return;
    editor.saving = true;
    App.showLoading('保存中...（カレンダーも更新しています）');
    try {
      await Api.call('adminSaveShifts', {
        staffEmail: editor.adminFor.email,
        periodKey: editor.pk,
        shifts: collectShifts(),
        approve: approve
      });
      App.toast('保存しました' + (approve ? '（承認済み）' : ''), 'success');
      location.hash = '#/admin';
    } catch (e) {
      App.toast(e.message, 'error');
      editor.saving = false;
      drawEditor();
    }
  }

  function myPatterns() {
    var myLocs = App.state.profile.locationIds;
    return App.state.masters.patterns.filter(function (p) {
      return !p.locationId || myLocs.length === 0 || myLocs.indexOf(p.locationId) >= 0;
    });
  }

  function defaultLocationId(pattern) {
    if (pattern && pattern.locationId) return pattern.locationId;
    return App.state.profile.locationIds[0] || (App.state.masters.locations[0] ? App.state.masters.locations[0].id : '');
  }

  function locationName(id) {
    var loc = App.state.masters.locations.filter(function (l) { return l.id === id; })[0];
    return loc ? loc.name : '';
  }

  function patternName(id) {
    var p = App.state.masters.patterns.filter(function (x) { return x.id === id; })[0];
    return p ? p.name : '';
  }

  function drawEditor() {
    var pk = editor.pk;
    var dates = App.periodDates(pk);
    var status = editor.submission ? editor.submission.status : 'none';
    var info = App.STATUS_INFO[status] || App.STATUS_INFO.none;
    var deadline = App.deadlineFor(pk);
    var overdue = new Date() > deadline;
    var patterns = myPatterns();
    var multiLoc = App.state.masters.locations.length > 1;

    var banner = '';
    if (info.banner) {
      banner = '<div class="status-banner banner-' + info.cls + '">' + esc(info.banner) +
        (status === 'rejected' && editor.submission.rejectReason
          ? '<br><b>理由: ' + esc(editor.submission.rejectReason) + '</b>' : '') +
        '</div>';
    }
    if (overdue && !editor.locked) {
      banner += '<div class="status-banner banner-orange">⚠️ 締切（' + App.fmtDeadline(deadline) + '）を過ぎています。提出は可能ですが、お早めに。</div>';
    }

    // 日付リスト
    var dayRows = dates.map(function (date) {
      var list = editor.entries[date] || [];
      var content;
      if (list.length === 0) {
        content = '<span class="day-off">休み</span>';
      } else {
        content = list.map(function (en) {
          return '<span class="entry-chip">' +
            (en.patternId ? esc(patternName(en.patternId)) + ' ' : '') +
            esc(en.startTime) + '〜' + esc(en.endTime) +
            (multiLoc && en.locationId ? '<small>@' + esc(locationName(en.locationId)) + '</small>' : '') +
            '</span>';
        }).join('');
      }
      return '<div class="day-row ' + App.weekdayClass(date) + '" data-date="' + date + '">' +
        (editor.locked ? '' :
          '<label class="day-check"><input type="checkbox"' + (editor.selectedDays[date] ? ' checked' : '') +
          ' onchange="Staff.toggleDay(\'' + date + '\', this.checked)"></label>') +
        '<div class="day-label" onclick="Staff.tapDay(\'' + date + '\')">' + App.dateLabel(date) + '</div>' +
        '<div class="day-content" onclick="Staff.tapDay(\'' + date + '\')">' + content + '</div>' +
        (editor.locked ? '' : '<button class="day-detail" onclick="Staff.openDaySheet(\'' + date + '\')">︙</button>') +
        '</div>';
    }).join('');

    // パターンチップ（スタンプ）＋一括操作
    var chipBar = '';
    if (!editor.locked) {
      var selCount = Object.keys(editor.selectedDays).length;
      chipBar = '<div class="chip-bar">' +
        '<div class="chip-bar-hint">パターンを選んで日付をタップ／チェックを付けて一括適用</div>' +
        '<div class="chip-bar-scroll">' +
        patterns.map(function (p) {
          return '<button class="pattern-chip' + (editor.selectedChip === p.id ? ' selected' : '') + '" ' +
            'onclick="Staff.selectChip(\'' + p.id + '\')">' + esc(p.name) + '<small>' + esc(p.startTime) + '〜' + esc(p.endTime) + '</small></button>';
        }).join('') +
        '<button class="pattern-chip chip-off' + (editor.selectedChip === 'off' ? ' selected' : '') + '" onclick="Staff.selectChip(\'off\')">休み<small>クリア</small></button>' +
        '</div>' +
        '<div class="quick-actions">' +
        '  <button class="btn-mini" onclick="Staff.selectDays(\'all\')">☑ 全選択</button>' +
        '  <button class="btn-mini" onclick="Staff.selectDays(\'weekday\')">☑ 平日</button>' +
        '  <button class="btn-mini" onclick="Staff.selectDays(\'weekend\')">☑ 土日</button>' +
        '  <button class="btn-mini" onclick="Staff.selectDays(\'none\')">解除</button>' +
        '  <button class="btn-mini" onclick="Staff.openTemplateSheet()">📋 テンプレート</button>' +
        '  <button class="btn-mini" onclick="Staff.copyPrevious()">前回コピー</button>' +
        '  <button class="btn-mini danger" onclick="Staff.clearAll()">全クリア</button>' +
        '</div>' +
        (selCount > 0
          ? '<div class="quick-actions">' +
            '  <button class="btn-mini primary" onclick="Staff.applySelected()">✓ 選択した' + selCount + '日に適用</button>' +
            '  <button class="btn-mini" onclick="Staff.offSelected()">選択日を休みに</button>' +
            '</div>'
          : '') +
        '</div>';
    }

    var footer;
    if (editor.adminFor) {
      footer = '<div class="editor-footer">' +
        '<div class="footer-buttons">' +
        '  <button class="btn btn-outline" onclick="Staff.adminSave(false)">保存のみ</button>' +
        '  <button class="btn btn-primary" onclick="Staff.adminSave(true)">保存して承認</button>' +
        '</div>' +
        '</div>';
    } else if (editor.locked) {
      footer = '<div class="editor-footer">' +
        '<button class="btn btn-outline btn-block" onclick="Staff.requestChange()">🔓 変更をリクエストする</button>' +
        '</div>';
    } else {
      footer = '<div class="editor-footer">' +
        '<textarea id="comment-input" placeholder="コメント・連絡事項（任意）" rows="2">' + esc(editor.comment) + '</textarea>' +
        '<div class="footer-buttons">' +
        '  <button class="btn btn-outline" onclick="Staff.saveDraft()">下書き保存</button>' +
        '  <button class="btn btn-primary" onclick="Staff.submit()">✓ 完了して提出</button>' +
        '</div>' +
        '</div>';
    }

    var title = editor.adminFor
      ? editor.adminFor.name + ' さんの修正'
      : App.periodLabelShort(pk) + 'のシフト希望';
    App.setView(
      App.header(title, editor.adminFor ? '#/admin' : '#/home') +
      '<div class="page editor-page">' +
      banner +
      '<div class="deadline-line">提出締切: ' + App.fmtDeadline(deadline) + '</div>' +
      '<div class="day-list">' + dayRows + '</div>' +
      '<p class="muted center">※ 未入力の日は「休み希望」として扱われます</p>' +
      '</div>' +
      chipBar +
      footer
    );
  }

  function selectChip(id) {
    editor.selectedChip = editor.selectedChip === id ? null : id;
    preserveComment();
    drawEditor();
  }

  function tapDay(date) {
    if (editor.locked) return;
    if (!editor.selectedChip) {
      openDaySheet(date);
      return;
    }
    preserveComment();
    if (editor.selectedChip === 'off') {
      delete editor.entries[date];
    } else {
      var p = App.state.masters.patterns.filter(function (x) { return x.id === editor.selectedChip; })[0];
      if (!p) return;
      editor.entries[date] = [{
        patternId: p.id, startTime: p.startTime, endTime: p.endTime, locationId: defaultLocationId(p)
      }];
    }
    drawEditor();
  }

  // ---------- チェックボックス選択・一括適用 ----------

  function toggleDay(date, checked) {
    if (checked) editor.selectedDays[date] = true;
    else delete editor.selectedDays[date];
    preserveComment();
    drawEditor();
  }

  function selectDays(mode) {
    preserveComment();
    editor.selectedDays = {};
    if (mode !== 'none') {
      App.periodDates(editor.pk).forEach(function (date) {
        var day = new Date(date + 'T00:00:00').getDay();
        var isWeekend = day === 0 || day === 6;
        if (mode === 'all' || (mode === 'weekday' && !isWeekend) || (mode === 'weekend' && isWeekend)) {
          editor.selectedDays[date] = true;
        }
      });
    }
    drawEditor();
  }

  function applySelected() {
    if (!editor.selectedChip) {
      App.toast('先に下のパターン（または「休み」）を選んでください', 'error');
      return;
    }
    preserveComment();
    var p = editor.selectedChip === 'off'
      ? null
      : App.state.masters.patterns.filter(function (x) { return x.id === editor.selectedChip; })[0];
    Object.keys(editor.selectedDays).forEach(function (date) {
      if (!p) {
        delete editor.entries[date];
      } else {
        editor.entries[date] = [{ patternId: p.id, startTime: p.startTime, endTime: p.endTime, locationId: defaultLocationId(p) }];
      }
    });
    var n = Object.keys(editor.selectedDays).length;
    editor.selectedDays = {};
    drawEditor();
    App.toast(n + '日分に適用しました', 'success');
  }

  function offSelected() {
    preserveComment();
    var n = Object.keys(editor.selectedDays).length;
    Object.keys(editor.selectedDays).forEach(function (date) { delete editor.entries[date]; });
    editor.selectedDays = {};
    drawEditor();
    App.toast(n + '日分を休みにしました', 'success');
  }

  // ---------- テンプレート ----------

  var WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

  async function loadTemplates() {
    if (editor.templates === null) {
      try {
        var list = await Api.call('getTemplates');
        editor.templates = list.map(function (t) {
          var data = {};
          try { data = JSON.parse(t.data); } catch (e) { /* 壊れたデータは空扱い */ }
          return { id: t.id, name: t.name, data: data };
        });
      } catch (e) {
        App.toast(e.message, 'error');
        editor.templates = [];
      }
    }
    return editor.templates;
  }

  async function openTemplateSheet() {
    preserveComment();
    var c = document.getElementById('modal-container');
    c.innerHTML =
      '<div class="sheet-overlay"><div class="sheet">' +
      '<div class="sheet-handle"></div><h3>📋 テンプレート</h3>' +
      '<p class="muted">読み込み中...</p></div></div>';
    var templates = await loadTemplates();

    var rows = templates.length === 0
      ? '<p class="muted">まだテンプレートがありません。<br>シフトを入力してから「現在の入力から作成」を押すと、曜日ごとのパターンとして保存されます。</p>'
      : templates.map(function (t) {
        var summary = [1, 2, 3, 4, 5, 6, 0].map(function (w) {
          var list = t.data[w] || [];
          return WEEKDAY_NAMES[w] + ':' + (list.length === 0 ? '休' : list.map(function (en) {
            return en.patternId ? patternName(en.patternId) || (en.startTime + '〜') : en.startTime + '〜' + en.endTime;
          }).join('+'));
        }).join(' ');
        return '<div class="template-row">' +
          '<div class="template-info"><b>' + esc(t.name) + '</b><br><small class="muted">' + esc(summary) + '</small></div>' +
          '<div class="template-buttons">' +
          '  <button class="btn btn-primary btn-sm" onclick="Staff.applyTemplate(\'' + t.id + '\')">適用</button>' +
          '  <button class="btn-mini danger" onclick="Staff.deleteTemplate(\'' + t.id + '\')">削除</button>' +
          '</div></div>';
      }).join('');

    c.innerHTML =
      '<div class="sheet-overlay" onclick="if(event.target===this)App.closeSheet()">' +
      '  <div class="sheet">' +
      '    <div class="sheet-handle"></div>' +
      '    <h3>📋 テンプレート</h3>' +
      '    <p class="muted">曜日ごとの勤務パターンを保存して、期間全体に一括入力できます。</p>' +
      rows +
      '    <div class="sheet-actions">' +
      '      <button class="btn btn-outline" onclick="App.closeSheet()">閉じる</button>' +
      '      <button class="btn btn-primary" onclick="Staff.saveTemplateFromCurrent()">＋ 現在の入力から作成</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';
  }

  /** 現在の入力を「曜日→枠リスト」に変換して保存（各曜日の最初の日の内容を採用） */
  async function saveTemplateFromCurrent() {
    var hasInput = Object.keys(editor.entries).some(function (d) { return (editor.entries[d] || []).length > 0; });
    if (!hasInput) {
      App.toast('先にシフトを入力してください', 'error');
      return;
    }
    App.closeSheet();
    var name = await App.promptModal(
      'テンプレート名',
      '<p>曜日ごとの勤務内容を「曜日パターン」として保存します。<br>（各曜日で入力がある最初の日の内容を採用。入力がない曜日は「休み」）</p>',
      '例: いつもの週', '保存'
    );
    if (!name) return;

    // 各曜日について「実際に入力がある最初の日」の内容を採用する
    var byWeekday = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    var filled = {};
    App.periodDates(editor.pk).forEach(function (date) {
      var w = new Date(date + 'T00:00:00').getDay();
      var list = editor.entries[date] || [];
      if (!filled[w] && list.length > 0) {
        filled[w] = true;
        byWeekday[w] = list.map(function (en) {
          return { patternId: en.patternId, startTime: en.startTime, endTime: en.endTime, locationId: en.locationId };
        });
      }
    });
    if (Object.keys(filled).length === 0) {
      App.toast('入力内容からパターンを作れませんでした', 'error');
      return;
    }

    try {
      await Api.call('saveTemplate', { name: name, data: byWeekday });
      editor.templates = null; // 再読込させる
      App.toast('テンプレート「' + name + '」を保存しました', 'success');
      openTemplateSheet();
    } catch (e) {
      App.toast(e.message, 'error');
    }
  }

  async function applyTemplate(id) {
    var templates = await loadTemplates();
    var t = templates.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    App.closeSheet();
    document.getElementById('modal-container').innerHTML = '';
    App.periodDates(editor.pk).forEach(function (date) {
      var w = new Date(date + 'T00:00:00').getDay();
      var list = t.data[w] || [];
      if (list.length === 0) {
        delete editor.entries[date];
      } else {
        editor.entries[date] = list.map(function (en) {
          return { patternId: en.patternId, startTime: en.startTime, endTime: en.endTime, locationId: en.locationId };
        });
      }
    });
    editor.selectedDays = {};
    drawEditor();
    App.toast('テンプレート「' + t.name + '」を適用しました', 'success');
  }

  async function deleteTemplate(id) {
    var yes = await App.confirmModal('テンプレート削除', 'このテンプレートを削除しますか？', '削除する');
    if (!yes) { openTemplateSheet(); return; }
    try {
      await Api.call('deleteTemplate', { id: id });
      editor.templates = null;
      App.toast('削除しました', 'success');
    } catch (e) {
      App.toast(e.message, 'error');
    }
    openTemplateSheet();
  }

  async function copyPrevious() {
    preserveComment();
    var prevPk = App.shiftPeriod(editor.pk, -1);
    App.toast('前回（' + App.periodLabelShort(prevPk) + '）を読み込み中...', 'info');
    try {
      var data = await Api.call('getMyPeriod', { periodKey: prevPk });
      if (data.shifts.length === 0) { App.toast('前回のデータがありません', 'error'); return; }
      var prevDates = App.periodDates(prevPk);
      var curDates = App.periodDates(editor.pk);
      var byDate = {};
      data.shifts.forEach(function (s) {
        if (!byDate[s.date]) byDate[s.date] = [];
        byDate[s.date].push(s);
      });
      curDates.forEach(function (date, i) {
        var src = prevDates[i] && byDate[prevDates[i]];
        if (src) {
          editor.entries[date] = src.map(function (s) {
            return { patternId: s.patternId, startTime: s.startTime, endTime: s.endTime, locationId: s.locationId };
          });
        } else {
          delete editor.entries[date];
        }
      });
      drawEditor();
      App.toast('前回の希望をコピーしました', 'success');
    } catch (e) {
      App.toast(e.message, 'error');
    }
  }

  async function clearAll() {
    var yes = await App.confirmModal('全クリア', 'この期間の入力をすべてクリアしますか？', 'クリアする');
    if (!yes) return;
    preserveComment();
    editor.entries = {};
    drawEditor();
  }

  function preserveComment() {
    var el = document.getElementById('comment-input');
    if (el) editor.comment = el.value;
  }

  // ---------- 日別詳細シート（時刻微調整・複数枠） ----------

  function openDaySheet(date) {
    if (editor.locked) return;
    var multiLoc = App.state.masters.locations.length > 1;
    var list = (editor.entries[date] || []).map(function (e) { return Object.assign({}, e); });
    if (list.length === 0) {
      var p = myPatterns()[0];
      list.push(p
        ? { patternId: p.id, startTime: p.startTime, endTime: p.endTime, locationId: defaultLocationId(p) }
        : { patternId: '', startTime: '09:00', endTime: '18:00', locationId: defaultLocationId(null) });
    }

    function entryHtml(en, i) {
      var patternOpts = '<option value="">（自由入力）</option>' + myPatterns().map(function (p) {
        return '<option value="' + p.id + '"' + (en.patternId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('');
      var locOpts = App.state.masters.locations.map(function (l) {
        return '<option value="' + l.id + '"' + (en.locationId === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>';
      }).join('');
      return '<div class="sheet-entry" data-idx="' + i + '">' +
        '<div class="sheet-entry-row">' +
        '  <select class="se-pattern" onchange="Staff.sheetPatternChange(' + i + ', this.value)">' + patternOpts + '</select>' +
        (multiLoc ? '<select class="se-location">' + locOpts + '</select>' : '') +
        '</div>' +
        '<div class="sheet-entry-row">' +
        '  <input type="time" class="se-start" value="' + esc(en.startTime) + '"> 〜 ' +
        '  <input type="time" class="se-end" value="' + esc(en.endTime) + '">' +
        '  <button class="btn-mini danger" onclick="Staff.sheetRemoveEntry(' + i + ')">削除</button>' +
        '</div>' +
        '</div>';
    }

    var c = document.getElementById('modal-container');
    c.innerHTML =
      '<div class="sheet-overlay" onclick="if(event.target===this)App.closeSheet()">' +
      '  <div class="sheet">' +
      '    <div class="sheet-handle"></div>' +
      '    <h3>' + App.dateLabel(date) + ' の希望</h3>' +
      '    <div id="sheet-entries">' + list.map(entryHtml).join('') + '</div>' +
      '    <button class="btn-mini" onclick="Staff.sheetAddEntry()">＋ 枠を追加（1日に複数勤務）</button>' +
      '    <div class="sheet-actions">' +
      '      <button class="btn btn-outline" onclick="Staff.sheetSetOff(\'' + date + '\')">休みにする</button>' +
      '      <button class="btn btn-primary" onclick="Staff.sheetSave(\'' + date + '\')">この内容にする</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    sheetState = { date: date, list: list };
  }

  var sheetState = null;

  function sheetPatternChange(idx, patternId) {
    var p = App.state.masters.patterns.filter(function (x) { return x.id === patternId; })[0];
    if (p) {
      var entry = document.querySelectorAll('.sheet-entry')[idx];
      entry.querySelector('.se-start').value = toTimeValue(p.startTime);
      entry.querySelector('.se-end').value = toTimeValue(p.endTime);
    }
  }

  function toTimeValue(t) {
    var parts = String(t).split(':');
    return App.pad2(Number(parts[0])) + ':' + App.pad2(Number(parts[1] || 0));
  }

  function sheetCollect() {
    var entries = [];
    document.querySelectorAll('.sheet-entry').forEach(function (el) {
      var start = el.querySelector('.se-start').value;
      var end = el.querySelector('.se-end').value;
      if (!start || !end) return;
      var locSel = el.querySelector('.se-location');
      entries.push({
        patternId: el.querySelector('.se-pattern').value,
        startTime: start,
        endTime: end,
        locationId: locSel ? locSel.value : defaultLocationId(null)
      });
    });
    return entries;
  }

  function sheetAddEntry() {
    var cur = sheetCollect();
    cur.push({ patternId: '', startTime: '09:00', endTime: '18:00', locationId: defaultLocationId(null) });
    sheetState.list = cur;
    openDaySheetFromState();
  }

  function sheetRemoveEntry(idx) {
    var cur = sheetCollect();
    cur.splice(idx, 1);
    if (cur.length === 0) {
      sheetSetOff(sheetState.date);
      return;
    }
    sheetState.list = cur;
    openDaySheetFromState();
  }

  function openDaySheetFromState() {
    var date = sheetState.date;
    var saved = editor.entries[date];
    editor.entries[date] = sheetState.list;
    openDaySheet(date);
    if (saved) editor.entries[date] = saved; else delete editor.entries[date];
  }

  function sheetSetOff(date) {
    delete editor.entries[date];
    App.closeSheet();
    document.getElementById('modal-container').innerHTML = '';
    drawEditor();
  }

  function sheetSave(date) {
    var entries = sheetCollect();
    // 時間重複チェック
    for (var i = 0; i < entries.length; i++) {
      for (var j = i + 1; j < entries.length; j++) {
        if (entries[i].startTime < entries[j].endTime && entries[j].startTime < entries[i].endTime) {
          App.toast('時間帯が重複しています', 'error');
          return;
        }
      }
    }
    if (entries.length === 0) {
      delete editor.entries[date];
    } else {
      editor.entries[date] = entries;
    }
    document.getElementById('modal-container').innerHTML = '';
    drawEditor();
  }

  // ---------- 保存・提出 ----------

  function collectShifts() {
    var shifts = [];
    Object.keys(editor.entries).forEach(function (date) {
      editor.entries[date].forEach(function (en) {
        shifts.push({
          date: date, patternId: en.patternId,
          startTime: en.startTime, endTime: en.endTime, locationId: en.locationId
        });
      });
    });
    return shifts;
  }

  async function saveDraft() {
    if (editor.saving) return;
    preserveComment();
    editor.saving = true;
    try {
      await Api.call('saveDraft', { periodKey: editor.pk, shifts: collectShifts(), comment: editor.comment });
      App.toast('下書きを保存しました', 'success');
      editor.submission = editor.submission || {};
      editor.submission.status = 'draft';
    } catch (e) {
      App.toast(e.message, 'error');
    }
    editor.saving = false;
    drawEditor();
  }

  async function submit() {
    if (editor.saving) return;
    preserveComment();
    var shifts = collectShifts();
    var dates = App.periodDates(editor.pk);
    var offDays = dates.filter(function (d) { return !editor.entries[d] || editor.entries[d].length === 0; });

    var body =
      '<p>入力: <b>' + (dates.length - offDays.length) + '日</b> ／ 休み希望: <b>' + offDays.length + '日</b></p>' +
      (offDays.length > 0
        ? '<p class="muted">休み扱い: ' + offDays.map(function (d) { return App.dateLabel(d); }).join('、') + '</p>' : '') +
      '<p class="warn-text">⚠️ 提出後はロックされ、変更には管理者の承認が必要になります。</p>';

    var yes = await App.confirmModal('シフト希望を提出しますか？', body, '提出してロックする', 'まだ編集する');
    if (!yes) return;

    editor.saving = true;
    App.showLoading('提出中...（カレンダー登録も行っています）');
    try {
      var result = await Api.call('submit', { periodKey: editor.pk, shifts: shifts, comment: editor.comment });
      App.toast('提出しました！' + (result.late ? '（締切超過として記録）' : ''), 'success');
      if (result.calendar && result.calendar.skipped === 'calendar_not_connected') {
        App.toast('カレンダー未連携のため予定は登録されていません', 'info');
      }
      renderInput(editor.pk);
    } catch (e) {
      App.toast(e.message, 'error');
      editor.saving = false;
      drawEditor();
    }
  }

  async function requestChange() {
    var reason = await App.promptModal(
      '変更リクエスト',
      '<p>提出済みシフトの変更には管理者の承認が必要です。変更したい理由を入力してください。</p>',
      '例: 15日に急用が入ったため休みに変更したい',
      'リクエスト送信'
    );
    if (!reason) return;
    try {
      await Api.call('createChangeRequest', { periodKey: editor.pk, reason: reason });
      App.toast('変更リクエストを送信しました。管理者の承認をお待ちください。', 'success');
    } catch (e) {
      App.toast(e.message, 'error');
    }
  }

  // ---------- みんなのシフト（承認済みのみ） ----------

  async function renderEveryone(pk) {
    pk = pk || App.currentPeriodKey();
    App.showLoading();
    var data;
    try {
      data = await Api.call('getApprovedShifts', { periodKey: pk });
    } catch (e) {
      App.toast(e.message, 'error');
      data = { shifts: [], staff: [] };
    }

    var nameByEmail = {};
    data.staff.forEach(function (s) { nameByEmail[s.email] = s.name; });
    var byDate = {};
    data.shifts.forEach(function (s) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    });

    var rows = App.periodDates(pk).map(function (date) {
      var list = (byDate[date] || []).sort(function (a, b) { return a.startTime < b.startTime ? -1 : 1; });
      return '<div class="day-row ' + App.weekdayClass(date) + '">' +
        '<div class="day-label">' + App.dateLabel(date) + '</div>' +
        '<div class="day-content">' +
        (list.length === 0
          ? '<span class="day-off">—</span>'
          : list.map(function (s) {
            return '<span class="entry-chip">' + esc(nameByEmail[s.staffEmail] || s.staffEmail) +
              ' <small>' + esc(s.startTime) + '〜' + esc(s.endTime) + '</small></span>';
          }).join('')) +
        '</div></div>';
    }).join('');

    App.setView(
      App.header('みんなのシフト') +
      '<div class="page">' +
      periodNav(pk, '#/everyone/') +
      '<p class="muted center">承認済みのシフトのみ表示されます</p>' +
      '<div class="day-list">' + rows + '</div>' +
      '</div>' +
      App.tabbar('everyone')
    );
  }

  function periodNav(pk, hashPrefix) {
    return '<div class="period-nav">' +
      '<button class="btn-mini" onclick="location.hash=\'' + hashPrefix + App.shiftPeriod(pk, -1) + '\'">◀ 前</button>' +
      '<span class="period-nav-label">' + esc(App.periodLabel(pk)) + '</span>' +
      '<button class="btn-mini" onclick="location.hash=\'' + hashPrefix + App.shiftPeriod(pk, 1) + '\'">次 ▶</button>' +
      '</div>';
  }

  return {
    renderHome: renderHome,
    renderInput: renderInput,
    renderAdminEdit: renderAdminEdit,
    adminSave: adminSave,
    renderEveryone: renderEveryone,
    periodNav: periodNav,
    selectChip: selectChip,
    tapDay: tapDay,
    toggleDay: toggleDay,
    selectDays: selectDays,
    applySelected: applySelected,
    offSelected: offSelected,
    openTemplateSheet: openTemplateSheet,
    saveTemplateFromCurrent: saveTemplateFromCurrent,
    applyTemplate: applyTemplate,
    deleteTemplate: deleteTemplate,
    copyPrevious: copyPrevious,
    clearAll: clearAll,
    openDaySheet: openDaySheet,
    sheetPatternChange: sheetPatternChange,
    sheetAddEntry: sheetAddEntry,
    sheetRemoveEntry: sheetRemoveEntry,
    sheetSetOff: sheetSetOff,
    sheetSave: sheetSave,
    saveDraft: saveDraft,
    submit: submit,
    requestChange: requestChange
  };
})();
