/**
 * @module @zona/sim/settlement-inert.test
 *
 * СЦЕНАРИЙ МИРА (QA 2.2): «Поселение стоит посреди живой Зоны, но остаётся
 * ИНЕРТНЫМ». Поселение — сущность с `Position` (D-046), поэтому его ВИДЯТ соседи
 * (Perception кладёт всех носителей Position в бакеты локаций). Задача этого гейта —
 * доказать, что эта видимость БЕЗОБИДНА: за 30 дней полного конвейера Фазы 1
 * поселение
 *   • НЕ обзаводится тегами актора (Alive/Human/Animal/Needs/Health/Task) —
 *     значит Movement/Needs/Death/TaskSelection/Encounters/Animals его не трогают;
 *   • НЕ телепортируется и вообще не двигается (Position.loc == dest == своя loc
 *     всё время; ни одного move/* с его eid) — закон «позиция меняется только по
 *     рёбрам» держится даже для нежильца-без-Task;
 *   • НЕ порождает ЛОЖНЫХ БОЁВ: ни одно `encounter/started`/`encounter/resolved`
 *     не числит поселение в сторонах/потерях (Encounters гейтит Human/Animal);
 *   • НЕ порождает ЛОЖНЫХ БЕГСТВ/страха: у поселения нет тега животного/человека,
 *     поэтому олень не бежит «от поселения», а кабан-угроза им не считается;
 *   • НЕ гибнет (нет entity/died с его eid) и хранит склад/кассу/мораль неизменными
 *     (в Фазе 1 экономики ещё нет — ничто не пишет в Settlement/склад поселения).
 *
 * При этом ПИНУЕМ (фиксируем как известное поведение, а не баг): поселение РЕАЛЬНО
 * появляется в `contacts` co-located соседей — это ожидаемо и безвредно.
 *
 * Детерминизм (закон №8): один seed на мир, состояние читаем после прогона; сравнение
 * — со стартовыми балансовыми константами и с событиями лога (упорядочен публикацией).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed } from '@zona/shared';
import { createSimWorld, type SimWorld } from './core/world';
import { createScheduler } from './core/scheduler';
import { registerPhase1Systems } from './pipeline';
import { queryEntities, hasComponent } from './core/ecs';
import {
  Settlement,
  Position,
  Home,
  Human,
  Animal,
  Alive,
  Needs,
  Health,
  Task,
} from './core/components';
import { worldgen } from './worldgen';
import { TICKS_PER_DAY } from './balance/time';
import { MAP, getSettlements } from './data/index';
import {
  SETTLEMENT_START_MORALE,
  SETTLEMENT_START_SECURITY,
  TRADER_PROFESSION_ID,
} from './balance/worldgen';

const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const HOME = Home as unknown as { loc: Uint32Array };
const SETTLE = Settlement as unknown as { morale: Float32Array; security: Float32Array };

/** Живой мир Фазы 1 (worldgen + 9 систем), как headless-CLI. */
function buildLive(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase1Systems(scheduler);
  return { world, scheduler };
}

function settlementEids(world: SimWorld): readonly EntityId[] {
  return queryEntities(world.ecs, [Settlement]);
}

function traderEids(world: SimWorld): readonly EntityId[] {
  return queryEntities(world.ecs, [Human]).filter(
    (e) => world.resources.get<string>('profession', e) === TRADER_PROFESSION_ID,
  );
}

describe('поселение инертно: 30 дней живой Зоны не превращают базу в актора (2.2, D-046)', () => {
  it('за 30 дней поселение НЕ получает тегов актора (Alive/Human/Animal/Needs/Health/Task)', () => {
    const { world, scheduler } = buildLive(42);
    const bases = settlementEids(world);
    expect(bases.length).toBe(getSettlements().length);

    scheduler.run(world, TICKS_PER_DAY * 30);

    for (const s of bases) {
      // Ни одна система Фазы 1 не «оживила» поселение: без этих тегов оно невидимо
      // для Movement(Task)/Needs/Death(Health)/TaskSelection(Human)/Encounters/Animals.
      expect(hasComponent(world.ecs, Alive, s)).toBe(false);
      expect(hasComponent(world.ecs, Human, s)).toBe(false);
      expect(hasComponent(world.ecs, Animal, s)).toBe(false);
      expect(hasComponent(world.ecs, Needs, s)).toBe(false);
      expect(hasComponent(world.ecs, Health, s)).toBe(false);
      expect(hasComponent(world.ecs, Task, s)).toBe(false);
      // …но Position оно несёт (для локализации/D-046) — иначе тест ни о чём.
      expect(hasComponent(world.ecs, Position, s)).toBe(true);
    }
  }, 30000);

  it('поселение не телепортируется и не двигается: стоит на своей loc, ни одного move/* с его eid', () => {
    const { world, scheduler } = buildLive(42);
    const bases = settlementEids(world);
    const homeLoc = new Map(bases.map((s) => [s, POS.loc[s]!]));

    scheduler.run(world, TICKS_PER_DAY * 30);

    for (const s of bases) {
      // Позиция не сдвинулась ни на ребро (Movement пропускает стендера без Task).
      expect(POS.loc[s]).toBe(homeLoc.get(s));
      expect(POS.dest[s]).toBe(homeLoc.get(s)); // dest===loc всё время ⇒ «стоит»
      // Всё ещё на своей settlement-локации (связность с картой не нарушена).
      expect(MAP.locations[POS.loc[s]!]!.type).toBe('settlement');
    }

    const movedSettlement = world.bus.log.some(
      (e) =>
        (e.type === 'move/departed' || e.type === 'move/arrived') &&
        bases.includes((e.payload as { eid: EntityId }).eid),
    );
    expect(movedSettlement).toBe(false);
  }, 30000);

  it('НИ ОДНОГО ложного боя: за 30 дней ни encounter/started, ни casualties не числят поселение', () => {
    const { world, scheduler } = buildLive(42);
    const bases = new Set(settlementEids(world));

    scheduler.run(world, TICKS_PER_DAY * 30);

    const started = world.bus.log.filter((e) => e.type === 'encounter/started');
    // Реальные бои шли (охота на дичь) — иначе тест не проверяет фильтрацию.
    expect(started.length).toBeGreaterThan(0);
    for (const e of started) {
      const sides = (e.payload as { sides: readonly (readonly EntityId[])[] }).sides.flat();
      for (const eid of sides) expect(bases.has(eid)).toBe(false); // поселение — не боец
    }
    for (const e of world.bus.log) {
      if (e.type === 'encounter/resolved') {
        const cas = (e.payload as { casualties: readonly EntityId[] }).casualties;
        for (const eid of cas) expect(bases.has(eid)).toBe(false); // поселение не гибнет в бою
      }
      if (e.type === 'entity/died') {
        expect(bases.has((e.payload as { eid: EntityId }).eid)).toBe(false); // и вообще не умирает
      }
    }
  }, 30000);

  it('склад/касса/мораль поселения НЕИЗМЕННЫ за 30 дней (Фаза 1 экономики не трогает базу, закон №3)', () => {
    const { world, scheduler } = buildLive(42);
    const bases = settlementEids(world);
    // Снимок ДО прогона: склад = свежая копия из worldgen, касса, мораль/защита.
    const before = bases.map((s) => ({
      eid: s,
      inv: world.resources.get<{ item: string; qty: number }[]>('inventory', s),
      money: world.resources.get<number>('money', s),
      morale: SETTLE.morale[s],
      security: SETTLE.security[s],
    }));

    scheduler.run(world, TICKS_PER_DAY * 30);

    for (const b of before) {
      // Ничто в Фазе 1 не пишет в склад/кассу поселения (Encounters/TaskEffects
      // адресуют инвентарь ЛЮДЕЙ, не поселений) ⇒ база физически неподвижна.
      expect(world.resources.get<{ item: string; qty: number }[]>('inventory', b.eid)).toEqual(b.inv);
      expect(world.resources.get<number>('money', b.eid)).toBe(b.money);
      // Settlement-компонент тоже никто не пишет в Фазе 1 (мораль/защита статичны).
      expect(SETTLE.morale[b.eid]).toBe(b.morale);
      expect(SETTLE.security[b.eid]).toBe(b.security);
      expect(SETTLE.morale[b.eid]).toBeCloseTo(SETTLEMENT_START_MORALE, 5);
      expect(SETTLE.security[b.eid]).toBeCloseTo(SETTLEMENT_START_SECURITY, 5);
    }
  }, 30000);

  it('ПИНУЕМ известное поведение: поселение ВИДНО соседям (есть в их contacts), но это безвредно', () => {
    // Поселение — носитель Position ⇒ Perception кладёт его в бакет локации, и
    // co-located соседи видят его как контакт. Это ОЖИДАЕМО и не ведёт к бою/бегству
    // (проверено выше). Фиксируем факт, чтобы будущее изменение (напр. исключение
    // поселений из Perception) было осознанным решением, а не молчаливой регрессией.
    const { world, scheduler } = buildLive(42);
    const bases = new Set(settlementEids(world));
    scheduler.run(world, 3); // достаточно, чтобы Perception построил contacts

    const seenBySomeNeighbour = queryEntities(world.ecs, [Human, Alive]).some((h) => {
      const c = world.resources.get<{ target: EntityId }[]>('contacts', h);
      return c?.some((x) => bases.has(x.target)) ?? false;
    });
    expect(seenBySomeNeighbour).toBe(true);
  }, 15000);
});

// ═════════════════════════════════════════════════════════════════════════════
// ТОРГОВЕЦ — ОБЫЧНЫЙ СМЕРТНЫЙ NPC (задача 2.2, D-051). ПИНУЕМ Ф1-поведение до 2.6:
// у торговца НЕТ спец-задачи TRADE (появится в 2.6), нет бессмертия и «привязки к
// прилавку». В Фазе 1 он ходит и гибнет как сталкер — это ОЖИДАЕМО, фиксируем как
// контракт (иначе 2.6 не будет знать стартовую точку: типичный торговец Ф1 не
// доживает до 30-го дня — см. смертность ниже).
// ═════════════════════════════════════════════════════════════════════════════
describe('торговец — смертный ординарный NPC, живёт как сталкер до TRADE-задачи 2.6 (D-051)', () => {
  it('НЕТ бессмертия/спец-защиты: контракт компонентов торговца = контракт сталкера', () => {
    const { world } = buildLive(42);
    const traders = traderEids(world);
    const stalker = queryEntities(world.ecs, [Human, Alive]).find((e) => !traders.includes(e))!;
    expect(traders.length).toBe(getSettlements().length);
    for (const t of traders) {
      // Тот же смертный набор, что у сталкера: Position/Needs/Health/Task-способность/
      // Human/Alive. Ни одного «бессмертного» тега сверх сталкера (Settlement — на
      // отдельном eid базы, не на торговце).
      for (const C of [Position, Needs, Health, Human, Alive, Home] as const) {
        expect(hasComponent(world.ecs, C, t)).toBe(hasComponent(world.ecs, C, stalker));
      }
      expect(hasComponent(world.ecs, Settlement, t)).toBe(false); // торговец — не база
    }
  });

  it('за 30 дней торговец НЕ idle: берёт задачи, УХОДИТ из поселения (ординарный распорядок)', () => {
    // Торговец подчиняется TaskSelection/Movement как все: он не «прилипает» к базе.
    const { world, scheduler } = buildLive(42);
    const traders = new Set(traderEids(world));
    const homeLoc = new Map([...traders].map((t) => [t, HOME.loc[t]!]));
    const leftHome = new Set<EntityId>();

    // Позицию сэмплируем каждый тик (после смерти позиция «застывает» — но факт ухода
    // с прилавка уже зафиксируется). Факт получения задачи берём из ЛОГА (task/selected
    // переживает смерть носителя, в отличие от компонента Task, снятого Death).
    for (let i = 0; i < TICKS_PER_DAY * 30; i++) {
      scheduler.run(world, 1);
      for (const t of traders) if (POS.loc[t] !== homeLoc.get(t)) leftHome.add(t);
    }

    const traderTasked = new Set<EntityId>();
    for (const e of world.bus.log) {
      if (e.type !== 'task/selected') continue;
      const eid = (e.payload as { eid: EntityId }).eid;
      if (traders.has(eid)) traderTasked.add(eid);
    }
    // Каждый торговец хоть раз получал задачу (0 idle, закон №4) и уходил из базы —
    // значит он живёт как ординарный NPC, а не как статичный «магазин».
    expect(traderTasked.size).toBe(traders.size);
    expect(leftHome.size).toBe(traders.size);
  }, 30000);

  it('торговец СМЕРТЕН: за 30 дней (seed 7) гибнет как обычный NPC (нет спец-защиты, D-051)', () => {
    // Пин Ф1-реальности: на seed 7 ОБА торговца погибают к 30-му дню — смерть снимает
    // общий Death по hp<=0, торговец под ним наравне со сталкерами. Когда 2.6 введёт
    // TRADE-распорядок, этот тест зафиксирует смену поведения (торговец начнёт выживать).
    const { world, scheduler } = buildLive(7);
    const traders = traderEids(world);
    scheduler.run(world, TICKS_PER_DAY * 30);
    const traderDeaths = world.bus.log.filter(
      (e) => e.type === 'entity/died' && traders.includes((e.payload as { eid: EntityId }).eid),
    ).length;
    expect(traderDeaths).toBeGreaterThan(0); // торговец реально может умереть
  }, 30000);
});
