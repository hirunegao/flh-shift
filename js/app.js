// ============================================================
// アプリ本体 — 認証・ルーティング・共通ユーティリティ
// ============================================================

var App = (function () {
  var state = {
    idToken: null,
    profile: null,        // { email, name, isAdmin, locationIds }
    masters: { locations: [], patterns: [] },
    settings: {},
    calendarConnected: false,
    inviteMode: false     // true: 招待方式（個別のカレンダー連携操作は不要）
  };

  // ---------- 起動 ----------

  function init() {
    var saved = sessionStorage.getItem('flh_id_token');
    if (saved) {
      state.idToken = saved;
      login();
    } else {
      waitForGis(renderLogin);
    }
    window.addEventListener('hashchange', route);
  }

  function waitForGis(cb) {
    if (window.google && google.accounts) return cb();
    setTimeout(function () { waitForGis(cb); }, 100);
  }

  // ---------- ログイン ----------

  function renderLogin(message) {
    var root = document.getElementById('app');
    root.innerHTML =
      '<div class="login-screen">' +
      '  <div class="login-card">' +
      '    <div class="login-logo">📅</div>' +
      '    <h1>FLH シフト希望</h1>' +
      '    <p class="login-sub">スタッフ用シフト希望提出システム</p>' +
      (message ? '<p class="login-error">' + esc(message) + '</p>' : '') +
      '    <div id="gsi-button"></div>' +
      '  </div>' +
      '</div>';

    waitForGis(function () {
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: function (resp) {
          state.idToken = resp.credential;
          sessionStorage.setItem('flh_id_token', resp.credential);
          login();
        }
      });
      google.accounts.id.renderButton(document.getElementById('gsi-button'), {
        theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ja'
      });
    });
  }

  async function login() {
    showLoading('ログイン中...');
    try {
      var data = await Api.call('login');
      state.profile = data.staff;
      state.masters = data.masters;
      state.settings = data.settings;
      state.calendarConnected = data.calendarConnected;
      state.inviteMode = !!data.inviteMode;
      if (!location.hash || location.hash === '#/') {
        location.hash = '#/home';
      }
      route();
      // カレンダー未連携なら初回に案内
      if (!state.calendarConnected && !sessionStorage.getItem('flh_cal_prompted')) {
        sessionStorage.setItem('flh_cal_prompted', '1');
        setTimeout(function () {
          confirmModal(
            'Googleカレンダー連携',
            'シフトをあなたのGoogleカレンダーに自動反映できます。連携しますか？<br><span class="muted">（あとで「設定」からも連携できます）</span>',
            '連携する', 'あとで'
          ).then(function (yes) { if (yes) connectCalendar(); });
        }, 600);
      }
    } catch (e) {
      sessionStorage.removeItem('flh_id_token');
      state.idToken = null;
      renderLogin(e.message);
    }
  }

  function onAuthExpired() {
    sessionStorage.removeItem('flh_id_token');
    state.idToken = null;
  }

  function logout() {
    sessionStorage.removeItem('flh_id_token');
    sessionStorage.removeItem('flh_cal_prompted');
    state.idToken = null;
    state.profile = null;
    location.hash = '';
    renderLogin();
  }

  // ---------- カレンダー連携（OAuth code flow） ----------

  function connectCalendar() {
    if (state.inviteMode) {
      // 招待方式では権限要求は不要（シフトの予定は自動で本人カレンダーに届く）
      toast('カレンダーは自動連携済みです。設定は不要です。', 'info');
      return;
    }
    var client = google.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/calendar.events',
      ux_mode: 'popup',
      login_hint: state.profile.email,
      callback: async function (resp) {
        if (!resp.code) return;
        showLoading('カレンダーを連携中...');
        try {
          await Api.call('oauthExchange', { code: resp.code });
          state.calendarConnected = true;
          toast('Googleカレンダーと連携しました', 'success');
        } catch (e) {
          toast(e.message, 'error');
        }
        route();
      }
    });
    client.requestCode();
  }

  // ---------- ルーティング ----------

  function route() {
    if (!state.profile) return;
    var hash = location.hash || '#/home';
    var parts = hash.replace(/^#\//, '').split('/');

    switch (parts[0]) {
      case 'home': return Staff.renderHome();
      case 'input': return Staff.renderInput(decodeURIComponent(parts[1] || ''));
      case 'everyone': return Staff.renderEveryone(parts[1] ? decodeURIComponent(parts[1]) : null);
      case 'settings': return renderSettings();
      case 'admin':
        if (!state.profile.isAdmin) { location.hash = '#/home'; return; }
        return Admin.render(parts.slice(1));
      default:
        location.hash = '#/home';
    }
  }

  // ---------- 設定画面 ----------

  function renderSettings() {
    setView(
      header('設定') +
      '<div class="page">' +
      '  <div class="card">' +
      '    <h3>Googleカレンダー連携</h3>' +
      '    <p class="muted">シフトの提出・承認時に、あなたのGoogleカレンダーへ自動で予定が入ります。</p>' +
      '    <p>状態: ' + (state.inviteMode
        ? '<span class="chip chip-green">自動連携（招待方式）</span>'
        : (state.calendarConnected
          ? '<span class="chip chip-green">連携済み</span>'
          : '<span class="chip chip-gray">未連携</span>')) + '</p>' +
      (state.inviteMode
        ? '<p class="muted">シフトの予定が「FLHシフト配信」から自動で届きます。設定は不要です。</p>'
        : (state.calendarConnected
          ? ''
          : '<button class="btn btn-primary" onclick="App.connectCalendar()">カレンダーを連携する</button>')) +
      '  </div>' +
      '  <div class="card">' +
      '    <h3>アカウント</h3>' +
      '    <p>' + esc(state.profile.name) + '<br><span class="muted">' + esc(state.profile.email) + '</span></p>' +
      '    <button class="btn btn-outline" onclick="App.logout()">ログアウト</button>' +
      '  </div>' +
      '</div>' +
      tabbar('settings')
    );
  }

  // ---------- 期間ユーティリティ ----------

  // "2026-08-A" → { year, month, half }
  function parsePeriod(pk) {
    var m = pk.match(/^(\d{4})-(\d{2})-([AB])$/);
    return { year: Number(m[1]), month: Number(m[2]), half: m[3] };
  }

  function periodLabel(pk) {
    var p = parsePeriod(pk);
    return p.year + '年' + p.month + '月' + (p.half === 'A' ? '前半（1〜15日）' : '後半（16〜末日）');
  }

  function periodLabelShort(pk) {
    var p = parsePeriod(pk);
    return p.month + '月' + (p.half === 'A' ? '前半' : '後半');
  }

  function periodDates(pk) {
    var p = parsePeriod(pk);
    var lastDay = new Date(p.year, p.month, 0).getDate();
    var start = p.half === 'A' ? 1 : 16;
    var end = p.half === 'A' ? 15 : lastDay;
    var dates = [];
    for (var d = start; d <= end; d++) {
      dates.push(p.year + '-' + pad2(p.month) + '-' + pad2(d));
    }
    return dates;
  }

  function clampDayOfMonth(year, month, day) {
    var last = new Date(year, month, 0).getDate();
    var n = Number(day);
    if (!n || n < 1) return 1;
    return Math.min(n, last);
  }

  function deadlineFor(pk) {
    var p = parsePeriod(pk);
    var dayA = Number(state.settings.deadlineDayA || 25);
    var dayB = Number(state.settings.deadlineDayB || 10);
    if (p.half === 'A') {
      var py = p.month === 1 ? p.year - 1 : p.year;
      var pm = p.month === 1 ? 12 : p.month - 1;
      return new Date(py, pm - 1, clampDayOfMonth(py, pm, dayA), 23, 59, 59);
    }
    return new Date(p.year, p.month - 1, clampDayOfMonth(p.year, p.month, dayB), 23, 59, 59);
  }

  /** 提出対象の期間（未来の3期間）＋現在進行中の期間 */
  function selectablePeriods() {
    var now = new Date();
    var list = [];
    for (var offset = 0; offset <= 2; offset++) {
      var d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      ['A', 'B'].forEach(function (half) {
        list.push(d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + half);
      });
    }
    // 期間終了済みのものは除外（当月の前半が終わっていたら消す）
    return list.filter(function (pk) {
      var dates = periodDates(pk);
      var lastDate = new Date(dates[dates.length - 1] + 'T23:59:59');
      return lastDate >= now;
    }).slice(0, 4);
  }

  /** 全期間ナビゲーション用: pkの前/次 */
  function shiftPeriod(pk, delta) {
    var p = parsePeriod(pk);
    var idx = (p.year * 12 + (p.month - 1)) * 2 + (p.half === 'A' ? 0 : 1) + delta;
    var half = idx % 2 === 0 ? 'A' : 'B';
    var monthIdx = Math.floor(idx / 2);
    var year = Math.floor(monthIdx / 12);
    var month = (monthIdx % 12) + 1;
    return year + '-' + pad2(month) + '-' + half;
  }

  function currentPeriodKey() {
    var now = new Date();
    var half = now.getDate() <= 15 ? 'A' : 'B';
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + half;
  }

  // ---------- 表示ユーティリティ ----------

  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  function dateLabel(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WEEKDAYS[d.getDay()] + '）';
  }

  function weekdayClass(dateStr) {
    var day = new Date(dateStr + 'T00:00:00').getDay();
    return day === 0 ? 'sun' : day === 6 ? 'sat' : '';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDeadline(d) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  var STATUS_INFO = {
    none: { label: '未入力', cls: 'gray', banner: '' },
    draft: { label: '入力中', cls: 'gray', banner: '入力中です。「完了して提出」を押すまで管理者への提出は完了しません。' },
    submitted: { label: '提出済み', cls: 'blue', banner: '提出済みです。管理者の承認をお待ちください。変更には管理者の承認が必要です。' },
    approved: { label: '承認済み', cls: 'green', banner: 'シフトが承認されました。変更には管理者の承認が必要です。' },
    rejected: { label: '差し戻し', cls: 'orange', banner: '差し戻されました。内容を修正して再提出してください。' }
  };

  function statusChip(status) {
    var info = STATUS_INFO[status] || STATUS_INFO.none;
    return '<span class="chip chip-' + info.cls + '">' + info.label + '</span>';
  }

  // ---------- UI部品 ----------

  function setView(html) {
    document.getElementById('app').innerHTML = html;
  }

  function showLoading(text) {
    setView('<div class="loading-screen"><div class="spinner"></div><p>' + esc(text || '読み込み中...') + '</p></div>');
  }

  function header(title, backHash) {
    return '<header class="app-header">' +
      (backHash ? '<button class="back-btn" onclick="location.hash=\'' + backHash + '\'">←</button>' : '<span class="back-btn-space"></span>') +
      '<h1>' + esc(title) + '</h1>' +
      '<span class="header-space"></span>' +
      '</header>';
  }

  function tabbar(active) {
    var tabs = [
      { id: 'home', hash: '#/home', icon: '🏠', label: 'ホーム' },
      { id: 'everyone', hash: '#/everyone', icon: '👥', label: 'みんな' }
    ];
    if (state.profile.isAdmin) {
      tabs.push({ id: 'admin', hash: '#/admin', icon: '🛠', label: '管理' });
    }
    tabs.push({ id: 'settings', hash: '#/settings', icon: '⚙️', label: '設定' });
    return '<nav class="tabbar">' + tabs.map(function (t) {
      return '<a href="' + t.hash + '" class="tab' + (active === t.id ? ' active' : '') + '">' +
        '<span class="tab-icon">' + t.icon + '</span><span>' + t.label + '</span></a>';
    }).join('') + '</nav>';
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 10);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 3500);
  }

  /** 確認モーダル。Promise<boolean> を返す */
  function confirmModal(title, bodyHtml, okLabel, cancelLabel) {
    return new Promise(function (resolve) {
      var c = document.getElementById('modal-container');
      c.innerHTML =
        '<div class="modal-overlay">' +
        '  <div class="modal">' +
        '    <h3>' + esc(title) + '</h3>' +
        '    <div class="modal-body">' + bodyHtml + '</div>' +
        '    <div class="modal-actions">' +
        '      <button class="btn btn-outline" id="modal-cancel">' + esc(cancelLabel || 'キャンセル') + '</button>' +
        '      <button class="btn btn-primary" id="modal-ok">' + esc(okLabel || 'OK') + '</button>' +
        '    </div>' +
        '  </div>' +
        '</div>';
      document.getElementById('modal-ok').onclick = function () { c.innerHTML = ''; resolve(true); };
      document.getElementById('modal-cancel').onclick = function () { c.innerHTML = ''; resolve(false); };
    });
  }

  /** テキスト入力付きモーダル。Promise<string|null> */
  function promptModal(title, bodyHtml, placeholder, okLabel) {
    return new Promise(function (resolve) {
      var c = document.getElementById('modal-container');
      c.innerHTML =
        '<div class="modal-overlay">' +
        '  <div class="modal">' +
        '    <h3>' + esc(title) + '</h3>' +
        '    <div class="modal-body">' + bodyHtml +
        '      <textarea id="modal-input" rows="3" placeholder="' + esc(placeholder || '') + '"></textarea>' +
        '    </div>' +
        '    <div class="modal-actions">' +
        '      <button class="btn btn-outline" id="modal-cancel">キャンセル</button>' +
        '      <button class="btn btn-primary" id="modal-ok">' + esc(okLabel || '送信') + '</button>' +
        '    </div>' +
        '  </div>' +
        '</div>';
      document.getElementById('modal-ok').onclick = function () {
        var v = document.getElementById('modal-input').value.trim();
        if (!v) { toast('入力してください', 'error'); return; }
        c.innerHTML = '';
        resolve(v);
      };
      document.getElementById('modal-cancel').onclick = function () { c.innerHTML = ''; resolve(null); };
    });
  }

  function closeSheet() {
    var el = document.querySelector('.sheet-overlay');
    if (el) el.remove();
  }

  // ---------- 公開 ----------

  return {
    init: init,
    getIdToken: function () { return state.idToken; },
    onAuthExpired: onAuthExpired,
    logout: logout,
    connectCalendar: connectCalendar,
    state: state,
    route: route,
    // 期間
    parsePeriod: parsePeriod, periodLabel: periodLabel, periodLabelShort: periodLabelShort,
    periodDates: periodDates, deadlineFor: deadlineFor, selectablePeriods: selectablePeriods,
    shiftPeriod: shiftPeriod, currentPeriodKey: currentPeriodKey,
    // 表示
    dateLabel: dateLabel, weekdayClass: weekdayClass, esc: esc, pad2: pad2,
    fmtDeadline: fmtDeadline, statusChip: statusChip, STATUS_INFO: STATUS_INFO,
    // UI
    setView: setView, showLoading: showLoading, header: header, tabbar: tabbar,
    toast: toast, confirmModal: confirmModal, promptModal: promptModal, closeSheet: closeSheet
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
