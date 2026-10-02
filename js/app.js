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
  var unsubscribe = null, lastSig = null, draftEmail = '';

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
    if (!user) { setScreen('login'); return; }
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

  function renderLogin(message) {
    var emailIn = el('input', { class: 'input', id: 'authEmail', type: 'email', autocomplete: 'username', inputmode: 'email', placeholder: 'name@mail.ru', value: draftEmail });
    var passIn = el('input', { class: 'input', id: 'authPassword', type: 'password', autocomplete: 'current-password', placeholder: 'пароль' });
    var showPass = el('input', { type: 'checkbox', id: 'authShow' });
    showPass.addEventListener('change', function () { passIn.type = showPass.checked ? 'text' : 'password'; });
    var errBox = el('div', { class: 'banner banner-error', role: 'alert', id: 'authError', hidden: true });
    var okBox = el('div', { class: 'banner banner-ok', role: 'status', id: 'authInfo', hidden: !message, text: message || '' });
    var bIn = el('button', { type: 'submit', class: 'btn btn-primary', id: 'btnSignIn', text: 'Войти' });
    var bUp = el('button', { type: 'button', class: 'btn', id: 'btnSignUp', text: 'Создать аккаунт' });
    var bForgot = el('button', { type: 'button', class: 'link', id: 'btnForgot', text: 'Забыли пароль?' });

    function fail(text) { errBox.textContent = text; errBox.hidden = false; okBox.hidden = true; }
    function busy(on) { [bIn, bUp, bForgot].forEach(function (b) { b.disabled = on; }); }
    function readEmail() {
      draftEmail = emailIn.value.trim();
      emailIn.classList.remove('invalid'); passIn.classList.remove('invalid');
      if (!draftEmail) { emailIn.classList.add('invalid'); emailIn.focus(); fail('Введите адрес почты.'); return null; }
      if (!EMAIL_RE.test(draftEmail)) { emailIn.classList.add('invalid'); emailIn.focus(); fail('Адрес почты написан неправильно. Пример: name@mail.ru'); return null; }
      errBox.hidden = true;
      return draftEmail;
    }
    function run(promise, onOk) {
      busy(true);
      promise.then(function (r) { busy(false); if (onOk) onOk(r); }, function (e) {
        busy(false);
        if (e && e.accountCreated) { state.verifyNotice = 'Аккаунт создан, но письмо отправить не удалось. ' + window.NeitFirebaseAdapter.explainError(e, 'auth') + ' Нажмите «Отправить письмо ещё раз».'; if (state.screen === 'verify') setScreen('verify'); return; }
        fail(window.NeitFirebaseAdapter.explainError(e, 'auth'));
      });
    }

    var form = el('form', { novalidate: true, id: 'authForm' },
      okBox, errBox,
      el('div', { class: 'field' }, el('label', { for: 'authEmail', text: 'Почта' }), emailIn),
      el('div', { class: 'field' }, el('label', { for: 'authPassword', text: 'Пароль' }), passIn,
        el('label', { class: 'check', for: 'authShow' }, showPass, 'Показать пароль')),
      el('div', { class: 'btn-row' }, bIn, bUp),
      el('p', null, bForgot),
      el('p', { class: 'hint', text: 'Войти могут только сотрудники, чья почта добавлена в список. Если вы здесь впервые: нажмите «Создать аккаунт», подтвердите почту по ссылке из письма и сообщите Андрею, какую почту вы указали — он добавит её в список.' }));

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = readEmail(); if (!email) return;
      if (!passIn.value) { passIn.classList.add('invalid'); passIn.focus(); fail('Введите пароль.'); return; }
      run(storage.signIn(email, passIn.value));
    });
    bUp.addEventListener('click', function () {
      var email = readEmail(); if (!email) return;
      if (passIn.value.length < 8) { passIn.classList.add('invalid'); passIn.focus(); fail('Придумайте пароль: не меньше 8 символов.'); return; }
      state.verifyNotice = '';
      run(storage.signUp(email, passIn.value), function () {
        state.verifyNotice = 'Мы отправили письмо на ' + email + '.';
        if (state.screen === 'verify') setScreen('verify');
      });
    });
    bForgot.addEventListener('click', function () {
      var email = readEmail(); if (!email) return;
      run(storage.resetPassword(email), function () {
        okBox.textContent = 'Если эта почта зарегистрирована, мы отправили на неё письмо со ссылкой для нового пароля. Проверьте и папку «Спам».';
        okBox.hidden = false;
      });
    });
    return authCard('Вход', [form]);
  }

  function renderVerify() {
    var email = state.user ? state.user.email : '';
    var info = el('div', { class: 'banner banner-ok', role: 'status', id: 'verifyNotice', hidden: !state.verifyNotice, text: state.verifyNotice });
    var msg = el('div', { class: 'banner banner-warn', role: 'alert', id: 'verifyMsg', hidden: true });
    var bCheck = el('button', { class: 'btn btn-primary', id: 'btnVerified', text: 'Я подтвердил(а) почту' });
    var bResend = el('button', { class: 'btn', id: 'btnResend', text: 'Отправить письмо ещё раз' });
    function say(t, ok) { msg.textContent = t; msg.className = 'banner ' + (ok ? 'banner-ok' : 'banner-warn'); msg.hidden = false; }
    function busy(on) { bCheck.disabled = on; bResend.disabled = on; }
    bCheck.addEventListener('click', function () {
      busy(true);
      storage.refreshUser().then(function (u) {
        busy(false);
        if (u && u.emailVerified) route(u);
        else say('Почта ещё не подтверждена. Откройте письмо и нажмите на ссылку в нём (проверьте папку «Спам»), потом нажмите эту кнопку снова.', false);
      }, function (e) { busy(false); say(window.NeitFirebaseAdapter.explainError(e, 'auth'), false); });
    });
    bResend.addEventListener('click', function () {
      busy(true);
      storage.sendVerification().then(function () { busy(false); say('Письмо отправлено ещё раз на ' + email + '.', true); },
        function (e) { busy(false); say(window.NeitFirebaseAdapter.explainError(e, 'auth'), false); });
    });
    return authCard('Подтвердите почту', [
      info,
      el('p', null, 'Вы вошли как ', el('b', { text: email }), '. Чтобы получить доступ к данным, почту нужно подтвердить.'),
      el('ol', null,
        el('li', { text: 'Откройте письмо от Firebase (проверьте и папку «Спам»).' }),
        el('li', { text: 'Нажмите в письме на ссылку подтверждения.' }),
        el('li', { text: 'Вернитесь сюда и нажмите «Я подтвердил(а) почту» — или выйдите и войдите заново.' })),
      msg,
      el('div', { class: 'btn-row' }, bCheck, bResend, el('button', { class: 'btn', id: 'btnLogoutVerify', text: 'Выйти', onclick: doSignOut }))]);
  }

  function renderDenied() {
    var email = state.user ? state.user.email : '';
    var msg = el('div', { class: 'banner banner-warn', hidden: true, id: 'deniedMsg' });
    var bRetry = el('button', { class: 'btn btn-primary', id: 'btnRetry', text: 'Проверить ещё раз', onclick: function () {
      bRetry.disabled = true;
      storage.refreshUser().then(function (u) { route(u); }, function (e) { bRetry.disabled = false; msg.textContent = window.NeitFirebaseAdapter.explainError(e, 'auth'); msg.hidden = false; });
    } });
    return authCard('Нет доступа', [
      el('div', { class: 'banner banner-error', role: 'alert', id: 'deniedText', text: 'Нет доступа: ваш email не в списке разрешённых.' }),
      el('p', null, 'Вы вошли как ', el('b', { text: email }), '. Сообщите Андрею эту почту — он добавит её в список. После этого нажмите «Проверить ещё раз».'),
      msg,
      el('div', { class: 'btn-row' }, bRetry, el('button', { class: 'btn', id: 'btnLogoutDenied', text: 'Выйти и войти под другой почтой', onclick: doSignOut }))]);
  }

  function doSignOut() {
    storage.signOut().catch(function (e) { toast(window.NeitFirebaseAdapter.explainError(e, 'auth')); });
  }

  /** Строка состояния: «Общая база подключена, вы вошли как …» + кнопка «Выйти». */
  function renderStatusBar() {
    var b = $('#statusBar');
    b.replaceChildren();
    if (!state.user || state.screen !== 'app') { b.hidden = true; return; }
    var offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || (state.loaded && state.conn.fromCache);
    var text, cls;
    if (offline) { cls = 'banner-warn'; text = 'Нет связи с общей базой — показаны последние полученные данные; изменения не сохранятся, пока нет интернета. '; }
    else if (state.conn.pending) { cls = 'banner-warn'; text = 'Отправляем изменения в общую базу… '; }
    else { cls = 'banner-ok'; text = 'Общая база подключена, '; }
    b.className = 'banner status-bar ' + cls;
    b.appendChild(el('span', { id: 'statusText' }, text + 'вы вошли как ', el('b', { text: state.user.email })));
    b.appendChild(el('button', { class: 'btn btn-small', id: 'btnSignOut', text: 'Выйти', onclick: doSignOut }));
    b.hidden = false;
  }

  /* =====================================================================
   * 3. Период, вкладки, баннер
   * =================================================================== */
  function bindStaticUi() {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.dataset.tab; renderAll(); window.scrollTo(0, 0); });
    });
    $('#yearSelect').addEventListener('change', function (e) { state.year = +e.target.value; renderAll(); });
  }

  function renderAll() {
    if (state.screen !== 'app') return;
    renderStatusBar();
    renderMigrate();
    renderPeriod();
    document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === state.tab ? 'true' : 'false'); });
    var view = $('#view');
    view.replaceChildren();
    if (!state.loaded) { view.appendChild(el('div', { class: 'card empty', id: 'viewLoading' }, el('p', { text: 'Загружаем данные из общей базы…' }))); return; }
    if (state.tab === 'summary') view.appendChild(renderSummary());
    else if (state.tab === 'data') view.appendChild(renderDataTab());
    else view.appendChild(renderList(state.tab));
  }

  /* Предложение перенести старые данные с этого устройства (кнопкой, не автоматически). */
  function renderMigrate() {
    var box = $('#migrateBox');
    box.replaceChildren();
    var m = state.legacyMeta || {};
    if (!state.loaded || !state.legacyDocs.length || m.migratedAt || m.migrateDismissed) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('div', { class: 'banner banner-warn', id: 'migrateBanner' },
      el('p', null, el('b', { text: 'На этом устройстве есть старые данные: ' + state.legacyDocs.length + ' УПД. ' }),
        'Они сохранены только в этом браузере. Чтобы Наташа и Настя их видели, перенесите их в общую базу. Дубли пропустим.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', id: 'btnMigrate', text: 'Перенести данные с этого устройства в общую базу', onclick: migrateLegacy }),
        el('button', { class: 'btn', id: 'btnMigrateHide', text: 'Не переносить', onclick: dismissMigrate }))));
  }

  /** Делит УПД на подходящие для базы и неполные (без номера/контрагента, слишком длинные поля). */
  function splitStorable(docs) {
    var ok = [], bad = 0;
    docs.forEach(function (d) {
      var e = Core.validateDoc(d).errors;
      if (e.date || e.number || e.partner || e.inn || e.lines) bad++; else ok.push(d);
    });
    return { ok: ok, bad: bad };
  }

  function saveLegacyMeta(patch) {
    state.legacyMeta = Object.assign({}, state.legacyMeta, patch);
    return legacy.setMeta(state.legacyMeta).catch(function () {});
  }

  function dismissMigrate() {
    confirmDialog({ title: 'Не переносить данные?', text: 'Старые данные останутся только на этом устройстве, и это предложение больше не появится. Их можно будет сохранить файлом резервной копии, пока вы не очистите данные браузера.', okText: 'Да, не переносить' })
      .then(function (ok) { if (ok) saveLegacyMeta({ migrateDismissed: new Date().toISOString() }).then(renderAll); });
  }

  function migrateLegacy() {
    var split = splitStorable(state.legacyDocs);
    var plan = Core.planMerge(state.docs, split.ok);
    var text = 'На этом устройстве найдено УПД: ' + state.legacyDocs.length + '. Новых для общей базы: ' + plan.fresh.length +
      '. Уже есть в базе (пропустим): ' + plan.duplicates + (split.bad ? '. Неполных (пропустим): ' + split.bad : '') + '.';
    if (!plan.fresh.length) {
      confirmDialog({ title: 'Переносить нечего', text: text + ' Отметить перенос выполненным и убрать это сообщение?', okText: 'Да, убрать' })
        .then(function (ok) { if (ok) saveLegacyMeta({ migratedAt: new Date().toISOString() }).then(renderAll); });
      return;
    }
    confirmDialog({ title: 'Перенести данные в общую базу?', text: text + ' После переноса их увидят все, кто вошёл. На этом устройстве копия останется.', okText: 'Перенести: ' + plan.fresh.length })
      .then(function (ok) {
        if (!ok) return;
        $('#btnMigrate') && ($('#btnMigrate').disabled = true);
        storage.putMany(plan.fresh).then(reload)
          .then(function () { return saveLegacyMeta({ migratedAt: new Date().toISOString() }); })
          .then(function () { renderAll(); toast('Перенесено УПД: ' + plan.fresh.length); })
          .catch(function (e) { $('#btnMigrate') && ($('#btnMigrate').disabled = false); saveError(e); });
      });
  }

  function renderPeriod() {
    var sel = $('#yearSelect');
    var years = state.docs.map(function (d) { return +d.date.slice(0, 4); });
    var min = Math.min.apply(null, years.concat([cq.year - 1, state.year]));
    var max = Math.max.apply(null, years.concat([cq.year + 1, state.year]));
    sel.replaceChildren();
    for (var y = max; y >= min; y--) sel.appendChild(el('option', { value: y, text: String(y) }));
    sel.value = String(state.year);
    var seg = $('#quarterSeg');
    seg.replaceChildren();
    [1, 2, 3, 4].forEach(function (q) {
      seg.appendChild(el('button', {
        type: 'button', 'aria-pressed': String(q === state.quarter), text: q + ' кв.',
        onclick: function () { state.quarter = q; renderAll(); }
      }));
    });
    $('#periodText').textContent = state.quarter + ' квартал ' + state.year + ': ' + Core.quarterRangeText(state.year, state.quarter) +
      ' (квартал определяется по дате УПД)';
  }

  /* =====================================================================
   * 4. Вкладка «Итоги»
   * =================================================================== */
  function signed(k) { return (k > 0 ? '+' : '') + Core.formatMoney(k); }

  function renderSummary() {
    var s = Core.summarize(state.docs, state.year, state.quarter);
    var root = el('div');
    var title = state.quarter + ' квартал ' + state.year;

    // Заголовок только для печати
    root.appendChild(el('div', { class: 'print-only' },
      el('h2', { text: 'Сводка по НДС — ' + Core.COMPANY.name + ' (ИНН ' + Core.COMPANY.inn + ')' }),
      el('p', { text: title + ' · сформировано ' + Core.formatDate(Core.todayISO()) })));

    if (!s.sales.count && !s.purchases.count) {
      root.appendChild(el('div', { class: 'card empty no-print' },
        el('p', { text: 'За ' + title + ' пока нет ни одного УПД.' }),
        el('p', { text: 'Добавьте УПД во вкладках «Наши УПД» и «УПД поставщиков» — итог появится здесь сам.' })));
    }

    // Главный результат
    var cls = s.diff > 0 ? 'pay' : (s.diff < 0 ? 'refund' : '');
    var label = s.diff > 0 ? 'К уплате в бюджет (НДС за ' + title + ')' : (s.diff < 0 ? 'К возмещению из бюджета (НДС за ' + title + ')' : 'НДС за ' + title);
    root.appendChild(el('div', { class: 'card result ' + cls, id: 'resultCard' },
      el('div', { class: 'label', text: label }),
      el('div', { class: 'amount', id: 'resultAmount', text: money(Math.abs(s.diff)) }),
      el('div', { class: 'formula', text: 'НДС с продаж ' + money(s.sales.vat) + ' − НДС по покупкам ' + money(s.purchases.vat) + ' = ' + money(s.diff) }),
      s.diff < 0 ? el('div', { class: 'formula', text: 'Вычетов больше, чем начислений: государство должно вернуть разницу (или зачесть в следующем периоде).' }) : null));

    root.appendChild(el('div', { class: 'grid-2' },
      kpi('НДС с продаж (начислено)', s.sales.vat, 'Наших УПД: ' + s.sales.count + ' · продажи без НДС ' + money(s.sales.net), 'kpiSales'),
      kpi('НДС по покупкам (к вычету)', s.purchases.vat, 'УПД поставщиков: ' + s.purchases.count + ' · покупки без НДС ' + money(s.purchases.net), 'kpiPurchases')));

    // По ставкам
    var keys = Core.RATES.map(function (r) { return r.key; }).filter(function (k) { return s.sales.byRate[k] || s.purchases.byRate[k]; });
    var card1 = el('div', { class: 'card' }, el('h2', { text: 'По ставкам НДС' }));
    if (!keys.length) card1.appendChild(el('p', { class: 'muted', text: 'Нет данных за этот квартал.' }));
    else {
      var tb = el('tbody');
      keys.forEach(function (k) {
        var a = s.sales.byRate[k] || { net: 0, vat: 0 }, p = s.purchases.byRate[k] || { net: 0, vat: 0 };
        tb.appendChild(el('tr', null, el('td', { text: Core.rateLabel(k) }), el('td', { text: Core.formatMoney(a.net) }), el('td', { text: Core.formatMoney(a.vat) }),
          el('td', { text: Core.formatMoney(p.net) }), el('td', { text: Core.formatMoney(p.vat) })));
      });
      card1.appendChild(el('div', { class: 'table-scroll' }, el('table', { id: 'rateTable' },
        el('thead', null, el('tr', null, el('th', { text: 'Ставка' }), el('th', { text: 'Продажи без НДС' }), el('th', { text: 'НДС с продаж' }), el('th', { text: 'Покупки без НДС' }), el('th', { text: 'НДС по покупкам' }))),
        tb,
        el('tfoot', null, el('tr', null, el('td', { text: 'Всего' }), el('td', { text: Core.formatMoney(s.sales.net) }), el('td', { text: Core.formatMoney(s.sales.vat) }),
          el('td', { text: Core.formatMoney(s.purchases.net) }), el('td', { text: Core.formatMoney(s.purchases.vat) }))))));
    }
    root.appendChild(card1);

    // По месяцам
    var mb = el('tbody');
    s.months.forEach(function (m) {
      mb.appendChild(el('tr', null, el('td', { text: Core.monthName(m.month).replace(/^./, function (c) { return c.toUpperCase(); }) }),
        el('td', { text: Core.formatMoney(m.salesVat) }), el('td', { text: Core.formatMoney(m.purchVat) }),
        el('td', { class: m.diff > 0 ? 'pos' : (m.diff < 0 ? 'neg' : ''), text: signed(m.diff) })));
    });
    root.appendChild(el('div', { class: 'card' }, el('h2', { text: 'По месяцам квартала' }),
      el('div', { class: 'table-scroll' }, el('table', { id: 'monthTable' },
        el('thead', null, el('tr', null, el('th', { text: 'Месяц' }), el('th', { text: 'НДС с продаж' }), el('th', { text: 'НДС по покупкам' }), el('th', { text: 'Разница' }))),
        mb)),
      el('p', { class: 'muted', text: 'Разница: плюс — по этому месяцу начислено больше, чем к вычету. Налог платится по итогу всего квартала, а не по месяцам.' })));

    // Налог на прибыль
    var pr = s.profit;
    root.appendChild(el('div', { class: 'card', id: 'profitCard' }, el('h2', { text: 'Налог на прибыль ' + pr.percent + '% — приблизительно' }),
      el('table', null, el('tbody', null,
        el('tr', null, el('td', { text: 'Продажи без НДС' }), el('td', { text: money(s.sales.net) })),
        el('tr', null, el('td', { text: '− Покупки без НДС' }), el('td', { text: money(s.purchases.net) })),
        el('tr', null, el('td', { text: '= Прибыль до налога (оценка)' }), el('td', { text: money(pr.base) })),
        el('tr', null, el('td', { text: 'Налог ' + pr.percent + '%' }), el('td', { id: 'profitTax', text: money(pr.tax) })))),
      pr.negative && (s.sales.count || s.purchases.count) ? el('p', { class: 'muted', text: 'Покупки по УПД больше или равны продажам — по этой оценке налог 0 ₽ (отрицательным он не бывает).' }) : null,
      el('p', { class: 'warn-text', text: 'Только оценка: в УПД нет всех расходов (зарплаты, налоги, взносы, аренда и т.д.), поэтому настоящий налог на прибыль будет другим. Точную сумму считает бухгалтер.' })));

    // Кнопки
    root.appendChild(el('div', { class: 'btn-row no-print' },
      el('button', { class: 'btn btn-primary', id: 'btnExport', text: 'Скачать квартал для Excel (CSV)', onclick: exportQuarter }),
      el('button', { class: 'btn', id: 'btnPrint', text: 'Распечатать сводку', onclick: function () { window.print(); } })));

    root.appendChild(el('details', { class: 'card help no-print' }, el('summary', { text: 'Как это считается? (простыми словами)' }),
      el('ul', null,
        el('li', { text: 'НДС с продаж — налог, который мы выставили покупателям в наших УПД. Его нужно заплатить государству.' }),
        el('li', { text: 'НДС по покупкам — налог, который поставщики указали в своих УПД. Его можно вычесть из того, что мы платим (если документы оформлены правильно).' }),
        el('li', { text: 'К уплате = НДС с продаж − НДС по покупкам. Если получилось меньше нуля — это «К возмещению».' }),
        el('li', { text: 'Квартал берётся по дате УПД. Сколько вычета принять в этом квартале, окончательно решает бухгалтер.' }),
        el('li', { text: 'Обычно декларацию по НДС сдают до 25-го числа месяца после квартала, а налог платят тремя равными частями до 28-го числа каждого из следующих трёх месяцев. Сроки лучше уточнить у бухгалтера.' }),
        el('li', { text: 'Суммы считаются в копейках с точным округлением до копейки.' }))));
    return root;
  }

  function kpi(label, amount, sub, id) {
    return el('div', { class: 'card kpi' }, el('div', { class: 'label', text: label }), el('div', { class: 'amount', id: id, text: money(amount) }), el('div', { class: 'muted', text: sub }));
  }

  /* =====================================================================
   * 5. Списки УПД
   * =================================================================== */
  function renderList(type) {
    var root = el('div');
    var docs = Core.docsInQuarter(state.docs, state.year, state.quarter, type).sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.number < b.number ? 1 : -1);
    });
    root.appendChild(el('h2', { text: TYPE_TITLE[type] + ' — ' + state.quarter + ' кв. ' + state.year }));
    root.appendChild(el('div', { class: 'toolbar' },
      el('button', { class: 'btn btn-primary', id: 'btnAdd', text: '+ Добавить УПД', onclick: function () { openForm(type, null); } }),
      el('button', { class: 'btn', id: 'btnImport', text: 'Загрузить из файла', onclick: function () { openImport(type); } })));

    if (!docs.length) {
      root.appendChild(el('div', { class: 'card empty' }, el('p', { text: 'За этот квартал УПД пока нет.' }),
        el('p', { text: 'Нажмите «+ Добавить УПД» или загрузите файл из 1С / Excel.' })));
      return root;
    }
    var tot = { net: 0, vat: 0, gross: 0 };
    docs.forEach(function (d) { var c = Core.calcDoc(d); tot.net += c.net; tot.vat += c.vat; tot.gross += c.gross; });
    root.appendChild(el('div', { class: 'totals-bar', id: 'listTotals' },
      el('span', { text: 'УПД: ' }, el('b', { text: String(docs.length) })),
      el('span', { text: 'Без НДС: ' }, el('b', { text: money(tot.net) })),
      el('span', { text: 'НДС: ' }, el('b', { text: money(tot.vat) })),
      el('span', { text: 'Итого: ' }, el('b', { text: money(tot.gross) }))));
    docs.forEach(function (d) { root.appendChild(docCard(d)); });
    return root;
  }

  function docCard(d) {
    var c = Core.calcDoc(d);
    var rates = Object.keys(c.byRate).map(function (k) { return Core.rateLabel(k) + ': НДС ' + Core.formatMoney(c.byRate[k].vat); }).join(' · ');
    return el('div', { class: 'doc', 'data-id': d.id },
      el('div', { class: 'doc-top' },
        el('span', { class: 'doc-title', text: '№ ' + d.number + ' от ' + Core.formatDate(d.date) }),
        el('span', { class: 'doc-sub', text: d.partner + (d.inn ? ' · ИНН ' + d.inn : '') })),
      el('div', { class: 'doc-sums' },
        el('div', null, el('span', { class: 'k', text: 'Без НДС' }), el('span', { class: 'v', text: money(c.net) })),
        el('div', null, el('span', { class: 'k', text: 'НДС' }), el('span', { class: 'v', text: money(c.vat) })),
        el('div', null, el('span', { class: 'k', text: 'Итого' }), el('span', { class: 'v', text: money(c.gross) }))),
      el('div', { class: 'doc-lines', text: (d.lines.length > 1 ? 'Строк: ' + d.lines.length + ' · ' : '') + rates }),
      el('div', { class: 'doc-actions' },
        el('button', { class: 'btn btn-small', text: 'Изменить', onclick: function () { openForm(d.type, d); } }),
        el('button', { class: 'btn btn-small btn-danger', text: 'Удалить', onclick: function () { deleteDoc(d); } })));
  }

  function deleteDoc(d) {
    confirmDialog({
      title: 'Удалить УПД?',
      text: '№ ' + d.number + ' от ' + Core.formatDate(d.date) + ', ' + d.partner + ', итого ' + money(Core.calcDoc(d).gross) + '. УПД исчезнет у всех, кто работает с сайтом. Вернуть удалённое не получится (только из резервной копии).',
      okText: 'Да, удалить', danger: true
    }).then(function (ok) {
      if (!ok) return;
      storage.remove(d.id).then(reload).then(function () { renderAll(); toast('УПД удалён'); }).catch(saveError);
    });
  }

  /* =====================================================================
   * 6. Окно «Добавить / изменить УПД»
   * =================================================================== */
  function defaultDateForPeriod() {
    var t = Core.todayISO(), q = Core.quarterOf(t);
    if (q.year === state.year && q.quarter === state.quarter) return t;
    var m = (state.quarter - 1) * 3 + 1;
    return state.year + '-' + (m < 10 ? '0' : '') + m + '-01';
  }

  function openForm(type, doc) {
    var dlg = $('#dlgForm');
    var isSale = type === 'sale';
    var st = doc ? {
      date: doc.date, number: doc.number, partner: doc.partner, inn: doc.inn, mode: doc.mode,
      lines: doc.lines.map(function (l) { return { amount: Core.inputMoney(l.amount), rate: l.rate, vat: l.vat == null ? '' : Core.inputMoney(l.vat) }; })
    } : { date: defaultDateForPeriod(), number: '', partner: '', inn: '', mode: 'net', lines: [{ amount: '', rate: Core.DEFAULT_RATE, vat: '' }] };

    // известные контрагенты — для подсказок при вводе
    var partners = {};
    state.docs.forEach(function (d) { if (d.type === type && !partners[d.partner]) partners[d.partner] = d.inn; });

    var errBox = {};                       // поле → элемент для текста ошибки
    function errEl(name) { return (errBox[name] = el('div', { class: 'err', role: 'alert', hidden: true })); }
    function setErr(name, text) { var e = errBox[name]; if (!e) return; e.textContent = text || ''; e.hidden = !text; }

    var innHint = el('div', { class: 'hint', text: '10 цифр у организации, 12 — у ИП. Можно оставить пустым.' });
    function updateInnHint() {
      var r = Core.checkInn(st.inn);
      innHint.className = (r === 'format' || r === 'checksum') ? 'warn-text' : 'hint';
      innHint.textContent = r === 'format' ? 'ИНН должен быть из 10 или 12 цифр — проверьте. (Сохранить всё равно можно.)'
        : r === 'checksum' ? 'Контрольная цифра не сходится — возможно, опечатка. (Сохранить всё равно можно.)'
        : r === 'ok' ? 'ИНН выглядит правильно.' : '10 цифр у организации, 12 — у ИП. Можно оставить пустым.';
    }

    var linesBox = el('div', { id: 'linesBox' });
    var totalBox = el('div', { class: 'line-preview', id: 'docTotal' });

    function buildDocFromState() {
      var extra = {};
      var lines = st.lines.map(function (l, i) {
        var amount = Core.parseMoney(l.amount);
        var vat = null;
        if (String(l.vat).trim() !== '') {
          vat = Core.parseMoney(l.vat);
          if (vat === null) extra['line-' + i] = 'НДС вручную: введите сумму цифрами или оставьте пустым.';
        }
        return { amount: amount, rate: l.rate, vat: vat };
      });
      return { doc: { type: type, date: st.date, number: st.number, partner: st.partner, inn: st.inn.replace(/\s/g, ''), mode: st.mode, lines: lines }, extra: extra };
    }

    function updatePreviews() {
      var built = buildDocFromState().doc, sum = { net: 0, vat: 0, gross: 0 }, any = false;
      built.lines.forEach(function (l, i) {
        var box = document.getElementById('lp-' + i);
        if (!box) return;
        if (Number.isInteger(l.amount)) {
          var c = Core.calcLine(l, built.mode);
          box.textContent = 'Без НДС ' + money(c.net) + ' · НДС ' + money(c.vat) + ' · Итого ' + money(c.gross);
          sum.net += c.net; sum.vat += c.vat; sum.gross += c.gross; any = true;
        } else box.textContent = 'Введите сумму — здесь сразу появится расчёт.';
      });
      totalBox.textContent = any ? 'Всего по УПД: без НДС ' + money(sum.net) + ' · НДС ' + money(sum.vat) + ' · Итого ' + money(sum.gross) : 'Всего по УПД: —';
    }

    function renderLines() {
      linesBox.replaceChildren();
      st.lines.forEach(function (l, i) {
        var amountLabel = st.mode === 'gross' ? 'Сумма С НДС, ₽' : 'Сумма БЕЗ НДС, ₽';
        var amountInput = el('input', { class: 'input', id: 'amt-' + i, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'например 108196,72', value: l.amount, 'aria-label': amountLabel + ', строка ' + (i + 1) });
        amountInput.addEventListener('input', function () { l.amount = amountInput.value; setErr('line-' + i, ''); amountInput.classList.remove('invalid'); updatePreviews(); });
        var rateSel = el('select', { class: 'input', id: 'rate-' + i, 'aria-label': 'Ставка НДС, строка ' + (i + 1) },
          Core.RATES.map(function (r) { return el('option', { value: r.key, text: r.label }); }));
        rateSel.value = l.rate;
        rateSel.addEventListener('change', function () { l.rate = rateSel.value; updatePreviews(); });
        var vatInput = el('input', { class: 'input', id: 'vat-' + i, type: 'text', inputmode: 'decimal', placeholder: 'оставьте пустым — посчитаем сами', value: l.vat });
        vatInput.addEventListener('input', function () { l.vat = vatInput.value; updatePreviews(); });
        var e = errEl('line-' + i);
        linesBox.appendChild(el('div', { class: 'line-box' },
          el('div', { class: 'line-head' }, el('span', { text: 'Строка ' + (i + 1) }),
            st.lines.length > 1 ? el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Убрать', onclick: function () { st.lines.splice(i, 1); renderLines(); updatePreviews(); } }) : null),
          el('div', { class: 'form-grid' },
            el('div', { class: 'field' }, el('label', { for: 'amt-' + i, text: amountLabel }), amountInput),
            el('div', { class: 'field' }, el('label', { for: 'rate-' + i, text: 'Ставка НДС' }), rateSel)),
          e,
          el('details', null, el('summary', { text: 'НДС не сходится на копейки? Ввести НДС вручную' }),
            el('div', { class: 'field' }, el('label', { for: 'vat-' + i, text: 'НДС по документу, ₽' }), vatInput,
              el('div', { class: 'hint', text: 'Нужно редко: если в самом УПД НДС отличается от расчёта на копейку-две.' }))),
          el('div', { class: 'line-preview', id: 'lp-' + i })));
      });
    }

    function field(labelText, input, name, hintNode) {
      return el('div', { class: 'field' }, el('label', { for: input.id, text: labelText }), input, hintNode || null, name ? errEl(name) : null);
    }
    function bind(input, key, after) {
      input.addEventListener('input', function () { st[key] = input.value; input.classList.remove('invalid'); setErr(key, ''); if (after) after(); });
    }

    var iDate = el('input', { class: 'input', id: 'f-date', type: 'date', value: st.date, required: true });
    var iNum = el('input', { class: 'input', id: 'f-number', type: 'text', value: st.number, autocomplete: 'off', placeholder: 'например 147' });
    var iPartner = el('input', { class: 'input', id: 'f-partner', type: 'text', value: st.partner, autocomplete: 'off', list: 'partnerList', placeholder: isSale ? 'кому продали' : 'от кого купили' });
    var iInn = el('input', { class: 'input', id: 'f-inn', type: 'text', inputmode: 'numeric', maxlength: '12', value: st.inn, autocomplete: 'off', placeholder: '10 или 12 цифр' });
    bind(iDate, 'date'); bind(iNum, 'number'); bind(iPartner, 'partner');
    iPartner.addEventListener('change', function () {   // знакомый контрагент — подставляем ИНН
      if (!iInn.value && partners[iPartner.value]) { iInn.value = partners[iPartner.value]; st.inn = iInn.value; updateInnHint(); }
    });
    iInn.addEventListener('input', function () {
      var cleaned = iInn.value.replace(/\D/g, '');
      if (cleaned !== iInn.value) iInn.value = cleaned;
      st.inn = cleaned; updateInnHint();
    });

    var modeRow = el('div', { class: 'radio-row', role: 'radiogroup' },
      ['net', 'gross'].map(function (m) {
        var r = el('input', { type: 'radio', name: 'mode', value: m, checked: st.mode === m });
        r.addEventListener('change', function () { st.mode = m; renderLines(); updatePreviews(); });
        return el('label', null, r, m === 'net' ? 'Без НДС (НДС добавим сверху)' : 'С НДС (НДС посчитаем «назад»)');
      }));

    var summaryErr = el('div', { class: 'banner banner-error', role: 'alert', hidden: true, id: 'formError' });
    var warnBox = el('div', { class: 'banner banner-warn', hidden: true, id: 'formWarn' });

    var form = el('form', { novalidate: true });
    form.appendChild(el('div', { class: 'dlg-head' }, el('h2', { id: 'formTitle', text: (doc ? 'Изменить УПД' : 'Добавить УПД') + ' — ' + (isSale ? 'наш (продажа)' : 'от поставщика (покупка)') }),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', text: '×', onclick: function () { dlg.close(); } })));
    form.appendChild(el('div', { class: 'dlg-body' },
      summaryErr,
      el('div', { class: 'form-grid' },
        field('Дата УПД', iDate, 'date', el('div', { class: 'hint', text: 'По дате определяется квартал.' })),
        field('Номер УПД', iNum, 'number')),
      field(isSale ? 'Покупатель (контрагент)' : 'Поставщик (контрагент)', iPartner, 'partner'),
      el('datalist', { id: 'partnerList' }, Object.keys(partners).map(function (p) { return el('option', { value: p }); })),
      el('div', { class: 'field' }, el('label', { for: 'f-inn', text: 'ИНН контрагента' }), iInn, innHint, errEl('inn')),
      el('div', { class: 'field' }, el('div', { class: 'lbl', text: 'Сумма в УПД указана:' }), modeRow,
        el('div', { class: 'hint', text: 'Смотрите в документе: «Стоимость без налога» или «Стоимость с налогом».' })),
      el('h3', { text: 'Строки УПД' }),
      el('p', { class: 'hint', text: 'Если в УПД товары с разными ставками НДС — добавьте по строке на каждую ставку.' }),
      errEl('lines'), linesBox,
      el('button', { type: 'button', class: 'btn btn-small', id: 'btnAddLine', text: '+ Добавить строку', onclick: function () { st.lines.push({ amount: '', rate: Core.DEFAULT_RATE, vat: '' }); renderLines(); updatePreviews(); } }),
      el('div', { style: 'height:10px' }), totalBox, warnBox));
    form.appendChild(el('div', { class: 'dlg-foot' },
      el('button', { type: 'submit', class: 'btn btn-primary', id: 'btnSave', text: 'Сохранить' }),
      el('button', { type: 'button', class: 'btn', text: 'Отмена', onclick: function () { dlg.close(); } })));

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var built = buildDocFromState(), d = built.doc;
      var v = Core.validateDoc(d);
      var errors = Object.assign({}, v.errors, built.extra);
      // защита от дублей
      if (!errors.date && !errors.number && !errors.partner) {
        var key = Core.docKey(d);
        var dup = state.docs.find(function (x) { return x.type === type && Core.docKey(x) === key && (!doc || x.id !== doc.id); });
        if (dup) errors.number = 'Такой УПД уже есть (та же дата, номер и контрагент). Проверьте номер или дату.';
      }
      ['date', 'number', 'partner', 'inn', 'lines'].forEach(function (n) { setErr(n, errors[n]); });
      iDate.classList.toggle('invalid', !!errors.date); iNum.classList.toggle('invalid', !!errors.number); iPartner.classList.toggle('invalid', !!errors.partner); iInn.classList.toggle('invalid', !!errors.inn);
      st.lines.forEach(function (l, i) { setErr('line-' + i, errors['line-' + i]); var a = document.getElementById('amt-' + i); if (a) a.classList.toggle('invalid', !!errors['line-' + i]); });
      var keys = Object.keys(errors);
      summaryErr.hidden = !keys.length;
      summaryErr.textContent = keys.length ? 'Исправьте отмеченные поля (' + keys.length + ') — и нажмите «Сохранить» ещё раз.' : '';
      if (keys.length) {
        var firstBad = dlg.querySelector('.invalid'); if (firstBad) firstBad.focus();
        return;
      }
      var now = new Date().toISOString();
      d.id = doc ? doc.id : Core.newId();
      d.number = Core.cleanText(d.number); d.partner = Core.cleanText(d.partner);
      d.createdAt = doc ? doc.createdAt : now; d.updatedAt = now;
      storage.put(d).then(reload).then(function () {
        var q = Core.quarterOf(d.date);
        var moved = q.year !== state.year || q.quarter !== state.quarter;
        state.year = q.year; state.quarter = q.quarter; state.tab = type;
        dlg.close(); renderAll();
        toast(moved ? 'Сохранено. Показан ' + q.quarter + ' квартал ' + q.year + ' — по дате УПД.' : 'Сохранено');
      }).catch(saveError);
    });

    dlg.replaceChildren(form);
    renderLines(); updatePreviews(); updateInnHint();
    dlg.showModal();
    iDate.focus();
  }

  /* =====================================================================
   * 7. Подтверждение (вместо системного confirm — крупнее и понятнее)
   * =================================================================== */
  function confirmDialog(opts) {
    var dlg = $('#dlgConfirm');
    return new Promise(function (resolve) {
      var answer = false;
      var okBtn = el('button', { class: 'btn ' + (opts.danger ? 'btn-danger solid' : 'btn-primary'), id: 'btnConfirmOk', text: opts.okText || 'Да', disabled: !!opts.typeWord, onclick: function () { answer = true; dlg.close(); } });
      var typed = null;
      if (opts.typeWord) {      // для самых опасных действий: нужно набрать слово вручную
        typed = el('input', { class: 'input', id: 'confirmTyped', type: 'text', autocomplete: 'off', 'aria-label': 'Введите слово ' + opts.typeWord });
        typed.addEventListener('input', function () { okBtn.disabled = typed.value.trim().toUpperCase() !== opts.typeWord; });
      }
      dlg.replaceChildren(
        el('div', { class: 'dlg-head' }, el('h2', { id: 'confirmTitle', text: opts.title })),
        el('div', { class: 'dlg-body' }, el('p', { text: opts.text }),
          typed ? el('div', { class: 'field' }, el('label', { for: 'confirmTyped', text: 'Чтобы подтвердить, введите слово ' + opts.typeWord }), typed) : null),
        el('div', { class: 'dlg-foot' }, okBtn,
          el('button', { class: 'btn', id: 'btnConfirmCancel', text: 'Отмена', onclick: function () { dlg.close(); } })));
      dlg.addEventListener('close', function () { resolve(answer); }, { once: true });
      dlg.showModal();
      dlg.querySelector('#btnConfirmCancel').focus();     // по умолчанию — безопасная кнопка
    });
  }

  /* =====================================================================
   * 8. Импорт из CSV
   * =================================================================== */
  function downloadTemplate() {
    download('shablon-upd.csv', Csv.templateCSV(), 'text/csv;charset=utf-8', true);
  }

  function openImport(type) {
    var dlg = $('#dlgImport');
    var body = el('div', { class: 'dlg-body' });
    var foot = el('div', { class: 'dlg-foot' });
    dlg.replaceChildren(
      el('div', { class: 'dlg-head' }, el('h2', { id: 'importTitle', text: 'Загрузка из файла — ' + TYPE_TITLE[type] }),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', text: '×', onclick: function () { dlg.close(); } })),
      body, foot);

    function stepChoose(message) {
      body.replaceChildren(
        message ? el('div', { class: 'banner banner-error', role: 'alert', id: 'importError', text: message }) : null,
        el('p', { text: 'Выберите файл CSV (из 1С или Excel). Сначала мы покажем, что получится, и только потом добавим — ничего не изменится без вашего подтверждения.' }),
        el('div', { class: 'field' }, el('label', { for: 'importFile', text: 'Файл' }),
          el('input', { type: 'file', id: 'importFile', class: 'input', accept: '.csv,.txt,.tsv,text/csv', onchange: function (e) { onFile(e.target.files[0]); } })),
        el('details', { class: 'help' }, el('summary', { text: 'Какие колонки нужны?' }),
          el('p', { text: 'Дата; Номер; Контрагент; ИНН; Сумма без НДС; Ставка НДС; НДС; Итого. Разделитель — точка с запятой или запятая. Суммы можно писать с запятой: 108196,72.' }),
          el('p', { text: 'Обязательно: дата, номер, контрагент и сумма (без НДС или итого). Если в УПД несколько ставок — пишите отдельными строками с одинаковыми датой, номером и контрагентом: они соберутся в один УПД.' }),
          el('p', { text: 'Файл .xlsx: откройте в Excel → «Сохранить как» → «CSV (разделитель — точка с запятой)».' }),
          el('p', { text: 'Повторно загруженные УПД (те же дата + номер + контрагент) не добавляются второй раз.' })));
      foot.replaceChildren(
        el('button', { class: 'btn', id: 'btnTemplate', text: 'Скачать шаблон', onclick: downloadTemplate }),
        el('button', { class: 'btn', text: 'Закрыть', onclick: function () { dlg.close(); } }));
    }

    function onFile(file) {
      if (!file) return;
      readFileText(file).then(function (text) {
        var res = Csv.parseImport(text, { type: type, existing: state.docs });
        if (!res.ok) return stepChoose(res.fatal);
        stepPreview(res);
      }).catch(function (e) {
        stepChoose(e && e.message === 'xlsx'
          ? 'Это файл Excel (.xlsx). Откройте его в Excel и сохраните как «CSV (разделитель — точка с запятой)», затем загрузите снова.'
          : 'Не удалось прочитать файл.');
      });
    }

    function stepPreview(res) {
      var tb = el('tbody');
      res.items.forEach(function (it) {
        var d = it.doc, c = d ? Core.calcDoc(d) : null;
        var pill = it.status === 'ok' ? el('span', { class: 'pill pill-ok', text: it.warnings.length ? 'Добавим (проверьте)' : 'Добавим' })
          : it.status === 'duplicate' ? el('span', { class: 'pill pill-dup', text: 'Уже есть' }) : el('span', { class: 'pill pill-err', text: 'Ошибка' });
        var msgs = it.errors.concat(it.warnings);
        tb.appendChild(el('tr', null,
          el('td', null, pill), el('td', { text: it.rows.join(', ') }),
          el('td', { text: d ? Core.formatDate(d.date) + ' · № ' + d.number + ' · ' + d.partner : '—' }),
          el('td', { text: c ? Core.formatMoney(c.gross) : '' }),
          el('td', null, msgs.length ? el('ul', { class: 'import-msgs' }, msgs.map(function (m) { return el('li', { text: m }); })) : '')));
      });
      var n = res.counts.ok;
      body.replaceChildren(
        el('div', { class: 'banner ' + (res.counts.error ? 'banner-warn' : 'banner-ok'), id: 'importSummary',
          text: 'Будет добавлено: ' + n + '. Уже есть (пропустим): ' + res.counts.duplicate + '. С ошибками (пропустим): ' + res.counts.error + '.' }),
        res.counts.error ? el('p', { class: 'hint', text: 'УПД с ошибками не добавляются. Исправьте строки в файле и загрузите его снова — уже добавленные дубли не повторятся.' }) : null,
        el('div', { class: 'table-scroll' }, el('table', { class: 'import-table' },
          el('thead', null, el('tr', null, el('th', { text: 'Что будет' }), el('th', { text: 'Строки файла' }), el('th', { text: 'УПД' }), el('th', { text: 'Итого, ₽' }), el('th', { text: 'Замечания' }))), tb)));
      foot.replaceChildren(
        el('button', { class: 'btn btn-primary', id: 'btnImportConfirm', text: n ? 'Добавить: ' + n : 'Нечего добавлять', disabled: !n, onclick: function () {
          var docs = res.items.filter(function (it) { return it.status === 'ok'; }).map(function (it) { return it.doc; });
          storage.putMany(docs).then(reload).then(function () {
            dlg.close(); state.tab = type; renderAll(); toast('Добавлено УПД: ' + docs.length);
          }).catch(saveError);
        } }),
        el('button', { class: 'btn', text: 'Выбрать другой файл', onclick: function () { stepChoose(); } }),
        el('button', { class: 'btn', text: 'Отмена', onclick: function () { dlg.close(); } }));
    }

    stepChoose();
    dlg.showModal();
  }

  /* =====================================================================
   * 9. Экспорт квартала
   * =================================================================== */
  function exportQuarter() {
    var y = state.year, q = state.quarter;
    var rows = [['Вид', 'Дата', 'Номер', 'Контрагент', 'ИНН', 'Сумма без НДС', 'Ставка НДС', 'НДС', 'Итого']];
    Core.docsInQuarter(state.docs, y, q).sort(function (a, b) {
      return a.type !== b.type ? (a.type === 'sale' ? -1 : 1) : (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    }).forEach(function (d) {
      var c = Core.calcDoc(d);
      d.lines.forEach(function (l, i) {
        rows.push([d.type === 'sale' ? 'Продажа' : 'Покупка', Core.formatDate(d.date), d.number, d.partner, d.inn,
          Core.csvMoney(c.lines[i].net), Core.rateLabel(l.rate), Core.csvMoney(c.lines[i].vat), Core.csvMoney(c.lines[i].gross)]);
      });
    });
    var s = Core.summarize(state.docs, y, q);
    function sumRow(label, value) { return [label, '', '', '', '', '', '', Core.csvMoney(value), '']; }
    rows.push([], ['СВОДКА ЗА ' + q + ' КВАРТАЛ ' + y + ' (' + Core.COMPANY.name + ', ИНН ' + Core.COMPANY.inn + ')'],
      sumRow('НДС с продаж (начислено)', s.sales.vat), sumRow('НДС по покупкам (к вычету)', s.purchases.vat),
      sumRow(s.diff >= 0 ? 'К уплате в бюджет' : 'К возмещению из бюджета', Math.abs(s.diff)),
      sumRow('Продажи без НДС', s.sales.net), sumRow('Покупки без НДС', s.purchases.net),
      sumRow('Налог на прибыль ' + s.profit.percent + '% (приблизительно)', s.profit.tax));
    download('upd-' + y + '-Q' + q + '.csv', Csv.buildCSV(rows), 'text/csv;charset=utf-8', true);
    toast('Файл для Excel скачан');
  }

  /* =====================================================================
   * 10. Вкладка «Копия данных»
   * =================================================================== */
  function renderDataTab() {
    var root = el('div');
    var nSale = state.docs.filter(function (d) { return d.type === 'sale'; }).length;
    var nPurch = state.docs.length - nSale;
    var last = state.meta.lastBackup ? Core.formatDate(state.meta.lastBackup.slice(0, 10)) : 'ещё не делали на этом устройстве';
    root.appendChild(el('h2', { text: 'Резервная копия данных' }));
    root.appendChild(el('div', { class: 'card' },
      el('p', { id: 'storageInfo', text: 'Где лежат данные: ' + storage.describe() + '.' }),
      el('p', { text: 'Сейчас записано: наших УПД — ' + nSale + ', УПД поставщиков — ' + nPurch + '. Последняя копия: ' + last + '.' }),
      el('p', { class: 'warn-text', text: 'Общая база надёжнее браузера, но от ошибок (например, случайно удалили УПД) защищает только копия. Сохраняйте файл после работы (хотя бы раз в неделю) и храните в надёжном месте.' }),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', id: 'btnBackup', text: 'Сохранить резервную копию', onclick: backup }),
        el('label', { class: 'btn', id: 'lblRestore', text: 'Добавить данные из копии', for: 'restoreFile' }),
        el('input', { type: 'file', id: 'restoreFile', accept: '.json,application/json', hidden: true, onchange: function (e) { restore(e.target.files[0]); e.target.value = ''; } }))));
    root.appendChild(el('div', { class: 'card help' }, el('h3', { text: 'Как вернуть данные из копии' }),
      el('ol', null, el('li', { text: 'Нажмите «Добавить данные из копии» и выберите файл .json, сохранённый раньше.' }),
        el('li', { text: 'Сайт покажет, сколько УПД из копии новые, а сколько уже есть — и добавит только новые, без дублей. Существующие записи не меняются и не удаляются.' }))));
    root.appendChild(el('div', { class: 'card' }, el('h3', { text: 'Очистить общую базу' }),
      el('p', { class: 'muted', text: 'Удаляет ВСЕ УПД из общей базы — они пропадут у всех. Сначала сохраните резервную копию.' }),
      el('button', { class: 'btn btn-danger', id: 'btnClear', text: 'Удалить все данные…', onclick: clearAll })));
    return root;
  }

  function backup() {
    var now = new Date().toISOString();
    var payload = { app: 'neit-upd', version: 1, exportedAt: now, docs: state.docs };
    download('neit-upd-kopiya-' + Core.todayISO() + '.json', JSON.stringify(payload, null, 2), 'application/json', false);
    state.meta.lastBackup = now;
    storage.setMeta(state.meta).then(function () { renderAll(); toast('Резервная копия скачана (' + state.docs.length + ' УПД)'); }).catch(saveError);
  }

  /** Возврат из копии: добавляет только новые УПД (без дублей), ничего не заменяет и не удаляет. */
  function restore(file) {
    if (!file) return;
    file.text().then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (!data || data.app !== 'neit-upd' || !Array.isArray(data.docs)) { toast('Это не файл резервной копии этого сайта.'); return; }
      var docs = data.docs.map(Core.normalizeDoc).filter(Boolean);
      var split = splitStorable(docs);
      var plan = Core.planMerge(state.docs, split.ok);
      var broken = data.docs.length - split.ok.length;
      var info = 'В копии УПД: ' + data.docs.length + '. Новых: ' + plan.fresh.length + '. Уже есть в базе (пропустим): ' + plan.duplicates + (broken ? '. Повреждённых или неполных (пропустим): ' + broken : '') + '.';
      if (!plan.fresh.length) { toast('Добавлять нечего. ' + info); return; }
      return confirmDialog({ title: 'Добавить данные из копии?', text: info + ' Новые УПД появятся у всех, кто вошёл.', okText: 'Добавить: ' + plan.fresh.length })
        .then(function (ok) {
          if (!ok) return;
          return storage.putMany(plan.fresh).then(reload).then(function () { renderAll(); toast('Добавлено из копии: ' + plan.fresh.length); });
        });
    }).catch(saveError);
  }

  function clearAll() {
    confirmDialog({ title: 'Удалить ВСЕ данные из общей базы?', text: 'Будет удалено УПД: ' + state.docs.length + ' — у всех пользователей. Это нельзя отменить (кроме добавления ранее сохранённой копии).', okText: 'Да, удалить всё', danger: true, typeWord: 'УДАЛИТЬ' })
      .then(function (ok) {
        if (!ok) return;
        storage.replaceAll([]).then(reload).then(function () { renderAll(); toast('Все данные удалены'); }).catch(saveError);
      });
  }

  start();
}());
