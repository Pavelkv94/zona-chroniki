/**
 * @module @zona/sim/systems/economy.test
 *
 * Гейт системы Economy (задача 2.3, B5, D-045/D-046): доказывает ПОТРЕБЛЕНИЕ,
 * ПРОИЗВОДСТВО, МОРАЛЬ, СТРОЙКУ и ЗАБРОШЕННОСТЬ поселений — детерминированно из
 * состояния мира (закон №2, без rng), с сохранением МАССЫ (закон №3: consumed
 * уничтожает, produced создаёт, леджер сходится) и resume-безопасностью (P0:
 * split ≡ continuous по хэшу; дробный долг потребления — в сериализуемом
 * ResourceStore, не в рантайм-накопителе).
 *
 * Economy НЕ входит в конвейер Фазы 1 (подключит 2.16), поэтому здесь она гоняется
 * в ОТДЕЛЬНОМ планировщике (только Economy). Голдены Фазы 1 не затрагиваются.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, ItemId, Seed, SimEvent } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  worldgen,
  serialize,
  deserialize,
  hashSnapshot,
  TICKS_PER_DAY,
  Economy,
  type SimWorld,
} from '../index';
import { spawnEntity, addComponent, hasComponent, queryEntities } from '../core/ecs';
import { Settlement, Position, Home, Job, Human, Alive } from '../core/components';
import { getItem } from '../data/index';
import {
  MORALE_ABANDON_THRESHOLD,
  MORALE_MAX,
  ECONOMY_CADENCE,
  SECURITY_PER_CAPITA,
} from '../balance/economy';
// Стартовую мораль поселения держит balance/worldgen (её ставит worldgen 2.2).
import { SETTLEMENT_START_MORALE as WG_START_MORALE } from '../balance/worldgen';

const SETTLE = Settlement as unknown as {
  morale: Float32Array;
  security: Float32Array;
  buildTarget: Uint8Array;
  buildProgress: Float32Array;
};
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
const HOME = Home as unknown as { loc: Uint32Array };
const JOB = Job as unknown as { workplace: Uint32Array; employer: Uint32Array };

interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Отфильтрованные события заданного типа С СУЖЕНИЕМ payload (filter не сужает сам). */
function eventsOfType<T extends SimEvent['type']>(
  world: SimWorld,
  type: T,
): ReadonlyArray<Extract<SimEvent, { type: T }>> {
  return world.bus.log.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

/** Мир из worldgen + планировщик ТОЛЬКО с Economy (как подключит 2.16, но изолированно). */
function buildEconWorld(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  scheduler.register(Economy);
  return { world, scheduler };
}

/** eid поселения по loc (worldgen ставит Position.loc = loc поселения). */
function settlementAtLoc(world: SimWorld, loc: number): EntityId {
  const hit = queryEntities(world.ecs, [Settlement]).find((e) => (POS.loc[e] as number) === loc);
  expect(hit, `ожидалось поселение на loc ${loc}`).toBeDefined();
  return hit as EntityId;
}

/** Σ qty предметов заданного kind на складе поселения. */
function stockOfKind(world: SimWorld, eid: EntityId, kind: string): number {
  const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
  let sum = 0;
  for (const e of inv) if (getItem(e.item).kind === kind) sum += e.qty;
  return sum;
}

/** Σ qty конкретного предмета на складе. */
function stockOf(world: SimWorld, eid: EntityId, item: string): number {
  const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
  let sum = 0;
  for (const e of inv) if (e.item === item) sum += e.qty;
  return sum;
}

/** Σ qty списанного данным поселением с причиной reason (по леджеру). */
function upkeepConsumedBy(world: SimWorld, eid: EntityId, reason: string): number {
  let sum = 0;
  for (const ev of eventsOfType(world, 'item/consumed')) {
    if (ev.payload.who === eid && ev.payload.reason === reason) sum += ev.payload.qty;
  }
  return sum;
}

// ── МАНУАЛЬНАЯ СБОРКА (точный контроль населения/труда/склада) ────────────────
// Поселение обязано стоять на loc с data (getSettlement) — loc 0 = Кордон
// (recipe canned<-meat labor 3, buildQueue [watchtower]).

const KORDON_LOC = 0;

function spawnSettlement(world: SimWorld, loc: number, inv: InventoryEntry[], morale = 0.7): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Settlement, eid);
  SETTLE.morale[eid] = morale;
  SETTLE.security[eid] = 0.6;
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, inv);
  world.resources.set<number>('money', eid, 0);
  return eid;
}

/** Живой человек: резидент (Home.loc=homeLoc) и опционально работник (Job.employer). */
function spawnPerson(world: SimWorld, homeLoc: number, employer?: EntityId, workplace = 0): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Home, eid);
  HOME.loc[eid] = homeLoc;
  if (employer !== undefined) {
    addComponent(world.ecs, Job, eid);
    JOB.employer[eid] = employer;
    JOB.workplace[eid] = workplace;
  }
  return eid;
}

/** Прогнать Economy N раз (по одному due-запуску на кратный ECONOMY_CADENCE тик). */
function runEconomy(world: SimWorld, scheduler: ReturnType<typeof createScheduler>, ticks: number): void {
  scheduler.run(world, ticks);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) ПОТРЕБЛЕНИЕ: склад убывает пропорционально населению; item/consumed(upkeep)
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: потребление тратит провизию со склада пропорц. населению (закон №3)', () => {
  it('за 2 дня Кордон (население 21) проедает МНОГО больше Ростока (население 1)', () => {
    const { world, scheduler } = buildEconWorld(42);
    const kordon = settlementAtLoc(world, 0);
    const rostok = settlementAtLoc(world, 5);

    const kFoodBefore = stockOfKind(world, kordon, 'food');
    const rFoodBefore = stockOfKind(world, rostok, 'food');

    // 2 дня: Росток (население 1) накопит >=1 целый юнит спроса, а Кордон ещё НЕ
    // исчерпает воду (депл. ~2.38 дня) ⇒ окно без дефицита/заброшенности.
    runEconomy(world, scheduler, TICKS_PER_DAY * 2);

    // Оба реально проели провизию (item/consumed reason 'upkeep' эмитятся).
    const kUpkeep = upkeepConsumedBy(world, kordon, 'upkeep');
    const rUpkeep = upkeepConsumedBy(world, rostok, 'upkeep');
    expect(kUpkeep).toBeGreaterThan(0);
    expect(rUpkeep).toBeGreaterThan(0);

    // Кордон (население 21) съел на ПОРЯДОК больше Ростока (население 1) — расход
    // пропорционален населению (детерминированная арифметика, не «шанс»).
    expect(kUpkeep).toBeGreaterThan(rUpkeep * 5);
    // Ни одно поселение ещё не заброшено (окно без дефицита).
    expect(world.bus.log.some((e) => e.type === 'settlement/abandoned')).toBe(false);
    // Склады реально убыли.
    expect(stockOfKind(world, kordon, 'food')).toBeLessThan(kFoodBefore);
    expect(stockOfKind(world, rostok, 'food')).toBeLessThan(rFoodBefore);
  }, 20000);

  it('за 30 дней склад Кордона убывает до нуля по провизии (население давит на запасы)', () => {
    const { world, scheduler } = buildEconWorld(42);
    const kordon = settlementAtLoc(world, 0);
    runEconomy(world, scheduler, TICKS_PER_DAY * 30);
    // Провизия (еда+вода) Кордона выедена под ноль (население 21 vs скромный склад).
    expect(stockOfKind(world, kordon, 'food')).toBe(0);
    expect(stockOfKind(world, kordon, 'drink')).toBe(0);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) ПУСТОЙ СКЛАД → ДЕФИЦИТ → МОРАЛЬ ПАДАЕТ → settlement/abandoned (причинно)
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: пустой склад роняет мораль до порога и поселение забрасывается (B5)', () => {
  it('поселение с пустым складом и населением: мораль падает, settlement/abandoned РОВНО раз', () => {
    const world = createSimWorld(1 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    // Склад без еды/воды (только бинт — не провизия) ⇒ дефицит при любом спросе.
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'bandage' as ItemId, qty: 3 }], 0.7);
    // 30 работников-резидентов: создают ЧАСТЫЙ спрос (Home.loc=Кордон, целый юнит
    // копится каждые ~5 запусков) и заняты (Job.employer) — мораль просядет за дни.
    const workers = Array.from({ length: 30 }, () => spawnPerson(world, KORDON_LOC, eid, KORDON_LOC));

    runEconomy(world, sched, TICKS_PER_DAY * 5);

    const abandoned = eventsOfType(world, 'settlement/abandoned').filter(
      (e) => e.payload.settlement === eid,
    );
    expect(abandoned.length).toBe(1); // РОВНО раз (флаг гасит повторную эмиссию)
    // Мораль пробила порог заброшенности.
    expect(SETTLE.morale[eid] as number).toBeLessThanOrEqual(MORALE_ABANDON_THRESHOLD);
    // Флаг заброшенности выставлен (сериализуем, resume-safe).
    expect(world.resources.get<boolean>('settlementAbandoned', eid)).toBe(true);
    // Работники потеряли Job (работодателя-поселения не стало).
    for (const w of workers) expect(hasComponent(world.ecs, Job, w)).toBe(false);
    // Причинность: abandoned ссылается на дефицитный item/consumed(upkeep) ИЛИ null
    // (склад провизии был пуст → списания-события не возникло). Здесь склад без еды
    // ⇒ upkeep-списаний нет ⇒ causedBy === null (эндогенный корень пустого склада).
    expect(abandoned[0]!.causedBy).toBeNull();
    expect(abandoned[0]!.payload.reason).toContain('дефицит');
  }, 30000);

  it('достаточный склад: мораль НЕ падает (растёт к максимуму), поселение НЕ заброшено', () => {
    const world = createSimWorld(1 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    // Щедрый склад еды/воды на 1 жителя — спрос покрыт, дефицита нет.
    const eid = spawnSettlement(
      world,
      KORDON_LOC,
      [{ item: 'canned' as ItemId, qty: 500 }, { item: 'water' as ItemId, qty: 500 }],
      0.7,
    );
    // 5 резидентов: спрос покрыт с запасом, целый юнит копится часто ⇒ мораль растёт.
    for (let i = 0; i < 5; i++) spawnPerson(world, KORDON_LOC);

    runEconomy(world, sched, TICKS_PER_DAY * 10);

    expect(world.bus.log.some((e) => e.type === 'settlement/abandoned')).toBe(false);
    // Мораль поднялась выше старта (достаток на запусках с покрытым спросом).
    expect(SETTLE.morale[eid] as number).toBeGreaterThan(0.7);
    // Провизия убыла (потребление шло), но не в ноль.
    expect(stockOf(world, eid, 'canned')).toBeGreaterThan(0);
    expect(stockOf(world, eid, 'canned')).toBeLessThan(500);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) ПРОИЗВОДСТВО: сырьё + труд → товар; без труда — нет производства; масса сведена
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: производство конвертирует сырьё в товар ТОЛЬКО при труде (закон №3)', () => {
  /** Мир: Кордон-склад с meat, 3 работника-НЕрезидента (Home на loc 1 ⇒ pop=0, без потребления). */
  function makeProductionWorld(withJob: boolean): { world: SimWorld; sched: ReturnType<typeof createScheduler>; eid: EntityId } {
    const world = createSimWorld(2 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'meat' as ItemId, qty: 10 }]);
    // Работники живут в ДРУГОЙ локации (Home.loc=1) ⇒ население Кордона = 0 (нет
    // потребления, изолируем производство). Заняты, если withJob.
    for (let i = 0; i < 3; i++) spawnPerson(world, 1, withJob ? eid : undefined, KORDON_LOC);
    return { world, sched, eid };
  }

  it('сырьё meat + 3 работника (labor 3) → 1 canned за запуск: consumed(production)+produced', () => {
    const { world, sched, eid } = makeProductionWorld(true);
    // Один due-запуск Economy (tick 0 кратен ECONOMY_CADENCE).
    sched.run(world, 1);

    expect(stockOf(world, eid, 'meat')).toBe(9); // сырьё ушло
    expect(stockOf(world, eid, 'canned')).toBe(1); // товар создан

    const produced = eventsOfType(world, 'item/produced').filter((e) => e.payload.settlement === eid);
    expect(produced.length).toBe(1);
    expect(produced[0]!.payload.item).toBe('canned');
    expect(produced[0]!.payload.qty).toBe(1);
    expect(produced[0]!.causedBy).toBeNull();

    const prodConsumed = eventsOfType(world, 'item/consumed').filter(
      (e) => e.payload.who === eid && e.payload.reason === 'production',
    );
    expect(prodConsumed.length).toBe(1);
    expect(prodConsumed[0]!.payload.item).toBe('meat');
    expect(prodConsumed[0]!.payload.qty).toBe(1);
  });

  it('БЕЗ труда (нет Job) производства НЕТ: meat не тронут, ни одного item/produced', () => {
    const { world, sched, eid } = makeProductionWorld(false);
    sched.run(world, 5);
    expect(stockOf(world, eid, 'meat')).toBe(10); // сырьё нетронуто
    expect(world.bus.log.some((e) => e.type === 'item/produced')).toBe(false);
  });

  it('МАССА СВЕДЕНА через производство: Σ inventory delta == леджер (produced−consumed)', () => {
    const { world, sched, eid } = makeProductionWorld(true);
    // Тоталы предметов ДО (baseline).
    const before = worldItemTotals(world);
    sched.run(world, 100); // много запусков: meat 10 → 10 canned, затем стоп (нет сырья)
    const after = worldItemTotals(world);
    const ledger = ledgerItemDelta(world);

    // Для КАЖДОГО предмета: (after − before) обязано равняться дельте леджера — это
    // ровно то равенство, что проверяет EconomyInvariant (закон №3), для производства.
    const items = new Set<string>([...before.keys(), ...after.keys(), ...ledger.keys()]);
    for (const item of items) {
      const observed = (after.get(item) ?? 0) - (before.get(item) ?? 0);
      expect(observed, `масса ${item} должна сойтись с леджером`).toBe(ledger.get(item) ?? 0);
    }
    // Реально было и потребление сырья, и выработка (иначе тест пустой).
    expect(stockOf(world, eid, 'canned')).toBe(10);
    expect(stockOf(world, eid, 'meat')).toBe(0);
  }, 20000);
});

/** Σ qty каждого предмета по ВСЕМ носителям 'inventory' (аналог worldTotals.items). */
function worldItemTotals(world: SimWorld): Map<string, number> {
  const m = new Map<string, number>();
  for (const [, inv] of world.resources.entries<readonly InventoryEntry[]>('inventory')) {
    for (const e of inv) m.set(e.item, (m.get(e.item) ?? 0) + e.qty);
  }
  return m;
}

/** Дельта массы предметов из леджера (produced +, consumed −) — как ledgerDelta. */
function ledgerItemDelta(world: SimWorld): Map<string, number> {
  const m = new Map<string, number>();
  for (const ev of eventsOfType(world, 'item/produced')) {
    m.set(ev.payload.item, (m.get(ev.payload.item) ?? 0) + ev.payload.qty);
  }
  for (const ev of eventsOfType(world, 'item/harvested')) {
    m.set(ev.payload.item, (m.get(ev.payload.item) ?? 0) + ev.payload.qty);
  }
  for (const ev of eventsOfType(world, 'item/consumed')) {
    m.set(ev.payload.item, (m.get(ev.payload.item) ?? 0) - ev.payload.qty);
  }
  return m;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4) СТРОИТЕЛЬСТВО: buildProgress растёт под трудом; на 100% → settlement/built
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: строительство завершает проект на 100% прогресса (B5)', () => {
  it('3 работника доводят buildProgress до 1.0 → settlement/built(watchtower), прогресс сброшен', () => {
    const world = createSimWorld(3 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    // Склад без сырья рецепта (нет meat) ⇒ производства нет; НЕрезиденты ⇒ pop=0.
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'bandage' as ItemId, qty: 1 }]);
    // Работники — НЕрезиденты (Home.loc=1) ⇒ население Кордона 0 (без потребления/
    // морали, изолируем стройку). 3 работника × 0.01/запуск = 0.03 ⇒ ~34 запуска до 1.0.
    for (let i = 0; i < 3; i++) spawnPerson(world, 1, eid, KORDON_LOC);

    sched.run(world, TICKS_PER_DAY);

    const built = eventsOfType(world, 'settlement/built').filter((e) => e.payload.settlement === eid);
    expect(built.length).toBe(1);
    expect(built[0]!.payload.project).toBe('watchtower'); // первый проект buildQueue Кордона
    expect(built[0]!.causedBy).toBeNull();
    // Прогресс сброшен; buildQueue длиной 1 ИСЧЕРПАНА ⇒ buildTarget стал done-сентинелом
    // (> длины очереди), а НЕ 0 (иначе стройка зациклилась бы, перечитав 0 как «начать»).
    expect(SETTLE.buildProgress[eid] as number).toBe(0);
    expect(SETTLE.buildTarget[eid] as number).toBeGreaterThan(1);

    // НЕТ зацикливания: ещё 2 дня труда НЕ порождают повторной стройки того же проекта.
    sched.run(world, TICKS_PER_DAY * 2);
    const builtAfter = eventsOfType(world, 'settlement/built').filter((e) => e.payload.settlement === eid);
    expect(builtAfter.length).toBe(1);
  }, 20000);

  it('без труда стройка не идёт: buildProgress остаётся 0, ни одного settlement/built', () => {
    const world = createSimWorld(3 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'canned' as ItemId, qty: 500 }, { item: 'water' as ItemId, qty: 500 }]);
    spawnPerson(world, KORDON_LOC); // резидент (потребляет), но НЕ работник

    sched.run(world, TICKS_PER_DAY);
    expect(SETTLE.buildProgress[eid] as number).toBe(0);
    expect(world.bus.log.some((e) => e.type === 'settlement/built')).toBe(false);
  }, 20000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5) ДЕТЕРМИНИЗМ (2×) и RESUME P0 (split ≡ continuous; дробный долг сериализуем)
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: детерминизм и resume-безопасность (закон №8, P0)', () => {
  it('один seed → идентичный хэш мира дважды (rng не используется, порядок сорт.)', () => {
    const a = buildEconWorld(42);
    a.scheduler.run(a.world, TICKS_PER_DAY * 5);
    const b = buildEconWorld(42);
    b.scheduler.run(b.world, TICKS_PER_DAY * 5);
    expect(hashSnapshot(serialize(a.world))).toBe(hashSnapshot(serialize(b.world)));
  }, 30000);

  it('split (5д → save/load → 5д) даёт ТОТ ЖЕ мир, что непрерывные 10д (дробный долг цел)', () => {
    // Непрерывный контроль.
    const cont = buildEconWorld(7);
    cont.scheduler.run(cont.world, TICKS_PER_DAY * 10);
    const contHash = hashSnapshot(serialize(cont.world));

    // Split: 5 дней → сериализация → восстановление → ещё 5 дней.
    const split = buildEconWorld(7);
    split.scheduler.run(split.world, TICKS_PER_DAY * 5);
    const restored = deserialize(serialize(split.world));
    const rs = createScheduler();
    rs.register(Economy);
    rs.run(restored, TICKS_PER_DAY * 5);

    // Побитово совпал с непрерывным ⇒ consumptionDebt (дробный накопитель) пережил
    // save/load тождественно: resume не сдвинул историю потребления (P0).
    expect(hashSnapshot(serialize(restored))).toBe(contHash);
  }, 30000);

  it('дробный долг потребления ХРАНИТСЯ в ResourceStore (не в рантайм-накопителе)', () => {
    const { world, scheduler } = buildEconWorld(42);
    const kordon = settlementAtLoc(world, 0);
    scheduler.run(world, TICKS_PER_DAY); // накопился дробный хвост спроса
    const debt = world.resources.get<{ food: number; water: number }>('consumptionDebt', kordon);
    expect(debt).toBeDefined();
    // Хвост — в [0,1): целая часть уже списана со склада, дробь копится дальше.
    expect(debt!.food).toBeGreaterThanOrEqual(0);
    expect(debt!.food).toBeLessThan(1);
    expect(debt!.water).toBeGreaterThanOrEqual(0);
    expect(debt!.water).toBeLessThan(1);
  }, 20000);
});

// Санити: стартовая мораль worldgen совпадает с константой (защита от рассинхрона
// balance/economy ↔ balance/worldgen — обе держат «стартовые» числа поселения).
describe('Economy balance sanity', () => {
  it('MORALE_ABANDON_THRESHOLD ниже стартовой морали (иначе поселение забрасывается сразу)', () => {
    expect(MORALE_ABANDON_THRESHOLD).toBeLessThan(WG_START_MORALE);
    // SETTLEMENT_START_MORALE тут не импортируется из economy (его там нет) — но
    // worldgen-константа должна быть выше порога, иначе стартовое поселение мертво.
    expect(WG_START_MORALE).toBeGreaterThan(MORALE_ABANDON_THRESHOLD);
  });
});

// Число запусков Economy (every=ECONOMY_CADENCE) за `ticks` тиков с tick 0:
// due на 0, C, 2C, … < ticks ⇒ floor((ticks-1)/C)+1.
function economyRuns(ticks: number): number {
  return ticks < 1 ? 0 : Math.floor((ticks - 1) / ECONOMY_CADENCE) + 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6) ДРОБНЫЙ ДОЛГ resume-safe: целый расход == floor(накопленного спроса); хвост
//    в [0,1); склад ВСЕГДА целочислен; долг НИКОГДА не отрицателен; дроби не
//    теряются и не дублируются (закон №3 — масса на целых, закон №8 — split≡cont)
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: дробный долг потребления — целый расход, хвост в [0,1), масса на дробях цела', () => {
  it('за 1000 тиков (спрос накопился дробно) расход == floor(спроса), долг == хвост, склад цел', () => {
    const world = createSimWorld(11 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    // Щедрый склад еды/питья: дефицита НЕТ ⇒ весь запрошенный целый спрос покрыт,
    // ничего не «теряется» голодом — можно точно сверить расход с накопленным спросом.
    const eid = spawnSettlement(
      world,
      KORDON_LOC,
      [{ item: 'bread' as ItemId, qty: 1000 }, { item: 'water' as ItemId, qty: 1000 }],
    );
    const POP = 5;
    for (let i = 0; i < POP; i++) spawnPerson(world, KORDON_LOC); // 5 резидентов, без Job

    const TICKS = 1000;
    const foodBefore = stockOfKind(world, eid, 'food');
    const waterBefore = stockOfKind(world, eid, 'drink');
    sched.run(world, TICKS);

    // Накопленный спрос за все запуски = perCapita(1.0) × POP × (C/сутки) × запусков.
    const runs = economyRuns(TICKS);
    const demand = 1.0 * POP * (ECONOMY_CADENCE / TICKS_PER_DAY) * runs;
    const expectConsumed = Math.floor(demand);
    const expectDebt = demand - expectConsumed; // дробный хвост в [0,1)

    const foodConsumed = upkeepConsumedBy(world, eid, 'upkeep');
    // Весь upkeep — только еда+вода; сверим суммарный целый расход с floor(спроса)×2
    // (еда и вода симметричны: одинаковый perCapita). Здесь meat нет ⇒ food только bread.
    const foodDelta = foodBefore - stockOfKind(world, eid, 'food');
    const waterDelta = waterBefore - stockOfKind(world, eid, 'drink');

    // Целый расход == floor накопленного спроса, ОТДЕЛЬНО по еде и воде.
    expect(foodDelta).toBe(expectConsumed);
    expect(waterDelta).toBe(expectConsumed);
    // Дефицита не было ⇒ склад-дельта == Σ item/consumed(upkeep) (нет потери/дубля дроби).
    expect(foodConsumed).toBe(foodDelta + waterDelta);

    // Долг хранит РОВНО дробный хвост (в [0,1), НИКОГДА не отрицателен) — сериализуемо.
    const debt = world.resources.get<{ food: number; water: number }>('consumptionDebt', eid)!;
    expect(debt.food).toBeGreaterThanOrEqual(0);
    expect(debt.food).toBeLessThan(1);
    expect(debt.food).toBeCloseTo(expectDebt, 6);
    expect(debt.water).toBeCloseTo(expectDebt, 6);

    // Склад ЦЕЛОЧИСЛЕН (закон №3 — предметы дискретны, дробь живёт лишь в долге).
    const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
    for (const e of inv) expect(Number.isInteger(e.qty)).toBe(true);
  }, 20000);

  it('split РОВНО на тике списания (дробный хвост в долге) ≡ непрерывному прогону', () => {
    // Непрерывный контроль: 1000 тиков.
    const cont = (() => {
      const world = createSimWorld(11 as Seed);
      const s = createScheduler();
      s.register(Economy);
      spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 1000 }, { item: 'water' as ItemId, qty: 1000 }]);
      for (let i = 0; i < 5; i++) spawnPerson(world, KORDON_LOC);
      s.run(world, 1000);
      return hashSnapshot(serialize(world));
    })();

    // Split ровно на tick 500 (кратен ECONOMY_CADENCE ⇒ это ТИК СПИСАНИЯ, долг несёт
    // дробный хвост < 1): 500 → save/load → 500. Дробный долг обязан пережить save/load.
    const world = createSimWorld(11 as Seed);
    const s = createScheduler();
    s.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 1000 }, { item: 'water' as ItemId, qty: 1000 }]);
    for (let i = 0; i < 5; i++) spawnPerson(world, KORDON_LOC);
    s.run(world, 500);
    // На точке разреза долг УЖЕ дробный (не 0 и не целый) — иначе тест не про дробь.
    const midDebt = world.resources.get<{ food: number; water: number }>('consumptionDebt', eid)!;
    expect(midDebt.food).toBeGreaterThan(0);
    expect(midDebt.food).toBeLessThan(1);

    const restored = deserialize(serialize(world));
    const rs = createScheduler();
    rs.register(Economy);
    rs.run(restored, 500);

    expect(hashSnapshot(serialize(restored))).toBe(cont);
  }, 20000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7) ЗАБРОШЕННОСТЬ РОВНО РАЗ: много тиков ниже порога → одно событие; resume не
//    дублирует (флаг сериализуем); заброшенное поселение ИНЕРТНО
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: settlement/abandoned эмитится ровно раз и переживает resume (B5, P0)', () => {
  /** Мир: голодное поселение (склад без провизии) с 30 занятыми резидентами. */
  function makeStarvingWorld(seed: number): { world: SimWorld; sched: ReturnType<typeof createScheduler>; eid: EntityId; workers: EntityId[] } {
    const world = createSimWorld(seed as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'bandage' as ItemId, qty: 3 }], 0.7);
    const workers = Array.from({ length: 30 }, () => spawnPerson(world, KORDON_LOC, eid, KORDON_LOC));
    return { world, sched, eid, workers };
  }

  it('мораль ниже порога МНОГО дней подряд → всего ОДНО settlement/abandoned', () => {
    const { world, sched, eid } = makeStarvingWorld(21);
    // Долго держим ниже порога: 20 дней — многократно больше, чем нужно на распад.
    sched.run(world, TICKS_PER_DAY * 20);
    const abandoned = eventsOfType(world, 'settlement/abandoned').filter((e) => e.payload.settlement === eid);
    expect(abandoned.length).toBe(1); // ровно раз, несмотря на тысячи тиков ниже порога
  }, 30000);

  it('resume ПОСЛЕ заброшенности не порождает второго settlement/abandoned (флаг цел)', () => {
    const { world, sched, eid } = makeStarvingWorld(21);
    // Доводим до заброшенности.
    sched.run(world, TICKS_PER_DAY * 6);
    expect(world.resources.get<boolean>('settlementAbandoned', eid)).toBe(true);
    const beforeCount = eventsOfType(world, 'settlement/abandoned').length;
    expect(beforeCount).toBe(1);

    // Save/load ПОСЛЕ заброшенности (флаг в снапшоте) → ещё 10 дней.
    const restored = deserialize(serialize(world));
    const rs = createScheduler();
    rs.register(Economy);
    rs.run(restored, TICKS_PER_DAY * 10);

    // Лог (eventLog сериализуется) всё ещё несёт РОВНО одно abandoned — resume не дублировал.
    const after = eventsOfType(restored, 'settlement/abandoned').filter((e) => e.payload.settlement === eid);
    expect(after.length).toBe(1);
  }, 30000);

  it('заброшенное поселение ИНЕРТНО: после abandoned нет нового потребления, работники без Job', () => {
    const { world, sched, eid, workers } = makeStarvingWorld(21);
    sched.run(world, TICKS_PER_DAY * 6);
    expect(world.resources.get<boolean>('settlementAbandoned', eid)).toBe(true);
    for (const w of workers) expect(hasComponent(world.ecs, Job, w)).toBe(false);

    const consumedAt = upkeepConsumedBy(world, eid, 'upkeep');
    const producedBefore = eventsOfType(world, 'item/produced').filter((e) => e.payload.settlement === eid).length;
    // Ещё 10 дней: заброшенное поселение Economy больше не обслуживает.
    sched.run(world, TICKS_PER_DAY * 10);
    expect(upkeepConsumedBy(world, eid, 'upkeep')).toBe(consumedAt); // потребление ЗАМЕРЛО
    expect(eventsOfType(world, 'item/produced').filter((e) => e.payload.settlement === eid).length).toBe(producedBefore);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8) resume на РАЗНЫХ фазах (до/во время дефицита; до/после built) ≡ continuous
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: split ≡ continuous на любой фазе жизни поселения (P0)', () => {
  function starving(seed: number): { world: SimWorld; sched: ReturnType<typeof createScheduler> } {
    const world = createSimWorld(seed as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'water' as ItemId, qty: 4 }], 0.7);
    for (let i = 0; i < 20; i++) spawnPerson(world, KORDON_LOC, eid, KORDON_LOC);
    return { world, sched };
  }

  // Разрезы охватывают: до первого дефицита, в разгар дефицита, около заброшенности.
  for (const splitDay of [1, 3, 6]) {
    it(`split на дне ${splitDay} (фаза дефицита/распада) ≡ непрерывным 12 дням`, () => {
      const cont = starving(33);
      cont.sched.run(cont.world, TICKS_PER_DAY * 12);
      const contHash = hashSnapshot(serialize(cont.world));

      const split = starving(33);
      split.sched.run(split.world, TICKS_PER_DAY * splitDay);
      const restored = deserialize(serialize(split.world));
      const rs = createScheduler();
      rs.register(Economy);
      rs.run(restored, TICKS_PER_DAY * (12 - splitDay));

      expect(hashSnapshot(serialize(restored))).toBe(contHash);
    }, 30000);
  }

  it('split вокруг settlement/built ≡ непрерывному (стройка resume-safe)', () => {
    // Изолированная стройка: НЕрезиденты-работники (pop=0, без потребления/распада).
    function building(seed: number): { world: SimWorld; sched: ReturnType<typeof createScheduler> } {
      const world = createSimWorld(seed as Seed);
      const sched = createScheduler();
      sched.register(Economy);
      const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'bandage' as ItemId, qty: 1 }]);
      for (let i = 0; i < 3; i++) spawnPerson(world, 1, eid, KORDON_LOC);
      return { world, sched };
    }
    const cont = building(44);
    cont.sched.run(cont.world, TICKS_PER_DAY * 3); // watchtower достраивается внутри 1 дня
    const contHash = hashSnapshot(serialize(cont.world));

    const split = building(44);
    split.sched.run(split.world, TICKS_PER_DAY); // разрез РЯДОМ с завершением стройки
    const restored = deserialize(serialize(split.world));
    const rs = createScheduler();
    rs.register(Economy);
    rs.run(restored, TICKS_PER_DAY * 2);
    expect(hashSnapshot(serialize(restored))).toBe(contHash);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9) МОРАЛЬ: границы [0,1] и «нейтральный» запуск без целого спроса
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: мораль зажата в [0,1]; пустой спрос нейтрален (не разгоняет ложно)', () => {
  it('достаток МНОГО дней → мораль упирается в потолок MORALE_MAX и НЕ превышает его', () => {
    const world = createSimWorld(55 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'canned' as ItemId, qty: 5000 }, { item: 'water' as ItemId, qty: 5000 }], 0.9);
    for (let i = 0; i < 5; i++) spawnPerson(world, KORDON_LOC);
    sched.run(world, TICKS_PER_DAY * 40); // с запасом на выход к потолку
    expect(SETTLE.morale[eid] as number).toBe(MORALE_MAX); // РОВНО потолок, не выше
    // Ещё дни у потолка — мораль не «переливает» за 1.0.
    sched.run(world, TICKS_PER_DAY * 5);
    expect(SETTLE.morale[eid] as number).toBe(MORALE_MAX);
  }, 30000);

  it('пустое поселение (население 0): мораль НЕПОДВИЖНА, security 0, не заброшено', () => {
    const world = createSimWorld(56 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    // Ни одного резидента (Home.loc никуда не указывает на KORDON_LOC).
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'canned' as ItemId, qty: 10 }], 0.5);
    sched.run(world, TICKS_PER_DAY * 10);
    // Нет спроса ⇒ мораль не растёт (и не падает): пустое поселение не «богатеет».
    expect(SETTLE.morale[eid] as number).toBe(0.5);
    expect(SETTLE.security[eid] as number).toBe(0); // защита — производная от населения
    expect(world.bus.log.some((e) => e.type === 'settlement/abandoned')).toBe(false);
    // Провизия НЕ тронута (некому есть) — леджер upkeep пуст.
    expect(stockOf(world, eid, 'canned')).toBe(10);
  }, 20000);

  it('security растёт с населением (производная pop×SECURITY_PER_CAPITA)', () => {
    const world = createSimWorld(57 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'canned' as ItemId, qty: 5000 }, { item: 'water' as ItemId, qty: 5000 }]);
    const POP = 4;
    for (let i = 0; i < POP; i++) spawnPerson(world, KORDON_LOC);
    sched.run(world, ECONOMY_CADENCE); // одного запуска достаточно
    expect(SETTLE.security[eid] as number).toBeCloseTo(POP * SECURITY_PER_CAPITA, 6);
  }, 20000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10) ПРОИЗВОДСТВО: нехватка труда/сырья → 0 (масса из воздуха не берётся, закон №1)
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: производство требует И сырьё, И достаточный труд (иначе 0)', () => {
  it('сырьё есть, но работников < labor (2 < 3) → ни одной партии, meat не тронут', () => {
    const world = createSimWorld(61 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'meat' as ItemId, qty: 10 }]);
    // 2 работника-НЕрезидента (pop=0): труда < labor(3) ⇒ floor(2/3)=0 партий.
    for (let i = 0; i < 2; i++) spawnPerson(world, 1, eid, KORDON_LOC);
    sched.run(world, TICKS_PER_DAY);
    expect(stockOf(world, eid, 'meat')).toBe(10);
    expect(world.bus.log.some((e) => e.type === 'item/produced')).toBe(false);
  }, 20000);

  it('труд есть, но сырья НЕТ (meat 0) → ни одной партии, ни одного produced/consumed', () => {
    const world = createSimWorld(62 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'bandage' as ItemId, qty: 5 }]);
    for (let i = 0; i < 6; i++) spawnPerson(world, 1, eid, KORDON_LOC); // труда с избытком
    sched.run(world, TICKS_PER_DAY);
    expect(world.bus.log.some((e) => e.type === 'item/produced')).toBe(false);
    expect(world.bus.log.some((e) => e.type === 'item/consumed' && e.payload.reason === 'production')).toBe(false);
  }, 20000);

  it('6 работников (2×labor) + сырьё → 2 партии за запуск (труд масштабирует выработку)', () => {
    const world = createSimWorld(63 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    const eid = spawnSettlement(world, KORDON_LOC, [{ item: 'meat' as ItemId, qty: 10 }]);
    for (let i = 0; i < 6; i++) spawnPerson(world, 1, eid, KORDON_LOC);
    sched.run(world, 1); // один запуск
    expect(stockOf(world, eid, 'canned')).toBe(2); // floor(6/3)=2 партии
    expect(stockOf(world, eid, 'meat')).toBe(8);
    const produced = eventsOfType(world, 'item/produced').filter((e) => e.payload.settlement === eid);
    expect(produced.length).toBe(1);
    expect(produced[0]!.payload.qty).toBe(2);
  }, 20000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11) НЕСКОЛЬКО ПОСЕЛЕНИЙ независимы: голод одного не трогает достаток другого
// ═══════════════════════════════════════════════════════════════════════════
describe('Economy: поселения обрабатываются независимо (обход сорт. по eid)', () => {
  it('сытое (loc 5) и голодное (loc 0) поселения: одно процветает, другое заброшено', () => {
    const world = createSimWorld(71 as Seed);
    const sched = createScheduler();
    sched.register(Economy);
    // Голодный Кордон (loc 0): склад без провизии + резиденты.
    const starve = spawnSettlement(world, 0, [{ item: 'bandage' as ItemId, qty: 1 }], 0.7);
    for (let i = 0; i < 15; i++) spawnPerson(world, 0, starve, 0);
    // Сытый Росток (loc 5): щедрый склад + резиденты.
    const thrive = spawnSettlement(world, 5, [{ item: 'canned' as ItemId, qty: 5000 }, { item: 'water' as ItemId, qty: 5000 }], 0.7);
    for (let i = 0; i < 5; i++) spawnPerson(world, 5);

    sched.run(world, TICKS_PER_DAY * 8);

    // Голодный заброшен; сытый — нет и мораль его выросла (независимость исходов).
    expect(world.resources.get<boolean>('settlementAbandoned', starve)).toBe(true);
    expect(world.resources.get<boolean>('settlementAbandoned', thrive)).not.toBe(true);
    expect(SETTLE.morale[thrive] as number).toBeGreaterThan(0.7);
    // Склад сытого никем «чужим» не тронут — provision убыла только его собственным спросом.
    expect(stockOf(world, thrive, 'canned')).toBeGreaterThan(0);
    expect(stockOf(world, thrive, 'canned')).toBeLessThan(5000);
    // Каждое abandoned относится РОВНО к голодному eid (не перепутаны поселения).
    const abandoned = eventsOfType(world, 'settlement/abandoned');
    expect(abandoned.every((e) => e.payload.settlement === starve)).toBe(true);
  }, 30000);
});
