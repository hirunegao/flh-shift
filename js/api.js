// ============================================================
// API通信層 — GAS Web App とのやりとり
// ============================================================

var Api = (function () {
  var ERROR_MESSAGES = {
    auth_failed: '認証に失敗しました。もう一度ログインしてください。',
    token_expired: 'ログインの有効期限が切れました。もう一度ログインしてください。',
    not_registered: 'このアカウントは登録されていません。管理者に連絡してください。',
    forbidden: 'この操作の権限がありません。',
    locked: '提出済みのためロックされています。変更には管理者の承認が必要です。',
    not_found: 'データが見つかりませんでした。',
    calendar_not_connected: 'Googleカレンダーが未連携です。',
    invalid_request: 'リクエストが不正です。',
    server_error: 'サーバーエラーが発生しました。時間をおいて再度お試しください。',
    network_error: '通信エラーが発生しました。電波状況をご確認ください。'
  };

  async function call(action, payload) {
    var idToken = App.getIdToken();
    var body = JSON.stringify({ action: action, idToken: idToken, payload: payload || {} });
    var res;
    try {
      // Content-Type: text/plain にすることでCORSプリフライトを回避（GAS対応）
      res = await fetch(GAS_URL, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    } catch (e) {
      throw new ApiError('network_error');
    }
    var json;
    try {
      json = await res.json();
    } catch (e) {
      throw new ApiError('server_error');
    }
    if (!json.ok) {
      if (json.error === 'token_expired' || json.error === 'auth_failed') {
        App.onAuthExpired();
      }
      throw new ApiError(json.error || 'server_error');
    }
    return json.data;
  }

  function ApiError(code) {
    this.code = code;
    this.message = ERROR_MESSAGES[code] || ERROR_MESSAGES.server_error;
  }
  ApiError.prototype = Object.create(Error.prototype);

  return { call: call, ApiError: ApiError, messages: ERROR_MESSAGES };
})();
