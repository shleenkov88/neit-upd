/*
 * storage-firebase.js — ЗАГОТОВКА адаптера для Firebase (Cloud Firestore).
 *
 * !!! СЕЙЧАС НЕ ПОДКЛЮЧЕНО И НЕ РАБОТАЕТ. Файл не загружается из index.html. !!!
 * Firebase-проект не создан, ключей в репозитории нет. Это только план и каркас,
 * чтобы потом подключить облако за один вечер, не трогая остальной код.
 *
 * ЧТО НУЖНО БУДЕТ СДЕЛАТЬ (когда решите включать облако):
 *  1. Создать проект в Firebase (под аккаунтом владельца), включить Authentication
 *     (вход по e-mail/паролю для Наташи и Насти) и Cloud Firestore.
 *  2. ВАЖНО: правила базы (Firestore rules) закрыть для чужих, например:
 *       rules_version = '2';
 *       service cloud.firestore {
 *         match /databases/{db}/documents {
 *           match /upd/{id} { allow read, write: if request.auth != null
 *                             && request.auth.token.email in ['natasha@…', 'nastya@…']; }
 *         }
 *       }
 *     Тогда прочитать данные без входа нельзя.
 *  3. Положить Firebase SDK в репозиторий ФАЙЛАМИ (папка vendor/), без CDN, и подключить в index.html.
 *  4. Вписать публичный firebaseConfig (apiKey у Firebase не секрет, секретность даёт п. 2).
 *  5. Реализовать методы ниже и в js/app.js заменить NeitStorage.create() на
 *     new NeitFirebaseAdapter(firebaseConfig).
 *  6. Перенести существующие данные: «Сохранить резервную копию» → войти в облачную версию →
 *     «Загрузить копию» (replaceAll).
 *
 * Адаптер обязан вести себя ровно как LocalStorageAdapter в js/storage.js.
 * Хранить удобно один документ Firestore на один УПД: коллекция «upd», id = doc.id.
 */
(function (root) {
  'use strict';

  function NeitFirebaseAdapter(firebaseConfig) {
    this.name = 'firebase';
    this.shared = true;          // данные общие для Наташи и Насти
    this.persistent = true;
    this._config = firebaseConfig;
    this._db = null;
  }

  NeitFirebaseAdapter.prototype.describe = function () {
    return 'В облаке (Firebase), доступно после входа по паролю';
  };

  NeitFirebaseAdapter.prototype.init = function () {
    // TODO: firebase.initializeApp(this._config); this._db = firebase.firestore();
    //       дождаться входа пользователя (onAuthStateChanged) и показать форму входа, если не вошёл.
    return Promise.reject(new Error('Firebase-адаптер ещё не реализован'));
  };
  NeitFirebaseAdapter.prototype.getAll = function () {
    // TODO: return this._db.collection('upd').get().then(snap => snap.docs.map(d => d.data()));
    return Promise.reject(new Error('not implemented'));
  };
  NeitFirebaseAdapter.prototype.put = function (doc) {
    // TODO: return this._db.collection('upd').doc(doc.id).set(doc);
    return Promise.reject(new Error('not implemented'));
  };
  NeitFirebaseAdapter.prototype.putMany = function (docs) {
    // TODO: writeBatch, не больше 500 операций за раз.
    return Promise.reject(new Error('not implemented'));
  };
  NeitFirebaseAdapter.prototype.remove = function (id) {
    // TODO: return this._db.collection('upd').doc(id).delete();
    return Promise.reject(new Error('not implemented'));
  };
  NeitFirebaseAdapter.prototype.replaceAll = function (docs) {
    // TODO: удалить все документы коллекции и записать новые (батчами).
    return Promise.reject(new Error('not implemented'));
  };
  NeitFirebaseAdapter.prototype.getMeta = function () { return Promise.resolve({}); };
  NeitFirebaseAdapter.prototype.setMeta = function () { return Promise.resolve(); };

  root.NeitFirebaseAdapter = NeitFirebaseAdapter;
}(typeof self !== 'undefined' ? self : this));
