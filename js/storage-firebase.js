/*
 * storage-firebase.js — адаптер общей базы (Firebase: вход по почте + Cloud Firestore).
 *
 * Тот же набор методов, что и у адаптера в js/storage.js (getAll, put, putMany, remove,
 * replaceAll, getMeta, setMeta, init, describe), плюс то, что нужно общей базе:
 *   вход:      onAuth(cb), signIn, signUp, sendVerification, refreshUser, resetPassword, signOut, user
 *   живые данные: subscribe(onDocs, onError) — база сама присылает изменения, когда их делает другой человек
 *
 * Хранение: коллекция «upd», один документ на один УПД, id документа = id УПД.
 * Поля те же, что в модели сайта (см. Core.normalizeDoc) + updatedAt, updatedBy (почта того, кто сохранил).
 * Все расчёты (НДС, кварталы) остаются в браузере.
 *
 * SDK Firebase грузится как модуль ES с gstatic.com (версия закреплена ниже) — это единственная
 * внешняя зависимость сайта. Файл можно подключить и в Node (для тестов): SDK тогда подставляется
 * параметром opts.loadSdk.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NeitFirebaseAdapter = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SDK_VERSION = '11.10.0';
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  var COLLECTION = 'upd';
  var BATCH_SIZE = 400;           // у Firestore лимит 500 операций в одной пачке
  var WRITE_TIMEOUT_MS = 15000;
  var SDK_TIMEOUT_MS = 20000;
  var META_KEY = 'neit-upd:v2:shared-meta';

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { var e = new Error('timeout'); e.code = 'neit/timeout'; reject(e); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  function defaultLoadSdk() {
    // Динамический import() — модули ES. Если gstatic недоступен, будет ошибка (её покажет приложение).
    return withTimeout(Promise.all([
      import(SDK_BASE + 'firebase-app.js'),
      import(SDK_BASE + 'firebase-auth.js'),
      import(SDK_BASE + 'firebase-firestore.js')
    ]).then(function (m) { return { app: m[0], auth: m[1], fs: m[2] }; }), SDK_TIMEOUT_MS);
  }

  /**
   * Переводит ошибку Firebase в понятный текст.
   * context: 'auth' (вход/регистрация), 'read' (чтение данных), 'write' (запись данных).
   */
  function explainError(e, context) {
    var code = (e && e.code) ? String(e.code) : '';
    var NET = 'Нет связи. Проверьте интернет и попробуйте ещё раз.';
    if (code === 'neit/timeout' || code === 'auth/network-request-failed' || code === 'unavailable' || code === 'deadline-exceeded' ||
        code === 'firestore/unavailable' || code === 'neit/sdk') {
      return code === 'neit/sdk' ? 'Не удалось загрузить часть сайта (Google недоступен). Проверьте интернет и обновите страницу.' : NET;
    }
    if (code === 'permission-denied' || code === 'firestore/permission-denied') {
      return context === 'write'
        ? 'Запись не принята базой: у вас нет доступа (ваш email не в списке разрешённых или почта не подтверждена) либо данные не прошли проверку.'
        : 'Нет доступа: ваш email не в списке разрешённых. Попросите Андрея добавить вашу почту.';
    }
    if (code === 'unauthenticated') return 'Вход устарел. Выйдите и войдите снова.';
    if (code === 'resource-exhausted') return 'База временно не принимает запросы (превышен лимит). Попробуйте позже.';
    switch (code) {
      case 'auth/invalid-email': return 'Адрес почты написан неправильно. Пример: name@mail.ru';
      case 'auth/missing-email': return 'Введите адрес почты.';
      case 'auth/missing-password': return 'Введите пароль.';
      case 'auth/weak-password': return 'Пароль слишком простой. Нужно не меньше 8 символов.';
      case 'auth/email-already-in-use': return 'Эта почта уже зарегистрирована. Нажмите «Войти» (или «Забыли пароль?»).';
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
      case 'auth/invalid-login-credentials': return 'Неверная почта или пароль. Проверьте и попробуйте ещё раз. Если вы не регистрировались — нажмите «Создать аккаунт».';
      case 'auth/too-many-requests': return 'Слишком много попыток. Подождите несколько минут и попробуйте снова.';
      case 'auth/user-disabled': return 'Этот аккаунт отключён. Обратитесь к Андрею.';
      case 'auth/operation-not-allowed': return 'Вход по почте и паролю выключен в настройках проекта. Сообщите Андрею.';
      case 'auth/unauthorized-domain': return 'Этот адрес сайта не разрешён в настройках Firebase. Сообщите Андрею.';
      case 'auth/requires-recent-login': return 'Нужно войти заново.';
    }
    return 'Что-то пошло не так' + (code ? ' (' + code + ')' : '') + '. Попробуйте ещё раз.';
  }

  function NeitFirebaseAdapter(config, opts) {
    opts = opts || {};
    this.name = 'firebase';
    this.shared = true;              // данные общие для всех, кто вошёл
    this.persistent = true;
    this._config = config;
    this._loadSdk = opts.loadSdk || defaultLoadSdk;
    this._now = opts.now || function () { return new Date().toISOString(); };
    this._ls = opts.storage !== undefined ? opts.storage : (function () { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }());
    this._sdk = null; this._app = null; this._auth = null; this._db = null;
    this._docs = null;               // последний снимок данных из базы
    this._meta = {};
  }
  NeitFirebaseAdapter.explainError = explainError;
  NeitFirebaseAdapter.SDK_VERSION = SDK_VERSION;
  NeitFirebaseAdapter.COLLECTION = COLLECTION;

  NeitFirebaseAdapter.prototype.describe = function () {
    return 'В общей базе (Firebase) — видна всем, кто вошёл по почте и паролю';
  };

  NeitFirebaseAdapter.prototype.init = function () {
    var self = this;
    return this._loadSdk().then(function (sdk) {
      self._sdk = sdk;
      self._app = sdk.app.initializeApp(self._config);
      self._auth = sdk.auth.getAuth(self._app);
      try { self._auth.languageCode = 'ru'; } catch (e) { /* не страшно: письма придут на языке по умолчанию */ }
      // Автоопределение «длинных запросов» помогает за прокси и в некоторых браузерах.
      self._db = sdk.fs.initializeFirestore
        ? sdk.fs.initializeFirestore(self._app, { experimentalAutoDetectLongPolling: true })
        : sdk.fs.getFirestore(self._app);
    }, function (e) {
      var err = new Error('sdk'); err.code = 'neit/sdk'; err.cause = e; throw err;
    });
  };

  /* ---------------- вход ---------------- */
  function publicUser(u) { return u ? { uid: u.uid, email: u.email || '', emailVerified: !!u.emailVerified } : null; }

  Object.defineProperty(NeitFirebaseAdapter.prototype, 'user', {
    get: function () { return this._auth ? publicUser(this._auth.currentUser) : null; }
  });

  /** cb(user|null) вызывается при запуске и при каждом входе/выходе. Возвращает функцию «отписаться». */
  NeitFirebaseAdapter.prototype.onAuth = function (cb) {
    return this._sdk.auth.onAuthStateChanged(this._auth, function (u) { cb(publicUser(u)); });
  };
  NeitFirebaseAdapter.prototype.signIn = function (email, password) {
    return this._sdk.auth.signInWithEmailAndPassword(this._auth, email, password).then(function (c) { return publicUser(c.user); });
  };
  /** Создаёт аккаунт и сразу отправляет письмо для подтверждения почты. */
  NeitFirebaseAdapter.prototype.signUp = function (email, password) {
    var self = this;
    return this._sdk.auth.createUserWithEmailAndPassword(this._auth, email, password).then(function (c) {
      return self._sdk.auth.sendEmailVerification(c.user).then(function () { return publicUser(c.user); }, function (e) {
        // аккаунт создан, а письмо не ушло — сообщаем отдельно, чтобы можно было отправить заново
        e.accountCreated = true; throw e;
      });
    });
  };
  NeitFirebaseAdapter.prototype.sendVerification = function () {
    var u = this._auth.currentUser;
    if (!u) return Promise.reject(Object.assign(new Error('no user'), { code: 'unauthenticated' }));
    return this._sdk.auth.sendEmailVerification(u);
  };
  /** Перечитывает данные пользователя (подтвердил ли почту) и обновляет токен — правила базы смотрят на токен. */
  NeitFirebaseAdapter.prototype.refreshUser = function () {
    var u = this._auth.currentUser;
    if (!u) return Promise.resolve(null);
    return u.reload().then(function () { return u.getIdToken(true); }).then(function () { return publicUser(u); });
  };
  NeitFirebaseAdapter.prototype.resetPassword = function (email) { return this._sdk.auth.sendPasswordResetEmail(this._auth, email); };
  NeitFirebaseAdapter.prototype.signOut = function () { this._docs = null; return this._sdk.auth.signOut(this._auth); };

  /* ---------------- данные ---------------- */
  NeitFirebaseAdapter.prototype._col = function () { return this._sdk.fs.collection(this._db, COLLECTION); };

  /** Приводит УПД к записи для базы: только известные поля, без undefined, с updatedAt/updatedBy. */
  NeitFirebaseAdapter.prototype._record = function (doc) {
    var u = this.user;
    var now = this._now();
    var updatedAt = doc.updatedAt || now;
    return {
      id: String(doc.id), type: doc.type, date: doc.date, number: doc.number, partner: doc.partner,
      inn: doc.inn == null ? '' : String(doc.inn), mode: doc.mode,
      lines: (doc.lines || []).map(function (l) { return { amount: l.amount, rate: String(l.rate), vat: Number.isInteger(l.vat) ? l.vat : null }; }),
      createdAt: doc.createdAt || updatedAt, updatedAt: updatedAt,
      updatedBy: u ? u.email : ''
    };
  };

  /**
   * Подписка на изменения в реальном времени.
   * onDocs(docs, info) — вызывается сразу и после каждого изменения (в том числе чужого);
   *   info = { fromCache, hasPendingWrites }. onError(err) — например, нет доступа.
   * Возвращает функцию «отписаться».
   */
  NeitFirebaseAdapter.prototype.subscribe = function (onDocs, onError) {
    var self = this;
    return this._sdk.fs.onSnapshot(this._col(), { includeMetadataChanges: true }, function (snap) {
      self._docs = snap.docs.map(function (d) { return d.data(); });
      onDocs(self._docs.slice(), { fromCache: !!snap.metadata.fromCache, hasPendingWrites: !!snap.metadata.hasPendingWrites });
    }, function (e) { self._docs = null; onError(e); });
  };

  NeitFirebaseAdapter.prototype.getAll = function () {
    if (this._docs) return Promise.resolve(this._docs.slice());
    return this._sdk.fs.getDocs(this._col()).then(function (snap) { return snap.docs.map(function (d) { return d.data(); }); });
  };

  /** Выполняет список операций пачками. op: {set: record} или {del: id}. */
  NeitFirebaseAdapter.prototype._commit = function (ops) {
    var self = this, fs = this._sdk.fs;
    var chain = Promise.resolve();
    for (var i = 0; i < ops.length; i += BATCH_SIZE) {
      (function (part) {
        chain = chain.then(function () {
          var batch = fs.writeBatch(self._db);
          part.forEach(function (op) {
            if (op.set) batch.set(fs.doc(self._db, COLLECTION, op.set.id), op.set);
            else batch.delete(fs.doc(self._db, COLLECTION, op.del));
          });
          return withTimeout(batch.commit(), WRITE_TIMEOUT_MS);
        });
      }(ops.slice(i, i + BATCH_SIZE)));
    }
    return chain;
  };

  NeitFirebaseAdapter.prototype.putMany = function (docs) {
    var self = this;
    if (!this.user) return Promise.reject(Object.assign(new Error('no user'), { code: 'unauthenticated' }));
    return this._commit(docs.map(function (d) { return { set: self._record(d) }; }));
  };
  NeitFirebaseAdapter.prototype.put = function (doc) { return this.putMany([doc]); };
  NeitFirebaseAdapter.prototype.remove = function (id) {
    if (!this.user) return Promise.reject(Object.assign(new Error('no user'), { code: 'unauthenticated' }));
    return this._commit([{ del: String(id) }]);
  };
  /** Заменяет ВСЕ данные в общей базе (для всех пользователей!). Сайт использует только для «Удалить все данные». */
  NeitFirebaseAdapter.prototype.replaceAll = function (docs) {
    var self = this;
    if (!this.user) return Promise.reject(Object.assign(new Error('no user'), { code: 'unauthenticated' }));
    return this._sdk.fs.getDocs(this._col()).then(function (snap) {
      var keep = {};
      var ops = docs.map(function (d) { var r = self._record(d); keep[r.id] = true; return { set: r }; });
      snap.docs.forEach(function (d) { if (!keep[d.id]) ops.push({ del: d.id }); });
      return self._commit(ops);
    });
  };

  /* Служебное (дата последней копии) хранится на устройстве, а не в общей базе. */
  NeitFirebaseAdapter.prototype.getMeta = function () {
    try { var raw = this._ls && this._ls.getItem(META_KEY); return Promise.resolve(raw ? JSON.parse(raw) : {}); }
    catch (e) { return Promise.resolve(this._meta); }
  };
  NeitFirebaseAdapter.prototype.setMeta = function (meta) {
    this._meta = meta;
    try { if (this._ls) this._ls.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* не критично */ }
    return Promise.resolve();
  };

  return NeitFirebaseAdapter;
}));
