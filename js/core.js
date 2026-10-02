/*
 * core.js — «мозги» сайта: деньги, НДС, даты, кварталы, ИНН, сводка.
 *
 * Здесь НЕТ работы с экраном и браузером, поэтому этот файл можно
 * проверять обычными тестами в Node (tests/vat.test.js) и подключать
 * на странице обычным <script>.
 *
 * ГЛАВНОЕ ПРАВИЛО: все суммы хранятся и считаются в КОПЕЙКАХ целыми числами
 * (108 196,72 ₽ = 10819672). Так нет ошибок дробных чисел (0.1 + 0.2 ≠ 0.3).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NeitCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * Константы
   * ------------------------------------------------------------------- */
  var COMPANY = { name: 'ООО «Нейт»', inn: '3702195003' };
  var PROFIT_TAX_PERCENT = 25;               // налог на прибыль, %
  var MAX_KOPECKS = 1e13;                    // защита от опечаток: не больше 100 млрд ₽

  /** Ставки НДС. key хранится в данных, label показывается людям. */
  var RATES = [
    { key: '22',   percent: 22, label: '22%' },
    { key: '15',   percent: 15, label: '15%' },
    { key: '10',   percent: 10, label: '10%' },
    { key: '5',    percent: 5,  label: '5%' },
    { key: '0',    percent: 0,  label: '0%' },
    { key: 'none', percent: 0,  label: 'без НДС' }
  ];
  var DEFAULT_RATE = '22';

  var MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль',
    'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  var MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
    'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  function rateInfo(key) {
    for (var i = 0; i < RATES.length; i++) if (RATES[i].key === String(key)) return RATES[i];
    return null;
  }
  function ratePercent(key) { var r = rateInfo(key); return r ? r.percent : 0; }
  function rateLabel(key) { var r = rateInfo(key); return r ? r.label : String(key); }

  /* ---------------------------------------------------------------------
   * Деньги
   * ------------------------------------------------------------------- */

  /**
   * Делит n на d и округляет до целого «как в школе» (0,5 → вверх по модулю).
   * Работает только с целыми, поэтому без сюрпризов float.
   */
  function divRound(n, d) {
    var neg = (n < 0) !== (d < 0);
    n = Math.abs(n); d = Math.abs(d);
    var q = Math.floor((2 * n + d) / (2 * d));
    return neg ? -q : q;
  }

  /**
   * Читает сумму из текста пользователя и возвращает КОПЕЙКИ (целое) или null.
   * Понимает: "108196,72", "108 196.72", "1 234,5", "1.234,56", "1,234.56", "-500", "100 ₽".
   */
  function parseMoney(input) {
    if (typeof input === 'number') {
      if (!isFinite(input)) return null;
      var kn = Math.round(input * 100);
      return Math.abs(kn) < MAX_KOPECKS ? kn : null;
    }
    var s = String(input == null ? '' : input)
      .replace(/[\s\u00a0\u202f]/g, '')
      .replace(/₽|руб(лей|\.)?|р\.?$/gi, '');
    var neg = false;
    if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); }
    if (!s) return null;
    var hasComma = s.indexOf(',') >= 0, hasDot = s.indexOf('.') >= 0;
    if (hasComma && hasDot) {
      // последний знак — десятичный, другой — разделитель тысяч
      var dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      var th = dec === ',' ? '.' : ',';
      s = s.split(th).join('').replace(dec, '.');
    } else if (hasComma) {
      if (s.split(',').length > 2) return null;
      s = s.replace(',', '.');
    } else if (hasDot) {
      if (s.split('.').length > 2) return null;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var parts = s.split('.');
    if (parts[0].length > 12) return null;
    var k = parseInt(parts[0], 10) * 100 + parseInt(((parts[1] || '') + '00').slice(0, 2), 10);
    if (k >= MAX_KOPECKS) return null;
    return neg && k ? -k : k;
  }

  /** Копейки → "108 196,72" (пробел между тысячами — неразрывный). */
  function formatMoney(kopecks) {
    kopecks = kopecks || 0;
    var neg = kopecks < 0;
    var abs = Math.abs(kopecks);
    var rub = Math.floor(abs / 100), kop = abs % 100;
    var rubStr = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    return (neg ? '−' : '') + rubStr + ',' + (kop < 10 ? '0' : '') + kop;
  }
  /** Копейки → "108 196,72 ₽" */
  function formatRub(kopecks) { return formatMoney(kopecks) + '\u00a0₽'; }
  /** Копейки → "108196,72" (для CSV/Excel: запятая, без пробелов). */
  function csvMoney(kopecks) { return formatMoney(kopecks).replace(/\u00a0/g, '').replace('−', '-'); }
  /** Копейки → "108196.72" для полей ввода. */
  function inputMoney(kopecks) { return csvMoney(kopecks); }

  /* ---------------------------------------------------------------------
   * НДС
   * ------------------------------------------------------------------- */

  /**
   * Считает одну строку УПД.
   *  line = { amount: копейки, rate: '22', vat: копейки|null }
   *  mode = 'net'   — amount это сумма БЕЗ НДС (НДС добавляем сверху)
   *         'gross' — amount это сумма С НДС (НДС вычленяем «назад»)
   *  Если line.vat задан (число) — берём НДС «как в документе», не считаем.
   * Возвращает { net, vat, gross } в копейках.
   */
  function calcLine(line, mode) {
    var pct = ratePercent(line.rate);
    var amount = line.amount || 0;
    var hasOverride = pct > 0 && line.vat != null && Number.isInteger(line.vat);
    var net, vat, gross;
    if (mode === 'gross') {
      gross = amount;
      vat = hasOverride ? line.vat : divRound(gross * pct, 100 + pct);
      net = gross - vat;
    } else {
      net = amount;
      vat = hasOverride ? line.vat : divRound(net * pct, 100);
      gross = net + vat;
    }
    return { net: net, vat: vat, gross: gross };
  }

  /** Считает весь УПД: итоги и разбивку по ставкам. */
  function calcDoc(doc) {
    var res = { lines: [], net: 0, vat: 0, gross: 0, byRate: {} };
    (doc.lines || []).forEach(function (line) {
      var c = calcLine(line, doc.mode);
      res.lines.push(c);
      res.net += c.net; res.vat += c.vat; res.gross += c.gross;
      var r = res.byRate[line.rate] || (res.byRate[line.rate] = { net: 0, vat: 0, gross: 0 });
      r.net += c.net; r.vat += c.vat; r.gross += c.gross;
    });
    return res;
  }

  /* ---------------------------------------------------------------------
   * Даты и кварталы
   * ------------------------------------------------------------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function isRealDate(y, m, d) {
    if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
    var dim = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= dim[m - 1];
  }

  /** Читает дату "25.09.2026", "25.09.26", "2026-09-25", "25/09/2026" → "2026-09-25" или null. */
  function parseDate(input) {
    var s = String(input == null ? '' : input).trim();
    var m, y, mo, d;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}|\d{2})(?:\s.*)?$/.exec(s))) {
      d = +m[1]; mo = +m[2]; y = +m[3]; if (m[3].length === 2) y += 2000;
    } else return null;
    if (!isRealDate(y, mo, d)) return null;
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }
  function isISODate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDate(s) === s; }

  /** "2026-09-25" → "25.09.2026" */
  function formatDate(iso) {
    if (!isISODate(iso)) return '';
    return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
  }
  function todayISO(now) {
    now = now || new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  /** Квартал по ISO-дате: "2026-09-25" → { year: 2026, quarter: 3, month: 9 }. */
  function quarterOf(iso) {
    if (!isISODate(iso)) return null;
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7);
    return { year: y, quarter: Math.floor((m - 1) / 3) + 1, month: m };
  }
  function currentQuarter(now) { var q = quarterOf(todayISO(now)); return { year: q.year, quarter: q.quarter }; }

  /** Человеческое описание квартала: "с 1 июля по 30 сентября 2026". */
  function quarterRangeText(year, quarter) {
    var m1 = (quarter - 1) * 3, m3 = m1 + 2;
    var lastDay = [31, isRealDate(year, 2, 29) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m3];
    return 'с 1 ' + MONTHS_GEN[m1] + ' по ' + lastDay + ' ' + MONTHS_GEN[m3] + ' ' + year;
  }
  function monthName(month) { return MONTHS_NOM[month - 1]; }

  /* ---------------------------------------------------------------------
   * ИНН (проверка контрольной суммы по правилам ФНС)
   * ------------------------------------------------------------------- */
  function innChecksum(digits, coefs) {
    var sum = 0;
    for (var i = 0; i < coefs.length; i++) sum += coefs[i] * digits[i];
    return (sum % 11) % 10;
  }
  /**
   * Возвращает 'empty' | 'format' | 'checksum' | 'ok'.
   * Пустой ИНН — не ошибка, а просто «не указан».
   */
  function checkInn(value) {
    var s = String(value == null ? '' : value).replace(/\s/g, '');
    if (!s) return 'empty';
    if (!/^\d+$/.test(s) || (s.length !== 10 && s.length !== 12)) return 'format';
    var d = s.split('').map(Number);
    if (s.length === 10) {
      return innChecksum(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9] ? 'ok' : 'checksum';
    }
    var n11 = innChecksum(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
    var n12 = innChecksum(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
    return (n11 === d[10] && n12 === d[11]) ? 'ok' : 'checksum';
  }

  /* ---------------------------------------------------------------------
   * Документы
   * ------------------------------------------------------------------- */
  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function cleanText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  /** Ключ для защиты от дублей: дата + номер + контрагент (без учёта регистра и пробелов). */
  function docKey(doc) {
    return [doc.date, cleanText(doc.number).toLowerCase(), cleanText(doc.partner).toLowerCase()].join('|');
  }

  /**
   * Проверяет УПД. Возвращает { errors: {поле: текст}, warnings: [текст] }.
   * errors — сохранять нельзя; warnings — можно, но стоит перепроверить.
   * Ключи ошибок: date, number, partner, lines, line-0, line-1 ...
   */
  function validateDoc(doc) {
    var errors = {}, warnings = [];
    if (!isISODate(doc.date)) errors.date = 'Укажите дату УПД.';
    if (!cleanText(doc.number)) errors.number = 'Укажите номер УПД.';
    if (!cleanText(doc.partner)) errors.partner = 'Укажите, кто контрагент (название организации).';
    // лимиты длины совпадают с правилами базы (firestore.rules)
    if (cleanText(doc.number).length > 100) errors.number = 'Номер УПД слишком длинный (не больше 100 знаков).';
    if (cleanText(doc.partner).length > 300) errors.partner = 'Название контрагента слишком длинное (не больше 300 знаков).';
    if (doc.lines && doc.lines.length > 200) errors.lines = 'Слишком много строк в одном УПД (не больше 200).';
    if (!doc.lines || !doc.lines.length) errors.lines = 'Добавьте хотя бы одну строку с суммой.';
    (doc.lines || []).forEach(function (l, i) {
      if (!Number.isInteger(l.amount)) errors['line-' + i] = 'Введите сумму цифрами, например 108196,72';
      else if (l.amount === 0) errors['line-' + i] = 'Сумма не может быть нулевой.';
      else if (!rateInfo(l.rate)) errors['line-' + i] = 'Выберите ставку НДС.';
    });
    if (String(doc.inn == null ? '' : doc.inn).replace(/\s/g, '').length > 20) errors.inn = 'ИНН слишком длинный — проверьте, это должно быть 10 или 12 цифр.';
    var inn = checkInn(doc.inn);
    if (inn === 'format') warnings.push('ИНН должен состоять из 10 цифр (организация) или 12 цифр (ИП). Проверьте, пожалуйста.');
    if (inn === 'checksum') warnings.push('Контрольная цифра ИНН не сходится — возможно, опечатка. Сохранить можно, но лучше проверить.');
    return { errors: errors, warnings: warnings };
  }

  /**
   * Приводит «сырой» объект (из файла копии) к правильному виду УПД.
   * Возвращает null, если это не УПД.
   */
  function normalizeDoc(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type !== 'sale' && raw.type !== 'purchase') return null;
    if (!isISODate(raw.date) || !Array.isArray(raw.lines) || !raw.lines.length) return null;
    var lines = [];
    for (var i = 0; i < raw.lines.length; i++) {
      var l = raw.lines[i];
      if (!l || !Number.isInteger(l.amount) || !rateInfo(l.rate)) return null;
      lines.push({ amount: l.amount, rate: String(l.rate), vat: Number.isInteger(l.vat) ? l.vat : null });
    }
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      type: raw.type,
      date: raw.date,
      number: cleanText(raw.number),
      partner: cleanText(raw.partner),
      inn: String(raw.inn == null ? '' : raw.inn).replace(/\s/g, ''),
      mode: raw.mode === 'gross' ? 'gross' : 'net',
      lines: lines,
      createdAt: raw.createdAt || null,
      updatedAt: raw.updatedAt || null,
      updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : ''
    };
  }

  /**
   * Что можно добавить в общую базу без дублей.
   * existing — УПД, которые уже есть; incoming — кандидаты (с другого устройства, из копии).
   * Дубль — тот же id ИЛИ тот же вид + дата + номер + контрагент. Возвращает { fresh: [...], duplicates: число }.
   */
  function planMerge(existing, incoming) {
    var ids = {}, keys = {}, fresh = [], dups = 0;
    existing.forEach(function (d) { ids[d.id] = true; keys[d.type + '|' + docKey(d)] = true; });
    incoming.forEach(function (d) {
      var k = d.type + '|' + docKey(d);
      if (ids[d.id] || keys[k]) { dups++; return; }
      ids[d.id] = true; keys[k] = true; fresh.push(d);
    });
    return { fresh: fresh, duplicates: dups };
  }

  /* ---------------------------------------------------------------------
   * Сводка за квартал
   * ------------------------------------------------------------------- */
  function emptyTotals() { return { count: 0, net: 0, vat: 0, gross: 0, byRate: {} }; }
  function addTo(totals, calc) {
    totals.count += 1;
    totals.net += calc.net; totals.vat += calc.vat; totals.gross += calc.gross;
    Object.keys(calc.byRate).forEach(function (k) {
      var t = totals.byRate[k] || (totals.byRate[k] = { net: 0, vat: 0, gross: 0 });
      t.net += calc.byRate[k].net; t.vat += calc.byRate[k].vat; t.gross += calc.byRate[k].gross;
    });
  }

  /** Документы за квартал (по дате УПД). type — 'sale' | 'purchase' | undefined (оба). */
  function docsInQuarter(docs, year, quarter, type) {
    return docs.filter(function (d) {
      var q = quarterOf(d.date);
      return q && q.year === year && q.quarter === quarter && (!type || d.type === type);
    });
  }

  /**
   * Главная сводка.
   * Возвращает:
   *  sales / purchases — { count, net, vat, gross, byRate }
   *  diff              — НДС с продаж минус НДС по покупкам (>0 — к уплате, <0 — к возмещению)
   *  toPay / toRefund  — то же, но всегда положительное число и 0 с другой стороны
   *  months            — по трём месяцам квартала
   *  profit            — оценка налога на прибыль
   */
  function summarize(docs, year, quarter) {
    var res = { year: year, quarter: quarter, sales: emptyTotals(), purchases: emptyTotals(), months: [] };
    var firstMonth = (quarter - 1) * 3 + 1, i;
    for (i = 0; i < 3; i++) res.months.push({
      month: firstMonth + i, salesNet: 0, salesVat: 0, purchNet: 0, purchVat: 0, diff: 0
    });
    docsInQuarter(docs, year, quarter).forEach(function (d) {
      var calc = calcDoc(d);
      var m = res.months[quarterOf(d.date).month - firstMonth];
      if (d.type === 'sale') { addTo(res.sales, calc); m.salesNet += calc.net; m.salesVat += calc.vat; }
      else { addTo(res.purchases, calc); m.purchNet += calc.net; m.purchVat += calc.vat; }
    });
    res.months.forEach(function (m) { m.diff = m.salesVat - m.purchVat; });
    res.diff = res.sales.vat - res.purchases.vat;
    res.toPay = res.diff > 0 ? res.diff : 0;
    res.toRefund = res.diff < 0 ? -res.diff : 0;
    var base = res.sales.net - res.purchases.net;
    res.profit = {
      base: base,                                   // прибыль до налога (приблизительно)
      negative: base <= 0,                          // если не больше нуля, налог = 0
      tax: base > 0 ? divRound(base * PROFIT_TAX_PERCENT, 100) : 0,
      percent: PROFIT_TAX_PERCENT
    };
    return res;
  }

  return {
    COMPANY: COMPANY, RATES: RATES, DEFAULT_RATE: DEFAULT_RATE, PROFIT_TAX_PERCENT: PROFIT_TAX_PERCENT,
    MONTHS_NOM: MONTHS_NOM, MONTHS_GEN: MONTHS_GEN,
    rateInfo: rateInfo, ratePercent: ratePercent, rateLabel: rateLabel,
    divRound: divRound, parseMoney: parseMoney, formatMoney: formatMoney, formatRub: formatRub,
    csvMoney: csvMoney, inputMoney: inputMoney,
    calcLine: calcLine, calcDoc: calcDoc,
    parseDate: parseDate, isISODate: isISODate, formatDate: formatDate, todayISO: todayISO,
    quarterOf: quarterOf, currentQuarter: currentQuarter, quarterRangeText: quarterRangeText, monthName: monthName,
    checkInn: checkInn,
    newId: newId, cleanText: cleanText, docKey: docKey, validateDoc: validateDoc, normalizeDoc: normalizeDoc, planMerge: planMerge,
    docsInQuarter: docsInQuarter, summarize: summarize
  };
}));
