/**
 * Тесты headless-CLI (задача 0.6). Читаются как сценарии запуска мира из
 * консоли: оператор отдаёт приказы флагами, ядро прогоняется, наружу выходит
 * ОДИН детерминированный хэш истории.
 *
 * Три закона под прицелом:
 *  - №8 (детерминизм): один seed → одна история, в т.ч. МЕЖДУ процессами.
 *  - D-006: замер времени и флаг `--metrics` живут только в headless и НЕ
 *    трогают состояние мира — хэш от них не шевелится.
 *  - №7: длина суток берётся из `TICKS_PER_DAY`, а не из «1440» в коде.
 *
 * Фаза 0: реальных систем нет, поэтому лог событий пуст (`events === 0`).
 * Это зафиксировано намеренно — когда системы появятся, эти якоря должны
 * осознанно измениться, а не тихо разъехаться.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseArgs, runHeadless, type CliOptions } from './cli';

// ── Разбор приказов оператора ────────────────────────────────────────────────
describe('parseArgs: оператор задаёт условия прогона', () => {
  it('без флагов мир стартует на дефолтах: 1 день, seed 42, без метрик, без хроники', () => {
    expect(parseArgs([])).toEqual({ days: 1, seed: 42, metrics: false, logMode: 'none' });
  });

  it('полный приказ "--days 3 --seed 7 --metrics" читается целиком', () => {
    expect(parseArgs(['--days', '3', '--seed', '7', '--metrics'])).toEqual({
      days: 3,
      seed: 7,
      metrics: true,
      logMode: 'none',
    });
  });

  it('порядок флагов не меняет смысл приказа: прямой и обратный дают одно', () => {
    const forward = parseArgs(['--metrics', '--days', '3', '--seed', '7']);
    const reversed = parseArgs(['--seed', '7', '--days', '3', '--metrics']);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual({ days: 3, seed: 7, metrics: true, logMode: 'none' });
  });

  // ── Флаг --log (презентация, D-006) ────────────────────────────────────────
  it('--log verbose переключает режим хроники; дефолт — none', () => {
    expect(parseArgs(['--log', 'verbose']).logMode).toBe('verbose');
    expect(parseArgs(['--log', 'none']).logMode).toBe('none');
    expect(parseArgs([]).logMode).toBe('none');
  });

  it('--log с неизвестным режимом отвергается', () => {
    expect(() => parseArgs(['--log', 'loud'])).toThrow(/log/);
    expect(() => parseArgs(['--log'])).toThrow(/log/);
  });

  it('булев --metrics срабатывает и в начале, и в хвосте приказа', () => {
    const head = parseArgs(['--metrics', '--days', '2']);
    const tail = parseArgs(['--days', '2', '--metrics']);
    expect(head.metrics).toBe(true);
    expect(tail.metrics).toBe(true);
    expect(head).toEqual(tail);
  });

  it('повторный флаг: последнее значение побеждает ("--days 2 --days 5" → 5)', () => {
    // Зафиксировано поведение «последний выигрывает» (switch перезаписывает opts).
    expect(parseArgs(['--days', '2', '--days', '5']).days).toBe(5);
    expect(parseArgs(['--seed', '1', '--seed', '9']).seed).toBe(9);
  });

  // ── Границы seed (uint32) ──────────────────────────────────────────────────
  it('seed на нижней и верхней границе uint32 (0 и 4294967295) допустим', () => {
    expect(parseArgs(['--seed', '0']).seed).toBe(0);
    expect(parseArgs(['--seed', '4294967295']).seed).toBe(0xffffffff);
  });

  it('seed за границами uint32 (-1 и 2^32) отвергается', () => {
    expect(() => parseArgs(['--seed', '-1'])).toThrow(/seed/);
    expect(() => parseArgs(['--seed', '4294967296'])).toThrow(/seed/);
  });

  // ── Валидация days ─────────────────────────────────────────────────────────
  it('дни не бывают отрицательными: "--days -1" отвергается', () => {
    expect(() => parseArgs(['--days', '-1'])).toThrow(/days/);
  });

  it('дни не бывают дробными: "--days 1.5" отвергается', () => {
    expect(() => parseArgs(['--days', '1.5'])).toThrow(/days/);
  });

  it('дни не бывают буквами: "--days abc" отвергается', () => {
    expect(() => parseArgs(['--days', 'abc'])).toThrow(/days/);
  });

  // ── Оборванные и битые приказы ─────────────────────────────────────────────
  it('оборванный "--days" в хвосте бросает, а не молча даёт NaN', () => {
    expect(() => parseArgs(['--days'])).toThrow(/days/);
    // Убеждаемся, что это именно ошибка, а не тихий NaN в результате.
    let opts: CliOptions | undefined;
    try {
      opts = parseArgs(['--days']);
    } catch {
      opts = undefined;
    }
    expect(opts).toBeUndefined();
  });

  it('оборванный "--seed" в хвосте бросает, а не молча даёт NaN', () => {
    expect(() => parseArgs(['--seed'])).toThrow(/seed/);
  });

  it('форма "--days=3" через "=" НЕ поддерживается → неизвестный аргумент', () => {
    // Документируем контракт парсера: значение отделяется только пробелом.
    // "--days=3" целиком не совпадает ни с одним case → падаем как на неизвестном флаге.
    expect(() => parseArgs(['--days=3'])).toThrow(/неизвестн/i);
    expect(() => parseArgs(['--seed=7'])).toThrow(/неизвестн/i);
  });

  it('незнакомый флаг отвергается с человекочитаемой подсказкой', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/неизвестн/i);
  });

  // ── Верхняя граница days (ЗАКРЫТАЯ дыра, findings QA / MEDIUM) ─────────────
  it('--days без верхней границы больше НЕ проходит: переполняющее значение отвергается', () => {
    // Прежде seed был ограничен uint32, а days — нет: астрономический ввод
    // (или опечатка в sim:100days) давал ticks = days*TICKS_PER_DAY сверх
    // Number.MAX_SAFE_INTEGER → тихое округление и бесконечный scheduler.run.
    // Теперь parseArgs бросает ДО умножения. Проверяем throw на переполнении:
    expect(() => parseArgs(['--days', '99999999999999999999'])).toThrow(/days/);
    // Ровно на 1 сверх безопасного максимума floor(MAX_SAFE/1440) — тоже throw.
    const maxDays = Math.floor(Number.MAX_SAFE_INTEGER / 1440);
    expect(() => parseArgs(['--days', String(maxDays + 1)])).toThrow(/days/);
  });

  it('большое-но-безопасное days (ровно на границе) валидируется без throw', () => {
    // Граница floor(MAX_SAFE/TICKS_PER_DAY): days*1440 ещё в пределах MAX_SAFE.
    // Прогон НЕ запускаем (он был бы неподъёмным) — проверяем ТОЛЬКО разбор.
    const maxDays = Math.floor(Number.MAX_SAFE_INTEGER / 1440);
    expect(parseArgs(['--days', String(maxDays)])).toEqual({
      days: maxDays,
      seed: 42,
      metrics: false,
      logMode: 'none',
    });
  });
});

// ── Детерминизм прогона ──────────────────────────────────────────────────────
describe('runHeadless: одна история из одного seed (закон №8)', () => {
  const base: CliOptions = { days: 1, seed: 42, metrics: false, logMode: 'none' };

  it('два прогона одного мира дают побитово один и тот же хэш', () => {
    expect(runHeadless(base).snapshotHash).toBe(runHeadless(base).snapshotHash);
  });

  it('ЖИВОЙ мир: days=1/seed=42 порождает события (мир что-то делает, events > 0)', () => {
    // Фаза 1 (1.12): worldgen + 9 систем. Лог больше НЕ пуст — сталкеры выбирают
    // задачи, ходят, охотятся, гибнут; погода меняется; стада плодятся.
    const r = runHeadless(base);
    expect(r.events).toBeGreaterThan(0);
  });

  it('days=2 воспроизводим и лог живого мира непуст', () => {
    const a = runHeadless({ ...base, days: 2, seed: 7 });
    const b = runHeadless({ ...base, days: 2, seed: 7 });
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.events).toBeGreaterThan(0);
    expect(a.events).toBe(b.events);
  });

  it('четыре разных seed дают четыре разных истории (попарно различны)', () => {
    const seeds = [1, 2, 7, 99];
    const hashes = seeds.map((seed) => runHeadless({ ...base, seed }).snapshotHash);
    expect(new Set(hashes).size).toBe(seeds.length);
  });

  it('days=0 → ноль тиков планировщика, но worldgen уже населил мир (хэш валиден и стабилен)', () => {
    // days=0: систем НЕ прогоняем (0 тиков), но worldgen отработал при сборке —
    // события шины он не публикует (генезис — корень причинности, D-021), так что
    // лог пуст, а хэш детерминирован населённым, но ещё не «ожившим» миром.
    const r = runHeadless({ ...base, days: 0 });
    expect(r.events).toBe(0);
    expect(r.snapshotHash).toMatch(/^[0-9a-f]{8}$/);
    expect(r.snapshotHash).toBe(runHeadless({ ...base, days: 0 }).snapshotHash);
  });

  it('десять дней (14400 тиков) прогоняются без NaN и дают валидный хэш живого мира', () => {
    // D-075 (фикс здоровья нарратива): квадрат rumor-памяти Фазы 3 снят (addMemory
    // консолидирует память по факту) ⇒ горизонт возвращён на 10 дней (было 2 при ПЕРФ-ФЛАГЕ
    // D-074). 10-дневный прогон Фазы 3 теперь идёт за единицы секунд.
    const r = runHeadless({ ...base, days: 10 });
    expect(r.snapshotHash).toMatch(/^[0-9a-f]{8}$/);
    expect(Number.isNaN(r.ms)).toBe(false);
    expect(r.events).toBeGreaterThan(0);
  }, 120000);

  // ── ГОЛДЕНЫ живого CLI (закреплены задачей 1.12; core-голден 481914ae не тронут) ─
  it('ГОЛДЕН: day=1 seed=42 → 429867e2 (тот же прогон, что npm run smoke)', () => {
    // Якорь истории живого мира за один день. Смена значит: поведение систем
    // ИЛИ порядок ИЛИ worldgen изменились — обновлять ОСОЗНАННО, не молча.
    // Пере-закреплён balance-analyst-сессией (Фаза 1): смягчение спирали смерти
    // сменило константы (THIRST_PER_TICK, boar melee, gestationTicks) → e04c0d77
    // → 8a8faff4. Пере-закреплён задачей 2.0 (D-045): ретрофит леджера добавил
    // события item/consumed(eat/combat)+item/harvested(meat) в лог → 8a8faff4 →
    // cb104eca (мир НЕ изменился, только лог событий длиннее). Пере-закреплён задачей
    // 2.2: worldgen добавил 2 поселения (склад/касса — БАЗЛАЙН) + 2 торговца; новые
    // носители и 2 лишних актёра сдвигают общий поток world.rng → cb104eca → 70e9e546.
    // Пере-закреплён задачей 2.6: TaskSelection научился выбирать TRADE → 70e9e546 →
    // 165688eb. Пере-закреплён задачей 2.16a (D-064): CLI переключён на
    // registerPhase2Systems — оживают Economy (upkeep/производство поселений через
    // леджер) и Trade (NPC с TRADE-задачей реально торгуют у поселения), возможен
    // приток PopulationInflux по окну лога; поля/бандитов ещё нет (2.16b) ⇒
    // ArtifactSpawn/Search/Export/RobberyMemory/MemoryDecay дремлют → 165688eb →
    // 675e1485. Пере-закреплён задачей 2.16b (D-065): worldgen оживил ДРЕМЛЮЩИЕ петли —
    // 3 носителя AnomalyField (артефакты рождаются/собираются), 4 бандита (фракция
    // bandits predatory ⇒ ROB/RobberyMemory), резиденты + assignJobs (census труда
    // Economy > 0 ⇒ производство); +бандиты/резиденты/поля сдвигают общий поток
    // world.rng ⇒ 675e1485 → 1d52f17d (events 11170 → 18829). Перф-фиксы шины (индекс
    // by-tick + findLast) РЕЗУЛЬТАТ-ТОЖДЕСТВЕННЫ (хэш не тронут). См. DECISIONS
    // D-042/D-045/D-046/D-054/D-062/D-064/D-065.
    // Пере-закреплён задачей 2.16c (D-066): калибровка здоровья мира — балансовые
    // константы (W.trade 0.6→0.75 ВЫШЕ W.search, EXPORT_PRICE_FACTOR 1.0→1.3) оживляют
    // money-faucet: NPC с артефактом несёт его ПРОДАТЬ (а не копит), поселение
    // экспортирует за Периметр (moneyIn извне; на уровне поселения цикл пока слабо
    // убыточен — полная окупаемость за код-хвостами P-6). Иные оценки задач с тика 0
    // ⇒ 1d52f17d → 74211540.
    // Пере-закреплён задачей 3.0 (D-072, P-2): гейт Perception по АКТЁРАМ (Human/
    // Animal). Не-акторные носители Position (2 поселения 2.2 + 3 аномальных поля 2.9)
    // больше не попадают в contacts и не порождают шумовых perception/spotted ⇒ их
    // число за день УПАЛО 16358 → 10097 (−38%); меньше событий сдвигает id-нумерацию и
    // штампы причинности всего лога ⇒ 74211540 → 9bc823a7 (events 18919 → 12658). Мир
    // ПОВЕДЕНЧЕСКИ тот же (не-акторные contacts никто не потреблял: TaskSelection/
    // Encounters таргетят по loc/Human/Animal, D-038/D-072) — сдвиг чисто «меньше шума».
    // Пере-закреплён задачей 3.3 (D-071): worldgen сидит Personality {temperament,
    // talkativeness} КАЖДОМУ человеку — +2 rng-вызова на человека в КОНЦЕ spawnStalker.
    // Personality в тике НИКТО не читает (Radio 3.5 / Rumors 3.6 подключат) ⇒ НОВОГО
    // поведения нет; но общий подпоток world.rng('worldgen') последователен, поэтому +2
    // rng/человека ЗАКОННО сдвигают детерминированный стартовый мир (нужды/навыки/имена/
    // позиции/стада downstream) ⇒ 9bc823a7 → 3c54d141 (events 12658 → 13027).
    // Пере-закреплён задачей 3.7 (D-074, КАПСТОУН Фазы 3): CLI переключён на
    // registerPhase3Systems — оживает НАРРАТИВНЫЙ БЛОК (Radio→Rumors→Chronicle перед Death).
    // Эфир/молва/летопись ЗАПОЛНЯЮТ лог (radio/message, radio/relayed, chronicle/recorded) и
    // Chronicle копит fame субъектам (fame-петля §10.2) ⇒ хэш сдвинут МАССИВНО: 3c54d141 →
    // f554331d (events 13027 → 14794; за день-1 нарративных: radio/message 22, radio/relayed
    // 1728, chronicle/recorded 17). МИР ПОВЕДЕНЧЕСКИ ТОТ ЖЕ: все три системы читают
    // ЗАКОММИЧЕННОЕ прошлое (bus.at(tick−1)/окно, D-005) и пишут ТОЛЬКО fame/memory (ключи,
    // дизъюнктные money/inventory/positions) ⇒ perception/spotted неизменно 9217, EconomyInvariant
    // держится (нарратив массу не творит: chronicle/radio/relayed — не леджер, D-045/D-074).
    // Пере-закреплён задачей 3.8 (D-075, фикс здоровья нарратива): addMemory КОНСОЛИДИРУЕТ
    // память по (kind, subject, isFirsthand) — один слух/факт = одна ОСВЕЖАЕМАЯ запись, а не
    // тысячи копий (снят квадрат rumor-памяти 3.7). Event-ЛОГ БАЙТ-В-БАЙТ тот же (events 14794
    // не изменились — дедуп трогает ТОЛЬКО ключ 'memory', не эмитит/не гасит событий, поведение
    // мира тождественно), но сериализованная 'memory' иная ⇒ хэш сдвинут f554331d → 429867e2.
    // 5.0/D-083 (схемы Фазы 5): singleton WorldClock вырос с 2→5 полей (эмиссия, все=0) ⇒
    // канон сдвинут ЧИСТО СХЕМНО 429867e2 → 1b5beda6 (events 14794 те же, лог байт-в-байт).
    // 5.2/D-085 (FORAGE→forage_food + водопой-миграция животных): ПОВЕДЕНЧЕСКИЙ сдвиг —
    // фуражировка снимает голодные смерти дня-1 (день 1 мирный: 0 смертей, первые смерти
    // со дня 3), животные больше не гибнут от жажды (graze-first + миграция к воде).
    // P-5 задача А/D-086 (стоимость погони → равновесие хищник-жертва): лог день-1 19010→19122,
    // хэш 00dc66c3→7cd7db13 (детерминизм 2×).
    expect(runHeadless({ ...base, days: 1, seed: 42 }).snapshotHash).toBe('7cd7db13');
  });

  // ГОЛДЕН day=100 (npm run sim:100days). UN-SKIPPED задачей 3.8 (D-075): перф-квадрат rumor-
  // памяти 3.7 СНЯТ структурно (addMemory консолидирует память по факту), прогон 100 дней теперь
  // ~60с (было ~650с) — тест практичен и держится в таймауте 120с. Голден 0f1ef408 замерен
  // ПРЯМЫМ прогоном (npm run sim:100days / registerPhase3Systems — тот же путь, что buildWorld).
  it(
    'ГОЛДЕН: day=100 seed=42 → 0f1ef408 (npm run sim:100days)',
    () => {
      // Пере-закреплён balance-analyst-сессией: 925aa279 → f4cc990d. Пере-закреплён
      // задачей 2.0 (D-045): леджер-события в логе → f4cc990d → 84359104. Пере-закреплён
      // задачей 2.2: поселения+торговцы → 84359104 → ee2ef84c. Пере-закреплён задачей
      // 2.6: TaskSelection выбирает TRADE → ee2ef84c → 37a19d72. Пере-закреплён задачей
      // 2.16a (D-064): CLI на registerPhase2Systems (17 систем) — Economy/Trade/
      // PopulationInflux оживают → 37a19d72 → 626a8329. Пере-закреплён задачей 2.16b
      // (D-065): worldgen оживил ДРЕМЛЮЩИЕ петли (поля/бандиты/резиденты+наём) — все 17
      // систем реально работают (артефакты рождаются/собираются, бандиты грабят, приток
      // компаундится) → 626a8329 → 2fa78c11 (events 91655 → 798784). Прохождение этого
      // голдена ДОКАЗЫВАЕТ: EconomyInvariant держится весь 100-дневный прогон, ВКЛЮЧАЯ
      // склады/кассы поселений (базлайн t0), артефакты полей (item/harvested), реальные
      // сделки Trade (конс. перевод) и приток item/broughtIn (runHeadless сверяет массу
      // с леджером раз в игровой день и НЕ бросает) — ничего из воздуха (№3, D-045).
      // Перф-фиксы шины (индекс by-tick + findLast, 2.16b) РЕЗУЛЬТАТ-ТОЖДЕСТВЕННЫ (хэш
      // 2fa78c11 идентичен до/после фиксов) — они лишь сняли O(тиков×лога)-квадрат,
      // из-за которого плотный лог Фазы 2 деградировал прогон (587с → ~70с).
      // Пере-закреплён задачей 2.16c (D-066): балансовая калибровка money-faucet
      // (W.trade 0.6→0.75 ВЫШЕ W.search, EXPORT_PRICE_FACTOR 1.0→1.3) сдвигает
      // 100-дневную историю ⇒ 2fa78c11 → b64691c7 (events 798784 → 563941). Голден по-
      // прежнему ДОКАЗЫВАЕТ, что EconomyInvariant держится весь прогон, ВКЛЮЧАЯ новый
      // рабочий faucet: артефакты доходят до склада поселения и вывозятся за Периметр
      // (item/exported: товар −, деньги +), масса сверяется с леджером (D-045/D-066).
      // Пере-закреплён задачей 3.0 (D-072, P-2): гейт Perception по АКТЁРАМ. Не-акторные
      // носители Position (поселения 2.2 + аномальные поля 2.9) убраны из contacts ⇒
      // 100-дневный счётчик perception/spotted УПАЛ 82529 → 53697 (−35%); меньше событий
      // сдвигает id-нумерацию/штампы всего лога ⇒ b64691c7 → 0eb70da4 (events 563941 →
      // 535109). Мир ПОВЕДЕНЧЕСКИ тот же — не-акторные contacts не потреблялись решениями
      // (D-038/D-072). Голден по-прежнему ДОКАЗЫВАЕТ, что EconomyInvariant держится весь
      // прогон (масса сверяется с леджером раз в день, D-045) — perception массу не трогает.
      // Пере-закреплён задачей 3.3 (D-071): worldgen сидит Personality каждому человеку
      // (+2 rng-вызова на человека в КОНЦЕ spawnStalker); Personality в тике не читается ⇒
      // НОВОГО поведения нет, но rng-хвост ЗАКОННО сдвигает стартовый мир и всю 100-дневную
      // историю ⇒ 0eb70da4 → fd0bec10 (events 535109 → 532278). EconomyInvariant по-прежнему
      // держится весь прогон (масса сверяется с леджером, D-045) — Personality массу не трогает.
      // Пере-закреплён задачей 3.7 (D-074, КАПСТОУН Фазы 3): CLI на registerPhase3Systems —
      // оживает нарративный блок (Radio→Rumors→Chronicle перед Death). Эфир/молва/летопись
      // ЗАПОЛНЯЮТ лог и Chronicle копит fame ⇒ fd0bec10 → 561cc138 (events 532278 → 601468; за
      // 100 дней нарративных: radio/message 339, radio/relayed 68558, chronicle/recorded 293 —
      // ~692 нарративных событий/день). EconomyInvariant ДЕРЖИТСЯ весь прогон (нарратив массу не
      // творит: chronicle/radio/relayed — не леджер, incFame/addMemory двигают fame/memory,
      // дизъюнктные money/inventory; runHeadless сверяет массу с леджером раз в день, НЕ бросил).
      // Пере-закреплён задачей 3.8 (D-075, ФИКС ЗДОРОВЬЯ/ПЕРФА нарратива): addMemory КОНСОЛИДИРУЕТ
      // rumor-память по (kind, subject, isFirsthand) — слушатель хранит ОДНУ обновляемую запись о
      // факте, а не тысячи копий ⇒ массив 'memory'/NPC ОГРАНИЧЕН числом различных фактов (memMax
      // ~60 против ~38k), квадрат addMemory снят. Прогон 100 дней ~650с → ~60с (ниже базлайна
      // Фазы 2 ~70с). Event-ЛОГ БАЙТ-В-БАЙТ тот же (events 601468 не изменились — дедуп трогает
      // ТОЛЬКО ключ 'memory', поведение мира тождественно; radio/message 339, radio/relayed 68558,
      // chronicle/recorded 293 ЖИВЫ), но сериализованная 'memory' иная ⇒ 561cc138 → 0f1ef408.
      // EconomyInvariant по-прежнему держится весь прогон (нарратив/память массу не творят).
      // 5.0/D-083 (схемы Фазы 5): рост singleton WorldClock 2→5 полей (эмиссия=0) сдвинул канон
      // ЧИСТО СХЕМНО 0f1ef408 → 722409ac (events 601468 те же, лог байт-в-байт).
      // 5.2/D-085 (FORAGE→forage_food + водопой-миграция): ПОВЕДЕНЧЕСКИЙ сдвиг (форедж-питание,
      // животные не гибнут от жажды, охота калибрована) ⇒ 722409ac → 5c19263a (детерминизм 2×;
      // EconomyInvariant держится весь прогон — форедж-масса леджерится item/harvested
      // source:'forage'). P-5 (стада живут дольше, но хвост hunter-targeting остаётся — см. D-085).
      expect(runHeadless({ ...base, days: 100, seed: 42 }).snapshotHash).toBe('5c19263a');
    },
    240000, // 100 дней ~60с изолированно, НО под полной параллельной нагрузкой сьюта (плотный
    // нарративный лог Фазы 3 ~601k событий) доходит до ~130с ⇒ 120с флейкал таймаутом.
    // 240с — щедрый запас под CPU-контеншн. Мир/хэш от таймаута не зависят (D-006, презентация).
  );

  // ── Детерминизм живого мира на НЕСКОЛЬКИХ seed ──────────────────────────────
  // D-075: квадрат rumor-памяти Фазы 3 снят (addMemory консолидирует память) ⇒ горизонт
  // возвращён на 10 дней (было 2 при ПЕРФ-ФЛАГЕ D-074). Детерминизм и seed-зависимость на
  // ПЛОТНОМ нарративном мире — 6 десятидневных прогонов Фазы 3 идут за секунды.
  it('каждый seed воспроизводим: два прогона (42,7,999) за 10 дней идентичны', () => {
    for (const seed of [42, 7, 999]) {
      const a = runHeadless({ ...base, days: 10, seed });
      const b = runHeadless({ ...base, days: 10, seed });
      expect(a.snapshotHash, `seed=${seed}: два прогона обязаны совпасть`).toBe(b.snapshotHash);
      expect(a.events).toBe(b.events);
    }
  }, 120000);

  it('РАЗНЫЕ seed → РАЗНЫЕ истории: мир реально зависит от seed (42≠7≠999)', () => {
    const hashes = [42, 7, 999].map((seed) => runHeadless({ ...base, days: 10, seed }).snapshotHash);
    expect(new Set(hashes).size).toBe(3);
  }, 120000);

  it('НАДЁЖНОСТЬ: прогоны не делят изменяемое состояние — результат не зависит от предыстории', () => {
    // Прогоняем чужой seed, затем целевой; сравниваем с «чистым» целевым прогоном.
    const clean = runHeadless({ ...base, days: 2, seed: 7 }).snapshotHash;
    runHeadless({ ...base, days: 5, seed: 123 }); // «шум» между вызовами
    runHeadless({ ...base, days: 1, seed: 999 });
    const afterNoise = runHeadless({ ...base, days: 2, seed: 7 }).snapshotHash;
    expect(afterNoise).toBe(clean);
  }, 120000); // 4 полных живых прогона: под нагрузкой полного сьюта дефолтные 5000мс мало (флейки).
});

// ── Детерминизм МЕЖДУ процессами ─────────────────────────────────────────────
describe('runHeadless: одинаковый хэш и в новом процессе (закон №8)', () => {
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const tsxBin = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

  const runCli = (args: string[]): string =>
    execFileSync(tsxBin, [cliPath, ...args], { encoding: 'utf8' }).trim();

  it(
    'CLI, запущенный дважды в отдельных процессах, печатает идентичный хэш',
    () => {
      const first = runCli(['--days', '2', '--seed', '7']);
      const second = runCli(['--days', '2', '--seed', '7']);
      expect(first).toMatch(/^[0-9a-f]{8}$/);
      expect(first).toBe(second);
    },
    120000,
  );

  it(
    'хэш из отдельного процесса совпадает с in-process runHeadless (нет скрытой зависимости от процесса)',
    () => {
      const inProcess = runHeadless({ days: 2, seed: 7, metrics: false, logMode: 'none' }).snapshotHash;
      const subprocess = runCli(['--days', '2', '--seed', '7']);
      expect(subprocess).toBe(inProcess);
    },
    120000,
  );
});

// ── Инвариант D-006 ──────────────────────────────────────────────────────────
describe('D-006: метрики, замер времени и режим лога не касаются состояния мира', () => {
  it('metrics=true и metrics=false дают ОДИН И ТОТ ЖЕ хэш и одинаковый лог', () => {
    const withM = runHeadless({ days: 2, seed: 7, metrics: true, logMode: 'none' });
    const without = runHeadless({ days: 2, seed: 7, metrics: false, logMode: 'none' });
    expect(withM.snapshotHash).toBe(without.snapshotHash);
    expect(withM.events).toBe(without.events);
  });

  it('логи verbose и none дают ОДИН И ТОТ ЖЕ хэш (презентация не влияет, D-006)', () => {
    const verbose = runHeadless({ days: 2, seed: 7, metrics: false, logMode: 'verbose' });
    const none = runHeadless({ days: 2, seed: 7, metrics: false, logMode: 'none' });
    expect(verbose.snapshotHash).toBe(none.snapshotHash);
    expect(verbose.events).toBe(none.events);
    // verbose даёт строки хроники, none — нет.
    expect(verbose.logLines).toBeDefined();
    expect(none.logLines).toBeUndefined();
    expect((verbose.logLines ?? []).length).toBeGreaterThan(0);
  });

  it('инвариант держится на наборе (days, seed): {(0,42),(1,42),(2,7),(3,99),(5,999)}', () => {
    // D-075: квадрат rumor-памяти Фазы 3 снят ⇒ горизонт возвращён (3/5 дней, было ≤2 при
    // ПЕРФ-ФЛАГЕ D-074). Инвариант D-006 (metrics/verbose/тайминг не меняют мир/хэш).
    const cases: Array<[number, number]> = [
      [0, 42],
      [1, 42],
      [2, 7],
      [3, 99],
      [5, 999],
    ];
    for (const [days, seed] of cases) {
      // Три презентационных профиля обязаны дать ОДИН И ТОТ ЖЕ хэш: чистый,
      // с метриками и с verbose-хроникой (D-006 — вывод/тайминг вне мира).
      const plain = runHeadless({ days, seed, metrics: false, logMode: 'none' });
      const metrics = runHeadless({ days, seed, metrics: true, logMode: 'none' });
      const verbose = runHeadless({ days, seed, metrics: false, logMode: 'verbose' });
      const tag = `days=${days} seed=${seed}`;
      expect(metrics.snapshotHash, `${tag}: --metrics не должен менять мир`).toBe(plain.snapshotHash);
      expect(verbose.snapshotHash, `${tag}: --log verbose не должен менять мир`).toBe(plain.snapshotHash);
      // ms — презентационная величина: неотрицательна и в любом профиле.
      expect(plain.ms, `${tag}: ms>=0`).toBeGreaterThanOrEqual(0);
      expect(verbose.ms, `${tag}: ms>=0`).toBeGreaterThanOrEqual(0);
    }
  }, 120000); // 5 кейсов × 3 профиля прогонов; запас под параллель + плотнее мир (2.6 TRADE)

  it('ms — неотрицательное число и не участвует в хэше', () => {
    const r = runHeadless({ days: 1, seed: 42, metrics: true, logMode: 'none' });
    expect(typeof r.ms).toBe('number');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.snapshotHash).toBe(
      runHeadless({ days: 1, seed: 42, metrics: false, logMode: 'none' }).snapshotHash,
    );
  });
});
