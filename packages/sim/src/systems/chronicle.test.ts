/**
 * @module @zona/sim/systems/chronicle.test
 *
 * Гейт Chronicle (задача 3.2, D-068) — ЛЕТОПИСЬ МИРА как read-time проекция лога. Покрывает
 * контракт D-068 СИНТЕТИЧЕСКИ (инъекция событий в лог + прямой вызов Chronicle.update, как
 * тесты RobberyMemory D-063):
 *  - значимость >= порога → chronicle/recorded с правильными eventId/day/kind/subjects/loc/
 *    causedBy; ниже порога → нет записи;
 *  - fame-петля: субъекты растут на FAME_PER_CHRONICLE; повторная запись → выше будущая значимость;
 *  - реактивное окно at(tick−1): событие тика T записывается на T+1, не раньше и не дважды;
 *  - нет петли «запись о записи» (chronicle/recorded сам не записывается);
 *  - chronicle(bus) фильтрует летопись; unrollCauses раскручивает причинную цепочку;
 *  - read-time (не хранит состояние) ⇒ resume ≡ continuous; синтетический прогон детерминирован;
 *  - изоляция: incFame двигает ТОЛЬКО ключ 'fame' (EconomyInvariant не затронут); tick=0 no-op.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, ItemId, LocationId, Seed, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import type { SystemCtx } from '../core/system';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { getFame, significance, FAME_KEY } from '../narrative/significance';
import { entitySubject } from './memory';
import { Chronicle, chronicle, unrollCauses } from './chronicle';
import { CHRONICLE_THRESHOLD, FAME_PER_CHRONICLE } from '../balance/narrative';
import { TICKS_PER_DAY } from '../balance/time';

const LOC = 4 as LocationId;

/** Ручной ctx для прямого вызова Chronicle.update на тике `tick` (как в robbery-memory.test). */
function ctxAt(world: SimWorld, tick: number): SystemCtx {
  world.tick = tick as Tick;
  return {
    world,
    bus: world.bus,
    rng: world.rng.fork(`Chronicle@${tick}`),
    tick: tick as Tick,
  };
}

/**
 * Гоняет Chronicle на тике `tick` И КОММИТИТ его записи в лог (endTick): Chronicle публикует
 * `chronicle/recorded` в буфер текущего тика, а `bus.log`/`chronicle(bus)` видят лишь
 * ЗАКОММИЧЕННОЕ — как это делает планировщик в конце тика (D-005). endTick на пустом буфере
 * идемпотентен (тик без значимых событий).
 */
function runChronicle(world: SimWorld, tick: number): void {
  Chronicle.update(ctxAt(world, tick));
  world.bus.endTick(tick as Tick);
}

/** Публикует событие на тике `tick` и коммитит его в лог; возвращает выданный id. */
function commit(world: SimWorld, tick: number, e: Omit<SimEvent, 'id' | 'tick'>): EventId {
  world.tick = tick as Tick;
  const idv = world.bus.publish(e as never);
  world.bus.endTick(tick as Tick);
  return idv;
}

/** Смерть NPC с именем (significance = DEATH_NPC_WEIGHT 0.48 >= порога). */
function diedNpc(eid: EntityId, killer?: EntityId): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'entity/died',
    causedBy: null,
    payload: killer === undefined
      ? { eid, name: 'Сидоров', cause: 'combat' }
      : { eid, name: 'Сидоров', cause: 'combat', killer },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/** Рутинная сделка (significance 0.06 < порога). */
function tradeRoutine(buyer: EntityId, seller: EntityId): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'trade/executed',
    causedBy: null,
    payload: { buyer, seller, item: 'ammo' as ItemId, qty: 1, price: 10, money: 10 },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/** chronicle/recorded события лога. */
function records(world: SimWorld): Extract<SimEvent, { type: 'chronicle/recorded' }>[] {
  return world.bus.log.filter((e) => e.type === 'chronicle/recorded') as Extract<
    SimEvent,
    { type: 'chronicle/recorded' }
  >[];
}

/** Заброшенность поселения (значимость = SETTLEMENT_ABANDONED_WEIGHT 1.0 — ЯКОРЬ-МАКСИМУМ). */
function settlementAbandoned(settlement: EntityId): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'settlement/abandoned',
    causedBy: null,
    payload: { settlement, reason: 'провизия кончилась, мораль упала до нуля' },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/**
 * Рождение артефакта аномальным полем. `tier` задаёт значимость: base 0.30 + tier·0.08. НЕ несёт
 * участников (participantsOf по нему пуст) ⇒ субъекты записи пусты, а лифта по fame нет — идеально
 * для проверки «граница ровно на пороге» дробным tier'ом.
 */
function artifactSpawned(tier: number, loc: LocationId): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'artifact/spawned',
    causedBy: null,
    payload: { field: 7 as EntityId, item: 'art' as ItemId, tier, loc },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/**
 * Суммарная МАССА мира (Σ 'money' + Σ 'inventory'.qty по item, по всем eid) — реплика worldTotals
 * (D-045). Считаем ЛОКАЛЬНО, чтобы /sim не тянул зависимость на /headless (закон №5): нужен лишь
 * факт «летопись массу не двигает». `fame` (ключ 'fame') в сумму НЕ входит по построению — он не
 * 'money' и не 'inventory'. Детерминизм суммы не зависит от порядка (целые).
 */
function worldMass(world: SimWorld): { money: number; items: ReadonlyMap<ItemId, number> } {
  let money = 0;
  for (const [, m] of world.resources.entries<number>('money')) money += m;
  const items = new Map<ItemId, number>();
  for (const [, inv] of world.resources.entries<readonly { item: ItemId; qty: number }[]>(
    'inventory',
  )) {
    for (const e of inv) items.set(e.item, (items.get(e.item) ?? 0) + e.qty);
  }
  return { money, items };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('Chronicle: значимое событие → запись летописи (D-068)', () => {
  it('смерть NPC (sig>=порог) даёт chronicle/recorded с eventId/day/kind/subjects/causedBy', () => {
    const w = createSimWorld(1 as Seed);
    const victim = 5 as EntityId;
    const killer = 8 as EntityId;
    const diedId = commit(w, 2 * TICKS_PER_DAY + 10, diedNpc(victim, killer)); // день 2

    runChronicle(w, 2 * TICKS_PER_DAY + 11);

    const recs = records(w);
    expect(recs).toHaveLength(1);
    const p = recs[0]!.payload;
    expect(p.eventId).toBe(diedId);
    expect(recs[0]!.causedBy).toBe(diedId); // значимое событие — причина своей записи (D-030)
    expect(p.kind).toBe('entity/died');
    expect(p.day).toBe(2); // floor(tick / TICKS_PER_DAY)
    expect(p.significance).toBeGreaterThanOrEqual(CHRONICLE_THRESHOLD);
    // Субъекты — участники (жертва+убийца), закодированы Subject, сорт.+уникальны.
    expect(p.subjects).toEqual([entitySubject(victim), entitySubject(killer)]);
    expect(p.loc).toBeUndefined(); // entity/died локацию не несёт
  });

  it('рутинная сделка (sig<порог) НЕ попадает в летопись', () => {
    const w = createSimWorld(2 as Seed);
    commit(w, 10, tradeRoutine(2 as EntityId, 3 as EntityId));
    runChronicle(w, 11);
    expect(records(w)).toEqual([]);
  });

  it('пространственное событие (грабёж) несёт loc в записи', () => {
    // loot/transferred sig 0.28 < порога — сам не пишется; берём encounter/started с loc,
    // но его sig 0.30 < 0.4 тоже. Значимое пространственное — artifact/spawned высокого tier.
    const w = createSimWorld(3 as Seed);
    // artifact/spawned tier 2: base 0.30 + 2*0.08 = 0.46 >= порога, несёт loc.
    const evId = commit(w, 5, {
      type: 'artifact/spawned',
      causedBy: null,
      payload: { field: 7 as EntityId, item: 'art' as ItemId, tier: 2, loc: LOC },
    } as Omit<SimEvent, 'id' | 'tick'>);

    runChronicle(w, 6);

    const recs = records(w);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.payload.eventId).toBe(evId);
    expect(recs[0]!.payload.loc).toBe(LOC);
  });
});

describe('Chronicle: fame-петля (§10.2, D-067)', () => {
  it('субъекты записи растут на FAME_PER_CHRONICLE; повтор → выше будущая значимость', () => {
    const w = createSimWorld(4 as Seed);
    const victim = 5 as EntityId;

    // База: до записей fame = 0, значимость смерти = чистый DEATH_NPC_WEIGHT.
    const baseSig = significance(
      { ...diedNpc(victim), id: 99 as EventId, tick: 0 as Tick } as SimEvent,
      w,
    );
    expect(getFame(w.resources, victim)).toBe(0);

    // Первая запись → fame += FAME_PER_CHRONICLE.
    commit(w, 10, diedNpc(victim));
    runChronicle(w, 11);
    expect(getFame(w.resources, victim)).toBe(FAME_PER_CHRONICLE);

    // Вторая запись про того же субъекта → fame += ещё FAME_PER_CHRONICLE.
    commit(w, 20, diedNpc(victim));
    runChronicle(w, 21);
    expect(getFame(w.resources, victim)).toBe(2 * FAME_PER_CHRONICLE);

    // ОБРАТНАЯ СВЯЗЬ: будущая значимость смерти этого субъекта теперь ВЫШЕ базовой (лифт по fame).
    const liftedSig = significance(
      { ...diedNpc(victim), id: 99 as EventId, tick: 0 as Tick } as SimEvent,
      w,
    );
    expect(liftedSig).toBeGreaterThan(baseSig);
  });

  it('несколько субъектов записи — каждый растёт РОВНО раз (дедуп)', () => {
    const w = createSimWorld(5 as Seed);
    const victim = 5 as EntityId;
    const killer = 8 as EntityId;
    commit(w, 10, diedNpc(victim, killer));
    runChronicle(w, 11);
    expect(getFame(w.resources, victim)).toBe(FAME_PER_CHRONICLE);
    expect(getFame(w.resources, killer)).toBe(FAME_PER_CHRONICLE);
  });
});

describe('Chronicle: реактивное окно at(tick−1) (закон №6, D-005)', () => {
  it('событие тика T записывается на T+1, не раньше и не дважды; tick=0 no-op', () => {
    const w = createSimWorld(6 as Seed);
    const victim = 5 as EntityId;

    // tick=0 — окна прошлого тика нет.
    expect(() => Chronicle.update(ctxAt(w, 0))).not.toThrow();

    commit(w, 10, diedNpc(victim));
    // На тике 10 (совпадает с событием) — ещё не «прошлый тик».
    runChronicle(w, 10);
    expect(records(w)).toHaveLength(0);
    // На тике 11 — ровно раз.
    runChronicle(w, 11);
    expect(records(w)).toHaveLength(1);
    // На тике 12 — окно (at(11)) НЕ содержит смерти (только запись); повтора нет.
    runChronicle(w, 12);
    expect(records(w)).toHaveLength(1);
  });
});

describe('Chronicle: нет петли «запись о записи»', () => {
  it('chronicle/recorded сам не порождает запись (страж + вес 0)', () => {
    const w = createSimWorld(7 as Seed);
    const victim = 5 as EntityId;
    commit(w, 10, diedNpc(victim));
    runChronicle(w, 11); // запись сделана и закоммичена на тике 11
    // На тике 12 читаем закоммиченный тик 11 (там chronicle/recorded) — новой записи НЕТ.
    runChronicle(w, 12);
    expect(records(w)).toHaveLength(1);
  });
});

describe('Chronicle: read-time летопись и раскрутка причин (§10.1, D-068)', () => {
  it('chronicle(bus) фильтрует летопись; unrollCauses раскручивает цепочку событие→причина', () => {
    const w = createSimWorld(8 as Seed);
    // Причинная цепочка: encounter/started (корень) → encounter/resolved (causedBy started).
    w.tick = 10 as Tick;
    const startedId = w.bus.publish({
      type: 'encounter/started',
      causedBy: null,
      payload: { sides: [[1 as EntityId], [2 as EntityId]], loc: LOC },
    } as never);
    const resolvedId = w.bus.publish({
      type: 'encounter/resolved',
      causedBy: startedId,
      payload: { winnerSide: 0, casualties: [2 as EntityId], ammoSpent: [] },
    } as never);
    w.bus.endTick(10 as Tick);

    runChronicle(w, 11);

    // Летопись: одна запись (resolved 0.42+0.06 >= порог; started 0.30 < порог — не пишется).
    const entries = chronicle(w.bus);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.eventId).toBe(resolvedId);
    expect(entries[0]!.kind).toBe('encounter/resolved');
    expect(entries[0]!.subjects).toEqual([entitySubject(2 as EntityId)]); // casualties

    // Раскрутка причин от записи: запись → resolved → started → корень.
    const chain = unrollCauses(w.bus, entries[0]!.recordId);
    expect(chain).toEqual([entries[0]!.recordId, resolvedId, startedId]);
  });

  it('unrollCauses на несуществующем id → []', () => {
    const w = createSimWorld(9 as Seed);
    expect(unrollCauses(w.bus, 999 as EventId)).toEqual([]);
  });
});

describe('Chronicle: детерминизм и resume ≡ continuous (закон №8, read-time не хранит)', () => {
  it('два прогона одного сценария → идентичные летопись и fame', () => {
    function run(seed: number): { recs: number; fame: number } {
      const w = createSimWorld(seed as Seed);
      const victim = 5 as EntityId;
      commit(w, 10, diedNpc(victim));
      runChronicle(w, 11);
      return { recs: records(w).length, fame: getFame(w.resources, victim) };
    }
    expect(run(42)).toEqual(run(42));
  });

  it('непрерывный прогон === split через save/load (запись в логе + fame в resources)', () => {
    function build(seed: number): SimWorld {
      const w = createSimWorld(seed as Seed);
      commit(w, 10, diedNpc(5 as EntityId, 8 as EntityId));
      return w;
    }
    // Непрерывно: запись на тике 11, коммит.
    const cont = build(0);
    runChronicle(cont, 11);

    // Split: событие на тике 10, save/load, затем запись на тике 11 на восстановленном мире.
    const split = build(0);
    const restored = deserialize(serialize(split));
    runChronicle(restored, 11);

    expect(hashSnapshot(serialize(restored))).toBe(hashSnapshot(serialize(cont)));
  });
});

describe('Chronicle: изоляция — incFame двигает только ключ fame (EconomyInvariant не затронут)', () => {
  it('после записи есть ТОЛЬКО ключ fame; money/inventory не появились', () => {
    const w = createSimWorld(10 as Seed);
    commit(w, 10, diedNpc(5 as EntityId));
    runChronicle(w, 11);
    // Единственный ресурсный ключ, который тронула летопись, — 'fame' (дизъюнктен money/inventory).
    expect(w.resources.keys()).toEqual([FAME_KEY]);
  });

  it('нет значимых событий в окне ⇒ полный no-op (0 записей, 0 fame-ключей)', () => {
    const w = createSimWorld(11 as Seed);
    commit(w, 10, tradeRoutine(2 as EntityId, 3 as EntityId)); // ниже порога
    runChronicle(w, 11);
    expect(records(w)).toEqual([]);
    expect(w.resources.keys()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ 3.2 (QA): граница порога, якорь-поселение, пустые субъекты, закон №3
// через worldTotals, детерминизм записей, обрыв причинной цепочки.
// ═══════════════════════════════════════════════════════════════════════════

describe('Chronicle: порог ВКЛЮЧИТЕЛЬНЫЙ — событие РОВНО на 0.4 попадает в летопись', () => {
  it('artifact/spawned tier 1.25 даёт significance == CHRONICLE_THRESHOLD и пишется (>=, не >)', () => {
    const w = createSimWorld(20 as Seed);
    // base 0.30 + 1.25·0.08 = 0.40 ровно; событие без участников ⇒ лифта по fame нет.
    const ev = artifactSpawned(1.25, LOC);
    // Премиса границы: значимость РОВНО на пороге (иначе тест не про границу).
    expect(significance({ ...ev, id: 1 as EventId, tick: 0 as Tick } as SimEvent, w)).toBe(
      CHRONICLE_THRESHOLD,
    );

    const evId = commit(w, 5, ev);
    runChronicle(w, 6);

    const recs = records(w);
    expect(recs).toHaveLength(1); // ровно на пороге ⇒ ВНУТРИ летописи (порог включительный)
    expect(recs[0]!.payload.eventId).toBe(evId);
    expect(recs[0]!.payload.significance).toBe(CHRONICLE_THRESHOLD);
  });

  it('artifact/spawned tier 1.2 (significance 0.396 < порога) остаётся за бортом', () => {
    const w = createSimWorld(21 as Seed);
    const ev = artifactSpawned(1.2, LOC); // 0.30 + 1.2·0.08 = 0.396
    // Премиса: строго НИЖЕ порога — на волосок, чтобы поймать `<` vs `<=`.
    expect(significance({ ...ev, id: 1 as EventId, tick: 0 as Tick } as SimEvent, w)).toBeLessThan(
      CHRONICLE_THRESHOLD,
    );

    commit(w, 5, ev);
    runChronicle(w, 6);
    expect(records(w)).toEqual([]); // чуть ниже порога — не драма, мимо летописи
  });
});

describe('Chronicle: якорь-максимум — гибель поселения всегда в летописи (GDD §10.2)', () => {
  it('settlement/abandoned (sig 1.0) → ровно одна запись; поселение-eid получает fame', () => {
    const w = createSimWorld(22 as Seed);
    const town = 42 as EntityId;
    const abandonId = commit(w, 3 * TICKS_PER_DAY, settlementAbandoned(town));

    runChronicle(w, 3 * TICKS_PER_DAY + 1);

    const recs = records(w);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.payload.kind).toBe('settlement/abandoned');
    expect(recs[0]!.payload.day).toBe(3); // событие ровно в начале дня 3
    expect(recs[0]!.payload.subjects).toEqual([entitySubject(town)]); // поселение — субъект-eid
    // Петля §10.2 работает и для поселения (это тоже eid, D-046), не только для NPC.
    expect(getFame(w.resources, town)).toBe(FAME_PER_CHRONICLE);
  });
});

describe('Chronicle: значимое событие БЕЗ участников → subjects пуст, но запись есть', () => {
  it('artifact/spawned высокого tier пишется c пустыми subjects и НЕ трогает fame', () => {
    const w = createSimWorld(23 as Seed);
    // tier 2: 0.30 + 2·0.08 = 0.46 >= порога; participantsOf(artifact/spawned) = [] (по контракту).
    commit(w, 5, artifactSpawned(2, LOC));
    runChronicle(w, 6);

    const recs = records(w);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.payload.subjects).toEqual([]); // некого возвеличивать
    // Нет субъектов ⇒ incFame ни разу не звался ⇒ ключа 'fame' в мире не возникло.
    expect(w.resources.keys()).toEqual([]);
  });

  it('субъекты записи — ВСЕГДА сущности "e:…", летопись не выдумывает фракции "f:…"', () => {
    const w = createSimWorld(24 as Seed);
    w.tick = 7 as Tick;
    // Разнородный тик: смерть с убийцей, грабёж-исход, гибель поселения.
    w.bus.publish(diedNpc(5 as EntityId, 8 as EntityId) as never);
    w.bus.publish(settlementAbandoned(42 as EntityId) as never);
    w.bus.publish({
      type: 'encounter/resolved',
      causedBy: null,
      payload: { winnerSide: 0, casualties: [2 as EntityId], ammoSpent: [] },
    } as never);
    w.bus.endTick(7 as Tick);

    runChronicle(w, 8);

    const allSubjects = records(w).flatMap((r) => r.payload.subjects);
    expect(allSubjects.length).toBeGreaterThan(0);
    // Chronicle кодирует участников ТОЛЬКО как сущности (entitySubject); фракции fame не получают.
    for (const s of allSubjects) expect(s.startsWith('e:')).toBe(true);
  });
});

describe('Chronicle: закон №3 — летопись не творит массу (worldTotals неизменны, fame дизъюнктен)', () => {
  it('после прогона с записями Σденег и Σпредметов мира не сдвинулись; fame отдельно', () => {
    const w = createSimWorld(25 as Seed);
    // Даём миру реальную массу на посторонних eid — эталон, который летопись НЕ должна двигать.
    w.resources.set<number>('money', 100 as EntityId, 500);
    w.resources.set<readonly { item: ItemId; qty: number }[]>('inventory', 101 as EntityId, [
      { item: 'ammo' as ItemId, qty: 7 },
      { item: 'bread' as ItemId, qty: 3 },
    ]);
    const before = worldMass(w);

    // Значимое событие → запись + incFame субъектам (victim+killer).
    commit(w, 10, diedNpc(5 as EntityId, 8 as EntityId));
    runChronicle(w, 11);
    expect(records(w)).toHaveLength(1);
    expect(getFame(w.resources, 5 as EntityId)).toBe(FAME_PER_CHRONICLE); // петля сработала

    const after = worldMass(w);
    // EconomyInvariant по смыслу: масса без леджер-события не меняется. Летопись массу не леджерит.
    expect(after.money).toBe(before.money);
    expect(after.items).toEqual(before.items);
    // fame живёт в ключе 'fame' — он НЕ входит в worldTotals (money/inventory), закон №3 цел.
    expect(w.resources.keys()).toEqual(['fame', 'inventory', 'money']);
  });
});

describe('Chronicle: день выводится из тика (day = floor(tick / TICKS_PER_DAY))', () => {
  it('событие на последнем тике дня 2 → day 2; на первом тике дня 3 → day 3', () => {
    const lastOfDay2 = 3 * TICKS_PER_DAY - 1;
    const firstOfDay3 = 3 * TICKS_PER_DAY;

    const wA = createSimWorld(26 as Seed);
    commit(wA, lastOfDay2, diedNpc(5 as EntityId));
    runChronicle(wA, lastOfDay2 + 1);
    expect(records(wA)[0]!.payload.day).toBe(2);

    const wB = createSimWorld(27 as Seed);
    commit(wB, firstOfDay3, diedNpc(5 as EntityId));
    runChronicle(wB, firstOfDay3 + 1);
    expect(records(wB)[0]!.payload.day).toBe(3);
  });
});

describe('Chronicle: детерминизм записей и read-time проекция переживает save/load', () => {
  it('два независимых прогона одного сценария → ПОБИТОВО одинаковая летопись', () => {
    function scenario(seed: number): readonly unknown[] {
      const w = createSimWorld(seed as Seed);
      w.tick = 12 as Tick;
      w.bus.publish(diedNpc(5 as EntityId, 8 as EntityId) as never);
      w.bus.publish(settlementAbandoned(42 as EntityId) as never);
      w.bus.publish(artifactSpawned(2, LOC) as never);
      w.bus.endTick(12 as Tick);
      runChronicle(w, 13);
      return chronicle(w.bus).map((e) => ({
        eventId: e.eventId,
        day: e.day,
        kind: e.kind,
        subjects: e.subjects,
        loc: e.loc,
        significance: e.significance,
      }));
    }
    // Один seed для обоих: одинаковая история ⇒ одинаковая летопись (закон №8).
    expect(scenario(99)).toEqual(scenario(99));
  });

  it('chronicle(bus) после save/load посреди прогона ≡ непрерывному (записи живут в логе)', () => {
    function build(seed: number): SimWorld {
      const w = createSimWorld(seed as Seed);
      w.tick = 10 as Tick;
      w.bus.publish(diedNpc(5 as EntityId, 8 as EntityId) as never);
      w.bus.publish(settlementAbandoned(42 as EntityId) as never);
      w.bus.endTick(10 as Tick);
      return w;
    }
    const cont = build(0);
    runChronicle(cont, 11);

    const split = deserialize(serialize(build(0)));
    runChronicle(split, 11);

    // Летопись — не отдельный стор, а фильтр лога ⇒ resume отдаёт те же строки, что continuous.
    expect(chronicle(split.bus)).toEqual(chronicle(cont.bus));
  });
});

describe('Chronicle: unrollCauses — раскрутка причин конечна, монотонна и переживает обрыв', () => {
  it('id вдоль цепочки СТРОГО убывают (причина всегда раньше следствия)', () => {
    const w = createSimWorld(28 as Seed);
    w.tick = 10 as Tick;
    const startedId = w.bus.publish({
      type: 'encounter/started',
      causedBy: null,
      payload: { sides: [[1 as EntityId], [2 as EntityId]], loc: LOC },
    } as never);
    const resolvedId = w.bus.publish({
      type: 'encounter/resolved',
      causedBy: startedId,
      payload: { winnerSide: 0, casualties: [2 as EntityId], ammoSpent: [] },
    } as never);
    w.bus.endTick(10 as Tick);
    runChronicle(w, 11);

    const chain = unrollCauses(w.bus, records(w)[0]!.id);
    // запись → resolved → started: каждый следующий id строго меньше предыдущего ⇒ прогресс, нет циклов.
    for (let i = 1; i < chain.length; i++) expect(chain[i]!).toBeLessThan(chain[i - 1]!);
    expect(chain[chain.length - 1]).toBe(startedId); // упирается в корень цепочки
  });

  it('оборванная причина (causedBy указывает на id вне лога) → цепочка обрывается, без зацикливания', () => {
    const w = createSimWorld(29 as Seed);
    const phantom = 999999 as EventId; // id, которого в логе нет (напр. сгорел после discardTick)
    w.tick = 10 as Tick;
    const orphanId = w.bus.publish({
      type: 'encounter/resolved',
      causedBy: phantom,
      payload: { winnerSide: 0, casualties: [2 as EntityId], ammoSpent: [] },
    } as never);
    w.bus.endTick(10 as Tick);

    // Раскрутка доходит до самого события и обрывается на отсутствующей причине — не виснет.
    expect(unrollCauses(w.bus, orphanId)).toEqual([orphanId]);
  });
});
