/*
 * csv.js — чтение и запись CSV (для Excel / 1С) и разбор файла-импорта УПД.
 * Как и core.js, не зависит от браузера: проверяется тестами в Node.
 *
 * Колонки файла импорта (порядок не важен, если есть строка заголовков):
 *   дата; номер; контрагент; ИНН; сумма без НДС; ставка; НДС; итого
 * Одна строка файла = одна строка УПД. Строки с одинаковыми
 * «дата + номер + контрагент» собираются в ОДИН УПД с несколькими строками.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.NeitCsv = factory(root.NeitCore);
}(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  /* ---------------------------------------------------------------------
   * Низкоуровневый CSV
   * ------------------------------------------------------------------- */

  /** Угадывает разделитель по первой непустой строке: ; , или табуляция. */
  function detectDelimiter(text) {
    var first = (text.split(/\r?\n/).filter(function (l) { return l.trim(); })[0]) || '';
    var best = ';', bestCount = -1;
    [';', '\t', ','].forEach(function (d) {
      var n = first.split(d).length - 1;
      if (n > bestCount) { best = d; bestCount = n; }
    });
    return best;
  }

  /** Разбирает текст CSV в массив строк (массивов ячеек). Понимает кавычки и переносы внутри кавычек. */
  function parseCSV(text, delimiter) {
    text = String(text || '').replace(/^\uFEFF/, '');
    delimiter = delimiter || detectDelimiter(text);
    var rows = [], row = [], cell = '', inQuotes = false, i, ch;
    for (i = 0; i < text.length; i++) {
      ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
        } else cell += ch;
      } else if (ch === '"' && cell === '') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(cell); cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /** Собирает CSV-текст (без BOM — его добавляет код скачивания). */
  function buildCSV(rows, delimiter) {
    delimiter = delimiter || ';';
    var re = new RegExp('[' + (delimiter === '\t' ? '\\t' : delimiter) + '"\\r\\n]');
    return rows.map(function (r) {
      return r.map(function (c) {
        var s = String(c == null ? '' : c);
        return re.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(delimiter);
    }).join('\r\n') + '\r\n';
  }

  /* ---------------------------------------------------------------------
   * Заголовки и ставки
   * ------------------------------------------------------------------- */
  var COLUMNS = ['date', 'number', 'partner', 'inn', 'net', 'rate', 'vat', 'total'];
  var TEMPLATE_HEADER = ['Дата', 'Номер', 'Контрагент', 'ИНН', 'Сумма без НДС', 'Ставка НДС', 'НДС', 'Итого'];

  function normHeader(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  }
  /** Определяет, какой колонке соответствует заголовок. */
  function headerToColumn(h) {
    h = normHeader(h);
    if (!h) return null;
    if (/^дата/.test(h) || h === 'date') return 'date';
    if (/^(номер|n|no|№|номер упд|номер документа)$/.test(h) || /^номер/.test(h)) return 'number';
    if (/(контрагент|покупатель|поставщик|продавец|организация|partner|клиент)/.test(h)) return 'partner';
    if (/^инн/.test(h) || h === 'inn') return 'inn';
    if (/(без ндс|без налога|сумма без|net)/.test(h)) return 'net';
    if (/(ставка|rate)/.test(h)) return 'rate';
    if (/^(ндс|сумма ндс|vat)$/.test(h)) return 'vat';
    if (/(итого|всего|с ндс|total|gross)/.test(h)) return 'total';
    return null;
  }

  /** "22%", "22", "без НДС", "0%" → ключ ставки; null — не распознано. */
  function parseRate(text) {
    var s = String(text == null ? '' : text).toLowerCase().replace(/[\s%]/g, '').replace(',', '.').replace(/ё/g, 'е');
    if (!s) return '';
    if (/^(безндс|безналога|нет|-|—|ндснеоблагается|необлагается)$/.test(s)) return 'none';
    var n = parseFloat(s);
    if (isFinite(n) && /^[\d.]+$/.test(s)) {
      if (n > 0 && n < 1) n = Math.round(n * 100);          // 0.22 → 22
      var key = String(Math.round(n * 100) / 100);
      if (Core.rateInfo(key) && key !== 'none') return key;
    }
    return null;
  }

  /* ---------------------------------------------------------------------
   * Разбор файла импорта
   * ------------------------------------------------------------------- */

  /** Подбирает ставку по сумме без НДС и НДС (если ставка в файле не указана). */
  function inferRate(net, vat) {
    var order = ['22', '15', '10', '5'];
    for (var i = 0; i < order.length; i++) {
      var calc = Core.divRound(net * Core.ratePercent(order[i]), 100);
      if (Math.abs(calc - vat) <= 1) return order[i];
    }
    return null;
  }

  /**
   * Разбирает одну строку файла в «кандидата» строки УПД.
   * Возвращает { errors:[], warnings:[], rec:{date,number,partner,inn,line} }
   */
  function parseRow(cells, col) {
    var errors = [], warnings = [];
    function get(name) { return col[name] == null ? '' : String(cells[col[name]] == null ? '' : cells[col[name]]).trim(); }

    var date = Core.parseDate(get('date'));
    if (!get('date')) errors.push('не указана дата');
    else if (!date) errors.push('дата «' + get('date') + '» не читается (нужно, например, 25.09.2026)');
    var number = Core.cleanText(get('number'));
    if (!number) errors.push('не указан номер');
    var partner = Core.cleanText(get('partner'));
    if (!partner) errors.push('не указан контрагент');
    var inn = get('inn').replace(/\s/g, '').replace(/\.0+$/, '');   // Excel любит дописывать ".0"

    function money(name, title) {
      var raw = get(name);
      if (raw === '') return undefined;
      var v = Core.parseMoney(raw);
      if (v === null) { errors.push(title + ' «' + raw + '» не читается'); return null; }
      return v;
    }
    var net = money('net', 'сумма без НДС');
    var vat = money('vat', 'НДС');
    var total = money('total', 'итого');

    var rateRaw = get('rate');
    var rate = parseRate(rateRaw);
    if (rate === null) errors.push('ставка «' + rateRaw + '» не подходит (доступно: 22%, 15%, 10%, 5%, 0%, без НДС)');

    var line = null;
    if (!errors.length) {
      var amount, mode;
      if (net !== undefined) { amount = net; mode = 'net'; }
      else if (total !== undefined && vat !== undefined) { amount = total - vat; mode = 'net'; }
      else if (total !== undefined) { amount = total; mode = 'gross'; }
      else { errors.push('нет суммы (заполните «Сумма без НДС» или «Итого»)'); }

      if (!errors.length) {
        if (rate === '') {                                  // ставки нет — пробуем понять сами
          var base = mode === 'net' ? amount : null;
          if (base !== null && vat !== undefined && vat !== 0) rate = inferRate(base, vat);
          else if (base !== null && vat === 0) rate = 'none';
          if (!rate) errors.push('не указана ставка НДС');
          else warnings.push('ставка не указана — определена по сумме: ' + Core.rateLabel(rate));
        }
        if (amount === 0) errors.push('сумма равна нулю');
      }
      if (!errors.length) {
        var pct = Core.ratePercent(rate);
        var lineVat = null;                                    // null = считать автоматически
        if (mode === 'gross') {
          // приводим «сумму с НДС» к «без НДС» + НДС, чтобы все строки УПД были в одном виде
          var back = Core.calcLine({ amount: amount, rate: rate }, 'gross');
          amount = back.net;
          if (back.vat !== Core.calcLine({ amount: amount, rate: rate }, 'net').vat) lineVat = back.vat;
        }
        var calc = Core.calcLine({ amount: amount, rate: rate, vat: lineVat }, 'net').vat;
        if (vat !== undefined && pct > 0) {
          if (Math.abs(vat - calc) > 5) warnings.push('НДС в файле (' + Core.formatRub(vat) + ') отличается от расчёта (' + Core.formatRub(calc) + ') — проверьте ставку');
          // НДС берём «как в документе», если он отличается от расчёта на копейки
          lineVat = (vat === Core.calcLine({ amount: amount, rate: rate }, 'net').vat) ? null : vat;
        } else if (vat !== undefined && pct === 0 && vat !== 0) {
          warnings.push('при ставке «' + Core.rateLabel(rate) + '» НДС должен быть 0, значение из файла проигнорировано');
        }
        var res = Core.calcLine({ amount: amount, rate: rate, vat: lineVat }, 'net');
        if (total !== undefined && net !== undefined && Math.abs(res.gross - total) > 1) {
          warnings.push('«Итого» в файле (' + Core.formatRub(total) + ') не равно сумме без НДС + НДС (' + Core.formatRub(res.gross) + ')');
        }
        line = { amount: amount, rate: rate, vat: lineVat };
      }
    }
    var innState = Core.checkInn(inn);
    if (innState === 'format') warnings.push('ИНН «' + inn + '» — должно быть 10 или 12 цифр');
    if (innState === 'checksum') warnings.push('контрольная цифра ИНН не сходится');
    return { errors: errors, warnings: warnings, rec: { date: date, number: number, partner: partner, inn: inn, line: line } };
  }

  /**
   * Разбирает текст файла.
   *  opts.type      — 'sale' | 'purchase' (в какую вкладку грузим)
   *  opts.existing  — уже имеющиеся УПД (для поиска дублей)
   * Возвращает:
   *  { ok, fatal, items:[{status:'ok'|'duplicate'|'error', rows:[№строк], doc, errors, warnings}], counts }
   */
  function parseImport(text, opts) {
    opts = opts || {};
    var rows = parseCSV(text).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
    if (!rows.length) return { ok: false, fatal: 'Файл пустой.', items: [], counts: { ok: 0, duplicate: 0, error: 0 } };

    // заголовки: если в первой строке узнали хотя бы 3 колонки — это строка заголовков
    var col = {}, found = 0, startIndex = 0;
    rows[0].forEach(function (h, i) {
      var name = headerToColumn(h);
      if (name && col[name] == null) { col[name] = i; found++; }
    });
    if (found >= 3) startIndex = 1;
    else { col = {}; COLUMNS.forEach(function (n, i) { col[n] = i; }); }   // без заголовков — порядок по умолчанию
    if (col.date == null || col.number == null || col.partner == null) {
      return { ok: false, fatal: 'Не нашли обязательные колонки: Дата, Номер, Контрагент. Скачайте шаблон и сравните заголовки.', items: [], counts: { ok: 0, duplicate: 0, error: 0 } };
    }
    if (col.net == null && col.total == null) {
      return { ok: false, fatal: 'Не нашли колонку с суммой: «Сумма без НДС» или «Итого».', items: [], counts: { ok: 0, duplicate: 0, error: 0 } };
    }

    var existingKeys = {};
    (opts.existing || []).forEach(function (d) { if (d.type === opts.type) existingKeys[Core.docKey(d)] = true; });

    var groups = [], byKey = {};
    for (var i = startIndex; i < rows.length; i++) {
      var parsed = parseRow(rows[i], col);
      var rowNo = i + 1;                                       // как в Excel: строка 1 — заголовки
      var key = (parsed.rec.date && parsed.rec.number && parsed.rec.partner) ? Core.docKey(parsed.rec) : null;
      var g = key ? byKey[key] : null;
      if (!g) {
        g = { key: key, rows: [], errors: [], warnings: [], recs: [] };
        groups.push(g);
        if (key) byKey[key] = g;
      }
      g.rows.push(rowNo);
      g.recs.push(parsed.rec);
      parsed.errors.forEach(function (e) { g.errors.push('строка ' + rowNo + ': ' + e); });
      parsed.warnings.forEach(function (w) { g.warnings.push('строка ' + rowNo + ': ' + w); });
    }

    var counts = { ok: 0, duplicate: 0, error: 0 }, seen = {};
    var items = groups.map(function (g) {
      var item = { rows: g.rows, errors: g.errors, warnings: g.warnings, doc: null, status: 'ok' };
      if (g.errors.length) { item.status = 'error'; counts.error++; return item; }
      var first = g.recs[0];
      var inn = '';
      g.recs.forEach(function (r) { if (!inn && r.inn) inn = r.inn; });
      item.doc = {
        id: Core.newId(), type: opts.type, date: first.date, number: first.number, partner: first.partner,
        inn: inn, mode: 'net', lines: g.recs.map(function (r) { return r.line; }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      if (existingKeys[g.key]) { item.status = 'duplicate'; item.errors.push('такой УПД уже есть в списке (дата, номер и контрагент совпадают)'); counts.duplicate++; }
      else counts.ok++;
      return item;
    });
    return { ok: true, fatal: null, items: items, counts: counts };
  }

  /** Шаблон для заполнения: только заголовки, без данных. */
  function templateCSV() { return buildCSV([TEMPLATE_HEADER]); }

  return {
    detectDelimiter: detectDelimiter, parseCSV: parseCSV, buildCSV: buildCSV,
    headerToColumn: headerToColumn, parseRate: parseRate, parseImport: parseImport,
    templateCSV: templateCSV, TEMPLATE_HEADER: TEMPLATE_HEADER
  };
}));
