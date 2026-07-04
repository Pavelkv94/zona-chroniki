/**
 * @module @zona/sim/narrative/significance.test
 *
 * Гейт ЗНАЧИМОСТИ + fame (задача 3.1, D-067). Покрывает контракт D-067:
 *  - significance ДЕТЕРМИНИРОВАНА (тот же ev+мир → то же число) и всегда ∈ [0..1];
 *  - веса по типам: заброшенность поселения = МАКС (1.0); смерть NPC > рутинного trade;
 *    смерть NPC > смерти животного; артефакт растёт со ступенью (tier);
 *  - масштаб по fame: жертва с высоким fame → значимее анонима; самый известный участник;
 *  - неизвестный/шумовой тип → низкий вес БЕЗ throw; служебные события ~0;
 *  - getFame(нет записи)=0; incFame МОНОТОНЕН, клампится CAP, пишет НОВЫМ значением (D-035);
 *  - fame round-trip через serialize/deserialize (автосериализуется как money, D-050).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, Seed, Tick, ItemId, LocationId, SimEvent } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity } from '../core/ecs';
import { serialize, deserialize } from '../core/snapshot';
import { significance, getFame, incFame, FAME_KEY } from './significance';
import { FAME_CAP } from '../balance/narrative';

/** Сырое число → branded EntityId. */
const id = (n: number): EntityId => n as EntityId;

/** Собирает событие с общей «шапкой» (id/tick/causedBy) заданного типа+payload. */
function ev<T extends SimEvent>(partial: Omit<T, 'id' | 'tick' | 'causedBy'> & Partial<SimEvent>): T {
  return {
    id: 1 as EventId,
    tick: 0 as Tick,
    causedBy: null,
    ...partial,
  } as T;
}

function freshWorld(): SimWorld {
  return createSimWorld(7 as Seed);
}

// Готовые события для тестов весов (payload минимально валиден).
const deathNpc = ev<Extract<SimEvent, { type: 'entity/died' }>>({
  type: 'entity/died',
  payload: { eid: id(5), name: 'Сидорович', cause: 'combat' },
});
const deathAnon = ev<Extract<SimEvent, { type: 'entity/died' }>>({
  type: 'entity/died',
  payload: { eid: id(5), cause: 'combat' }, // без name → аноним/зверь
});
const trade = ev<Extract<SimEvent, { type: 'trade/executed' }>>({
  type: 'trade/executed',
  payload: { buyer: id(2), seller: id(3), item: 'ammo' as ItemId, qty: 1, price: 10, money: 10 },
});
const abandoned = ev<Extract<SimEvent, { type: 'settlement/abandoned' }>>({
  type: 'settlement/abandoned',
  payload: { settlement: id(9), reason: 'голод' },
});

describe('significance — базовые веса и границы', () => {
  it('всегда ∈ [0..1] для всех типов события', () => {
    const world = freshWorld();
    const samples: SimEvent[] = [
      deathNpc,
      deathAnon,
      trade,
      abandoned,
      ev<Extract<SimEvent, { type: 'artifact/spawned' }>>({
        type: 'artifact/spawned',
        payload: { field: id(1), item: 'art' as ItemId, tier: 9, loc: 0 as LocationId },
      }),
      ev<Extract<SimEvent, { type: 'encounter/resolved' }>>({
        type: 'encounter/resolved',
        payload: { winnerSide: 0, casualties: [id(1), id(2), id(3), id(4)], ammoSpent: [] },
      }),
    ];
    for (const e of samples) {
      const s = significance(e, world);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('ДЕТЕРМИНИРОВАНА: тот же ev+мир → то же число', () => {
    const world = freshWorld();
    expect(significance(deathNpc, world)).toBe(significance(deathNpc, world));
    expect(significance(abandoned, world)).toBe(significance(abandoned, world));
  });

  it('ЯКОРЬ: заброшенность поселения = максимум (1.0)', () => {
    expect(significance(abandoned, freshWorld())).toBe(1);
  });

  it('смерть NPC значимее рутинной сделки (DoD)', () => {
    const world = freshWorld();
    expect(significance(deathNpc, world)).toBeGreaterThan(significance(trade, world));
  });

  it('смерть NPC (с именем) значимее смерти животного (без имени)', () => {
    const world = freshWorld();
    expect(significance(deathNpc, world)).toBeGreaterThan(significance(deathAnon, world));
  });

  it('носитель цели определяется и по name в мире (payload без name)', () => {
    const world = freshWorld();
    const eid = spawnEntity(world.ecs);
    world.resources.set<string>('name', eid, 'Меченый');
    const deathByCarrier = ev<Extract<SimEvent, { type: 'entity/died' }>>({
      type: 'entity/died',
      payload: { eid, cause: 'starvation' }, // name опущен, но носитель ИМЕНОВАН
    });
    // Как NPC-смерть, не как звериная.
    expect(significance(deathByCarrier, world)).toBe(significance(deathNpc, world));
  });

  it('артефакт: выше tier → выше значимость', () => {
    const world = freshWorld();
    const lo = ev<Extract<SimEvent, { type: 'artifact/spawned' }>>({
      type: 'artifact/spawned',
      payload: { field: id(1), item: 'art' as ItemId, tier: 1, loc: 0 as LocationId },
    });
    const hi = ev<Extract<SimEvent, { type: 'artifact/spawned' }>>({
      type: 'artifact/spawned',
      payload: { field: id(1), item: 'art' as ItemId, tier: 5, loc: 0 as LocationId },
    });
    expect(significance(hi, world)).toBeGreaterThan(significance(lo, world));
  });

  it('encounter/resolved: больше потерь → выше значимость', () => {
    const world = freshWorld();
    const one = ev<Extract<SimEvent, { type: 'encounter/resolved' }>>({
      type: 'encounter/resolved',
      payload: { winnerSide: 0, casualties: [id(1)], ammoSpent: [] },
    });
    const many = ev<Extract<SimEvent, { type: 'encounter/resolved' }>>({
      type: 'encounter/resolved',
      payload: { winnerSide: 0, casualties: [id(1), id(2), id(3)], ammoSpent: [] },
    });
    expect(significance(many, world)).toBeGreaterThan(significance(one, world));
  });

  it('неизвестный тип события → низкий вес (0) БЕЗ throw', () => {
    const world = freshWorld();
    const unknown = { id: 1 as EventId, tick: 0 as Tick, causedBy: null, type: 'ufo/landed', payload: {} } as unknown as SimEvent;
    expect(() => significance(unknown, world)).not.toThrow();
    expect(significance(unknown, world)).toBe(0);
  });

  it('служебные/шумовые типы дают ~0', () => {
    const world = freshWorld();
    const move = ev<Extract<SimEvent, { type: 'move/arrived' }>>({
      type: 'move/arrived',
      payload: { eid: id(1), at: 0 as LocationId },
    });
    expect(significance(move, world)).toBe(0);
  });
});

describe('significance — масштаб по fame', () => {
  it('жертва с высоким fame → значимее анонимной жертвы', () => {
    const world = freshWorld();
    const sigAnon = significance(deathNpc, world); // fame(5)=0
    incFame(world.resources, id(5), FAME_CAP); // легенда Зоны
    const sigFamous = significance(deathNpc, world);
    expect(sigFamous).toBeGreaterThan(sigAnon);
  });

  it('масштаб берёт САМОГО ИЗВЕСТНОГО участника боя', () => {
    const world = freshWorld();
    const started = ev<Extract<SimEvent, { type: 'encounter/started' }>>({
      type: 'encounter/started',
      payload: { sides: [[id(10), id(11)], [id(12)]], loc: 0 as LocationId },
    });
    const before = significance(started, world);
    incFame(world.resources, id(12), FAME_CAP); // дичь-легенда на другой стороне
    const after = significance(started, world);
    expect(after).toBeGreaterThan(before);
  });

  it('fame НЕ поднимает значимость выше 1.0 (кламп)', () => {
    const world = freshWorld();
    incFame(world.resources, id(5), FAME_CAP);
    expect(significance(deathNpc, world)).toBeLessThanOrEqual(1);
  });
});

describe('fame — getFame / incFame', () => {
  it('getFame(нет записи) = 0', () => {
    expect(getFame(freshWorld().resources, id(42))).toBe(0);
  });

  it('incFame монотонен и накапливается', () => {
    const world = freshWorld();
    incFame(world.resources, id(1), 3);
    expect(getFame(world.resources, id(1))).toBe(3);
    incFame(world.resources, id(1), 4);
    expect(getFame(world.resources, id(1))).toBe(7);
  });

  it('incFame клампится CAP (не растёт выше потолка)', () => {
    const world = freshWorld();
    incFame(world.resources, id(1), FAME_CAP + 1000);
    expect(getFame(world.resources, id(1))).toBe(FAME_CAP);
    incFame(world.resources, id(1), 50);
    expect(getFame(world.resources, id(1))).toBe(FAME_CAP);
  });

  it('incFame монотонен: отрицательный delta не уменьшает fame', () => {
    const world = freshWorld();
    incFame(world.resources, id(1), 10);
    incFame(world.resources, id(1), -5);
    expect(getFame(world.resources, id(1))).toBe(10);
  });

  it('incFame пишет НОВЫМ значением через resources.set (D-035)', () => {
    const world = freshWorld();
    incFame(world.resources, id(1), 5);
    // Значение — примитив (число), не разделяемая ссылка: перезапись не мутирует прочитанное.
    const snapshot = getFame(world.resources, id(1));
    incFame(world.resources, id(1), 5);
    expect(snapshot).toBe(5); // ранее прочитанное не изменилось
    expect(getFame(world.resources, id(1))).toBe(10);
  });
});

describe('fame — сериализация (D-050: автосериализуется как money)', () => {
  it('round-trip через serialize/deserialize сохраняет fame живой сущности', () => {
    const world = freshWorld();
    const eid = spawnEntity(world.ecs);
    incFame(world.resources, eid, 33);
    const restored = deserialize(serialize(world));
    expect(getFame(restored.resources, eid)).toBe(33);
    expect(restored.resources.get<number>(FAME_KEY, eid)).toBe(33);
  });

  it('round-trip fame переживает НЕСКОЛЬКО сущностей и не путает их (D-050)', () => {
    const world = freshWorld();
    const a = spawnEntity(world.ecs);
    const b = spawnEntity(world.ecs);
    const c = spawnEntity(world.ecs);
    incFame(world.resources, a, 10);
    incFame(world.resources, b, FAME_CAP); // легенда
    // c намеренно без записи fame — после load обязан читаться как 0.
    const restored = deserialize(serialize(world));
    expect(getFame(restored.resources, a)).toBe(10);
    expect(getFame(restored.resources, b)).toBe(FAME_CAP);
    expect(getFame(restored.resources, c)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ 3.1: ВЕСЬ словарь shared/events.ts даёт значимость ∈ [0..1] без NaN/throw;
// полный порядок весов (якоря GDD §10.2); монотонности tier/fame; активный кламп.
// Читается как «ни одно событие Зоны не срывает шкалу значимости».
// ═══════════════════════════════════════════════════════════════════════════

/** Плоский конструктор события ЛЮБОГО типа (для обхода всего словаря). */
function mk(type: string, payload: unknown): SimEvent {
  return { id: 1 as EventId, tick: 0 as Tick, causedBy: null, type, payload } as unknown as SimEvent;
}

const L = (n: number): LocationId => n as LocationId;
const I = (s: string): ItemId => s as ItemId;

/**
 * РЕПРЕЗЕНТАТИВНЫЙ образец на КАЖДЫЙ член union SimEvent (shared/events.ts). Ключ —
 * строка type; при добавлении нового члена union тест `покрывает весь словарь`
 * заставит дополнить эту карту (guard от «забытого типа»). Участники (eid 1..20)
 * переиспользуются, чтобы прокачка fame на них проверяла лифт на всём словаре.
 */
const DICTIONARY: Readonly<Record<string, SimEvent>> = {
  'sim/tickStarted': mk('sim/tickStarted', { tick: 0 as Tick }),
  'sim/snapshotTaken': mk('sim/snapshotTaken', { hash: 'deadbeef' }),
  'move/departed': mk('move/departed', { eid: id(1), from: L(0), to: L(1) }),
  'move/arrived': mk('move/arrived', { eid: id(1), at: L(1) }),
  'weather/changed': mk('weather/changed', { from: 0, to: 1 }),
  'needs/threshold': mk('needs/threshold', { eid: id(1), need: 'hunger', level: 'critical' }),
  'task/selected': mk('task/selected', { eid: id(1), kind: 0, targetLoc: L(0) }),
  'perception/spotted': mk('perception/spotted', { observer: id(1), target: id(2), loc: L(0) }),
  'encounter/started': mk('encounter/started', { sides: [[id(1), id(2)], [id(3)]], loc: L(0) }),
  'encounter/resolved': mk('encounter/resolved', { winnerSide: 0, casualties: [id(2), id(3)], ammoSpent: [] }),
  'animal/born': mk('animal/born', { eid: id(4), herd: 1, loc: L(0) }),
  'artifact/spawned': mk('artifact/spawned', { field: id(5), item: I('art'), tier: 3, loc: L(0) }),
  'item/produced': mk('item/produced', { settlement: id(6), item: I('bread'), qty: 2 }),
  'item/consumed': mk('item/consumed', { who: id(1), item: I('food'), qty: 1, reason: 'eat' }),
  'item/harvested': mk('item/harvested', { who: id(1), item: I('meat'), qty: 1, source: 'carcass' }),
  'item/broughtIn': mk('item/broughtIn', { who: id(7), items: [[I('ammo'), 5]], money: 100 }),
  'item/exported': mk('item/exported', { who: id(7), item: I('art'), qty: 1, moneyIn: 200 }),
  'entity/died': mk('entity/died', { eid: id(5), name: 'Сидорович', cause: 'combat' }),
  'corpse/created': mk('corpse/created', { eid: id(5), loc: L(0), items: [] }),
  'settlement/built': mk('settlement/built', { settlement: id(6), project: 'wall' }),
  'settlement/abandoned': mk('settlement/abandoned', { settlement: id(6), reason: 'голод' }),
  'trade/executed': mk('trade/executed', { buyer: id(2), seller: id(3), item: I('ammo'), qty: 1, price: 10, money: 10 }),
  'artifact/collected': mk('artifact/collected', { collector: id(1), field: id(5), item: I('art'), qty: 1, loc: L(0) }),
  'loot/transferred': mk('loot/transferred', { from: id(2), to: id(3), items: [[I('ammo'), 3]], money: 50, loc: L(0) }),
  'population/arrived': mk('population/arrived', { eid: id(8), loc: L(0), reason: 'приток' }),
};

/** Все члены union SimEvent (см. shared/events.ts) — «якорь полноты» словаря. */
const ALL_EVENT_TYPES: readonly string[] = [
  'sim/tickStarted', 'sim/snapshotTaken', 'move/departed', 'move/arrived', 'weather/changed',
  'needs/threshold', 'task/selected', 'perception/spotted', 'encounter/started', 'encounter/resolved',
  'animal/born', 'artifact/spawned', 'item/produced', 'item/consumed', 'item/harvested',
  'item/broughtIn', 'item/exported', 'entity/died', 'corpse/created', 'settlement/built',
  'settlement/abandoned', 'trade/executed', 'artifact/collected', 'loot/transferred', 'population/arrived',
];

describe('significance — ВЕСЬ словарь shared/events.ts безопасен ([0..1], без NaN/throw)', () => {
  it('образец покрывает КАЖДЫЙ член union (guard от забытого типа)', () => {
    // Если union расширили, а образец не добавили — тест падает, заставляя дополнить.
    expect(Object.keys(DICTIONARY).sort()).toEqual([...ALL_EVENT_TYPES].sort());
  });

  it('для КАЖДОГО типа значимость конечна и ∈ [0..1] (fame=0)', () => {
    const world = freshWorld();
    for (const type of ALL_EVENT_TYPES) {
      const s = significance(DICTIONARY[type]!, world);
      expect(Number.isFinite(s), `${type}: не конечно (${s})`).toBe(true);
      expect(Number.isNaN(s), `${type}: NaN`).toBe(false);
      expect(s, `${type}: < 0`).toBeGreaterThanOrEqual(0);
      expect(s, `${type}: > 1`).toBeLessThanOrEqual(1);
    }
  });

  it('ни один тип не бросает (даже без участников/имён в мире)', () => {
    const world = freshWorld();
    for (const type of ALL_EVENT_TYPES) {
      expect(() => significance(DICTIONARY[type]!, world), `${type}: throw`).not.toThrow();
    }
  });

  it('ЛИФТ по fame НЕ выводит НИ ОДИН тип за 1.0 (легенды на всех участниках)', () => {
    const world = freshWorld();
    // Прокачиваем fame на всех возможных участниках до потолка — максимальный лифт.
    for (let e = 0; e <= 20; e++) incFame(world.resources, id(e), FAME_CAP);
    for (const type of ALL_EVENT_TYPES) {
      const s = significance(DICTIONARY[type]!, world);
      expect(s, `${type}: лифт пробил 1.0`).toBeLessThanOrEqual(1);
      expect(s, `${type}: лифт ушёл < 0`).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(s), `${type}: NaN под лифтом`).toBe(false);
    }
  });

  it('ДЕТЕРМИНИЗМ на всём словаре: тот же ev+мир → то же число (2×)', () => {
    const world = freshWorld();
    for (const type of ALL_EVENT_TYPES) {
      const a = significance(DICTIONARY[type]!, world);
      const b = significance(DICTIONARY[type]!, world);
      expect(a, `${type}: недетерминирован`).toBe(b);
    }
  });
});

describe('significance — полный порядок весов (якоря GDD §10.2, DoD)', () => {
  it('settlement/abandoned = ГЛОБАЛЬНЫЙ максимум словаря (1.0)', () => {
    const world = freshWorld(); // fame=0 → чистые базовые веса
    const abandonedSig = significance(DICTIONARY['settlement/abandoned']!, world);
    expect(abandonedSig).toBe(1);
    for (const type of ALL_EVENT_TYPES) {
      expect(
        significance(DICTIONARY[type]!, world),
        `${type} не должен превосходить якорь-максимум`,
      ).toBeLessThanOrEqual(abandonedSig);
    }
  });

  it('иерархия БАЗОВЫХ весов: died > resolved(0 потерь) > started > loot > trade > spotted', () => {
    const w = freshWorld();
    const s = (t: string): number => significance(DICTIONARY[t]!, w);
    // resolved БЕЗ потерь = базовый 0.42 (в словаре образец с 2 потерями → выше, см. отд. тест).
    const resolvedBase = significance(
      mk('encounter/resolved', { winnerSide: 0, casualties: [], ammoSpent: [] }),
      w,
    );
    expect(s('entity/died')).toBeGreaterThan(resolvedBase); // 0.48 > 0.42
    expect(resolvedBase).toBeGreaterThan(s('encounter/started')); // 0.42 > 0.30
    expect(s('encounter/started')).toBeGreaterThan(s('loot/transferred')); // 0.30 > 0.28
    expect(s('loot/transferred')).toBeGreaterThan(s('trade/executed')); // 0.28 > 0.06
    expect(s('trade/executed')).toBeGreaterThan(s('perception/spotted')); // 0.06 > 0.02
  });

  it('потери ПОДНИМАЮТ resolved выше базовой смерти NPC (бойня заметнее одиночной смерти)', () => {
    const w = freshWorld();
    // Образец словаря несёт 2 потери → 0.42 + 2·0.06 = 0.54 > 0.48 базовой смерти.
    expect(significance(DICTIONARY['encounter/resolved']!, w)).toBeGreaterThan(
      significance(DICTIONARY['entity/died']!, w),
    );
  });

  it('смерть NPC значимее СЛЕДСТВИЙ (труп) и рутины населения/экспорта', () => {
    const w = freshWorld();
    const s = (t: string): number => significance(DICTIONARY[t]!, w);
    expect(s('entity/died')).toBeGreaterThan(s('corpse/created'));
    expect(s('population/arrived')).toBeGreaterThan(s('item/exported'));
    expect(s('item/exported')).toBeGreaterThan(s('trade/executed'));
  });

  it('шумовые/служебные типы (move/task/sim) дают РОВНО 0', () => {
    const w = freshWorld();
    for (const type of ['move/departed', 'move/arrived', 'task/selected', 'sim/tickStarted', 'sim/snapshotTaken']) {
      expect(significance(DICTIONARY[type]!, w), `${type} должен быть шумом (0)`).toBe(0);
    }
  });

  it('артефакт: значимость СТРОГО РАСТЁТ по tier (монотонно на диапазоне 0..5)', () => {
    const w = freshWorld();
    let prev = -1;
    for (let tier = 0; tier <= 5; tier++) {
      const s = significance(mk('artifact/spawned', { field: id(5), item: I('a'), tier, loc: L(0) }), w);
      expect(s, `tier ${tier} не выше tier ${tier - 1}`).toBeGreaterThan(prev);
      expect(s).toBeLessThanOrEqual(1);
      prev = s;
    }
  });

  it('АКТИВНЫЙ кламп: артефакт с огромным tier упирается РОВНО в 1.0 (raw>1 срезан)', () => {
    // base 0.30 + tier·0.08: tier=20 → raw=1.90 > 1 ⇒ clamp01 обязан вернуть 1.0.
    const s = significance(mk('artifact/spawned', { field: id(5), item: I('a'), tier: 20, loc: L(0) }), freshWorld());
    expect(s).toBe(1);
  });
});

describe('significance — лифт по fame МОНОТОНЕН на диапазоне известности', () => {
  it('smерть одной жертвы: fame 0<25<50<75<100 → значимость строго растёт, всегда ≤1', () => {
    const world = freshWorld();
    const victim = id(5);
    const death = mk('entity/died', { eid: victim, name: 'Стрелок', cause: 'combat' });
    let prev = -1;
    for (const target of [0, 25, 50, 75, FAME_CAP]) {
      // incFame монотонен ⇒ поднимаем строго вверх к каждому уровню.
      incFame(world.resources, victim, target - getFame(world.resources, victim));
      const s = significance(death, world);
      expect(s, `fame ${target}: не выше предыдущего`).toBeGreaterThan(prev);
      expect(s, `fame ${target}: пробил 1.0`).toBeLessThanOrEqual(1);
      prev = s;
    }
  });
});
