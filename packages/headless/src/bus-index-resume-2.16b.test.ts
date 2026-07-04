/**
 * @module @zona/headless/bus-index-resume-2.16b.test
 *
 * ГЕЙТ RESUME × ПЕРФ-ИНДЕКС ШИНЫ на РЕАЛЬНОМ ЖИВОМ конвейере Фазы 2 (задача 2.16b,
 * D-065 перф-фикс, D-008 «индекс — производное состояние»).
 *
 * КОНТЕКСТ. 2.16b сняла латентный КВАДРАТ O(тиков×лога) в шине двумя способами:
 *   • byTick-ИНДЕКС (`Map<tick, SimEvent[]>`) для `at(tick)`;
 *   • `findLast(pred)` — reverse-скан внутреннего лога без копии (Perception/Weather/Death).
 * Оба — ПРОИЗВОДНОЕ от append-only лога. При save/load индекс НЕ сериализуется, а
 * ПЕРЕСТРАИВАЕТСЯ из восстановленного лога в конструкторе шины (createEventBus(init)).
 *
 * ПОЧЕМУ ЭТО P0 (D-008). Если после deserialize индекс разошёлся бы с логом хоть на
 * одном тике, `at()`/`findLast()` вернули бы НЕ ТО событие — и системы, читающие шину
 * (RobberyMemory `bus.at(tick−1)`, Perception/Weather/Death `findLast`), приняли бы
 * другое решение → resume разъехался бы с непрерывным прогоном. Голдены хэша это ловят
 * КОСВЕННО; здесь мы бьём ПРЯМО в производное состояние: на восстановленной шине
 * РЕАЛЬНОГО плотного лога Фазы 2 индекс обязан быть тождествен наивному скану лога.
 *
 * Читается как сценарий Зоны: «сохранили мир в разгаре жизни (артефакты, грабежи,
 * торговля, приток), загрузили — и шина помнит ровно ту же историю, тик-в-тик».
 */

import { describe, it, expect } from 'vitest';
import type { Seed, SimEvent, Tick } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  registerPhase2Systems,
  worldgen,
  serialize,
  deserialize,
  hashSnapshot,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';

/** Собирает ПОЛНЫЙ живой конвейер Фазы 2 тем же путём, что headless-CLI (D-064). */
function buildPhase2(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase2Systems(scheduler);
  return { world, scheduler };
}

/** Нормализует лог до сравниваемого кортежа (id, tick, type, causedBy, payload). */
function normalize(log: readonly SimEvent[]): ReadonlyArray<Record<string, unknown>> {
  return log.map((e) => ({ id: e.id, tick: e.tick, type: e.type, causedBy: e.causedBy, payload: e.payload }));
}

/** Группирует лог по тику ОДНИМ проходом: наивный эталон для сверки byTick-индекса. */
function groupByTick(log: readonly SimEvent[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const e of log) {
    const t = e.tick as unknown as number;
    let b = m.get(t);
    if (b === undefined) {
      b = [];
      m.set(t, b);
    }
    b.push(e.id as unknown as number);
  }
  return m;
}

const SEEDS = [42, 7, 999] as const;
const SPLIT_DAYS = 5; // сплит в РАЗГАРЕ жизни — лог уже плотный (все петли ожили)

// ═════════════════════════════════════════════════════════════════════════════
// 1) ИНДЕКС ПОСЛЕ LOAD ТОЖДЕСТВЕН ЛОГУ на РЕАЛЬНОМ плотном логе Фазы 2 (D-008).
//    at(t) восстановленной шины == наивный log.filter(t) для КАЖДОГО тика; findLast
//    == reverse-find. Если бы перестройка индекса в deserialize была битой — здесь
//    бы и вскрылось (голдены хэша этого напрямую не показывают).
// ═════════════════════════════════════════════════════════════════════════════
describe('byTick-индекс шины перестроен КОНСИСТЕНТНО после deserialize (D-008, плотный лог Фазы 2)', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}: ${SPLIT_DAYS} дней живого конвейера → save/load`, () => {
      const { world, scheduler } = buildPhase2(seed);
      scheduler.run(world, SPLIT_DAYS * TICKS_PER_DAY);
      const restored = deserialize(serialize(world));

      it('лог пережил сериализацию непустым и плотным (не тривиальный кейс)', () => {
        // Все ожившие петли Фазы 2 должны были наполнить лог за 5 дней.
        expect(restored.bus.log.length).toBeGreaterThan(1000);
        expect(normalize(restored.bus.log)).toEqual(normalize(world.bus.log)); // лог не искажён load'ом
      });

      it('at(t) == наивный log.filter(t) для КАЖДОГО занятого тика (индекс перестроен верно)', () => {
        const expected = groupByTick(restored.bus.log);
        // Каждый занятый тик: индекс отдаёт ровно те же id в том же порядке.
        for (const [t, ids] of expected) {
          expect(
            restored.bus.at(t as Tick).map((e) => e.id as unknown as number),
            `at(${t}) индекса разошёлся с log.filter после load`,
          ).toEqual(ids);
        }
        // Индекс НЕ придумывает событий на пустых/будущих тиках.
        const occupied = new Set(expected.keys());
        let checkedEmpty = 0;
        for (let t = 0; t <= (restored.tick as unknown as number) + 2 && checkedEmpty < 50; t++) {
          if (occupied.has(t)) continue;
          expect(restored.bus.at(t as Tick), `at(${t}) должен быть пуст (тик без событий)`).toEqual([]);
          checkedEmpty++;
        }
      });

      it('findLast восстановленной шины тождествен reverse-find по восстановленному логу', () => {
        // Ровно те предикаты, которыми пользуются перф-переписанные системы Фазы 2:
        // Weather (тип weather/changed), Perception (move/*), Death (по id).
        const preds: ReadonlyArray<(e: SimEvent) => boolean> = [
          (e) => e.type === 'weather/changed',
          (e) => e.type === 'move/arrived' || e.type === 'move/departed',
          (e) => e.type === 'entity/died',
          (e) => e.type === 'trade/executed',
          (e) => e.id === restored.bus.log[Math.floor(restored.bus.log.length / 2)]!.id,
        ];
        for (const pred of preds) {
          expect(restored.bus.findLast(pred)).toBe([...restored.bus.log].reverse().find(pred));
        }
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) RESUME ≡ НЕПРЕРЫВНЫЙ на живом конвейере: split (5д → save/load → добег) даёт
//    ТОТ ЖЕ мир по хэшу И логу, что непрерывный прогон. Доказывает, что перестроенный
//    индекс не только «выглядит консистентным», но и ведёт симуляцию тик-в-тик так же
//    (at/findLast после load кормят системы теми же событиями — D-008/закон №8).
// ═════════════════════════════════════════════════════════════════════════════
describe('Resume живого конвейера Фазы 2 ≡ непрерывный (перф-индекс не сдвигает историю, D-008)', () => {
  const TOTAL_DAYS = 8;
  for (const seed of SEEDS) {
    it(`seed ${seed}: split на дне ${SPLIT_DAYS} совпал с непрерывным по хэшу И логу`, () => {
      // Непрерывный эталон.
      const cont = buildPhase2(seed);
      cont.scheduler.run(cont.world, TOTAL_DAYS * TICKS_PER_DAY);

      // Split: 5 дней → serialize → deserialize (индекс перестроен) → добег НОВЫМ конвейером.
      const split = buildPhase2(seed);
      split.scheduler.run(split.world, SPLIT_DAYS * TICKS_PER_DAY);
      const midLen = split.world.bus.log.length;
      const resumed = deserialize(serialize(split.world));
      const rs = createScheduler();
      registerPhase2Systems(rs);
      rs.run(resumed, (TOTAL_DAYS - SPLIT_DAYS) * TICKS_PER_DAY);

      expect(midLen, 'сплит по НАПОЛНЕННОЙ середине (не пустой мир)').toBeGreaterThan(1000);
      expect(hashSnapshot(serialize(resumed)), 'хэш split == непрерывный').toBe(
        hashSnapshot(serialize(cont.world)),
      );
      expect(normalize(resumed.bus.log), 'лог split == непрерывный (id/tick/type/causedBy/payload)').toEqual(
        normalize(cont.world.bus.log),
      );
    }, 60000);
  }
});
