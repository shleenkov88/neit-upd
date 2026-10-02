/*
 * Тесты расчётов. Запуск:  node tests/vat.test.js
 * Без внешних библиотек. Завершается с кодом 1, если хоть одна проверка не прошла.
 */
'use strict';
const assert = require('assert');
const Core = require('../js/core.js');
const Csv = require('../js/csv.js');
const Storage = require('../js/storage.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const eq = assert.strictEqual;
const doc = (type, date, lines, mode) => ({ type, date, number: '1', partner: 'X', inn: '', mode: mode || 'net', lines });

console.log('Деньги');
test('parseMoney: разные записи', () => {
  eq(Core.parseMoney('108196,72'), 10819672);
  eq(Core.parseMoney('108196.72'), 10819672);
  eq(Core.parseMoney('108 196,72 ₽'), 10819672);
  eq(Core.parseMoney('1.234,56'), 123456);
  eq(Core.parseMoney('1,234.56'), 123456);
  eq(Core.parseMoney('1\u00a0000'), 100000);
  eq(Core.parseMoney('5,5'), 550);
  eq(Core.parseMoney('-500'), -50000);
  eq(Core.parseMoney('0'), 0);
});
test('parseMoney: мусор → null', () => {
  ['', 'abc', '12,345', '1.2.3', '1,2,3', '--5', '99999999999999'].forEach(s => eq(Core.parseMoney(s), null, s));
});
test('formatMoney', () => {
  eq(Core.formatMoney(10819672), '108\u00a0196,72');
  eq(Core.formatMoney(5), '0,05');
  eq(Core.formatMoney(-12345), '−123,45');
  eq(Core.formatMoney(0), '0,00');
  eq(Core.csvMoney(10819672), '108196,72');
  eq(Core.csvMoney(-12345), '-123,45');
});
test('divRound: округление «половина вверх» по модулю, без float', () => {
  eq(Core.divRound(5, 10), 1); eq(Core.divRound(4, 10), 0); eq(Core.divRound(-5, 10), -1); eq(Core.divRound(15, 10), 2);
});

console.log('НДС');
test('Пример 1: 108196,72 без НДС при 22% → НДС 23803,28, итого 132000,00', () => {
  const c = Core.calcLine({ amount: Core.parseMoney('108196.72'), rate: '22' }, 'net');
  eq(c.net, 10819672); eq(c.vat, 2380328); eq(c.gross, 13200000);
  eq(Core.csvMoney(c.vat), '23803,28'); eq(Core.csvMoney(c.gross), '132000,00');
});
test('Пример 2: 352000 с НДС при 22% «назад» → без НДС 288524,59, НДС 63475,41', () => {
  const c = Core.calcLine({ amount: Core.parseMoney('352000'), rate: '22' }, 'gross');
  eq(c.net, 28852459); eq(c.vat, 6347541); eq(c.gross, 35200000);
  eq(Core.csvMoney(c.net), '288524,59'); eq(Core.csvMoney(c.vat), '63475,41');
});
test('Все ставки: 10000,00 без НДС', () => {
  const v = r => Core.calcLine({ amount: 1000000, rate: r }, 'net').vat;
  eq(v('22'), 220000); eq(v('15'), 150000); eq(v('10'), 100000); eq(v('5'), 50000); eq(v('0'), 0); eq(v('none'), 0);
});
test('Ставки 0% и «без НДС»: с НДС = без НДС', () => {
  ['0', 'none'].forEach(r => {
    const c = Core.calcLine({ amount: 12345, rate: r }, 'gross');
    eq(c.net, 12345); eq(c.vat, 0); eq(c.gross, 12345);
  });
});
test('Округление на границе 0,5 копейки (вверх)', () => {
  // 0,25 ₽ × 10% = 0,025 коп. → 0; 0,05 ₽ × 10% = 0,5 коп. → 1 коп.
  eq(Core.calcLine({ amount: 25, rate: '10' }, 'net').vat, 3);   // 2,5 → 3
  eq(Core.calcLine({ amount: 5, rate: '10' }, 'net').vat, 1);    // 0,5 → 1
  eq(Core.calcLine({ amount: 4, rate: '10' }, 'net').vat, 0);    // 0,4 → 0
});
test('Прямой и обратный расчёт согласованы (net+vat=gross) для многих сумм', () => {
  for (const rate of ['22', '15', '10', '5']) {
    for (let a = 1; a < 3000; a += 7) {
      const g = Core.calcLine({ amount: a, rate }, 'gross');
      eq(g.net + g.vat, a);
      const n = Core.calcLine({ amount: a, rate }, 'net');
      eq(n.net + n.vat, n.gross);
    }
  }
});
test('Большие суммы без потери копеек', () => {
  const c = Core.calcLine({ amount: Core.parseMoney('99999999999,99'), rate: '22' }, 'net');
  eq(c.vat, Math.round(9999999999999 * 22 / 100)); eq(c.gross, c.net + c.vat);
});
test('Ручной НДС «как в документе» перекрывает расчёт; для 0%/без НДС игнорируется', () => {
  eq(Core.calcLine({ amount: 10819672, rate: '22', vat: 2380327 }, 'net').vat, 2380327);
  eq(Core.calcLine({ amount: 10819672, rate: '22', vat: 2380327 }, 'net').gross, 13199999);
  eq(Core.calcLine({ amount: 1000, rate: '0', vat: 55 }, 'net').vat, 0);
  const g = Core.calcLine({ amount: 13200000, rate: '22', vat: 2380327 }, 'gross');
  eq(g.net, 10819673); eq(g.vat, 2380327);
});
test('calcDoc: несколько строк и разбивка по ставкам', () => {
  const c = Core.calcDoc(doc('sale', '2026-09-25', [{ amount: 10000, rate: '22' }, { amount: 20000, rate: '10' }, { amount: 5000, rate: '22' }]));
  eq(c.net, 35000); eq(c.vat, 2200 + 2000 + 1100); eq(c.gross, c.net + c.vat);
  eq(c.byRate['22'].net, 15000); eq(c.byRate['22'].vat, 3300); eq(c.byRate['10'].vat, 2000);
});

console.log('Даты и кварталы');
test('parseDate', () => {
  eq(Core.parseDate('25.09.2026'), '2026-09-25'); eq(Core.parseDate('5.9.26'), '2026-09-05');
  eq(Core.parseDate('2026-09-25'), '2026-09-25'); eq(Core.parseDate('25/09/2026'), '2026-09-25');
  eq(Core.parseDate('30.02.2026'), null); eq(Core.parseDate('29.02.2028'), '2028-02-29'); eq(Core.parseDate('abc'), null); eq(Core.parseDate(''), null);
});
test('quarterOf: границы кварталов', () => {
  const q = d => { const r = Core.quarterOf(d); return r.year + 'Q' + r.quarter; };
  eq(q('2026-01-01'), '2026Q1'); eq(q('2026-03-31'), '2026Q1'); eq(q('2026-04-01'), '2026Q2'); eq(q('2026-06-30'), '2026Q2');
  eq(q('2026-07-01'), '2026Q3'); eq(q('2026-09-30'), '2026Q3'); eq(q('2026-10-01'), '2026Q4'); eq(q('2026-12-31'), '2026Q4');
});
test('currentQuarter и описание периода', () => {
  const c = Core.currentQuarter(new Date(2026, 9, 2));
  eq(c.year, 2026); eq(c.quarter, 4);
  eq(Core.quarterRangeText(2026, 3), 'с 1 июля по 30 сентября 2026');
  eq(Core.quarterRangeText(2028, 1), 'с 1 января по 31 марта 2028');
});

console.log('ИНН');
test('checkInn', () => {
  eq(Core.checkInn('3702195003'), 'ok');      // ООО «Нейт»
  eq(Core.checkInn('7722753969'), 'ok');
  eq(Core.checkInn('500100732259'), 'ok');    // 12 цифр
  eq(Core.checkInn('3702195004'), 'checksum');
  eq(Core.checkInn('500100732250'), 'checksum');
  eq(Core.checkInn('123'), 'format'); eq(Core.checkInn('37021950a3'), 'format'); eq(Core.checkInn(''), 'empty');
});

console.log('Сводка за квартал');
const docs = [
  doc('sale', '2026-09-25', [{ amount: 10819672, rate: '22' }]),                    // НДС 23 803,28
  doc('purchase', '2026-09-20', [{ amount: 35200000, rate: '22' }], 'gross'),        // без НДС 288 524,59, НДС 63 475,41
  doc('sale', '2026-07-05', [{ amount: 100000, rate: '10' }]),                       // НДС 100,00
  doc('sale', '2026-10-01', [{ amount: 99999999, rate: '22' }]),                     // другой квартал
  doc('purchase', '2025-09-20', [{ amount: 99999999, rate: '22' }])                  // другой год
];
test('summarize: Q3 2026', () => {
  const s = Core.summarize(docs, 2026, 3);
  eq(s.sales.count, 2); eq(s.purchases.count, 1);
  eq(s.sales.vat, 2380328 + 10000); eq(s.sales.net, 10819672 + 100000);
  eq(s.purchases.vat, 6347541); eq(s.purchases.net, 28852459);
  eq(s.diff, 2390328 - 6347541); eq(s.toPay, 0); eq(s.toRefund, 3957213);
});
test('summarize: по месяцам', () => {
  const s = Core.summarize(docs, 2026, 3);
  eq(s.months.map(m => m.month).join(), '7,8,9');
  eq(s.months[0].salesVat, 10000); eq(s.months[1].salesVat, 0);
  eq(s.months[2].salesVat, 2380328); eq(s.months[2].purchVat, 6347541);
  eq(s.months.reduce((a, m) => a + m.diff, 0), s.diff);
});
test('summarize: к уплате', () => {
  const s = Core.summarize([doc('sale', '2026-02-01', [{ amount: 100000, rate: '22' }]), doc('purchase', '2026-02-02', [{ amount: 50000, rate: '22' }])], 2026, 1);
  eq(s.diff, 22000 - 11000); eq(s.toPay, 11000); eq(s.toRefund, 0);
});
test('summarize: пустой квартал', () => {
  const s = Core.summarize([], 2026, 2);
  eq(s.diff, 0); eq(s.sales.count, 0); eq(s.profit.tax, 0);
});
test('Налог на прибыль: (продажи − покупки) × 25%, не меньше 0', () => {
  const s = Core.summarize(docs, 2026, 3);
  eq(s.profit.base, (10819672 + 100000) - 28852459);
  eq(s.profit.negative, true); eq(s.profit.tax, 0);
  const p = Core.summarize([doc('sale', '2026-02-01', [{ amount: 1000001, rate: '22' }]), doc('purchase', '2026-02-02', [{ amount: 400000, rate: '22' }])], 2026, 1);
  eq(p.profit.base, 600001); eq(p.profit.tax, 150000);   // 6000,01 × 25% = 1500,0025 → 1500,00
  eq(p.profit.negative, false);
});
test('Разбивка по ставкам суммируется в итог', () => {
  const s = Core.summarize([doc('sale', '2026-02-01', [{ amount: 10000, rate: '22' }, { amount: 20000, rate: '5' }, { amount: 777, rate: 'none' }])], 2026, 1);
  const sum = Object.values(s.sales.byRate).reduce((a, r) => a + r.vat, 0);
  eq(sum, s.sales.vat); eq(s.sales.byRate['none'].vat, 0); eq(s.sales.byRate['5'].vat, 1000);
});

console.log('Проверка УПД');
test('validateDoc', () => {
  const ok = { date: '2026-09-25', number: '147', partner: 'ООО Тест', inn: '7722753969', lines: [{ amount: 100, rate: '22' }] };
  eq(Object.keys(Core.validateDoc(ok).errors).length, 0); eq(Core.validateDoc(ok).warnings.length, 0);
  const bad = Core.validateDoc({ date: '', number: ' ', partner: '', inn: '123', lines: [{ amount: null, rate: '22' }, { amount: 0, rate: '22' }, { amount: 5, rate: '99' }] });
  ['date', 'number', 'partner', 'line-0', 'line-1', 'line-2'].forEach(k => assert.ok(bad.errors[k], k));
  eq(bad.warnings.length, 1);
  eq(Core.validateDoc(Object.assign({}, ok, { inn: '7722753960' })).warnings.length, 1);   // ИНН — только предупреждение
  assert.ok(Core.validateDoc({ date: '2026-09-25', number: '1', partner: 'a', lines: [] }).errors.lines);
});
test('normalizeDoc отбрасывает мусор', () => {
  eq(Core.normalizeDoc(null), null); eq(Core.normalizeDoc({ type: 'x' }), null);
  eq(Core.normalizeDoc({ type: 'sale', date: '2026-01-01', lines: [{ amount: 1.5, rate: '22' }] }), null);
  const d = Core.normalizeDoc({ type: 'sale', date: '2026-01-01', number: ' 7 ', partner: ' А  Б ', lines: [{ amount: 100, rate: '22' }] });
  eq(d.number, '7'); eq(d.partner, 'А Б'); eq(d.mode, 'net'); assert.ok(d.id);
});
test('docKey: регистр и пробелы не важны', () => {
  eq(Core.docKey({ date: '2026-01-01', number: ' А-1 ', partner: 'ООО  Ромашка' }), Core.docKey({ date: '2026-01-01', number: 'а-1', partner: 'ооо ромашка' }));
});

console.log('CSV и импорт');
test('parseCSV: разделители, кавычки, BOM, переводы строк', () => {
  eq(JSON.stringify(Csv.parseCSV('\uFEFFa;b;c\r\n1;"x;y";"he said ""hi"""\n')), JSON.stringify([['a', 'b', 'c'], ['1', 'x;y', 'he said "hi"']]));
  eq(Csv.detectDelimiter('a,b,c'), ','); eq(Csv.detectDelimiter('a;b;c'), ';'); eq(Csv.detectDelimiter('a\tb\tc'), '\t');
  eq(JSON.stringify(Csv.parseCSV('a,b\n1,2')), JSON.stringify([['a', 'b'], ['1', '2']]));
});
test('buildCSV: экранирование и обратный разбор', () => {
  const rows = [['а;б', 'в"г', 'д\nе', 'ж']];
  eq(JSON.stringify(Csv.parseCSV(Csv.buildCSV(rows), ';')), JSON.stringify(rows));
});
test('parseRate', () => {
  eq(Csv.parseRate('22%'), '22'); eq(Csv.parseRate('22'), '22'); eq(Csv.parseRate('10,0'), '10'); eq(Csv.parseRate('0.22'), '22');
  eq(Csv.parseRate('без НДС'), 'none'); eq(Csv.parseRate('Без НДС'), 'none'); eq(Csv.parseRate('0%'), '0'); eq(Csv.parseRate(''), '');
  eq(Csv.parseRate('20%'), null); eq(Csv.parseRate('abc'), null);
});
const HEAD = 'Дата;Номер;Контрагент;ИНН;Сумма без НДС;Ставка НДС;НДС;Итого\n';
test('Импорт: пример из задачи и сохранение копеек', () => {
  const r = Csv.parseImport(HEAD + '25.09.2026;147;ООО Тест;7722753969;108196,72;22%;23803,28;132000,00', { type: 'sale', existing: [] });
  eq(r.ok, true); eq(r.counts.ok, 1);
  const c = Core.calcDoc(r.items[0].doc);
  eq(c.net, 10819672); eq(c.vat, 2380328); eq(c.gross, 13200000); eq(r.items[0].warnings.length, 0); eq(r.items[0].doc.lines[0].vat, null);
});
test('Импорт: только «Итого» + ставка → назад', () => {
  const r = Csv.parseImport(HEAD + '20.09.2026;131;ООО Тест;;;22;;352 000,00', { type: 'purchase', existing: [] });
  const c = Core.calcDoc(r.items[0].doc);
  eq(c.net, 28852459); eq(c.vat, 6347541); eq(c.gross, 35200000);
});
test('Импорт: разделитель «,» и без заголовков', () => {
  const r = Csv.parseImport('25.09.2026,5,Тест,,100.50,10,,', { type: 'sale', existing: [] });
  eq(r.ok, true); eq(r.counts.ok, 1); eq(Core.calcDoc(r.items[0].doc).vat, 1005);
});
test('Импорт: несколько ставок в одном УПД собираются вместе', () => {
  const r = Csv.parseImport(HEAD + '01.08.2026;9;Тест;;1000;22;;\n01.08.2026;9;Тест;;2000;10;;', { type: 'sale', existing: [] });
  eq(r.items.length, 1); eq(r.items[0].doc.lines.length, 2); eq(Core.calcDoc(r.items[0].doc).vat, 22000 + 20000);
});
test('Импорт: ошибки по строкам', () => {
  const r = Csv.parseImport(HEAD + ';1;А;;100;22;;\n01.01.2026;;А;;100;22;;\n01.01.2026;2;;;100;22;;\n31.02.2026;3;А;;100;22;;\n01.01.2026;4;А;;abc;22;;\n01.01.2026;5;А;;100;20%;;\n01.01.2026;6;А;;;22;;', { type: 'sale', existing: [] });
  eq(r.counts.error, 7); eq(r.counts.ok, 0);
  r.items.forEach(i => assert.ok(i.errors.length > 0));
});
test('Импорт: ставка не указана — определяется по НДС; иначе ошибка', () => {
  const a = Csv.parseImport(HEAD + '01.01.2026;1;А;;1000;;220;', { type: 'sale', existing: [] });
  eq(a.counts.ok, 1); eq(a.items[0].doc.lines[0].rate, '22'); eq(a.items[0].warnings.length, 1);
  const b = Csv.parseImport(HEAD + '01.01.2026;1;А;;1000;;;', { type: 'sale', existing: [] });
  eq(b.counts.error, 1);
});
test('Импорт: предупреждения (ИНН, расхождение НДС), но УПД добавляется', () => {
  const r = Csv.parseImport(HEAD + '01.01.2026;1;А;123;1000;22;500;', { type: 'sale', existing: [] });
  eq(r.counts.ok, 1); assert.ok(r.items[0].warnings.length >= 2); eq(r.items[0].doc.lines[0].vat, 50000);
});
test('Импорт: защита от дублей (уже есть в базе)', () => {
  const ex = [{ type: 'sale', date: '2026-09-25', number: '147', partner: 'ооо тест' }];
  const r = Csv.parseImport(HEAD + '25.09.2026;147;ООО Тест;;100;22;;\n26.09.2026;148;ООО Тест;;100;22;;', { type: 'sale', existing: ex });
  eq(r.counts.duplicate, 1); eq(r.counts.ok, 1);
  // такой же УПД, но в другой вкладке (закупки), дублем не считается
  eq(Csv.parseImport(HEAD + '25.09.2026;147;ООО Тест;;100;22;;', { type: 'purchase', existing: ex }).counts.ok, 1);
});
test('Импорт: нет обязательных колонок / пустой файл', () => {
  eq(Csv.parseImport('', { type: 'sale' }).ok, false);
  eq(Csv.parseImport('Дата;Номер;Контрагент\n01.01.2026;1;А', { type: 'sale' }).ok, false);
});
test('Шаблон: только заголовки, без данных', () => {
  const rows = Csv.parseCSV(Csv.templateCSV());
  eq(rows.length, 1); eq(rows[0].length, 8);
  eq(Csv.parseImport(Csv.templateCSV(), { type: 'sale' }).items.length, 0);
});

console.log('Хранилище');
test('LocalStorageAdapter: put / getAll / remove / replaceAll (на подделке localStorage)', () => {
  const mem = {}; const fake = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  const a = new Storage.LocalStorageAdapter(fake);
  return a.init().then(() => a.put({ id: '1', n: 1 })).then(() => a.putMany([{ id: '2' }, { id: '1', n: 2 }])).then(() => a.getAll()).then(all => {
    eq(all.length, 2); eq(all.find(d => d.id === '1').n, 2);
    return a.remove('1');
  }).then(() => a.getAll()).then(all => { eq(all.length, 1); return a.replaceAll([]); })
    .then(() => a.getAll()).then(all => { eq(all.length, 0); eq(a.persistent, true); })
    .catch(e => { failed++; passed--; console.log('  FAIL storage: ' + e.message); });
});
test('LocalStorageAdapter: недоступный localStorage → работает в памяти и честно сообщает', () => {
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() {} };
  const a = new Storage.LocalStorageAdapter(broken);
  return a.init().then(() => { eq(a.persistent, false); return a.put({ id: 'a' }); }).then(() => a.getAll()).then(all => eq(all.length, 1))
    .catch(e => { failed++; passed--; console.log('  FAIL storage fallback: ' + e.message); });
});

setTimeout(() => {
  console.log('\nИтог: пройдено ' + passed + ', провалено ' + failed);
  process.exit(failed ? 1 : 0);
}, 50);
