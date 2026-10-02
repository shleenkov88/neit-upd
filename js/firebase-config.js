/*
 * firebase-config.js — публичные настройки подключения к Firebase-проекту «neit-upd».
 * Это НЕ пароль и не секрет: такие значения всегда видны в любом сайте на Firebase.
 * Защищает данные не этот файл, а правила базы (firestore.rules) и вход по почте и паролю.
 * Паролей здесь нет и быть не должно.
 */
window.NEIT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAhCq5nvGbel075NsXqBfS0CamwkC0l3Uc',
  authDomain: 'neit-upd.firebaseapp.com',
  projectId: 'neit-upd',
  storageBucket: 'neit-upd.firebasestorage.app',
  messagingSenderId: '640013545073',
  appId: '1:640013545073:web:8e772e1c02bbb14a9a75d0'
};

/* Версия сайта: показывается внизу страницы, меняется при каждом выпуске (и в ?v= у скриптов в index.html). */
window.NEIT_APP_VERSION = '1.1.0';
