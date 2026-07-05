/**
 * @module @zona/headless/phase3-pipeline.test
 *
 * ГЕЙТ КАПСТОУНА ФАЗЫ 3 (D-074) — доказывает, что ПОЛНЫЙ ЖИВОЙ конвейер Фазы 3 (20 систем,
 * registerPhase3Systems = канон Ф2 D-064 + нарративный блок Radio→Rumors→Chronicle перед Death)
 * РЕАЛЬНО ведёт нарратив на живом прогоне, НЕ творя массы и НЕ ломая экономику. Читается как
 * сценарий Зоны: «за N дней мир переговаривается в эфире, разносит слухи и ведёт летопись своих
 * драм — и при этом ничего не берётся из воздуха».
 *
 * Соседние грани уже покрыты и здесь НЕ дублируются:
 *  · phase1-gate.test.ts (@zona/sim) — 0 idle, телепорты, смерти, масса (ФИЗИЧЕСКИЕ профили
 *    на Фазе 2 — нарратив поведенчески инертен, D-074) + Фаза-3-анкеры (хэш день-1, порядок
 *    20 систем, счётчик perception на РЕАЛЬНОМ конвейере Фазы 3);
 *  · pipeline.test.ts — инвариант порядка PHASE3_SYSTEMS (20 систем, нарративный блок, D-074);
 *  · phase2-pipeline.test.ts — инварианты чистого конвейера Фазы 2 (17 систем).
 * Этот файл целится в ГЛАВНОЕ обещание Фазы 3: эфир/молва/летопись РАБОТАЮТ (числа > 0),
 * fame РЕАЛЬНО копится (§10.2), EconomyInvariant держится ВЕСЬ прогон, ДЕТЕРМИНИЗМ 2× и
 * resume≡continuous С НАРРАТИВОМ (fame + память слухов + реактивы переживают save/load),
 * пустой мир 481914ae цел. Горизонт КОРОТКИЙ (ПЕРФ-ФЛАГ D-074 ниже) — но нарратив уже обилен.
 */

import { describe, it, expect } from 'vitest';
import type { Seed, Tick } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  registerPhase3Systems,
  worldgen,
  serialize,
  deserialize,
  hashSnapshot,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import { worldTotals, ledgerDelta, assertEconomyInvariant, type EconTotals } from './economy-invariant';

// ПЕРФ-ФЛАГ D-074: нарратив на плотном старте квадратичен по rumor-памяти (ниже). Каждый
// лишний seed × день умножает стоимость. Для ГЕЙТА нарратива достаточно ОДНОГО seed —
// эфир/молва/летопись обильно фаейрят уже к дню 1 (radio/relayed>1e3). Инвариант массы на
// 3 seeds × 30 дней ЧИСТОГО конвейера покрыт phase2-pipeline; здесь seed 42 доказывает, что
// НАРРАТИВ (fame/память слухов — вне money/inventory) массу не трогает.
const SEEDS = [42] as const;
// ── ПЕРФ-ФЛАГ (D-074, для balance-analyst) ───────────────────────────────────
// Нарратив на ПЛОТНОМ старте (хаб Кордон: ~20 co-located болтливых сталкеров) даёт
// КОМБИНАТОРНУЮ ретрансляцию: каждый radio/message/relayed в окне Rumors пишет память
// ВСЕМ слышащим, болтуны пересказывают → radio/relayed компаундится, а rumor-память
// (salience 0.05..0.45, MemoryDecay every:60) прунится МЕДЛЕННЕЕ, чем копится ⇒ массив
// памяти растёт БЕЗ верхней границы (замер: memMax ~26k записей/NPC к дню 6, ~38k к дню 8),
// а addMemory перестраивает+сортирует его на КАЖДУЮ вставку → квадрат. Это НЕ баг скана
// лога (Radio/Rumors/Chronicle читают bus.at(...) по индексу, O(тик)), а БАЛАНС/ЁМКОСТЬ
// (порог значимости RADIO/CHRONICLE, кламп «сообщений на loc/тик», кап памяти, скорость
// затухания слуха) — зона balance-analyst. Пока не оттюнено, ГЕЙТ держим на КОРОТКОМ
// горизонте (2 дня): нарратив уже обильно фаейрит к дню 1 (radio/relayed>1e3), а плотный
// старт ещё не раздул память до непрактичного. Инвариант массы/пустого мира тут же.
const DAYS = 2;

/** Собирает ПОЛНЫЙ конвейер Фазы 3 (20 систем) тем же путём, что headless-CLI (D-074). */
function buildPhase3(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase3Systems(scheduler);
  return { world, scheduler };
}

interface Phase3Run {
  readonly seed: number;
  readonly world: SimWorld;
  readonly baseline: EconTotals;
  readonly firstBreakingDay: number | null;
  readonly firstBreakMessage: string | null;
  readonly counts: Readonly<Record<string, number>>;
  /** Максимум fame по носителям (петля §10.2 копит известность). */
  readonly maxFame: number;
  /** Число носителей fame > 0. */
  readonly fameCarriers: number;
}

function runPhase3(seed: number): Phase3Run {
  const { world, scheduler } = buildPhase3(seed);
  const baseline = worldTotals(world);

  let firstBreakingDay: number | null = null;
  let firstBreakMessage: string | null = null;
  for (let day = 1; day <= DAYS; day++) {
    scheduler.run(world, TICKS_PER_DAY);
    if (firstBreakingDay === null) {
      try {
        assertEconomyInvariant(world, world.bus, baseline, world.tick);
      } catch (e) {
        firstBreakingDay = day;
        firstBreakMessage = (e as Error).message;
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const ev of world.bus.log) counts[ev.type] = (counts[ev.type] ?? 0) + 1;

  let maxFame = 0;
  let fameCarriers = 0;
  for (const [, f] of world.resources.entries<number>('fame')) {
    if (f > 0) fameCarriers++;
    if (f > maxFame) maxFame = f;
  }

  return { seed, world, baseline, firstBreakingDay, firstBreakMessage, counts, maxFame, fameCarriers };
}

const RUNS = new Map<number, Phase3Run>();
function runOf(seed: number): Phase3Run {
  let r = RUNS.get(seed);
  if (r === undefined) {
    r = runPhase3(seed);
    RUNS.set(seed, r);
  }
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) НАРРАТИВ РЕАЛЬНО РАБОТАЕТ НА ЖИВОМ ПРОГОНЕ (D-074): эфир, молва и летопись —
//    все три ветви производят события > 0 за прогон.
// ═════════════════════════════════════════════════════════════════════════════
describe('Нарратив живёт: эфир/молва/летопись производят события на живом конвейере (D-074)', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}: ${DAYS} дней всех 20 систем`, () => {
      const r = runOf(seed);

      it('Radio работает: radio/message > 0 (свидетели озвучивают значимые события в эфир)', () => {
        expect(r.counts['radio/message'] ?? 0).toBeGreaterThan(0);
      });

      it('Rumors работает: radio/relayed > 0 (болтуны ретранслируют услышанное с искажением)', () => {
        expect(r.counts['radio/relayed'] ?? 0).toBeGreaterThan(0);
      });

      it('Chronicle работает: chronicle/recorded > 0 (значимое попадает в летопись мира)', () => {
        expect(r.counts['chronicle/recorded'] ?? 0).toBeGreaterThan(0);
      });

      it('fame РЕАЛЬНО копится: есть носители с fame > 0 (петля §10.2 запущена Chronicle)', () => {
        expect(r.fameCarriers).toBeGreaterThan(0);
        expect(r.maxFame).toBeGreaterThan(0);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) НАРРАТИВ МАССУ НЕ ТВОРИТ (закон №3, D-045/D-074): EconomyInvariant держится
//    ВЕСЬ прогон полного конвейера с нарративом — chronicle/radio/relayed не леджер,
//    incFame/addMemory двигают ключи fame/memory (дизъюнктны money/inventory).
// ═════════════════════════════════════════════════════════════════════════════
describe('EconomyInvariant держится ВЕСЬ прогон Фазы 3 (нарратив не масса, закон №3)', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const r = runOf(seed);

      it('ни одного дня с массой вне леджера (assertEconomyInvariant не бросил)', () => {
        expect(
          r.firstBreakingDay,
          r.firstBreakingDay === null ? '' : `масса разошлась на дне ${r.firstBreakingDay}: ${r.firstBreakMessage}`,
        ).toBeNull();
      });

      it('дельта массы == леджер на финале (нарратив не сдвинул money/inventory)', () => {
        const now = worldTotals(r.world);
        const ledger = ledgerDelta(r.world.bus, 0 as Tick, r.world.tick);
        expect(now.money - r.baseline.money, 'деньги').toBe(ledger.money);
        const items = new Set<string>([...now.items.keys(), ...r.baseline.items.keys(), ...ledger.items.keys()]);
        for (const item of items) {
          const observed = (now.items.get(item as never) ?? 0) - (r.baseline.items.get(item as never) ?? 0);
          const expected = ledger.items.get(item as never) ?? 0;
          expect(observed, `${item}`).toBe(expected);
        }
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) ДЕТЕРМИНИЗМ 2× и RESUME≡CONTINUOUS С НАРРАТИВОМ (закон №8, D-074): один seed →
//    один хэш; save/load в СЕРЕДИНЕ прогона ≡ непрерывный. Нарратив НЕ рушит ни то,
//    ни другое: выбор шаблона/искажение — ЧИСТАЯ fnv стабильных id (НЕ rng-поток),
//    состояния системы не держат (fame/память слухов round-trip'ятся через снапшот).
// ═════════════════════════════════════════════════════════════════════════════
describe('Детерминизм 2× и resume≡continuous С НАРРАТИВОМ (закон №8, D-074)', () => {
  const D3_SEED = 42;
  const TOTAL = 2 * TICKS_PER_DAY; // короткий горизонт (ПЕРФ-ФЛАГ), но нарратив уже обилен
  const SPLIT = 1 * TICKS_PER_DAY; // сплит на НАПОЛНЕННОЙ середине (день 1 уже полон эфира/слухов)

  it('два прогона одного seed дают ИДЕНТИЧНЫЙ хэш (fnv-искажение детерминировано, не rng)', () => {
    const a = buildPhase3(D3_SEED);
    a.scheduler.run(a.world, TOTAL);
    const b = buildPhase3(D3_SEED);
    b.scheduler.run(b.world, TOTAL);
    expect(hashSnapshot(serialize(a.world))).toBe(hashSnapshot(serialize(b.world)));
  }, 60000);

  it('resume: прогон→serialize→deserialize→добег НОВЫМ конвейером ≡ непрерывный (fame+слухи переживают)', () => {
    // Непрерывный эталон.
    const cont = buildPhase3(D3_SEED);
    cont.scheduler.run(cont.world, TOTAL);

    // Расщеплённый: прогон до сплита → round-trip снапшота → добег НОВЫМ планировщиком.
    const half = buildPhase3(D3_SEED);
    half.scheduler.run(half.world, SPLIT);
    // На середине уже есть нарратив (эфир/слухи/fame) — сплит НЕ тривиален.
    const midCounts: Record<string, number> = {};
    for (const ev of half.world.bus.log) midCounts[ev.type] = (midCounts[ev.type] ?? 0) + 1;
    expect((midCounts['radio/message'] ?? 0) + (midCounts['radio/relayed'] ?? 0)).toBeGreaterThan(0);

    const resumed = deserialize(serialize(half.world));
    const resumeSched = createScheduler();
    registerPhase3Systems(resumeSched);
    resumeSched.run(resumed, TOTAL - SPLIT);

    // Хэш и лог тождественны непрерывному ⇒ fame (значимость), память слухов и реактивный
    // вход (bus.at-окна) переживают save/load без спец-логики (нарратив состояния не держит).
    expect(hashSnapshot(serialize(resumed))).toBe(hashSnapshot(serialize(cont.world)));
    expect(resumed.bus.log.length).toBe(cont.world.bus.log.length);
  }, 60000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) ПУСТОЙ МИР ЦЕЛ (D-074): нет сущностей ⇒ все 20 систем no-op (нарратив читает
//    пустое окно / нет слышащих), голден пустого снапшота 481914ae не сдвинут.
// ═════════════════════════════════════════════════════════════════════════════
describe('Пустой мир: голден 481914ae цел через конвейер Фазы 3 (D-074)', () => {
  it('свежий пустой мир = 481914ae; прогон 20 систем по пустоте не рождает ни событий, ни массы', () => {
    const empty = createSimWorld(0 as Seed);
    // ГОЛДЕН-ЯКОРЬ: свежий пустой мир (tick 0) сериализуется в 481914ae — нарратив в конвейере
    // его не сдвинул (проверка на СВЕЖЕМ мире, ДО прогона: после run world.tick растёт и хэш
    // ЗАКОННО иной — тик входит в снапшот; здесь важно, что ПУСТОТА даёт тот же якорь, что Ф1/Ф2).
    expect(hashSnapshot(serialize(empty))).toBe('481914ae');
    const baseline = worldTotals(empty);
    const scheduler = createScheduler();
    registerPhase3Systems(scheduler);
    scheduler.run(empty, TICKS_PER_DAY); // день полного конвейера Фазы 3 по пустоте
    // Нет носителей ⇒ ни одна из 20 систем (включая нарратив) не публикует событий/не двигает массу.
    expect(empty.bus.log.length).toBe(0);
    expect(() => assertEconomyInvariant(empty, empty.bus, baseline, empty.tick)).not.toThrow();
    const now = worldTotals(empty);
    expect(now.money).toBe(0);
    expect(now.items.size).toBe(0);
  });
});
