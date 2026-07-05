/**
 * @module @zona/headless/phase3-capstone.test
 *
 * КАПСТОУН ФАЗЫ 3 — УСИЛЕНИЕ ГЕЙТА (3.7/D-074 нарратив + 3.8/D-075 консолидация памяти).
 * Читается как ДЛИННЫЙ сценарий Зоны: «месяц Зона живёт без игрока — переговаривается в эфире,
 * разносит слухи, ведёт летопись своих драм; ничего не берётся из воздуха, память сталкеров не
 * пухнет до тысяч записей, а каждое событие летописи и каждая смерть прослеживаются по причинам
 * до самого корня». Три семени независимых историй — 42/7/999.
 *
 * ПОЧЕМУ ОТДЕЛЬНО ОТ phase3-pipeline.test.ts:
 *  · phase3-pipeline (D-074) писался ПОД ПЕРФ-ФЛАГ квадрата rumor-памяти и потому заперт на
 *    seed 42 × 2 дня. Задача 3.8 (D-075) СНЯЛА квадрат структурной консолидацией addMemory
 *    (память ограничена числом РАЗЛИЧНЫХ фактов, memMax ~64, sim:100days ~60с) — перф теперь
 *    ПОЗВОЛЯЕТ прогнать закон №3 на ЖИВОМ нарративе широко: 3 семени × 30 дней ≈ 30с.
 *  · Здесь целимся ИМЕННО в обещания, которые короткий горизонт доказать НЕ мог: масса держится
 *    ВЕСЬ ДЛИННЫЙ прогон на ВСЕХ семенах; консолидация ограничивает память ПОД НАГРУЗКОЙ (обильные
 *    слухи, но мало фактов); нарратив жив на КАЖДОМ семени; причинность цела через десятки тысяч
 *    нарративных событий (ни висячих `causedBy`, ни ссылок вперёд — цепочка сходится к корню).
 *
 * Соседние грани НЕ дублируются: единицы консолидации — memory.test.ts (D-075); порядок 20 систем
 * — pipeline.test.ts (D-074); детерминизм 2× / resume≡continuous с нарративом — phase1-gate.test.ts
 * + phase3-pipeline.test.ts; пустой мир 481914ae — phase3-pipeline.test.ts; голдены day1 429867e2 /
 * day100 0f1ef408 и перф — cli.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { Seed, Tick, MemoryRecord, SimEvent, EventId } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  registerPhase3Systems,
  worldgen,
  TICKS_PER_DAY,
  MEMORY_KEY,
  type SimWorld,
} from '@zona/sim';
import { worldTotals, ledgerDelta, assertEconomyInvariant, type EconTotals } from './economy-invariant';

// 3 семени = 3 независимых истории; 30 дней = «≥30» из наряда (закон №3 на живом нарративе).
// Перф после D-075: ~9-11с на семя (memMax ограничен консолидацией), ~30с суммарно.
const SEEDS = [42, 7, 999] as const;
const DAYS = 30;

/** Собирает ПОЛНЫЙ конвейер Фазы 3 (20 систем) тем же путём, что headless-CLI (D-074). */
function buildPhase3(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase3Systems(scheduler);
  return { world, scheduler };
}

interface CapstoneRun {
  readonly seed: number;
  readonly world: SimWorld;
  readonly baseline: EconTotals;
  /** Первый день, на котором assertEconomyInvariant бросил (null — не бросал ни разу). */
  readonly firstBreakingDay: number | null;
  readonly firstBreakMessage: string | null;
  readonly counts: Readonly<Record<string, number>>;
  /** Максимум записей памяти по любому NPC за ВЕСЬ прогон (потолок ёмкости D-075). */
  readonly memMaxOverRun: number;
  readonly maxFame: number;
  readonly fameCarriers: number;
}

/** Пик числа записей 'memory' по любому NPC на текущий момент (обход отсортирован по eid, №8). */
function peakMemory(world: SimWorld): number {
  let peak = 0;
  for (const [, recs] of world.resources.entries<readonly MemoryRecord[]>(MEMORY_KEY)) {
    if (recs.length > peak) peak = recs.length;
  }
  return peak;
}

function runCapstone(seed: number): CapstoneRun {
  const { world, scheduler } = buildPhase3(seed);
  const baseline = worldTotals(world);

  let firstBreakingDay: number | null = null;
  let firstBreakMessage: string | null = null;
  let memMaxOverRun = 0;
  for (let day = 1; day <= DAYS; day++) {
    scheduler.run(world, TICKS_PER_DAY);
    // Закон №3 КАЖДЫЙ день: масса замкнутого мира ровно на леджере (не «в конце», а весь прогон).
    if (firstBreakingDay === null) {
      try {
        assertEconomyInvariant(world, world.bus, baseline, world.tick);
      } catch (e) {
        firstBreakingDay = day;
        firstBreakMessage = (e as Error).message;
      }
    }
    // Пик памяти замеряем ПОДЕННО — ловит рост даже если к финалу MemoryDecay подрежет хвост.
    const peak = peakMemory(world);
    if (peak > memMaxOverRun) memMaxOverRun = peak;
  }

  const counts: Record<string, number> = {};
  for (const ev of world.bus.log) counts[ev.type] = (counts[ev.type] ?? 0) + 1;

  let maxFame = 0;
  let fameCarriers = 0;
  for (const [, f] of world.resources.entries<number>('fame')) {
    if (f > 0) fameCarriers++;
    if (f > maxFame) maxFame = f;
  }

  return { seed, world, baseline, firstBreakingDay, firstBreakMessage, counts, memMaxOverRun, maxFame, fameCarriers };
}

// Один тяжёлый прогон на семя, переиспользуемый всеми гранями (память как в phase3-pipeline).
const RUNS = new Map<number, CapstoneRun>();
function runOf(seed: number): CapstoneRun {
  let r = RUNS.get(seed);
  if (r === undefined) {
    r = runCapstone(seed);
    RUNS.set(seed, r);
  }
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) ЗАКОН №3 НА ЖИВОМ НАРРАТИВЕ, ВЕСЬ ДЛИННЫЙ ПРОГОН (D-045/D-074): масса замкнутого
//    мира весь месяц ровно на леджере. Нарратив (эфир/молва/летопись/fame/память слуха)
//    массу НЕ творит — chronicle/radio/relayed не леджер-типы, incFame/addMemory двигают
//    ключи fame/memory (дизъюнктны money/inventory). 3 семени × 30 дней.
// ═════════════════════════════════════════════════════════════════════════════
describe('Месяц Зоны: масса весь прогон на леджере — нарратив не творит денег/предметов (закон №3, D-074)', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}: ${DAYS} дней всех 20 систем`, () => {
      const r = runOf(seed);

      it('ни одного дня с массой вне леджера (assertEconomyInvariant не бросил ни разу)', () => {
        expect(
          r.firstBreakingDay,
          r.firstBreakingDay === null ? '' : `масса разошлась на дне ${r.firstBreakingDay}: ${r.firstBreakMessage}`,
        ).toBeNull();
      });

      it('дельта массы == леджер на финале месяца (деньги и каждый предмет сходятся)', () => {
        const now = worldTotals(r.world);
        const ledger = ledgerDelta(r.world.bus, 0 as Tick, r.world.tick);
        expect(now.money - r.baseline.money, 'деньги').toBe(ledger.money);
        const items = new Set<string>([...now.items.keys(), ...r.baseline.items.keys(), ...ledger.items.keys()]);
        for (const item of items) {
          const observed = (now.items.get(item as never) ?? 0) - (r.baseline.items.get(item as never) ?? 0);
          const expected = ledger.items.get(item as never) ?? 0;
          expect(observed, `предмет ${item}`).toBe(expected);
        }
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) КОНСОЛИДАЦИЯ ОГРАНИЧИВАЕТ ПАМЯТЬ ПОД НАГРУЗКОЙ (D-075, СНЯТИЕ ПЕРФ-КВАДРАТА 3.7):
//    слухи бушуют (десятки тысяч radio/relayed за месяц), но addMemory консолидирует по
//    факту (kind, subject, isFirsthand) ⇒ у любого NPC ОСТАЁТСЯ мало РАЗЛИЧНЫХ фактов, а
//    НЕ тысячи копий. До фикса memMax рос ~38k к дню 8; после — держится десятками (~64).
// ═════════════════════════════════════════════════════════════════════════════
describe('Молва бушует, память ограничена: консолидация по факту держит memory малой (D-075)', () => {
  // Порог с ОГРОМНЫМ запасом над структурным потолком (~64): при возврате квадрата (append
  // копий вместо merge) memMax был бы тысячами — этот предел его ловит, не флейча на разбросе.
  const MEM_CEILING = 500;

  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const r = runOf(seed);

      it('слухов ОБИЛЬНО за месяц (radio/relayed > 1000 — нагрузка реальна, не холостой тест)', () => {
        expect(r.counts['radio/relayed'] ?? 0).toBeGreaterThan(1000);
      });

      it(`пик памяти любого NPC ОГРАНИЧЕН (< ${MEM_CEILING}) весь прогон — не тысячи копий (квадрат снят)`, () => {
        expect(
          r.memMaxOverRun,
          `memMax=${r.memMaxOverRun} при relayed=${r.counts['radio/relayed'] ?? 0}: если это тысячи — вернулся квадрат 3.7`,
        ).toBeLessThan(MEM_CEILING);
      });

      it('память МНОГО меньше числа услышанных слухов (тысячи повторов схлопнуты в единицы фактов)', () => {
        // Прямое выражение семантики D-075: слышано десятки тысяч раз — помнится десятками.
        expect(r.memMaxOverRun * 50).toBeLessThan(r.counts['radio/relayed'] ?? 0);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) НАРРАТИВ ЖИВ НА КАЖДОМ СЕМЕНИ (D-074): эфир звучит, молва ползёт, летопись пишется,
//    fame копится — на ВСЕХ трёх историях, а не только на 42 (phase3-pipeline брал одно).
// ═════════════════════════════════════════════════════════════════════════════
describe('Нарратив жив на каждом семени: эфир/молва/летопись/fame > 0 (D-074)', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const r = runOf(seed);

      it('эфир звучит: radio/message > 0 (живые свидетели озвучивают значимое)', () => {
        expect(r.counts['radio/message'] ?? 0).toBeGreaterThan(0);
      });

      it('молва ползёт: radio/relayed > 0 (болтуны пересказывают с искажением)', () => {
        expect(r.counts['radio/relayed'] ?? 0).toBeGreaterThan(0);
      });

      it('летопись пишется: chronicle/recorded > 0 (значимое ложится в хроники мира)', () => {
        expect(r.counts['chronicle/recorded'] ?? 0).toBeGreaterThan(0);
      });

      it('слава копится: есть носители fame > 0 (петля §10.2 запущена Chronicle)', () => {
        expect(r.fameCarriers).toBeGreaterThan(0);
        expect(r.maxFame).toBeGreaterThan(0);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) ПРИЧИННОСТЬ ЦЕЛА ЧЕРЕЗ ВЕСЬ НАРРАТИВНЫЙ ЛОГ (закон №6/D-030): у КАЖДОГО события
//    causedBy либо null (корень), либо ссылается на РАНЕЕ опубликованное событие (лог
//    append-only ⇒ id причины строго меньше). Нет висячих ссылок, нет ссылок вперёд/на
//    себя. Нарративные события и смерти прослеживаются по причинам ДО корня.
// ═════════════════════════════════════════════════════════════════════════════
describe('Причинность цела: каждое событие месяца прослеживается по causedBy до корня (закон №6)', () => {
  const NARRATIVE_AND_DEATH = new Set<string>([
    'radio/message',
    'radio/relayed',
    'chronicle/recorded',
    'entity/died',
  ]);

  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const r = runOf(seed);
      const log = r.world.bus.log;
      const byId = new Map<number, SimEvent>();
      for (const ev of log) byId.set(ev.id as number, ev);

      it('ни одной висячей причины и ни одной ссылки вперёд (лог append-only, id причины < id следствия)', () => {
        let dangling = 0;
        let forwardOrSelf = 0;
        for (const ev of log) {
          const cb = ev.causedBy;
          if (cb === null) continue; // корень цепочки — законно
          if (!byId.has(cb as number)) dangling++;
          else if ((cb as number) >= (ev.id as number)) forwardOrSelf++;
        }
        expect(dangling, 'висячие causedBy (причина не в логе)').toBe(0);
        expect(forwardOrSelf, 'причина с id >= следствия (ссылка вперёд/на себя)').toBe(0);
      });

      it('каждое событие эфира/молвы/летописи/смерти сходится по цепочке причин к корню (null)', () => {
        const resolveToRoot = (start: SimEvent): boolean => {
          let cur: SimEvent | undefined = start;
          const seen = new Set<number>();
          while (cur !== undefined && cur.causedBy !== null) {
            const prevId = cur.causedBy as number;
            if (seen.has(prevId)) return false; // цикл (не должен существовать в append-only логе)
            seen.add(prevId);
            const next = byId.get(prevId);
            if (next === undefined || (next.id as number) >= (cur.id as number)) return false;
            cur = next;
          }
          return cur !== undefined; // дошли до события с causedBy === null
        };

        let checked = 0;
        let broken = 0;
        for (const ev of log) {
          if (!NARRATIVE_AND_DEATH.has(ev.type)) continue;
          checked++;
          if (!resolveToRoot(ev)) broken++;
        }
        expect(checked, 'нарративных/смертных событий в логе (тест не холостой)').toBeGreaterThan(0);
        expect(broken, 'событий с оборванной цепочкой причин').toBe(0);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5) ПОВЕДЕНЧЕСКИЙ ЯКОРЬ (D-075): консолидация трогает ТОЛЬКО ключ 'memory' (единственный
//    её читатель — MemoryDecay, событий не эмитит). ⇒ event-ЛОГ БАЙТ-В-БАЙТ тот же, что до
//    3.8: day1 seed42 = РОВНО 14794 события. Дешёвый (1 день) прямой сторож регрессии лога,
//    комплементарный голден-хэшу 429867e2 (cli.test): число событий — грубее хэша, но читаемо
//    привязано к утверждению D-075 «поведение мира тождественно, сдвинулась лишь 'memory'».
// ═════════════════════════════════════════════════════════════════════════════
describe('Лог-якорь живого конвейера: число событий закреплено (D-075, ре-пин 5.2/D-085)', () => {
  it('day1 seed42 через полный конвейер Фазы 3 даёт РОВНО 19010 событий (лог бит-в-бит)', () => {
    const { world, scheduler } = buildPhase3(42);
    scheduler.run(world, TICKS_PER_DAY);
    // 5.2/D-085 (FORAGE→forage_food + водопой): фуражировка сняла голодные смерти дня-1 (день 1
    // мирный), добавила события среды/питания, животные не гибнут от жажды ⇒ лог 14794 → 19010
    // (детерминизм 2×). Дешёвый сторож регрессии лога, комплементарный хэшу 00dc66c3 (cli.test).
    expect(world.bus.log.length).toBe(19010);
  });

  it('нарратив разгорается ко дню 2 (radio/relayed = 2672 — молва по встречам/наблюдениям)', () => {
    // 5.2/D-085: день 1 стал мирным; первые смерти лишь со дня 3. Но эфир/молва живут НЕ только
    // смертями — к концу дня 2 relayed=2672 (слухи о встречах, перемещениях, наблюдениях), при
    // radio/message=3 первых передачах и chronicle=3 записях. Интент «нарратив живёт из событий
    // мира» цел; смерти в него вливаются позже. Привязано к реальной траектории 5.2.
    const { world, scheduler } = buildPhase3(42);
    scheduler.run(world, TICKS_PER_DAY * 2);
    const counts: Record<string, number> = {};
    for (const ev of world.bus.log) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    expect(counts['radio/relayed']).toBe(2672);
    expect(counts['radio/message']).toBe(3);
    expect(counts['chronicle/recorded']).toBe(3);
  });
});

// Ссылки на типы (документируют форму значений, читаемых тестом).
const _memRec: Pick<MemoryRecord, 'kind' | 'subject' | 'isFirsthand'> = { kind: 'rumor', subject: 'e:1', isFirsthand: false };
const _evId: EventId = 1 as EventId;
void _memRec;
void _evId;
