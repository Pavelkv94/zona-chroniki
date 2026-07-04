/**
 * @module @zona/headless/phase2-pipeline.test
 *
 * УСИЛЕНИЕ КАПСТОУНА 2.16a (D-064) — инварианты ПОЛНОГО конвейера Фазы 2 (все 17
 * систем в каноническом порядке, registerPhase2Systems) на headless-поверхности.
 * Читается как сценарий Зоны, а не как проверка полей: «за 30 дней полный мир
 * ничего не творит из воздуха», «торговля переносит, но не печатает деньги»,
 * «спящие системы (поля/бандиты/экспорт) действительно молчат без носителей».
 *
 * Родственные сьюты покрывают соседние грани и здесь НЕ дублируются:
 *  · economy-invariant.test.ts — предохранитель на конвейере Фазы 1 + forgery-ловля;
 *  · phase1-gate.test.ts (в @zona/sim) — детерминизм 2×, resume, 0 idle, телепорты,
 *    цепочки смертей, порядок систем — уже НА конвейере Фазы 2 (buildLive Phase2).
 * Этот файл целится в ГЛАВНОЕ обещание D-064: полный конвейер Фазы 2 (а не Фазы 1)
 * не творит массу — assertEconomyInvariant держится ВЕСЬ прогон на КАЖДОМ дне для
 * seeds 42/7/999 × 30 дней; и в «спящие 5 систем реально no-op».
 */

import { describe, it, expect } from 'vitest';
import type { Seed, SimEvent, Tick } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  registerPhase2Systems,
  worldgen,
  serialize,
  hashSnapshot,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import { worldTotals, ledgerDelta, assertEconomyInvariant, type EconTotals } from './economy-invariant';

const SEEDS = [42, 7, 999] as const;
const DAYS = 30; // верхний горизонт DoD; охватывает охоту, голод, upkeep поселений, смерти

/** Собирает ПОЛНЫЙ конвейер Фазы 2 (17 систем) тем же путём, что headless-CLI (D-064). */
function buildPhase2(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase2Systems(scheduler);
  return { world, scheduler };
}

interface Phase2Run {
  readonly seed: number;
  readonly world: SimWorld;
  readonly baseline: EconTotals;
  readonly finalHash: string;
  /** День, на котором assertEconomyInvariant бросил (или null — держался весь прогон). */
  readonly firstBreakingDay: number | null;
  readonly firstBreakMessage: string | null;
  /** Число событий по типу за весь прогон. */
  readonly counts: Readonly<Record<string, number>>;
  /** Число item/harvested по источнику ('carcass' | 'anomaly'). */
  readonly harvestSources: Readonly<Record<string, number>>;
  readonly moneyStart: number;
  readonly moneyEnd: number;
}

/** Прогоняет полный конвейер Фазы 2 на `DAYS` дней, сверяя инвариант ПОСЛЕ КАЖДОГО дня. */
function runPhase2(seed: number): Phase2Run {
  const { world, scheduler } = buildPhase2(seed);
  const baseline = worldTotals(world);
  const moneyStart = baseline.money;

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
  const harvestSources: Record<string, number> = {};
  for (const ev of world.bus.log) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    if (ev.type === 'item/harvested') {
      const src = (ev as SimEvent & { type: 'item/harvested' }).payload.source;
      harvestSources[src] = (harvestSources[src] ?? 0) + 1;
    }
  }

  return {
    seed,
    world,
    baseline,
    finalHash: hashSnapshot(serialize(world)),
    firstBreakingDay,
    firstBreakMessage,
    counts,
    harvestSources,
    moneyStart,
    moneyEnd: worldTotals(world).money,
  };
}

// Дорогой 30-дневный прогон полного конвейера строится ОДИН раз на seed (кэш).
const RUNS = new Map<number, Phase2Run>();
function runOf(seed: number): Phase2Run {
  let r = RUNS.get(seed);
  if (r === undefined) {
    r = runPhase2(seed);
    RUNS.set(seed, r);
  }
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) ГЛАВНОЕ ОБЕЩАНИЕ D-064: полный конвейер Фазы 2 НЕ творит массу — инвариант
//    держится на КАЖДОМ игровом дне для seeds 42/7/999 × 30 дней (закон №3).
// ═════════════════════════════════════════════════════════════════════════════
describe('EconomyInvariant держится ВЕСЬ прогон ПОЛНОГО конвейера Фазы 2 (D-064, закон №3)', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}: 30 дней всех 17 систем`, () => {
      const r = runOf(seed);

      it('ни одного дня с массой вне леджера (assertEconomyInvariant не бросил ни разу)', () => {
        expect(
          r.firstBreakingDay,
          r.firstBreakingDay === null
            ? ''
            : `масса разошлась с леджером на дне ${r.firstBreakingDay}: ${r.firstBreakMessage}`,
        ).toBeNull();
      });

      it('масса мира изменилась РОВНО на дельту леджера (Σ − baseline == ledgerDelta 0..tick)', () => {
        // Прямая формула D-045 на ФИНАЛЕ полного конвейера: наблюдаемая дельта денег
        // и КАЖДОГО предмета совпадает с суммой леджер-событий — ничего вне леджера.
        const now = worldTotals(r.world);
        const ledger = ledgerDelta(r.world.bus, 0 as Tick, r.world.tick);
        expect(now.money - r.baseline.money, 'деньги: наблюдаемая дельта == леджер').toBe(ledger.money);
        const items = new Set<string>([...now.items.keys(), ...r.baseline.items.keys(), ...ledger.items.keys()]);
        for (const item of items) {
          const observed = (now.items.get(item as never) ?? 0) - (r.baseline.items.get(item as never) ?? 0);
          const expected = ledger.items.get(item as never) ?? 0;
          expect(observed, `${item}: наблюдаемая дельта == леджер`).toBe(expected);
        }
      });

      it('мир реально ЖИЛ (иначе инвариант ничего не сторожил): смерти, охота, upkeep, торговля', () => {
        // Полный конвейер должен ДВИГАТЬ массу, иначе «зелёный» тривиален. Требуем
        // события ВСЕХ активных механик Фазы 2: расход (consumed), добыча (harvested),
        // бой (encounter/resolved), сделки (trade/executed).
        expect(r.counts['item/consumed'] ?? 0, 'расход массы шёл').toBeGreaterThan(0);
        expect(r.counts['item/harvested'] ?? 0, 'охота давала мясо').toBeGreaterThan(0);
        expect(r.counts['encounter/resolved'] ?? 0, 'бои случались').toBeGreaterThan(0);
        expect(r.counts['trade/executed'] ?? 0, 'торговля шла (Trade оживлён)').toBeGreaterThan(0);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) ТОРГОВЛЯ — ПЕРЕВОД, А НЕ ФАУЦЕТ (δ0): сделки идут десятками, но Σ денег и Σ
//    предметов НЕ печатаются мимо леджера (D-047/D-064). Проверяем, что вся
//    наблюдаемая денежная дельта объясняется ТОЛЬКО леджером (broughtIn/exported).
// ═════════════════════════════════════════════════════════════════════════════
describe('Trade — конс. перевод: сделки не творят денег мимо леджера (δ0, D-047)', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: торговля шла, но Σ денег двигается только на денежный леджер`, () => {
      const r = runOf(seed);
      // Сделки реально исполнялись (иначе нечего проверять про δ0).
      expect(r.counts['trade/executed'] ?? 0).toBeGreaterThan(0);
      // Вся наблюдаемая дельта Σ money объясняется леджером (broughtIn.money +
      // exported.moneyIn). trade/executed НЕ леджер ⇒ его вклад в Σ money == 0.
      const ledger = ledgerDelta(r.world.bus, 0 as Tick, r.world.tick);
      expect(r.moneyEnd - r.moneyStart).toBe(ledger.money);
      // В текущем worldgen (2.16a) нет ни экспорта, ни притока денег ⇒ денежный
      // леджер == 0, а значит Σ денег НЕПОДВИЖНА, несмотря на десятки сделок.
      expect(ledger.money, 'без Export/Influx денег денежный леджер пуст').toBe(0);
      expect(r.moneyEnd, 'Σ денег неподвижна: торговля лишь перекладывает').toBe(r.moneyStart);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) ДРЕМЛЮЩИЕ 5 СИСТЕМ — РЕАЛЬНО NO-OP (D-064): без полей/бандитов в worldgen
//    (2.16b) ArtifactSpawn/ArtifactSearch/Export/RobberyMemory/MemoryDecay не
//    производят НИ ОДНОГО своего события — иначе порядок/оживление неверны.
// ═════════════════════════════════════════════════════════════════════════════
describe('Дремлющие системы Фазы 2 молчат без носителей (D-064)', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const r = runOf(seed);

      it('ArtifactSpawn спит: 0 artifact/spawned И 0 item/harvested(source=anomaly)', () => {
        expect(r.counts['artifact/spawned'] ?? 0).toBe(0);
        // Единственный источник массы артефактов — поля; их нет ⇒ вся добыча c туш.
        expect(r.harvestSources['anomaly'] ?? 0).toBe(0);
      });

      it('ArtifactSearch спит: 0 artifact/collected (некому подбирать)', () => {
        expect(r.counts['artifact/collected'] ?? 0).toBe(0);
      });

      it('Export спит: 0 item/exported (money-faucet закрыт до 2.16b)', () => {
        expect(r.counts['item/exported'] ?? 0).toBe(0);
      });

      it('ROB дремлет: 0 loot/transferred (стартовая когорта — не хищники)', () => {
        // RobberyMemory реактивен на loot/transferred; их нет ⇒ он тоже вхолостую.
        expect(r.counts['loot/transferred'] ?? 0).toBe(0);
      });

      it('вся добытая масса объяснима ТОЛЬКО тушами (harvest source == carcass)', () => {
        const sources = Object.keys(r.harvestSources);
        expect(sources.length).toBeGreaterThan(0); // охота была
        expect(sources).toEqual(['carcass']); // и ТОЛЬКО с туш
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) ПУСТОЙ МИР ЦЕЛ (D-064): createSimWorld без сущностей ⇒ все 17 систем no-op,
//    голден пустого снапшота 481914ae не сдвинут переходом на Фазу 2.
// ═════════════════════════════════════════════════════════════════════════════
describe('Пустой мир: голден 481914ae цел, конвейер Фазы 2 не оживляет пустоту (D-064)', () => {
  it('createSimWorld(0) без worldgen сериализуется в 481914ae', () => {
    const empty = createSimWorld(0 as Seed);
    expect(hashSnapshot(serialize(empty))).toBe('481914ae');
  });

  it('прогон пустого мира через все 17 систем не рождает ни событий, ни массы', () => {
    const empty = createSimWorld(0 as Seed);
    const baseline = worldTotals(empty);
    const scheduler = createScheduler();
    registerPhase2Systems(scheduler);
    scheduler.run(empty, TICKS_PER_DAY); // день полного конвейера по пустому миру
    // Нет носителей ⇒ ни одна из 17 систем не публикует событий и не двигает массу.
    expect(empty.bus.log.length).toBe(0);
    expect(() => assertEconomyInvariant(empty, empty.bus, baseline, empty.tick)).not.toThrow();
    const now = worldTotals(empty);
    expect(now.money).toBe(0);
    expect(now.items.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5) СМЕРТИ ОБЪЯСНИМЫ НА ПОЛНОМ КОНВЕЙЕРЕ: каждая entity/died за 30 дней всех 17
//    систем несёт непустую цепочку causedBy к корню-физиологии/бою (закон №6).
//    (phase1-gate MUST-4 доказывает то же на 10 днях; здесь — на 30-дневном
//    горизонте headless-прогона, чтобы длинный хвост тоже был без «сирот».)
// ═════════════════════════════════════════════════════════════════════════════
describe('Смерти объяснимы на 30 днях полного конвейера (закон №6)', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: каждая entity/died имеет causedBy != null и корень в needs/encounter`, () => {
      const r = runOf(seed);
      const byId = new Map<number, SimEvent>();
      for (const e of r.world.bus.log) byId.set(e.id as unknown as number, e);
      const deaths = r.world.bus.log.filter((e) => e.type === 'entity/died');
      expect(deaths.length, 'за 30 дней случились реальные смерти').toBeGreaterThan(0);

      const orphans: string[] = [];
      const badRoots: string[] = [];
      for (const d of deaths) {
        if (d.causedBy === null) {
          orphans.push(`id=${String(d.id)}`);
          continue;
        }
        // Идём по цепочке до корня (causedBy === null); корень обязан быть физиологией/боем.
        let cursor: SimEvent | undefined = d;
        const seen = new Set<number>();
        while (cursor && cursor.causedBy !== null) {
          const cid = cursor.id as unknown as number;
          if (seen.has(cid)) break; // защита от гипотетического цикла
          seen.add(cid);
          cursor = byId.get(cursor.causedBy as unknown as number);
        }
        const rootType = cursor?.type ?? '<нет корня>';
        if (!['needs/threshold', 'encounter/started', 'perception/spotted', 'task/selected'].includes(rootType)) {
          badRoots.push(`id=${String(d.id)} → корень "${rootType}"`);
        }
      }
      expect(orphans, `смерти без причины: ${orphans.slice(0, 5).join(', ')}`).toEqual([]);
      expect(badRoots, `неожиданные корни: ${badRoots.slice(0, 5).join(' | ')}`).toEqual([]);
    });
  }
});
