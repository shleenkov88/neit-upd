/*
 * app.js — экран сайта: вкладки, списки, формы, окна, кнопки.
 * Все расчёты берутся из NeitCore (js/core.js), CSV — из NeitCsv (js/csv.js),
 * хранение — из адаптера общей базы NeitFirebaseAdapter (js/storage-firebase.js);
 * NeitStorage (js/storage.js) нужен только чтобы найти СТАРЫЕ данные на этом устройстве и предложить перенос.
 *
 * Структура файла:
 *   1. Мелкие помощники (создание элементов, всплывающие сообщения, скачивание)
 *   2. Состояние и запуск
 *   3. Период и вкладки
 *   4. Вкладка «Итоги»
 *   5. Вкладки «Наши УПД» / «УПД поставщиков»
 *   6. Окно добавления/редактирования УПД
 *   7. Подтверждение
 *   8. Импорт из CSV
 *   9. Экспорт, печать
 *  10. Вкладка «Копия данных»
 */
(function () {
  'use strict';

  var Core = window.NeitCore, Csv = window.NeitCsv;
  var TYPE_TITLE = { sale: 'Наши УПД', purchase: 'УПД поставщиков' };

  /* =====================================================================
   * 1. Помощники
   * =================================================================== */

  /** Создаёт элемент: el('div', {class:'x', onclick: fn}, 'текст', другойЭлемент). Текст вставляется безопасно. */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(node, c); });
    else node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  function $(sel) { return document.querySelector(sel); }
  function money(k) { return Core.formatRub(k); }

  var toastTimer = null;
  function toast(text) {
    var t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /** Скачивание файла из текста. BOM нужен, чтобы Excel правильно прочитал русские буквы. */
  function download(filename, text, mime, withBom) {
    var blob = new Blob([withBom ? '\uFEFF' : '', text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /** Читает файл как текст: сначала UTF-8, если не вышло — Windows-1251 (так сохраняет русский Excel и 1С). */
  function readFileText(file) {
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (bytes[0] === 0x50 && bytes[1] === 0x4B) throw new Error('xlsx');
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (e) { return new TextDecoder('windows-1251').decode(bytes); }
    });
  }

  /* =====================================================================
   * 2. Состояние и запуск
   * =================================================================== */
  var storage = new window.NeitFirebaseAdapter(window.NEIT_FIREBASE_CONFIG);   // общая база
  var legacy = window.NeitStorage.create();                                    // старые данные на этом устройстве (только чтение + перенос)
  var cq = Core.currentQuarter();
  var state = {
    docs: [], meta: {}, tab: 'summary', year: cq.year, quarter: cq.quarter,
    screen: 'loading',          // loading | fatal | login | verify | denied | app
    user: null, loaded: false,  // loaded — первые данные из базы получены
    conn: { fromCache: false, pending: false },
    legacyDocs: [], legacyMeta: {},
    verifyNotice: '', fatalText: ''
  };
  var unsubscribe = null, lastSig = null, draftEmail = '', authMode = null;

  function saveError(e) {
    console.error(e);
    toast('Не удалось сохранить. ' + window.NeitFirebaseAdapter.explainError(e, 'write'));
  }

  function start() {
    bindStaticUi();
    $('#appVersion').textContent = window.NEIT_APP_VERSION || '';
    setScreen('loading');
    window.addEventListener('online', renderStatusBar);
    window.addEventListener('offline', renderStatusBar);
    legacy.init()
      .then(function () { return Promise.all([legacy.getAll(), legacy.getMeta()]); })
      .then(function (r) {
        state.legacyDocs = r[0].map(Core.normalizeDoc).filter(Boolean);
        state.legacyMeta = r[1] || {};
      })
      .catch(function () { state.legacyDocs = []; })
      .then(function () { return storage.init(); })
      .then(function () { return storage.getMeta(); })
      .then(function (meta) { state.meta = meta || {}; storage.onAuth(route); })
      .catch(function (e) {
        console.error(e);
        state.fatalText = window.NeitFirebaseAdapter.explainError(e, 'auth');
        setScreen('fatal');
      });
  }

  /** Обновляет список документов в памяти из хранилища. */
  function reload() {
    return storage.getAll().then(function (docs) { state.docs = docs.map(Core.normalizeDoc).filter(Boolean); });
  }

  /** Куда направить человека в зависимости от того, вошёл ли он и подтверждена ли почта. */
  function route(user) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    state.user = user; state.docs = []; state.loaded = false; lastSig = null;
    if (!user) { authMode = null; setScreen('login'); return; }
    if (user.emailVerified) rememberLogin();
    if (!user.emailVerified) { setScreen('verify'); return; }
    setScreen('app');
    unsubscribe = storage.subscribe(onDocs, onSubscribeError);
  }

  function onDocs(docs, info) {
    var normalized = docs.map(Core.normalizeDoc).filter(Boolean);
    var sig = JSON.stringify(normalized) + '|' + !!info.fromCache + '|' + !!info.hasPendingWrites + '|' + state.loaded;
    state.docs = normalized;
    state.conn = { fromCache: !!info.fromCache, pending: !!info.hasPendingWrites };
    var first = !state.loaded;
    state.loaded = true;
    if (first || sig !== lastSig) { lastSig = sig; renderAll(); }
  }

  function onSubscribeError(e) {
    unsubscribe = null;
    var code = e && e.code ? String(e.code) : '';
    if (code === 'permission-denied' || code === 'firestore/permission-denied') { setScreen('denied'); return; }   // ожидаемая ситуация, не ошибка сайта
    console.error(e);
    state.fatalText = window.NeitFirebaseAdapter.explainError(e, 'read');
    setScreen('fatal');
  }

  /* =====================================================================
   * 2а. Экраны входа
   * =================================================================== */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** Переключает экран: служебные (вход, подтверждение…) или основной (app). */
  function setScreen(name) {
    state.screen = name;
    var isApp = name === 'app';
    $('#appShell').hidden = !isApp;
    var box = $('#authScreen');
    box.hidden = isApp;
    box.replaceChildren();
    if (name === 'loading') box.appendChild(authCard('Подключаемся…', [el('p', { id: 'authLoading', text: 'Подключаемся к общей базе. Это занимает несколько секунд.' })]));
    else if (name === 'fatal') box.appendChild(renderFatal());
    else if (name === 'login') box.appendChild(renderLogin());
    else if (name === 'verify') box.appendChild(renderVerify());
    else if (name === 'denied') box.appendChild(renderDenied());
    else if (isApp) { renderAll(); }
    renderStatusBar();
  }

  function authCard(title, children) {
    return el('div', { class: 'card auth-card' }, el('h2', { text: title }), children);
  }

  function renderFatal() {
    return authCard('Не получилось подключиться', [
      el('div', { class: 'banner banner-error', role: 'alert', id: 'fatalText', text: state.fatalText || 'Неизвестная ошибка.' }),
      el('div', { class: 'btn-row' }, el('button', { class: 'btn btn-primary', id: 'btnReload', text: 'Обновить страницу', onclick: function () { location.reload(); } }),
        state.user ? el('button', { class: 'btn', text: 'Выйти', onclick: doSignOut }) : null)]);
  }

  /* Флаг «на этом устройстве уже входили»: по нему выбираем, какую вкладку открыть. */
  var HAD_LOGIN_KEY = 'neit-upd-had-login';
  function hadLogin() { try { return localStorage.getItem(HAD_LOGIN_KEY) === '1'; } catch (e) { return false; } }
  function rememberLogin() { try { localStorage.setItem(HAD_LOGIN_KEY, '1'); } catch (e) { /* хранилище недоступно — не страшно */ } }
  var MIN_PASSWORD = 6;
  var HINT_FIRST_TIME = 'Если вы здесь впервые — перейдите на вкладку «Я здесь впервые».';
  var HINT_SIGNUP_PW = 'Пароль вы придумываете сами. Его никто не выдаёт и не присылает — просто введите любой новый пароль (минимум 6 символов) и запомните его.';
  var HINT_SIGNIN_PW = 'Пароль — тот, который вы сами придумали при первой регистрации. Забыли — нажмите «Забыли пароль?»';
  var MSG_EMAIL_TAKEN = 'Эта почта уже зарегистрирована. Нажмите «Войти» или «Забыли пароль?»';

  /**
   * Экран входа с двумя вкладками. opts: { mode: 'signin'|'signup', error, info }.
   * Без opts вкладка выбирается по флагу «уже входили на этом устройстве».
   */
  function renderLogin(opts) {
    opts = opts || {};
    var mode = opts.mode || authMode || (hadLogin() ? 'signin' : 'signup');
    authMode = mode;
    var signup = mode === 'signup';

    var emailIn = el('input', { class: 'input', id: 'authEmail', type: 'email', autocomplete: 'username', inputmode: 'email', placeholder: 'name@mail.ru', value: draftEmail });
    var passIn = el('input', { class: 'input', id: 'authPassword', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', placeholder: signup ? 'Придумайте пароль' : 'Пароль' });
    var pass2In = signup ? el('input', { class: 'input', id: 'authPassword2', type: 'password', autocomplete: 'new-password', placeholder: 'введите тот же пароль ещё раз' }) : null;
    var showPass = el('input', { type: 'checkbox', id: 'authShow' });
    showPass.addEventListener('change', function () { var t = showPass.checked ? 'text' : 'password'; passIn.type = t; if (pass2In) pass2In.type = t; });
    var errBox = el('div', { class: 'banner banner-error', role: 'alert', id: 'authError', hidden: !opts.error, text: opts.error || '' });
    var okBox = el('div', { class: 'banner banner-ok', role: 'status', id: 'authInfo', hidden: !opts.info, text: opts.info || '' });
    var tipBox = el('div', { class: 'banner banner-warn', id: 'authTip', hidden: true, text: HINT_FIRST_TIME });
    var bSubmit = el('button', { type: 'submit', class: 'btn btn-primary btn-big', id: signup ? 'btnSignUp' : 'btnSignIn', text: signup ? 'Создать пароль и получить письмо' : 'Войти' });
    var bForgot = signup ? null : el('button', { type: 'button', class: 'link', id: 'btnForgot', text: 'Забыли пароль?' });
    var bSwitch = el('button', { type: 'button', class: 'link', id: 'btnSwitch', text: signup ? 'Уже есть пароль? Войти' : 'Первый раз здесь? Создать пароль' });
    bSwitch.addEventListener('click', function () { draftEmail = emailIn.value.trim(); showLogin(signup ? 'signin' : 'signup'); });

    function tab(id, m, text) {
      var b = el('button', { type: 'button', class: 'auth-tab', id: id, role: 'tab', 'aria-selected': String(mode === m), text: text });
      b.addEventListener('click', function () { if (mode !== m) { draftEmail = emailIn.value.trim(); showLogin(m); } });
      return b;
    }
    var tabs = el('div', { class: 'auth-tabs', role: 'tablist', 'aria-label': 'Вход или первая регистрация' },
      tab('tabSignIn', 'signin', 'Я уже зарегистрирован(а) — войти'),
      tab('tabSignUp', 'signup', 'Я здесь впервые — создать пароль'));

    function fail(text, tip) { errBox.textContent = text; errBox.hidden = false; okBox.hidden = true; tipBox.hidden = !tip; }
    function busy(on) { [bSubmit, bForgot, bSwitch].forEach(function (b) { if (b) b.disabled = on; }); }
    function readEmail() {
      draftEmail = emailIn.value.trim();
      [emailIn, passIn, pass2In].forEach(function (i) { if (i) i.classList.remove('invalid'); });
      if (!draftEmail) { emailIn.classList.add('invalid'); emailIn.focus(); fail('Введите адрес почты.'); return null; }
      if (!EMAIL_RE.test(draftEmail)) { emailIn.classList.add('invalid'); emailIn.focus(); fail('Адрес почты написан неправильно. Пример: name@mail.ru'); return null; }
      errBox.hidden = true; tipBox.hidden = true;
      return draftEmail;
    }
    function run(promise, onOk, onFail) {
      busy(true);
      promise.then(function (r) { busy(false); if (onOk) onOk(r); }, function (e) {
        busy(false);
        if (e && e.accountCreated) { state.verifyNotice = 'Пароль создан, но письмо отправить не удалось. ' + window.NeitFirebaseAdapter.explainError(e, 'auth') + ' Нажмите «Отправить письмо ещё раз».'; if (state.screen === 'verify') setScreen('verify'); return; }
        if (onFail && onFail(e)) return;
        fail(window.NeitFirebaseAdapter.explainError(e, 'auth'));
      });
    }

    var steps = signup ? el('ol', { class: 'auth-steps', id: 'authSteps' },
      el('li', { text: 'Введите свою рабочую почту и придумайте пароль, минимум ' + MIN_PASSWORD + ' символов. Запомните или запишите его.' }),
      el('li', { text: 'Нажмите «Создать пароль и получить письмо», затем откройте письмо от Firebase (проверьте «Спам») и нажмите ссылку внутри.' }),
      el('li', { text: 'Вернитесь на сайт и нажмите «Я подтвердил(а) почту».' })) : null;

    var form = el('form', { novalidate: true, id: 'authForm' },
      okBox, errBox, tipBox,
      el('div', { class: 'field' }, el('label', { for: 'authEmail', text: signup ? 'Ваша рабочая почта' : 'Почта' }), emailIn),
      el('div', { class: 'field' }, el('label', { for: 'authPassword', text: signup ? 'Придумайте пароль' : 'Пароль' }), passIn,
        signup ? null : el('p', { class: 'auth-note', id: 'authPassNote', text: HINT_SIGNIN_PW })),
      signup ? el('div', { class: 'field' }, el('label', { for: 'authPassword2', text: 'Повторите пароль' }), pass2In) : null,
      el('label', { class: 'check', for: 'authShow' }, showPass, 'Показать пароль'),
      el('div', { class: 'btn-row' }, bSubmit),
      el('p', { class: 'auth-links' }, bForgot, bSwitch));

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = readEmail(); if (!email) return;
      if (!passIn.value) { passIn.classList.add('invalid'); passIn.focus(); fail(signup ? 'Придумайте пароль.' : 'Введите пароль.'); return; }
      if (!signup) {
        run(storage.signIn(email, passIn.value), null, function (e) {
          var code = e && e.code ? String(e.code) : '';
          if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-login-credentials') {
            fail(window.NeitFirebaseAdapter.explainError(e, 'auth'), true); return true;
          }
          return false;
        });
        return;
      }
      if (passIn.value.length < MIN_PASSWORD) { passIn.classList.add('invalid'); passIn.focus(); fail('Пароль слишком короткий: нужно не меньше ' + MIN_PASSWORD + ' символов.'); return; }
      if (passIn.value !== pass2In.value) { pass2In.classList.add('invalid'); pass2In.focus(); fail('Пароли не совпадают. Введите один и тот же пароль дважды.'); return; }
      state.verifyNotice = '';
      run(storage.signUp(email, passIn.value), function () {
        state.verifyNotice = 'Мы отправили письмо на ' + email + '.';
        if (state.screen === 'verify') setScreen('verify');
      }, function (e) {
        if (e && String(e.code) === 'auth/email-already-in-use') { showLogin('signin', { error: MSG_EMAIL_TAKEN }); return true; }
        return false;
      });
    });
    if (bForgot) bForgot.addEventListener('click', function () {
      var email = readEmail(); if (!email) return;
      run(storage.resetPassword(email), function () {
        okBox.textContent = 'Если эта почта зарегистрирована, мы отправили на неё письмо со ссылкой для нового пароля.';
        okBox.hidden = false; errBox.hidden = true;
      });
    });

    return el('div', { class: 'card auth-card' },
      el('h2', { text: signup ? 'Первый вход: создайте пароль' : 'Вход' }),
      tabs,
      signup ? el('div', { class: 'banner banner-warn', id: 'signupHint', text: HINT_SIGNUP_PW }) : null,
      steps,
      form);
  }

  function showLogin(mode, opts) {
    opts = opts || {};
    opts.mode = mode;
    authMode = mode;
    var box = $('#authScreen');
    box.replaceChildren(renderLogin(opts));
  }

  function renderVerify() {
    var email = state.user && state.user.email || '';
    return authCard('Подтвердите почту', [
      el('p', { text: 'Мы отправили письмо на ' + email + '. Откройте его и нажмите ссылку внутри (проверьте папку «Спам»).' }),
      state.verifyNotice ? el('div', { class: 'banner banner-ok', text: state.verifyNotice }) : null,
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', text: 'Я подтвердил(а) почту', onclick: function () {
          storage.refreshUser().then(function (u) {
            if (u && u.emailVerified) route(u);
            else toast('Почта ещё не подтверждена. Нажмите ссылку в письме и попробуйте снова.');
          }).catch(saveError);
        } }),
        el('button', { class: 'btn', text: 'Отправить письмо ещё раз', onclick: function () {
          storage.sendVerification().then(function () { toast('Письмо отправлено ещё раз.'); }).catch(saveError);
        } }),
        el('button', { class: 'btn', text: 'Выйти', onclick: doSignOut }))
    ]);
  }

  function renderDenied() {
    var email = state.user && state.user.email || '';
    return authCard('Нет доступа', [
      el('div', { class: 'banner banner-error', text: 'Ваша почта ' + email + ' не входит в список разрешённых. Если вы вошли не под той почтой — выйдите и войдите под другой.' }),
      el('div', { class: 'btn-row' }, el('button', { class: 'btn', text: 'Выйти и войти под другой почтой', onclick: doSignOut }))
    ]);
  }

  function doSignOut() {
    storage.signOut().then(function () { setScreen('login'); }).catch(saveError);
  }

  /* =====================================================================
   * 3. Период и вкладки
   * =================================================================== */
  function bindStaticUi() {
    var yearSel = $('#yearSelect');
    var y = Core.currentQuarter().year;
    for (var i = y - 1; i <= y + 1; i++) yearSel.appendChild(el('option', { value: String(i), text: String(i) }));
    yearSel.value = String(state.year);
    yearSel.addEventListener('change', function () { state.year = +yearSel.value; renderAll(); });

    var seg = $('#quarterSeg');
    for (var q = 1; q <= 4; q++) {
      (function (qq) {
        var b = el('button', { class: 'seg-btn', type: 'button', text: qq + ' квартал', 'aria-pressed': String(state.quarter === qq) });
        b.addEventListener('click', function () { state.quarter = qq; renderAll(); });
        seg.appendChild(b);
      }(q));
    }

    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () { state.tab = btn.getAttribute('data-tab'); renderAll(); });
    });
  }

  function renderStatusBar() {
    var bar = $('#statusBar');
    if (state.screen !== 'app') { bar.hidden = true; return; }
    bar.hidden = false;
    var online = navigator.onLine;
    var txt = online
      ? 'Общая база подключена, вы вошли как ' + (state.user && state.user.email || '')
      : 'Нет связи с общей базой';
    if (state.conn.pending) txt += ' · есть неотправленные изменения';
    bar.textContent = txt;
    bar.className = 'banner status-bar ' + (online ? 'banner-ok' : 'banner-error');
    if (!online) bar.appendChild(el('button', { class: 'btn btn-sm', text: 'Выйти', onclick: doSignOut }));
    else bar.appendChild(el('button', { class: 'btn btn-sm', text: 'Выйти', onclick: doSignOut }));
  }

  function renderAll() {
    if (state.screen !== 'app') return;
    // обновить выбор периода
    $('#yearSelect').value = String(state.year);
    document.querySelectorAll('#quarterSeg .seg-btn').forEach(function (b, i) {
      b.setAttribute('aria-pressed', String(i + 1 === state.quarter));
    });
    document.querySelectorAll('.tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === state.tab;
      b.setAttribute('aria-selected', String(on));
      b.classList.toggle('active', on);
    });
    $('#periodText').textContent = Core.quarterRangeText(state.year, state.quarter) + ' (квартал определяется по дате УПД)';
    renderStatusBar();
    var view = $('#view');
    view.replaceChildren();
    if (state.tab === 'summary') renderSummary(view);
    else if (state.tab === 'sale') renderList(view, 'sale');
    else if (state.tab === 'purchase') renderList(view, 'purchase');
    else if (state.tab === 'data') renderData(view);
    // предложение переноса старых данных
    renderMigrate();
  }

  /* =====================================================================
   * 4. Вкладка «Итоги»
   * =================================================================== */
  function renderSummary(view) {
    var s = Core.summarize(state.docs, state.year, state.quarter);
    var diff = s.diff;
    var head = el('div', { class: 'summary-head' },
      el('h2', { text: 'Сводка по НДС — ' + state.quarter + ' квартал ' + state.year }),
      el('p', { class: 'muted', text: Core.quarterRangeText(state.year, state.quarter) }));

    var big = el('div', { class: 'big-result ' + (diff > 0 ? 'to-pay' : diff < 0 ? 'to-refund' : 'zero') },
      el('div', { class: 'big-label', text: diff > 0 ? 'К уплате в бюджет' : diff < 0 ? 'К возмещению' : 'НДС к уплате / возмещению' }),
      el('div', { class: 'big-sum', text: money(Math.abs(diff)) }),
      diff < 0 ? el('p', { class: 'muted', text: 'Вычетов больше, чем начислений: государство должно вернуть разницу (или зачесть в следующем периоде).' }) : null);

    var rows = [
      ['НДС с продаж (начислено)', money(s.sales.vat)],
      ['НДС по покупкам (к вычету)', '− ' + money(s.purchases.vat)],
      ['Разница', money(diff)]
    ];
    var table = el('table', { class: 'kv' });
    rows.forEach(function (r) { table.appendChild(el('tr', null, el('td', { text: r[0] }), el('td', { text: r[1] }))); });

    var byRate = el('div', { class: 'by-rate' }, el('h3', { text: 'По ставкам' }));
    var rates = Core.RATES;
    rates.forEach(function (r) {
      var sv = (s.sales.byRate[r.key] || {}).vat || 0;
      var pv = (s.purchases.byRate[r.key] || {}).vat || 0;
      if (!sv && !pv) return;
      byRate.appendChild(el('div', { class: 'rate-line' },
        el('span', { text: r.label }),
        el('span', { text: 'продажи ' + money(sv) + ' · покупки ' + money(pv) })));
    });

    var months = el('div', { class: 'months' }, el('h3', { text: 'По месяцам' }));
    s.months.forEach(function (m) {
      months.appendChild(el('div', { class: 'month-line' },
        el('span', { text: Core.monthName(m.month) }),
        el('span', { text: 'начислено ' + money(m.salesVat) + ' · к вычету ' + money(m.purchVat) + ' · ' + (m.diff >= 0 ? '+' : '') + money(m.diff) })));
    });
    months.appendChild(el('p', { class: 'muted', text: 'Разница: плюс — по этому месяцу начислено больше, чем к вычету. Налог платится по итогу всего квартала, а не по месяцам.' }));

    var profit = el('div', { class: 'profit' },
      el('h3', { text: 'Налог на прибыль ' + s.profit.percent + '% — приблизительно' }),
      el('p', { text: 'Продажи без НДС ' + money(s.sales.net) + ' − покупки без НДС ' + money(s.purchases.net) + ' = ' + money(s.profit.base) }),
      el('p', { class: 'big-sum-sm', text: s.profit.negative ? '0 ₽ (убыток или ноль)' : money(s.profit.tax) }),
      el('p', { class: 'muted', text: 'Только оценка: в УПД нет всех расходов (зарплаты, налоги, взносы, аренда и т.д.), поэтому настоящий налог на прибыль будет другим. Точную сумму считает бухгалтер.' }));

    var actions = el('div', { class: 'btn-row' },
      el('button', { class: 'btn', text: 'Скачать квартал для Excel (CSV)', onclick: function () { exportQuarter(); } }),
      el('button', { class: 'btn', text: 'Распечатать сводку', onclick: function () { window.print(); } }));

    view.appendChild(el('div', { class: 'card' }, head, big, table, byRate, months, profit, actions));
  }

  /* =====================================================================
   * 5. Вкладки списков УПД
   * =================================================================== */
  function renderList(view, type) {
    var docs = Core.docsInQuarter(state.docs, state.year, state.quarter, type);
    docs.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : a.number.localeCompare(b.number); });
    var title = TYPE_TITLE[type];
    var head = el('div', { class: 'list-head' },
      el('h2', { text: title }),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', text: '+ Добавить УПД', onclick: function () { openForm(type); } }),
        el('button', { class: 'btn', text: 'Загрузить из файла', onclick: function () { openImport(type); } })));

    if (!docs.length) {
      view.appendChild(el('div', { class: 'card' }, head, el('p', { class: 'muted', text: 'За этот квартал пока нет ни одного УПД.' })));
      return;
    }
    var list = el('div', { class: 'doc-list' });
    docs.forEach(function (d) {
      var c = Core.calcDoc(d);
      list.appendChild(el('div', { class: 'doc-card' },
        el('div', { class: 'doc-main' },
          el('div', { class: 'doc-title', text: Core.formatDate(d.date) + ' · № ' + d.number }),
          el('div', { class: 'doc-partner', text: d.partner + (d.inn ? ' · ИНН ' + d.inn : '') }),
          el('div', { class: 'doc-sum', text: 'Без НДС ' + money(c.net) + ' · НДС ' + money(c.vat) + ' · Итого ' + money(c.gross) })),
        el('div', { class: 'doc-actions' },
          el('button', { class: 'btn btn-sm', text: 'Изменить', onclick: function () { openForm(type, d); } }),
          el('button', { class: 'btn btn-sm btn-danger', text: 'Удалить', onclick: function () { confirmDelete(d); } }))));
    });
    view.appendChild(el('div', { class: 'card' }, head, list));
  }

  /* =====================================================================
   * 6. Окно формы УПД
   * =================================================================== */
  function openForm(type, doc) {
    var isEdit = !!doc;
    doc = doc || { type: type, date: Core.todayISO(), number: '', partner: '', inn: '', mode: 'net', lines: [{ amount: 0, rate: Core.DEFAULT_RATE, vat: null }] };
    var dlg = $('#dlgForm');
    dlg.replaceChildren();
    var title = el('h2', { id: 'formTitle', text: isEdit ? 'Изменить УПД' : 'Добавить УПД' });
    var form = el('form', { id: 'updForm', novalidate: true });

    var iDate = el('input', { class: 'input', id: 'f-date', type: 'date', value: doc.date });
    var iNumber = el('input', { class: 'input', id: 'f-number', type: 'text', value: doc.number, placeholder: 'например 147' });
    var iPartner = el('input', { class: 'input', id: 'f-partner', type: 'text', value: doc.partner, placeholder: type === 'sale' ? 'кому продали' : 'от кого купили' });
    var iInn = el('input', { class: 'input', id: 'f-inn', type: 'text', value: doc.inn, placeholder: '10 или 12 цифр', inputmode: 'numeric' });
    var innHint = el('p', { class: 'muted', text: '10 цифр у организации, 12 — у ИП. Можно оставить пустым.' });

    var modeRadios = el('div', { class: 'radios' });
    ['net', 'gross'].forEach(function (m) {
      var r = el('input', { type: 'radio', name: 'mode', value: m, checked: doc.mode === m });
      modeRadios.appendChild(el('label', null, r, m === 'net' ? 'Без НДС (НДС добавим сверху)' : 'С НДС (НДС выделим из суммы)'));
    });

    var linesBox = el('div', { id: 'linesBox' });
    var preview = el('div', { id: 'linePreview', class: 'preview muted', text: 'Введите сумму — здесь сразу появится расчёт.' });

    function renderLines() {
      linesBox.replaceChildren();
      doc.lines.forEach(function (l, i) {
        var rateSel = el('select', { class: 'input', id: 'rate-' + i });
        Core.RATES.forEach(function (r) { rateSel.appendChild(el('option', { value: r.key, text: r.label, selected: l.rate === r.key })); });
        rateSel.addEventListener('change', function () { l.rate = rateSel.value; updatePreview(); });
        var amtInput = el('input', { class: 'input', id: 'amt-' + i, type: 'text', inputmode: 'decimal', placeholder: 'например 108196,72', value: l.amount ? Core.inputMoney(l.amount) : '' });
        amtInput.addEventListener('input', function () { var k = Core.parseMoney(amtInput.value); l.amount = k || 0; updatePreview(); });
        var vatInput = el('input', { class: 'input', id: 'vat-' + i, type: 'text', inputmode: 'decimal', placeholder: 'оставьте пустым — посчитаем сами', value: l.vat != null ? Core.inputMoney(l.vat) : '' });
        vatInput.addEventListener('input', function () {
          var raw = vatInput.value.trim();
          l.vat = raw ? Core.parseMoney(raw) : null;
          updatePreview();
        });
        linesBox.appendChild(el('div', { class: 'line-row' },
          el('div', { class: 'field' }, el('label', { text: 'Сумма ' + (doc.mode === 'gross' ? 'С НДС' : 'БЕЗ НДС') + ', ₽' }), amtInput),
          el('div', { class: 'field' }, el('label', { text: 'Ставка НДС' }), rateSel),
          el('div', { class: 'field' }, el('label', { text: 'НДС (если в документе другой)' }), vatInput),
          doc.lines.length > 1 ? el('button', { type: 'button', class: 'btn btn-sm', text: 'Убрать', onclick: function () { doc.lines.splice(i, 1); renderLines(); updatePreview(); } }) : null));
      });
      linesBox.appendChild(el('button', { type: 'button', class: 'btn', text: '+ Добавить строку', onclick: function () { doc.lines.push({ amount: 0, rate: Core.DEFAULT_RATE, vat: null }); renderLines(); } }));
    }
    function updatePreview() {
      var c = Core.calcDoc(doc);
      preview.textContent = 'Всего по УПД: без НДС ' + money(c.net) + ' · НДС ' + money(c.vat) + ' · итого ' + money(c.gross);
    }
    renderLines();
    updatePreview();

    form.appendChild(el('div', { class: 'field' }, el('label', { for: 'f-date', text: 'Дата УПД' }), iDate, errEl('date')));
    form.appendChild(el('div', { class: 'field' }, el('label', { for: 'f-number', text: 'Номер УПД' }), iNumber, errEl('number')));
    form.appendChild(el('div', { class: 'field' }, el('label', { for: 'f-partner', text: 'Контрагент' }), iPartner, errEl('partner')));
    form.appendChild(el('div', { class: 'field' }, el('label', { for: 'f-inn', text: 'ИНН контрагента' }), iInn, innHint, errEl('inn')));
    form.appendChild(el('div', { class: 'field' }, el('label', { text: 'Сумма в УПД указана:' }), modeRadios,
      el('p', { class: 'muted', text: 'Смотрите в документе: «Стоимость без налога» или «Стоимость с налогом».' })));
    form.appendChild(el('div', { class: 'field' }, el('label', { text: 'Строки УПД' }), linesBox, errEl('lines')));
    form.appendChild(preview);
    form.appendChild(el('p', { class: 'muted', text: 'Суммы считаются в копейках с точным округлением до копейки.' }));

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      doc.date = iDate.value;
      doc.number = iNumber.value;
      doc.partner = iPartner.value;
      doc.inn = iInn.value;
      doc.mode = (form.querySelector('input[name=mode]:checked') || {}).value || 'net';
      var v = Core.validateDoc(doc);
      clearErrors();
      if (Object.keys(v.errors).length) {
        Object.keys(v.errors).forEach(function (k) { showErr(k, v.errors[k]); });
        return;
      }
      if (v.warnings.length) {
        // можно сохранить, но показываем
        if (!confirm(v.warnings.join('\n') + '\n\nВсё равно сохранить?')) return;
      }
      var dup = state.docs.some(function (x) { return x.id !== doc.id && Core.docKey(x) === Core.docKey(doc) && x.type === doc.type; });
      if (dup) { showErr('number', 'Такой УПД уже есть (та же дата, номер и контрагент). Проверьте номер или дату.'); return; }
      if (!doc.id) doc.id = Core.newId();
      storage.put(doc).then(function () {
        dlg.close();
        toast('Сохранено');
      }).catch(saveError);
    });

    dlg.appendChild(title);
    dlg.appendChild(form);
    dlg.appendChild(el('div', { class: 'btn-row' },
      el('button', { type: 'submit', form: 'updForm', class: 'btn btn-primary', text: 'Сохранить' }),
      el('button', { type: 'button', class: 'btn', text: 'Отмена', onclick: function () { dlg.close(); } })));
    dlg.showModal();
  }

  function errEl(key) { return el('p', { class: 'field-error', id: 'err-' + key, hidden: true }); }
  function showErr(key, text) {
    var e = document.getElementById('err-' + key);
    if (e) { e.textContent = text; e.hidden = false; }
  }
  function clearErrors() { document.querySelectorAll('.field-error').forEach(function (e) { e.hidden = true; }); }

  /* =====================================================================
   * 7. Подтверждение удаления
   * =================================================================== */
  function confirmDelete(doc) {
    var dlg = $('#dlgConfirm');
    dlg.replaceChildren();
    dlg.appendChild(el('h2', { id: 'confirmTitle', text: 'Удалить УПД?' }));
    dlg.appendChild(el('p', { text: 'Будет удалено УПД: ' + Core.formatDate(doc.date) + ' № ' + doc.number + ', ' + doc.partner + '. УПД исчезнет у всех, кто работает с сайтом. Вернуть удалённое не получится (только из резервной копии).' }));
    dlg.appendChild(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-danger', text: 'Да, удалить', onclick: function () {
        storage.remove(doc.id).then(function () { dlg.close(); toast('УПД удалён'); }).catch(saveError);
      } }),
      el('button', { class: 'btn', text: 'Отмена', onclick: function () { dlg.close(); } })));
    dlg.showModal();
  }

  /* =====================================================================
   * 8. Импорт CSV
   * =================================================================== */
  function openImport(type) {
    var dlg = $('#dlgImport');
    dlg.replaceChildren();
    dlg.appendChild(el('h2', { id: 'importTitle', text: 'Загрузить из файла' }));
    dlg.appendChild(el('p', { text: 'Выберите файл CSV (из 1С или Excel). Сначала мы покажем, что получится, и только потом добавим — ничего не изменится без вашего подтверждения.' }));
    dlg.appendChild(el('p', { class: 'muted', text: 'Дата; Номер; Контрагент; ИНН; Сумма без НДС; Ставка НДС; НДС; Итого. Разделитель — точка с запятой или запятая. Суммы можно писать с запятой: 108196,72.' }));
    var fileIn = el('input', { type: 'file', accept: '.csv,text/csv', id: 'csvFile' });
    var previewBox = el('div', { id: 'importPreview' });
    var addBtn = el('button', { class: 'btn btn-primary', text: 'Добавить', disabled: true });
    var parsed = null;

    fileIn.addEventListener('change', function () {
      var f = fileIn.files[0]; if (!f) return;
      readFileText(f).then(function (text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        try { parsed = Csv.parseImport(text, type); }
        catch (e) {
          if (String(e.message) === 'xlsx') { previewBox.textContent = 'Это файл Excel (.xlsx). Откройте его в Excel и сохраните как «CSV (разделитель — точка с запятой)», затем загрузите снова.'; addBtn.disabled = true; return; }
          throw e;
        }
        var plan = Core.planMerge(state.docs.filter(function (d) { return d.type === type; }), parsed.docs);
        previewBox.replaceChildren();
        previewBox.appendChild(el('p', { text: 'Будет добавлено: ' + plan.fresh.length + '. Уже есть (пропустим): ' + plan.duplicates + '. С ошибками (пропустим): ' + parsed.errors.length + '.' }));
        if (parsed.errors.length) {
          var ul = el('ul');
          parsed.errors.slice(0, 8).forEach(function (er) { ul.appendChild(el('li', { text: 'Строка ' + er.row + ': ' + er.text })); });
          previewBox.appendChild(ul);
        }
        addBtn.disabled = !plan.fresh.length;
        addBtn.onclick = function () {
          storage.putMany(plan.fresh).then(function () {
            dlg.close();
            toast('Добавлено ' + plan.fresh.length + ' УПД');
          }).catch(saveError);
        };
      }).catch(function (e) { previewBox.textContent = 'Не удалось прочитать файл: ' + (e.message || e); });
    });

    dlg.appendChild(fileIn);
    dlg.appendChild(el('div', { class: 'btn-row' },
      el('button', { class: 'btn', text: 'Скачать шаблон', onclick: function () { download('shablon-upd.csv', Csv.template(), 'text/csv', true); } }),
      el('button', { class: 'btn', text: 'Выбрать другой файл', onclick: function () { fileIn.value = ''; previewBox.replaceChildren(); addBtn.disabled = true; } })));
    dlg.appendChild(previewBox);
    dlg.appendChild(el('div', { class: 'btn-row' }, addBtn, el('button', { class: 'btn', text: 'Отмена', onclick: function () { dlg.close(); } })));
    dlg.showModal();
  }

  /* =====================================================================
   * 9. Экспорт и печать
   * =================================================================== */
  function exportQuarter() {
    var docs = Core.docsInQuarter(state.docs, state.year, state.quarter);
    var csv = Csv.exportQuarter(docs, state.year, state.quarter);
    download('upd-' + state.year + '-q' + state.quarter + '.csv', csv, 'text/csv', true);
    toast('Файл для Excel скачан');
  }

  /* =====================================================================
   * 10. Вкладка «Копия данных»
   * =================================================================== */
  function renderData(view) {
    var sales = state.docs.filter(function (d) { return d.type === 'sale'; }).length;
    var purch = state.docs.length - sales;
    var last = state.meta.lastBackup || 'ещё не делали на этом устройстве';
    view.appendChild(el('div', { class: 'card' },
      el('h2', { text: 'Резервная копия данных' }),
      el('p', { text: 'Сейчас записано: наших УПД — ' + sales + ', УПД поставщиков — ' + purch + '.' }),
      el('p', { class: 'muted', text: 'Последняя копия: ' + last }),
      el('p', { text: 'Где лежат данные: в общей базе (Firebase) — видна всем, кто вошёл по почте и паролю.' }),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', text: 'Сохранить резервную копию', onclick: saveBackup }),
        el('button', { class: 'btn', text: 'Добавить данные из копии', onclick: openRestore }),
        el('button', { class: 'btn btn-danger', text: 'Удалить все данные…', onclick: confirmWipe }))));
  }

  function saveBackup() {
    var data = { version: 2, exportedAt: new Date().toISOString(), docs: state.docs };
    download('neit-upd-kopiya-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data, null, 2), 'application/json');
    var meta = Object.assign({}, state.meta, { lastBackup: new Date().toLocaleString('ru') });
    storage.setMeta(meta).then(function () { state.meta = meta; renderAll(); toast('Резервная копия скачана'); });
  }

  function openRestore() {
    var dlg = $('#dlgImport');
    dlg.replaceChildren();
    dlg.appendChild(el('h2', { text: 'Добавить данные из копии?' }));
    dlg.appendChild(el('p', { text: 'Сайт покажет, сколько УПД из копии новые, а сколько уже есть — и добавит только новые, без дублей. Существующие записи не меняются и не удаляются.' }));
    var fileIn = el('input', { type: 'file', accept: '.json,application/json' });
    var info = el('div');
    var btn = el('button', { class: 'btn btn-primary', text: 'Добавить', disabled: true });
    fileIn.addEventListener('change', function () {
      var f = fileIn.files[0]; if (!f) return;
      f.text().then(function (text) {
        var data;
        try { data = JSON.parse(text); } catch (e) { info.textContent = 'Это не файл резервной копии этого сайта.'; return; }
        var incoming = (data.docs || []).map(Core.normalizeDoc).filter(Boolean);
        var plan = Core.planMerge(state.docs, incoming);
        info.textContent = 'В копии УПД: ' + incoming.length + '. Новых для общей базы: ' + plan.fresh.length + '. Уже есть в базе (пропустим): ' + plan.duplicates + '.';
        btn.disabled = !plan.fresh.length;
        btn.onclick = function () {
          storage.putMany(plan.fresh).then(function () { dlg.close(); toast('Добавлено ' + plan.fresh.length + ' УПД'); }).catch(saveError);
        };
      });
    });
    dlg.appendChild(fileIn);
    dlg.appendChild(info);
    dlg.appendChild(el('div', { class: 'btn-row' }, btn, el('button', { class: 'btn', text: 'Отмена', onclick: function () { dlg.close(); } })));
    dlg.showModal();
  }

  function confirmWipe() {
    var dlg = $('#dlgConfirm');
    dlg.replaceChildren();
    dlg.appendChild(el('h2', { text: 'Удалить ВСЕ данные из общей базы?' }));
    dlg.appendChild(el('p', { text: 'Удаляет ВСЕ УПД из общей базы — они пропадут у всех. Сначала сохраните резервную копию. Чтобы подтвердить, введите слово УДАЛИТЬ.' }));
    var input = el('input', { class: 'input', placeholder: 'УДАЛИТЬ' });
    dlg.appendChild(input);
    dlg.appendChild(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-danger', text: 'Да, удалить всё', onclick: function () {
        if (input.value !== 'УДАЛИТЬ') { toast('Введите слово УДАЛИТЬ'); return; }
        storage.replaceAll([]).then(function () { dlg.close(); toast('Все данные удалены'); }).catch(saveError);
      } }),
      el('button', { class: 'btn', text: 'Отмена', onclick: function () { dlg.close(); } })));
    dlg.showModal();
  }

  /* =====================================================================
   * Перенос старых данных с устройства
   * =================================================================== */
  function renderMigrate() {
    var box = $('#migrateBox');
    if (!state.legacyDocs.length || state.meta.migrated) { box.hidden = true; return; }
    var plan = Core.planMerge(state.docs, state.legacyDocs);
    box.hidden = false;
    box.className = 'banner banner-warn';
    box.replaceChildren();
    box.appendChild(el('p', { text: 'На этом устройстве есть старые УПД (' + state.legacyDocs.length + '), записанные до подключения общей базы. Новых для общей базы: ' + plan.fresh.length + '. Уже есть в базе (пропустим): ' + plan.duplicates + '. После переноса их увидят все, кто вошёл. На этом устройстве копия останется.' }));
    box.appendChild(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', text: 'Перенести данные с этого устройства в общую базу', onclick: function () {
        storage.putMany(plan.fresh).then(function () {
          var meta = Object.assign({}, state.meta, { migrated: true });
          return storage.setMeta(meta).then(function () { state.meta = meta; toast('Перенесено ' + plan.fresh.length + ' УПД'); renderAll(); });
        }).catch(saveError);
      } }),
      el('button', { class: 'btn', text: 'Да, не переносить', onclick: function () {
        if (!confirm('Отметить перенос выполненным и убрать это сообщение?\n\nСтарые данные останутся только на этом устройстве, и это предложение больше не появится. Их можно будет сохранить файлом резервной копии, пока вы не очистите данные браузера.')) return;
        var meta = Object.assign({}, state.meta, { migrated: true });
        storage.setMeta(meta).then(function () { state.meta = meta; renderAll(); });
      } })));
  }

  start();
}());
