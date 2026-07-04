/**
 * @module @zona/sim/systems/artifact-search.test
 *
 * Гейт системы ArtifactSearch (задача 2.10, D-057). Покрывает:
 *  - ПЕРЕВОД: стоящий в поле NPC с Task=SEARCH подбирает РОВНО ОДНУ единицу артефакта
 *    (поле пустеет на единицу, NPC пополняется), масса ДО == ПОСЛЕ (не леджер);
 *  - artifact/collected причинно: causedBy = Task.causeEvent NPC (штамп D-030);
 *  - ОДНА ЕДИНИЦА ЗА ВЫЗОВ: поле со стеком дренируется по единице за тик;
 *  - НЕ подбирает: NPC в пути (dest≠loc), NPC без Task=SEARCH, поле без артефакта;
 *  - NO-OP на мире без полей (голдены Фазы 1 не двигаются);
 *  - EconomyInvariant (D-045): ArtifactSpawn рождает (леджер harvested) + ArtifactSearch
 *    переводит (0 леджера) ⇒ Σ массы артефактов == Σ item/harvested, дельта перевода 0;
 *  - ГЛАВНЫЙ ТЕСТ (закон №1): подбор идёт без участия игрока/скрипта;
 *  - RESUME (P0, закон №8): непрерывный ≡ split save/load (хэш + лог collected);
 *  - детерминизм 2× (перевод — функция состояния, без rng).
 *
 * Компоненты — модульные singleton'ы: миры идут ПОСЛЕДОВАТЕЛЬНО; финал захватывается
 * в примитивы/хэш ДО прогона следующего мира.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, ItemId, Seed, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, hasComponent, queryEntities, stampCause } from '../core/ecs';
import { AnomalyField, Position, Task, Needs, Human, Alive, TaskKind } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { ARTIFACT_SPAWN_THRESHOLD } from '../balance/ecology';
import { ArtifactSpawn } from './artifact-spawn';
import { ArtifactSearch } from './artifact-search';
import { TaskSelection } from './task-selection';

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const FIELD = AnomalyField as unknown as { charge: Float32Array; tier: Uint8Array };
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const TASK = Task as unknown as { kind: Uint8Array; causeEvent: Uint32Array };
const NEED = Needs as unknown as { hunger: Float32Array; thirst: Float32Array; fatigue: Float32Array; fear: Float32Array };

interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Наземный лут поля / инвентарь NPC (или []). */
function inv(world: SimWorld, eid: EntityId): readonly InventoryEntry[] {
  return world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
}

/** Σ qty данного item по инвентарю сущности. */
function qtyOf(world: SimWorld, eid: EntityId, item: string): number {
  let sum = 0;
  for (const e of inv(world, eid)) if (e.item === item) sum += e.qty;
  return sum;
}

/** Селит аномальное поле с готовым артефактом на луте (без запуска ArtifactSpawn). */
function placeFieldWithLoot(world: SimWorld, loc: number, loot: readonly InventoryEntry[], tier = 0): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, AnomalyField, eid);
  FIELD.charge[eid] = 0;
  FIELD.tier[eid] = tier;
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // поле неподвижно
  if (loot.length > 0) world.resources.set('inventory', eid, loot);
  return eid;
}

/** Селит пустое аномальное поле (для ArtifactSpawn-цикла). */
function placeChargingField(world: SimWorld, loc: number, charge: number, tier = 0): EntityId {
  const eid = placeFieldWithLoot(world, loc, [], tier);
  FIELD.charge[eid] = charge;
  return eid;
}

/** Селит NPC с Task=SEARCH, стоящего (dest===loc) в `loc`; опц. штамп причины. */
function placeSearcher(world: SimWorld, loc: number, cause = 0): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // стоит
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Task, eid);
  TASK.kind[eid] = TaskKind.SEARCH;
  if (cause > 0) stampCause(Task, 'causeEvent', eid, cause as EventId);
  return eid;
}

/** Планировщик из указанных систем. */
function scheduler(...systems: Parameters<ReturnType<typeof createScheduler>['register']>[0][]) {
  const s = createScheduler();
  for (const sys of systems) s.register(sys);
  return s;
}

/** Плоские строки artifact/collected (безопасны для переноса между мирами). */
interface CollectRow {
  collector: EntityId;
  field: EntityId;
  item: string;
  qty: number;
  loc: number;
  tick: number;
  causedBy: number | null;
}
function collectRows(world: SimWorld): CollectRow[] {
  return world.bus.log
    .filter((e): e is Extract<SimEvent, { type: 'artifact/collected' }> => e.type === 'artifact/collected')
    .map((e) => ({
      collector: e.payload.collector,
      field: e.payload.field,
      item: e.payload.item,
      qty: e.payload.qty,
      loc: e.payload.loc,
      tick: e.tick,
      causedBy: e.causedBy,
    }));
}

const MEDUSA = 'artifact_medusa' as ItemId;

// ─────────────────────────────────────────────────────────────────────────────
// ПЕРЕВОД: подбор одной единицы, масса сохраняется, событие причинно
// ─────────────────────────────────────────────────────────────────────────────
describe('перевод артефакта поле→NPC (закон №3: масса сохраняется, не леджер)', () => {
  it('стоящий в поле NPC с Task=SEARCH подбирает 1 единицу; поле −1, NPC +1', () => {
    const w = createSimWorld(1 as Seed);
    const field = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 2 }]);
    const npc = placeSearcher(w, 4, 777); // причина проштампована

    scheduler(ArtifactSearch).run(w, 1);

    expect(qtyOf(w, field, MEDUSA)).toBe(1); // поле опустело на единицу
    expect(qtyOf(w, npc, MEDUSA)).toBe(1); // NPC пополнился
    // artifact/collected причинно.
    const rows = collectRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.collector).toBe(npc);
    expect(rows[0]!.field).toBe(field);
    expect(rows[0]!.item).toBe(MEDUSA);
    expect(rows[0]!.qty).toBe(1);
    expect(rows[0]!.loc).toBe(4);
    expect(rows[0]!.causedBy).toBe(777); // = Task.causeEvent (штамп D-030)
  });

  it('МАССА ДО == ПОСЛЕ: Σ артефактов в мире не меняется (перевод, не леджер)', () => {
    const w = createSimWorld(2 as Seed);
    const field = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 3 }]);
    const npc = placeSearcher(w, 4);
    const massBefore = qtyOf(w, field, MEDUSA) + qtyOf(w, npc, MEDUSA);

    scheduler(ArtifactSearch).run(w, 1);

    const massAfter = qtyOf(w, field, MEDUSA) + qtyOf(w, npc, MEDUSA);
    expect(massAfter).toBe(massBefore); // масса сохранена
    // Перевод НЕ леджерится: ни одного item/* события (в отличие от рождения).
    expect(w.bus.log.filter((e) => e.type.startsWith('item/'))).toHaveLength(0);
  });

  it('ОДНА ЕДИНИЦА ЗА ВЫЗОВ: стек qty=3 дренируется по единице за тик (3 подбора)', () => {
    const w = createSimWorld(3 as Seed);
    const field = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 3 }]);
    const npc = placeSearcher(w, 4);

    scheduler(ArtifactSearch).run(w, 3); // 3 тика подряд
    expect(qtyOf(w, field, MEDUSA)).toBe(0); // поле полностью опустошено
    expect(qtyOf(w, npc, MEDUSA)).toBe(3); // всё у NPC
    expect(collectRows(w)).toHaveLength(3); // ровно 3 подбора (по одному за тик)
    // 4-й тик: лут пуст ⇒ ничего не подбирает (нет события).
    scheduler(ArtifactSearch).run(w, 1);
    expect(collectRows(w)).toHaveLength(3); // события не добавились
  });

  it('ГЛАВНЫЙ ТЕСТ (закон №1): подбор идёт БЕЗ игрока — только состояние поля/NPC', () => {
    const w = createSimWorld(4 as Seed);
    const field = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 1 }]);
    const npc = placeSearcher(w, 4);
    scheduler(ArtifactSearch).run(w, 1);
    expect(qtyOf(w, npc, MEDUSA)).toBe(1);
    expect(qtyOf(w, field, MEDUSA)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// НЕ ПОДБИРАЕТ: в пути / не SEARCH / поле без артефакта / нет полей
// ─────────────────────────────────────────────────────────────────────────────
describe('ArtifactSearch не подбирает вне контракта', () => {
  it('NPC В ПУТИ (dest≠loc) не подбирает, даже стоя формально в поле', () => {
    const w = createSimWorld(10 as Seed);
    const field = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 1 }]);
    const npc = placeSearcher(w, 4);
    POS.dest[npc] = 5; // ещё идёт (dest≠loc)
    scheduler(ArtifactSearch).run(w, 1);
    expect(qtyOf(w, field, MEDUSA)).toBe(1); // лут не тронут
    expect(collectRows(w)).toHaveLength(0);
  });

  it('NPC без Task=SEARCH (напр. FORAGE) не подбирает', () => {
    const w = createSimWorld(11 as Seed);
    const field = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 1 }]);
    const npc = placeSearcher(w, 4);
    TASK.kind[npc] = TaskKind.FORAGE; // другая задача
    scheduler(ArtifactSearch).run(w, 1);
    expect(qtyOf(w, field, MEDUSA)).toBe(1);
    expect(collectRows(w)).toHaveLength(0);
  });

  it('поле БЕЗ артефакта → нечего подбирать (нет события)', () => {
    const w = createSimWorld(12 as Seed);
    placeFieldWithLoot(w, 4, []); // пустой лут
    placeSearcher(w, 4);
    scheduler(ArtifactSearch).run(w, 1);
    expect(collectRows(w)).toHaveLength(0);
  });

  it('NO-OP на мире без полей: ничего не публикует (голдены Фазы 1 стабильны)', () => {
    const w = createSimWorld(13 as Seed);
    placeSearcher(w, 4); // NPC с SEARCH, но полей в мире нет
    scheduler(ArtifactSearch).run(w, 5);
    expect(w.bus.log.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EconomyInvariant (D-045): рождение леджерится, перевод — нет; дельта перевода 0
// ─────────────────────────────────────────────────────────────────────────────
describe('EconomyInvariant: спавн (леджер) + сбор (перевод, 0 леджера) держат массу', () => {
  it('Σ артефактов в мире == Σ item/harvested; artifact/collected массу не творит', () => {
    // Поля рождают артефакты (ArtifactSpawn леджерит harvested), стоящие рядом NPC их
    // подбирают (ArtifactSearch переводит, БЕЗ леджера). Инвариант D-045 (baseline 0):
    // прирост массы мира == дельта леджера (только harvested — единственный источник).
    const w = createSimWorld(20 as Seed);
    const CAD = ArtifactSpawn.schedule.every;
    const fA = placeChargingField(w, 4, ARTIFACT_SPAWN_THRESHOLD, 0);
    const fB = placeChargingField(w, 5, ARTIFACT_SPAWN_THRESHOLD * 2, 1);
    const nA = placeSearcher(w, 4);
    const nB = placeSearcher(w, 5);

    scheduler(ArtifactSpawn, ArtifactSearch).run(w, CAD * 30);

    // Σ массы артефактов в мире (лут полей + инвентари NPC).
    let mass = 0;
    for (const eid of [fA, fB, nA, nB]) for (const e of inv(w, eid)) mass += e.qty;

    // Σ леджера (только harvested — рождения; collected НЕ леджерится).
    let ledger = 0;
    let collectedItems = 0;
    for (const e of w.bus.log) {
      if (e.type === 'item/harvested') ledger += e.payload.qty;
      if (e.type === 'artifact/collected') collectedItems += e.payload.qty;
    }

    expect(mass).toBeGreaterThan(0); // рождения реально были
    expect(collectedItems).toBeGreaterThan(0); // подборы реально были
    expect(mass).toBe(ledger); // масса == леджер (перевод дельту не добавил, D-045)
    // Ни одного «item/*» события от сбора: единственные леджеры — от рождения.
    const harvestedRows = w.bus.log.filter((e) => e.type === 'item/harvested').length;
    expect(harvestedRows).toBe(ledger); // qty=1 на рождение ⇒ строк == суммы
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESUME (P0, закон №8): непрерывный ≡ split save/load
// ─────────────────────────────────────────────────────────────────────────────
describe('resume: непрерывный ≡ split save/load (P0, закон №8)', () => {
  it('хэш и лог artifact/collected совпадают у непрерывного и split-прогонов', () => {
    const N = 40;
    const MID = 17;
    const build = (): SimWorld => {
      const w = createSimWorld(42 as Seed);
      placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 60 }]); // большой стек дренируется по 1/тик
      placeSearcher(w, 4, 555);
      return w;
    };

    const cont = build();
    scheduler(ArtifactSearch).run(cont, N);
    const contHash = hashSnapshot(serialize(cont));
    const contRows = collectRows(cont);

    const split = build();
    scheduler(ArtifactSearch).run(split, MID);
    const resumed = deserialize(serialize(split));
    scheduler(ArtifactSearch).run(resumed, N - MID);

    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    expect(collectRows(resumed)).toEqual(contRows);
    expect(contRows.length).toBeGreaterThan(0); // прогон реально подбирал
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ДЕТЕРМИНИЗМ (закон №8): перевод — функция состояния, без rng
// ─────────────────────────────────────────────────────────────────────────────
describe('детерминизм: 2 прогона одного seed идентичны (хэш + лог collected)', () => {
  function run(seed: number): { hash: string; rows: CollectRow[] } {
    const w = createSimWorld(seed as Seed);
    placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 5 }]);
    placeFieldWithLoot(w, 5, [{ item: 'artifact_moonlight' as ItemId, qty: 3 }], 2);
    placeSearcher(w, 4, 111);
    placeSearcher(w, 5, 222);
    scheduler(ArtifactSearch).run(w, 6);
    return { hash: hashSnapshot(serialize(w)), rows: collectRows(w) };
  }
  it('seed=333: идентичный снапшот-хэш и лог artifact/collected', () => {
    const a = run(333);
    const b = run(333);
    expect(a.hash).toBe(b.hash);
    expect(a.rows).toEqual(b.rows);
    expect(a.rows.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ПОСЛЕДОВАТЕЛЬНЫЙ ПОДБОР одного тика: два NPC у одного поля видят свежий лут
// ─────────────────────────────────────────────────────────────────────────────
describe('свежий лут на каждого NPC: последовательные подборы не задваивают массу', () => {
  it('два NPC у поля со стеком 2: за тик разбирают ровно 2 единицы (по одной каждому)', () => {
    const w = createSimWorld(30 as Seed);
    const field = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 2 }]);
    const n1 = placeSearcher(w, 4);
    const n2 = placeSearcher(w, 4);
    scheduler(ArtifactSearch).run(w, 1);
    expect(qtyOf(w, field, MEDUSA)).toBe(0); // поле опустошено
    expect(qtyOf(w, n1, MEDUSA) + qtyOf(w, n2, MEDUSA)).toBe(2); // ровно 2 у людей
    expect(collectRows(w)).toHaveLength(2); // два подбора
    // Если стека не хватает на обоих — второй уходит ни с чем (масса не растёт).
    const w2 = createSimWorld(31 as Seed);
    const f2 = placeFieldWithLoot(w2, 4, [{ item: MEDUSA, qty: 1 }]); // только один артефакт
    const a = placeSearcher(w2, 4);
    const b = placeSearcher(w2, 4);
    scheduler(ArtifactSearch).run(w2, 1);
    expect(qtyOf(w2, f2, MEDUSA)).toBe(0);
    expect(qtyOf(w2, a, MEDUSA) + qtyOf(w2, b, MEDUSA)).toBe(1); // один достался, второй пуст
    expect(collectRows(w2)).toHaveLength(1);
  });

  it('стек=1, два NPC → забирает МЕНЬШИЙ eid (обход queryEntities по возрастанию), больший пуст', () => {
    // Усиление предыдущего: не только «сумма 1», но и КТО именно подобрал — детерминизм
    // порядка NPC (закон №8). Первый в обходе (min eid) видит свежий лут и забирает; к
    // моменту второго поле уже опустошено → второму нечего взять (масса не задваивается).
    const w = createSimWorld(32 as Seed);
    const field = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 1 }]);
    const first = placeSearcher(w, 4); // меньший eid — расставлен раньше
    const second = placeSearcher(w, 4); // больший eid
    expect(first).toBeLessThan(second);
    scheduler(ArtifactSearch).run(w, 1);
    expect(qtyOf(w, first, MEDUSA)).toBe(1); // забрал именно min-eid
    expect(qtyOf(w, second, MEDUSA)).toBe(0); // большему eid не досталось
    expect(qtyOf(w, field, MEDUSA)).toBe(0);
    const rows = collectRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.collector).toBe(first); // единственный подбор — у min-eid
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// МАССА МИРА ПОБИТОВО (закон №3): Σ КАЖДОГО itemId по ВСЕМ eid ДО == ПОСЛЕ.
// Сильнее, чем «сумма по одному полю+NPC»: сверяем ВЕСЬ мультимножество мира —
// перевод не имеет права ни создать, ни потерять, ни ПОДМЕНИТЬ ни одну единицу.
// ─────────────────────────────────────────────────────────────────────────────
describe('масса мира сохраняется побитово: мультимножество Σ(itemId) ДО==ПОСЛЕ (не faucet)', () => {
  /** Σ qty по КАЖДОМУ item по ВСЕМ eid мира (лут полей + инвентари NPC). */
  function worldItemTotals(world: SimWorld): Map<string, number> {
    const acc = new Map<string, number>();
    for (const [, list] of world.resources.entries<readonly InventoryEntry[]>('inventory')) {
      for (const e of list) acc.set(e.item, (acc.get(e.item) ?? 0) + e.qty);
    }
    return acc;
  }

  it('несколько полей (смешанный лут: артефакты + не-артефакт) + несколько NPC: Σ мира неподвижна', () => {
    const w = createSimWorld(40 as Seed);
    const MOON = 'artifact_moonlight' as ItemId;
    const STONE = 'artifact_stone_flower' as ItemId;
    const AMMO = 'ammo_9mm' as ItemId; // НЕ артефакт — обязан остаться на поле нетронутым
    // Поле A: два вида артефактов + патроны (не-артефакт); поле B и C — по одному виду.
    const fA = placeFieldWithLoot(w, 4, [{ item: AMMO, qty: 5 }, { item: MEDUSA, qty: 2 }, { item: MOON, qty: 1 }]);
    placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 1 }]); // второе поле той же loc
    placeFieldWithLoot(w, 5, [{ item: STONE, qty: 3 }]);
    placeSearcher(w, 4);
    placeSearcher(w, 4);
    placeSearcher(w, 5);

    const before = worldItemTotals(w);
    scheduler(ArtifactSearch).run(w, 12); // дренаж по 1/тик, с запасом на полное опустошение
    const after = worldItemTotals(w);

    // Побитовое равенство мультимножеств: ключи и значения совпадают до единицы.
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    // Ни одного ledger-события массы от перевода (в отличие от рождения ArtifactSpawn).
    expect(w.bus.log.filter((e) => e.type.startsWith('item/'))).toHaveLength(0);
    // Подборы реально шли, и НЕ-артефакт (патроны) не сдвинулся с поля ни на единицу.
    expect(collectRows(w).length).toBeGreaterThan(0);
    expect(qtyOf(w, fA, AMMO)).toBe(5); // pickArtifact фильтрует по kind — патроны не берутся
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ПОЛИТИКА ВЫБОРА: min-itemId среди kind=artifact; min-eid поле-носитель.
// ─────────────────────────────────────────────────────────────────────────────
describe('политика выбора: min-itemId (только артефакты) и min-eid поле', () => {
  it('поле {ammo, moonlight, medusa}: дренаж medusa→moonlight (min-itemId), патроны нетронуты', () => {
    // itemId-порядок: ammo_9mm < artifact_medusa < artifact_moonlight. Наивный min-id
    // взял бы патроны — но pickArtifact СНАЧАЛА фильтрует kind==='artifact', поэтому
    // выбирается medusa (мин. среди артефактов), затем moonlight; патроны остаются.
    const w = createSimWorld(41 as Seed);
    const MOON = 'artifact_moonlight' as ItemId;
    const AMMO = 'ammo_9mm' as ItemId;
    const field = placeFieldWithLoot(w, 4, [{ item: AMMO, qty: 5 }, { item: MEDUSA, qty: 2 }, { item: MOON, qty: 1 }]);
    const npc = placeSearcher(w, 4);

    scheduler(ArtifactSearch).run(w, 3); // 3 артефакта → 3 подбора
    const rows = collectRows(w);
    expect(rows.map((r) => r.item)).toEqual([MEDUSA, MEDUSA, MOON]); // порядок: min-itemId раньше
    expect(qtyOf(w, npc, MEDUSA)).toBe(2);
    expect(qtyOf(w, npc, MOON)).toBe(1);
    expect(qtyOf(w, field, AMMO)).toBe(5); // не-артефакт остаётся на поле
    expect(qtyOf(w, npc, AMMO)).toBe(0); // и не переезжает к NPC
  });

  it('два поля одной loc с артефактом → дренируется поле с МЕНЬШИМ eid первым', () => {
    const w = createSimWorld(42 as Seed);
    const low = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 1 }]); // расставлено раньше — min eid
    const high = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 1 }]);
    expect(low).toBeLessThan(high);
    const npc = placeSearcher(w, 4);

    scheduler(ArtifactSearch).run(w, 1);
    expect(qtyOf(w, low, MEDUSA)).toBe(0); // min-eid поле опустело первым
    expect(qtyOf(w, high, MEDUSA)).toBe(1); // большего eid ещё не коснулись
    expect(collectRows(w)[0]!.field).toBe(low);
  });

  it('min-eid поле ПУСТО, старший eid держит артефакт → подбор с непустого (пустое пропущено)', () => {
    const w = createSimWorld(43 as Seed);
    const empty = placeFieldWithLoot(w, 4, []); // min eid, но лута нет
    const full = placeFieldWithLoot(w, 4, [{ item: MEDUSA, qty: 1 }]);
    expect(empty).toBeLessThan(full);
    const npc = placeSearcher(w, 4);

    scheduler(ArtifactSearch).run(w, 1);
    expect(qtyOf(w, npc, MEDUSA)).toBe(1);
    expect(qtyOf(w, full, MEDUSA)).toBe(0);
    expect(collectRows(w)[0]!.field).toBe(full); // носитель — непустое поле, а не min-eid
  });

  it('NPC в loc БЕЗ поля (поля есть, но в другой loc) → сбора нет, масса неподвижна', () => {
    const w = createSimWorld(44 as Seed);
    const field = placeFieldWithLoot(w, 5, [{ item: MEDUSA, qty: 1 }]); // поле в loc5
    const npc = placeSearcher(w, 4); // NPC стоит в loc4 — там поля нет
    scheduler(ArtifactSearch).run(w, 3);
    expect(qtyOf(w, field, MEDUSA)).toBe(1); // лут поля цел
    expect(qtyOf(w, npc, MEDUSA)).toBe(0);
    expect(collectRows(w)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ИНТЕГРАЦИЯ TaskSelection + ArtifactSearch: «сталкер нашёл поле, вычистил его,
// пошёл дальше». SEARCH держится ПОКА лут есть; поле пустеет → перевыбор ДРУГОЙ
// валидной задачи (не idle, закон №4). Полный причинный цикл без игрока (закон №1).
// ─────────────────────────────────────────────────────────────────────────────
describe('цикл SEARCH: держится пока лут есть, поле пустеет → перевыбор (не idle, закон №4)', () => {
  const DAY_TICK = 600 as Tick; // светлое время: SEARCH разрешён (не ночь)

  /** Спокойный живой Human с Needs (все нужды 0), стоящий в `loc`. */
  function placeCalmNpc(world: SimWorld, loc: number): EntityId {
    const eid = spawnEntity(world.ecs);
    addComponent(world.ecs, Position, eid);
    POS.loc[eid] = loc;
    POS.dest[eid] = loc;
    addComponent(world.ecs, Needs, eid);
    NEED.hunger[eid] = 0;
    NEED.thirst[eid] = 0;
    NEED.fatigue[eid] = 0;
    NEED.fear[eid] = 0;
    addComponent(world.ecs, Human, eid);
    addComponent(world.ecs, Alive, eid);
    return eid; // Task навесит сама TaskSelection
  }

  it('поле в loc0 со стеком 2: SEARCH два тика, затем поле пусто → DRINK; Task есть всё время', () => {
    const w = createSimWorld(50 as Seed);
    // Кордон (loc0): вода есть, безопасно. У спокойного NPC днём SEARCH (0.7·0.95)
    // бьёт DRINK/SLEEP-фоллбэки — пока на поле лежит артефакт.
    const field = placeFieldWithLoot(w, 0, [{ item: MEDUSA, qty: 2 }]);
    const npc = placeCalmNpc(w, 0);
    const sched = scheduler(TaskSelection, ArtifactSearch); // выбор ДО исполнения (D-032)

    // Тик 1: выбирает SEARCH и подбирает первую единицу (поле 2→1).
    w.tick = DAY_TICK;
    sched.tickOnce(w);
    expect(TASK.kind[npc]).toBe(TaskKind.SEARCH);
    expect(qtyOf(w, field, MEDUSA)).toBe(1);
    expect(qtyOf(w, npc, MEDUSA)).toBe(1);

    // Тик 2: поле ещё не пусто ⇒ SEARCH держится, вторая единица уходит (поле 1→0).
    w.tick = DAY_TICK;
    sched.tickOnce(w);
    expect(TASK.kind[npc]).toBe(TaskKind.SEARCH);
    expect(qtyOf(w, field, MEDUSA)).toBe(0);
    expect(qtyOf(w, npc, MEDUSA)).toBe(2);

    // Тик 3: поле пусто ⇒ artifactFieldLocs пуст ⇒ SEARCH выпадает (−∞); NPC не idle
    // (закон №4) — перевыбирает валидную задачу (у воды в Кордоне это DRINK).
    w.tick = DAY_TICK;
    sched.tickOnce(w);
    expect(hasComponent(w.ecs, Task, npc)).toBe(true); // не idle
    expect(TASK.kind[npc]).not.toBe(TaskKind.SEARCH); // от вычищенного поля отцепился
    expect(TASK.kind[npc]).toBe(TaskKind.DRINK); // конкретный перевыбор при этих весах
    // Больше подборов нет: ровно 2 artifact/collected за весь цикл.
    expect(collectRows(w)).toHaveLength(2);
    // Причинность: каждый подбор проштампован причиной задачи SEARCH (не null-корень).
    for (const r of collectRows(w)) expect(r.causedBy).not.toBeNull();
  });
});
