/*
 * storage.js — «слой хранения». Остальной код сайта не знает, ГДЕ лежат данные:
 * он только вызывает методы адаптера.
 *
 * Сейчас рабочие данные лежат в общей базе — адаптер NeitFirebaseAdapter (js/storage-firebase.js).
 * Адаптер localStorage из этого файла остался для двух целей:
 *   1) найти СТАРЫЕ данные, которые раньше были сохранены в этом браузере, и предложить перенос в общую базу;
 *   2) тесты.
 * Сайт НЕ работает с данными без входа.
 *
 * ИНТЕРФЕЙС АДАПТЕРА (все методы асинхронные, возвращают Promise):
 *   name                — короткое имя для экрана («localStorage», «firebase»)
 *   shared              — true, если данные видны всем пользователям (облако)
 *   persistent          — true, если данные реально сохраняются (false — только до закрытия вкладки)
 *   describe()          — строка простыми словами: где лежат данные
 *   init()              — подготовка (подключение), вызывается один раз при запуске
 *   getAll()            — все УПД: массив объектов
 *   put(doc)            — добавить или заменить УПД (по doc.id)
 *   putMany(docs)       — то же для нескольких
 *   remove(id)          — удалить УПД
 *   replaceAll(docs)    — заменить ВСЕ данные
 *   getMeta()/setMeta(obj) — служебное (дата последней копии и т.п.)
 * Адаптер общей базы дополнительно умеет вход (onAuth, signIn, signUp, …) и подписку subscribe().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NeitStorage = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DATA_KEY = 'neit-upd:v1:docs';
  var META_KEY = 'neit-upd:v1:meta';

  /** Адаптер на основе localStorage браузера. */
  function LocalStorageAdapter(storageObj) {
    this.name = 'localStorage';
    this.shared = false;
    this.persistent = true;
    this._ls = storageObj;
    this._memDocs = [];       // запасной вариант, если localStorage недоступен
    this._memMeta = {};
  }

  LocalStorageAdapter.prototype.describe = function () {
    return this.persistent
      ? 'Только в этом браузере на этом устройстве'
      : 'Хранилище браузера недоступно — данные пропадут при закрытии страницы!';
  };

  LocalStorageAdapter.prototype.init = function () {
    // Пробуем записать-прочитать: в «приватном» режиме или при полном диске localStorage может не работать.
    try {
      var probe = DATA_KEY + ':probe';
      this._ls.setItem(probe, '1');
      this._ls.removeItem(probe);
    } catch (e) {
      this._ls = null;
      this.persistent = false;
    }
    return Promise.resolve();
  };

  LocalStorageAdapter.prototype._read = function (key, fallback) {
    if (!this._ls) return key === META_KEY ? this._memMeta : this._memDocs;
    try {
      var raw = this._ls.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  };
  LocalStorageAdapter.prototype._write = function (key, value) {
    if (!this._ls) { if (key === META_KEY) this._memMeta = value; else this._memDocs = value; return; }
    this._ls.setItem(key, JSON.stringify(value));   // при нехватке места бросит ошибку — её покажет приложение
  };

  LocalStorageAdapter.prototype.getAll = function () {
    var docs = this._read(DATA_KEY, []);
    return Promise.resolve(Array.isArray(docs) ? docs : []);
  };
  LocalStorageAdapter.prototype.putMany = function (docs) {
    var self = this;
    return this.getAll().then(function (all) {
      docs.forEach(function (doc) {
        var i = all.findIndex(function (d) { return d.id === doc.id; });
        if (i >= 0) all[i] = doc; else all.push(doc);
      });
      self._write(DATA_KEY, all);
    });
  };
  LocalStorageAdapter.prototype.put = function (doc) { return this.putMany([doc]); };
  LocalStorageAdapter.prototype.remove = function (id) {
    var self = this;
    return this.getAll().then(function (all) {
      self._write(DATA_KEY, all.filter(function (d) { return d.id !== id; }));
    });
  };
  LocalStorageAdapter.prototype.replaceAll = function (docs) {
    this._write(DATA_KEY, docs);
    return Promise.resolve();
  };
  LocalStorageAdapter.prototype.getMeta = function () { return Promise.resolve(this._read(META_KEY, {}) || {}); };
  LocalStorageAdapter.prototype.setMeta = function (meta) { this._write(META_KEY, meta); return Promise.resolve(); };

  return {
    LocalStorageAdapter: LocalStorageAdapter,
    /** Адаптер localStorage этого браузера (старые данные устройства). */
    create: function () {
      var ls = null;
      try { ls = (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { ls = null; }
      return new LocalStorageAdapter(ls);
    }
  };
}));
