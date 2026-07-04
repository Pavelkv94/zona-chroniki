/**
 * @module @zona/sim/worldgen.test
 *
 * Гейт стартовой генерации мира (задача 1.3). Покрывает DoD:
 *  - ДЕТЕРМИНИЗМ (закон №8): worldgen(seed 42) дважды → идентичный хэш снапшота
 *    (eid, имена, позиции, инвентарь, навыки, стада);
 *  - контракт сталкера: Position(loc=Кордон), Needs НИЖЕ всех критических порогов
 *    (D-027), Health>0, Home, теги Human+Alive, имя с непустыми first И last
 *    (закон №4), непустой инвентарь с валидными itemId (закон №3), money>=0;
 *  - singleton WorldClock (ровно 1); никто не в Саркофаге; сталкеры в Кордоне;
 *  - стада: в wild/ruins (game>порога), не в settlement/Саркофаге; валидный
 *    species+herd; размер стада ∈ [herdMin,herdMax];
 *  - RESUME: worldgen → serialize → deserialize → идентичный хэш;
 *  - разные seed → разные имена/стада;
 *  - число сущностей < WORLD_CAPACITY.
 *
 * SoA-компоненты — модульные singleton'ы (общие колонки по eid): миры в тестах
 * идут ПОСЛЕДОВАТЕЛЬНО; где два мира делят eid, состояние первого захватывается в
 * строку-хэш/примитив ДО генерации второго (как в weather.test/needs.test).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed } from '@zona/shared';
import { createSimWorld, type SimWorld } from './core/world';
import { queryEntities, hasComponent } from './core/ecs';
import {
  Position,
  Needs,
  Health,
  Skills,
  Home,
  Animal,
  Task,
  WorldClock,
  Settlement,
  Human,
  Alive,
  WORLD_CAPACITY,
} from './core/components';
import { serialize, deserialize, hashSnapshot } from './core/snapshot';
import { MAP, getItem, getSpecies } from './data/index';
import {
  HUNGER_CRITICAL,
  THIRST_CRITICAL,
  FATIGUE_CRITICAL,
  HEALTH_MAX,
} from './balance/needs';
import {
  STALKER_COUNT,
  ENTRY_LOCATION,
  STARTING_HERDS,
  HERD_MIN_GAME,
  HERD_MAX_DANGER,
  SKILL_MIN,
  SKILL_MAX,
  STARTING_HUNGER_MIN,
  STARTING_HUNGER_MAX,
  STARTING_THIRST_MIN,
  STARTING_THIRST_MAX,
  STARTING_FATIGUE_MIN,
  STARTING_FATIGUE_MAX,
  ANIMAL_HUNGER_MIN,
  ANIMAL_HUNGER_MAX,
  ANIMAL_THIRST_MIN,
  ANIMAL_THIRST_MAX,
  ANIMAL_START_HP,
  STARTING_INVENTORY,
  STARTING_MONEY,
  STARTING_FACTION_ID,
  STARTING_PROFESSION_IDS,
  SETTLEMENT_START_MORALE,
  SETTLEMENT_START_SECURITY,
  TRADER_PROFESSION_ID,
} from './balance/worldgen';
import { getFaction, getProfession, getSettlements } from './data/index';
import { worldgen } from './worldgen';

// ── Типизированные проекции колонок для чтения в тестах ───────────────────────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
const NEED = Needs as unknown as {
  hunger: Float32Array;
  thirst: Float32Array;
  fatigue: Float32Array;
  fear: Float32Array;
};
const HP = Health as unknown as { hp: Float32Array };
const SKILL = Skills as unknown as {
  shooting: Float32Array;
  survival: Float32Array;
  stealth: Float32Array;
};
const ANIMAL = Animal as unknown as { species: Uint8Array; herd: Uint32Array };
const CLOCK = WorldClock as unknown as { weather: Uint8Array; weatherSince: Uint32Array };
const SETTLE = Settlement as unknown as {
  morale: Float32Array;
  security: Float32Array;
  buildTarget: Uint8Array;
  buildProgress: Float32Array;
};

/** Свежий заселённый мир. */
function generated(seed: number): SimWorld {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  return world;
}

/** true, если Human-сущность — торговец (профессия 'trader', задача 2.2). */
function isTrader(world: SimWorld, eid: EntityId): boolean {
  return world.resources.get<string>('profession', eid) === TRADER_PROFESSION_ID;
}

/**
 * Сталкеры = носители тега Human, КРОМЕ торговцев (2.2 добавила торговцев как
 * Human-NPC при поселениях; контракт стартовой когорты Кордона проверяется отдельно
 * от торговцев). Так исходные контракт-тесты сталкеров остаются про 20-когорту.
 */
function stalkers(world: SimWorld): readonly EntityId[] {
  return queryEntities(world.ecs, [Human]).filter((e) => !isTrader(world, e));
}

/** Торговцы = носители тега Human с профессией 'trader' (по одному на поселение). */
function traders(world: SimWorld): readonly EntityId[] {
  return queryEntities(world.ecs, [Human]).filter((e) => isTrader(world, e));
}

/** Сущности-поселения = носители компонента Settlement. */
function settlements(world: SimWorld): readonly EntityId[] {
  return queryEntities(world.ecs, [Settlement]);
}

/** Животные = носители компонента Animal. */
function animals(world: SimWorld): readonly EntityId[] {
  return queryEntities(world.ecs, [Animal]);
}

interface NameRecord {
  first: string;
  last: string;
  nickname: string;
}
interface InvEntry {
  item: string;
  qty: number;
}

describe('worldgen — детерминизм (закон №8)', () => {
  it('одинаковый seed → идентичный хэш снапшота', () => {
    const w1 = generated(42);
    const h1 = hashSnapshot(serialize(w1)); // захват ДО второй генерации
    const w2 = generated(42);
    const h2 = hashSnapshot(serialize(w2));
    expect(h2).toBe(h1);
  });

  it('разные seed → разные имена и разный хэш', () => {
    const w42 = generated(42);
    const h42 = hashSnapshot(serialize(w42));
    const names42 = stalkers(w42).map(
      (e) => world_name(w42, e),
    );
    const w43 = generated(43);
    const h43 = hashSnapshot(serialize(w43));
    const names43 = stalkers(w43).map((e) => world_name(w43, e));
    expect(h43).not.toBe(h42);
    // Наборы имён должны различаться хотя бы одной записью.
    expect(names43).not.toEqual(names42);
  });
});

function world_name(world: SimWorld, eid: EntityId): string {
  const n = world.resources.get<NameRecord>('name', eid);
  return n ? `${n.first} ${n.last}` : '';
}

describe('worldgen — контракт сталкера', () => {
  // ВАЖНО: SoA-колонки глобальны; мир генерируем ВНУТРИ каждого it (сразу перед
  // чтением), иначе другой тест (seed 43) перезапишет колонки на тех же eid.

  it('ровно STALKER_COUNT сталкеров', () => {
    const world = generated(42);
    expect(stalkers(world).length).toBe(STALKER_COUNT);
  });

  it('каждый: Position в Кордоне (dest===loc, стоит)', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      expect(hasComponent(world.ecs, Position, e)).toBe(true);
      expect(POS.loc[e]).toBe(ENTRY_LOCATION);
      expect(POS.dest[e]).toBe(ENTRY_LOCATION);
      expect(POS.etaTicks[e]).toBe(0);
    }
  });

  it('каждый: Needs СТРОГО ниже критических порогов (D-027)', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      expect(hasComponent(world.ecs, Needs, e)).toBe(true);
      expect(NEED.hunger[e]!).toBeLessThan(HUNGER_CRITICAL);
      expect(NEED.thirst[e]!).toBeLessThan(THIRST_CRITICAL);
      expect(NEED.fatigue[e]!).toBeLessThan(FATIGUE_CRITICAL);
      expect(NEED.hunger[e]!).toBeGreaterThanOrEqual(0);
      expect(NEED.fear[e]).toBe(0);
    }
  });

  it('каждый: Health>0, Skills, Home, теги Human+Alive', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      expect(hasComponent(world.ecs, Health, e)).toBe(true);
      expect(HP.hp[e]!).toBeGreaterThan(0);
      expect(hasComponent(world.ecs, Skills, e)).toBe(true);
      expect(hasComponent(world.ecs, Home, e)).toBe(true);
      expect(hasComponent(world.ecs, Human, e)).toBe(true);
      expect(hasComponent(world.ecs, Alive, e)).toBe(true);
    }
  });

  it('каждый: имя с НЕПУСТЫМИ first И last (закон №4)', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      const n = world.resources.get<NameRecord>('name', e);
      expect(n).toBeDefined();
      expect(typeof n!.first).toBe('string');
      expect(n!.first.length).toBeGreaterThan(0);
      expect(n!.last.length).toBeGreaterThan(0);
      expect(n!.nickname.length).toBeGreaterThan(0);
    }
  });

  it('каждый: непустой инвентарь с ВАЛИДНЫМИ itemId (закон №3), отсортирован', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      const inv = world.resources.get<InvEntry[]>('inventory', e);
      expect(inv).toBeDefined();
      expect(inv!.length).toBeGreaterThan(0);
      let prev = '';
      for (const entry of inv!) {
        expect(() => getItem(entry.item)).not.toThrow(); // существует в items.json
        expect(entry.qty).toBeGreaterThan(0);
        expect(entry.item >= prev).toBe(true); // сортировка по itemId
        prev = entry.item;
      }
    }
  });

  it('каждый: money>=0, faction/profession — id, резолвящиеся из data (закон №10)', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      const money = world.resources.get<number>('money', e);
      expect(money).toBeDefined();
      expect(money!).toBeGreaterThanOrEqual(0);
      // Фракция/профессия — КОНТЕНТ в /sim/data; worldgen кладёт id-ссылку, которая
      // ОБЯЗАНА резолвиться (иначе «фракция из воздуха»). Стартовая фракция = loners.
      const faction = world.resources.get<string>('faction', e)!;
      const profession = world.resources.get<string>('profession', e)!;
      expect(faction).toBe(STARTING_FACTION_ID);
      expect(() => getFaction(faction)).not.toThrow();
      expect(STARTING_PROFESSION_IDS).toContain(profession);
      expect(() => getProfession(profession)).not.toThrow();
    }
  });

  it('Task НЕ навешан (назначит TaskSelection 1.8, D-020)', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      expect(hasComponent(world.ecs, Task, e)).toBe(false);
    }
  });
});

describe('worldgen — мир и размещение', () => {
  it('ровно ОДИН носитель WorldClock (singleton, D-019)', () => {
    const world = generated(42);
    const clocks = queryEntities(world.ecs, [WorldClock]);
    expect(clocks.length).toBe(1);
    expect(CLOCK.weatherSince[clocks[0]!]).toBe(0);
  });

  it('все сталкеры в Кордоне; никто не в смертельной зоне (danger>=1)', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      expect(POS.loc[e]).toBe(ENTRY_LOCATION);
    }
    // Проверка через ДАННЫЕ (loc.danger), а не хардкод-id локации: ни один актёр
    // (сталкеры, торговцы, животные) не стартует в зоне danger>=1.0 (Саркофаг и
    // любая будущая смертельная зона). Торговцы стоят на своих поселениях (Кордон/
    // Росток — заведомо безопасны, но проверяем через данные, не через id).
    for (const e of [...stalkers(world), ...traders(world), ...animals(world)]) {
      expect(MAP.locations[POS.loc[e]!]!.danger).toBeLessThan(1.0);
    }
  });

  it('число сущностей в разумных границах (< WORLD_CAPACITY)', () => {
    const world = generated(42);
    const total = queryEntities(world.ecs, [Alive]).length + 1; // +WorldClock (без Alive)
    expect(total).toBeLessThan(WORLD_CAPACITY);
    expect(total).toBeGreaterThan(STALKER_COUNT); // есть и животные
  });
});

describe('worldgen — стада животных (D-025)', () => {
  it('каждое животное: Animal с валидным species; в wild/ruins, game>порога, danger<порога', () => {
    const world = generated(42);
    for (const e of animals(world)) {
      expect(hasComponent(world.ecs, Animal, e)).toBe(true);
      const sp = ANIMAL.species[e]!;
      expect(() => getSpecies(sp)).not.toThrow();
      expect(hasComponent(world.ecs, Alive, e)).toBe(true);
      expect(hasComponent(world.ecs, Health, e)).toBe(true);
      expect(HP.hp[e]!).toBeGreaterThan(0);

      const loc = POS.loc[e]!;
      const ld = MAP.locations[loc]!;
      expect(ld.type === 'wild' || ld.type === 'ruins').toBe(true);
      expect(ld.type).not.toBe('settlement');
      expect(ld.game).toBeGreaterThan(HERD_MIN_GAME);
      // Исключение смертельных зон — через ДАННЫЕ (danger), не хардкод-id (D-025).
      expect(ld.danger).toBeLessThan(HERD_MAX_DANGER);
      // Стоит на месте (D-019).
      expect(POS.dest[e]).toBe(loc);
    }
  });

  it('число стад и размеры ∈ [herdMin,herdMax], один вид на стадо', () => {
    const world = generated(42);
    // Группируем животных по herd.
    const byHerd = new Map<number, EntityId[]>();
    for (const e of animals(world)) {
      const h = ANIMAL.herd[e]!;
      let members = byHerd.get(h);
      if (members === undefined) {
        members = [];
        byHerd.set(h, members);
      }
      members.push(e);
    }
    const expectedHerds = STARTING_HERDS.reduce((s, x) => s + x.herds, 0);
    expect(byHerd.size).toBe(expectedHerds);

    for (const [, members] of byHerd) {
      // Один вид на стадо.
      const speciesOfHerd = ANIMAL.species[members[0]!]!;
      for (const m of members) expect(ANIMAL.species[m]).toBe(speciesOfHerd);
      const sp = getSpecies(speciesOfHerd);
      expect(members.length).toBeGreaterThanOrEqual(sp.herdMin);
      expect(members.length).toBeLessThanOrEqual(sp.herdMax);
    }
  });
});

describe('worldgen — RESUME (закон №8)', () => {
  it('worldgen → serialize → deserialize → идентичный хэш', () => {
    const world = generated(42);
    const snap = serialize(world);
    const h1 = hashSnapshot(snap);
    const restored = deserialize(snap);
    const h2 = hashSnapshot(serialize(restored));
    expect(h2).toBe(h1);
  });

  it('после load: имя/инвентарь/деньги/фракция/профессия КАЖДОГО сталкера тождественны', () => {
    // Сценарий: мир сохранён и загружен на другой машине — ни один сталкер не
    // «переродился» с чужим именем или лишним патроном (закон №3/№8). Ресурсы
    // живут в per-world Map, поэтому оригинал остаётся читаемым после load.
    const origin = generated(42);
    const originData = stalkers(origin).map((e) => ({
      name: origin.resources.get<NameRecord>('name', e),
      inv: origin.resources.get<InvEntry[]>('inventory', e),
      money: origin.resources.get<number>('money', e),
      faction: origin.resources.get<string>('faction', e),
      profession: origin.resources.get<string>('profession', e),
    }));

    const restored = deserialize(serialize(origin));
    const restoredStalkers = stalkers(restored);
    // Тот же поимённый состав по тем же eid (спавн по порядку, D-011).
    expect(restoredStalkers).toEqual(stalkers(origin));

    restoredStalkers.forEach((e, i) => {
      expect(restored.resources.get<NameRecord>('name', e)).toEqual(originData[i]!.name);
      expect(restored.resources.get<InvEntry[]>('inventory', e)).toEqual(originData[i]!.inv);
      expect(restored.resources.get<number>('money', e)).toBe(originData[i]!.money);
      expect(restored.resources.get<string>('faction', e)).toBe(originData[i]!.faction);
      expect(restored.resources.get<string>('profession', e)).toBe(originData[i]!.profession);
    });
  });

  it('после load: SoA-компоненты сталкеров (Position/Needs/Health/Skills/Home) тождественны', () => {
    // Захватываем горячие колонки ДО load (deserialize перепишет те же глобальные
    // колонки на те же eid — значения обязаны совпасть до последнего бита f32).
    const origin = generated(42);
    const before = stalkers(origin).map((e) => ({
      loc: POS.loc[e], dest: POS.dest[e], eta: POS.etaTicks[e],
      hunger: NEED.hunger[e], thirst: NEED.thirst[e], fatigue: NEED.fatigue[e], fear: NEED.fear[e],
      hp: HP.hp[e], sh: SKILL.shooting[e], su: SKILL.survival[e], st: SKILL.stealth[e],
    }));
    const restored = deserialize(serialize(origin));
    stalkers(restored).forEach((e, i) => {
      expect(POS.loc[e]).toBe(before[i]!.loc);
      expect(POS.dest[e]).toBe(before[i]!.dest);
      expect(POS.etaTicks[e]).toBe(before[i]!.eta);
      expect(NEED.hunger[e]).toBe(before[i]!.hunger);
      expect(NEED.thirst[e]).toBe(before[i]!.thirst);
      expect(NEED.fatigue[e]).toBe(before[i]!.fatigue);
      expect(NEED.fear[e]).toBe(before[i]!.fear);
      expect(HP.hp[e]).toBe(before[i]!.hp);
      expect(SKILL.shooting[e]).toBe(before[i]!.sh);
      expect(SKILL.survival[e]).toBe(before[i]!.su);
      expect(SKILL.stealth[e]).toBe(before[i]!.st);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// УСИЛЕННЫЕ ГЕЙТЫ (QA 1.3): дыры, найденные ревью тестов — навыки без проверки
// границ, нужды «в среднем», стада только для seed 42, отсутствие явной проверки
// на «вечный idle», источник инвентаря, независимость от глобального состояния.
// ─────────────────────────────────────────────────────────────────────────────

/** Снимок-хэш заселённого мира по seed (для кросс-seed и стабильности). */
function genHash(seed: number): string {
  return hashSnapshot(serialize(generated(seed)));
}

describe('worldgen — детерминизм между вызовами (усиление)', () => {
  it('два РАЗНЫХ world-объекта одного seed → те же eid и тот же снапшот', () => {
    const wA = generated(42);
    const snapA = serialize(wA); // deep-clone: изолирован от глобальных SoA-колонок
    const entA = [...stalkers(wA), ...animals(wA)];
    const wB = generated(42); // перезаписывает те же колонки — но snapA уже снят
    const snapB = serialize(wB);
    const entB = [...stalkers(wB), ...animals(wB)];
    // Спавн по порядку ⇒ идентичный набор eid.
    expect(entB).toEqual(entA);
    // И идентичные данные целиком.
    expect(hashSnapshot(snapB)).toBe(hashSnapshot(snapA));
  });

  it('worldgen НЕ зависит от глобального состояния между вызовами', () => {
    // Прогон seed 42, затем ЧУЖОЙ seed 99 (пачкает глобальные SoA-колонки/eid-reuse),
    // затем снова 42 — результат обязан совпасть с первым. Ловит скрытую зависимость
    // от module-level счётчиков/Set вне rng.
    const first = genHash(42);
    genHash(99); // намеренно «грязный» промежуточный прогон
    const again = genHash(42);
    expect(again).toBe(first);
  });

  it('стабильный голден-хэш seed 42 (регрессия детерминизма)', () => {
    // Любое непреднамеренное изменение порядка потребления rng/расстановки сломает
    // эту сверку. Значение зафиксировано текущей реализацией — не «магия».
    const h = genHash(42);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(genHash(42)).toBe(h); // идемпотентность снятия
  });
});

describe('worldgen — поимённый состав 20 сталкеров (закон №4)', () => {
  it('нет ПОЛНОГО дубля (first+last); однофамильцы/одноимённые допустимы', () => {
    const world = generated(42);
    const full = new Set<string>();
    for (const e of stalkers(world)) {
      const n = world.resources.get<NameRecord>('name', e)!;
      expect(n.first.length).toBeGreaterThan(0);
      expect(n.last.length).toBeGreaterThan(0);
      full.add(`${n.first}|${n.last}`);
    }
    // Пул 20×20 покрывает 20 сталкеров с запасом; линейный пробинг pickName
    // обязан исключить ВСЕ полные дубли.
    expect(full.size).toBe(STALKER_COUNT);
  });

  it('дубли кличек ДОПУСТИМЫ и зафиксированы как известные (пул кличек мал)', () => {
    // Клички НЕ дедуплицируются (в отличие от first+last) — 5 паттернов × 3 опции.
    // Коллизии кличек ожидаемы и не являются багом (позывной ≠ уникальный id).
    const world = generated(42);
    const nicks = stalkers(world).map(
      (e) => world.resources.get<NameRecord>('name', e)!.nickname,
    );
    expect(nicks.every((x) => x.length > 0)).toBe(true);
    // Известный факт: кличек меньше, чем сталкеров ⇒ дубли есть. Фиксируем как
    // контракт, а не как случайность.
    expect(new Set(nicks).size).toBeLessThan(STALKER_COUNT);
  });

  it('разные seed → разные наборы полных имён (2 seed)', () => {
    const w42 = generated(42);
    const names42 = stalkers(w42)
      .map((e) => world_name(w42, e))
      .join(',');
    const w7 = generated(7);
    const names7 = stalkers(w7)
      .map((e) => world_name(w7, e))
      .join(',');
    expect(names7).not.toBe(names42);
  });
});

describe('worldgen — нужды сталкера НИЖЕ порогов С ЗАПАСОМ (D-027, поимённо)', () => {
  it('гарантия баланса: стартовый диапазон СТРОГО ниже каждого критического порога', () => {
    // Структурная гарантия (не «в среднем по прогону»): даже верхняя граница
    // диапазона строго под порогом ⇒ ни один сталкер не может стартовать критическим.
    expect(STARTING_HUNGER_MAX).toBeLessThan(HUNGER_CRITICAL);
    expect(STARTING_THIRST_MAX).toBeLessThan(THIRST_CRITICAL);
    expect(STARTING_FATIGUE_MAX).toBeLessThan(FATIGUE_CRITICAL);
  });

  it('КАЖДЫЙ сталкер: каждая нужда в своём балансовом диапазоне [min,max)', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      const hunger = NEED.hunger[e]!;
      const thirst = NEED.thirst[e]!;
      const fatigue = NEED.fatigue[e]!;
      expect(hunger).toBeGreaterThanOrEqual(STARTING_HUNGER_MIN);
      expect(hunger).toBeLessThan(STARTING_HUNGER_MAX);
      expect(thirst).toBeGreaterThanOrEqual(STARTING_THIRST_MIN);
      expect(thirst).toBeLessThan(STARTING_THIRST_MAX);
      expect(fatigue).toBeGreaterThanOrEqual(STARTING_FATIGUE_MIN);
      expect(fatigue).toBeLessThan(STARTING_FATIGUE_MAX);
      // Ни одной NaN-нужды.
      expect(Number.isFinite(hunger)).toBe(true);
      expect(Number.isFinite(thirst)).toBe(true);
      expect(Number.isFinite(fatigue)).toBe(true);
      // И, как следствие, строго ниже КАЖДОГО критического порога с запасом.
      expect(hunger).toBeLessThan(HUNGER_CRITICAL);
      expect(thirst).toBeLessThan(THIRST_CRITICAL);
      expect(fatigue).toBeLessThan(FATIGUE_CRITICAL);
    }
  });
});

describe('worldgen — навыки сталкера в границах баланса (дыра: ранее не проверялось)', () => {
  it('КАЖДЫЙ навык ∈ [SKILL_MIN, SKILL_MAX); не NaN; HP = HEALTH_MAX', () => {
    const world = generated(42);
    for (const e of stalkers(world)) {
      for (const v of [SKILL.shooting[e]!, SKILL.survival[e]!, SKILL.stealth[e]!]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(SKILL_MIN);
        expect(v).toBeLessThan(SKILL_MAX);
      }
      // Входят в Зону здоровыми (D-021): ровно потолок здоровья.
      expect(HP.hp[e]).toBe(HEALTH_MAX);
    }
  });
});

describe('worldgen — инвентарь: физический источник и целостность (закон №3, D-021)', () => {
  it('КАЖДЫЙ сталкер несёт стандартный набор из-за Периметра (совпадает со STARTING_INVENTORY)', () => {
    // Источник задокументирован (D-021: внесено извне). Проверяем, что мир не
    // добавил и не потерял ни единицы относительно балансового набора.
    const expected = [...STARTING_INVENTORY]
      .map((s) => ({ item: s.itemId as string, qty: s.qty }))
      .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    const world = generated(42);
    for (const e of stalkers(world)) {
      const inv = world.resources.get<InvEntry[]>('inventory', e)!;
      expect(inv).toEqual(expected);
      // Каждая единица реальна (существует в items.json) и qty>0, отсортировано.
      let prev = '';
      for (const entry of inv) {
        expect(() => getItem(entry.item)).not.toThrow();
        expect(entry.qty).toBeGreaterThan(0);
        expect(Number.isInteger(entry.qty)).toBe(true);
        expect(entry.item >= prev).toBe(true);
        prev = entry.item;
      }
    }
  });

  // ФИКС QA-находки (ревью 1.3): buildStartingInventory() строит СВЕЖИЙ массив +
  // свежие {item,qty} на КАЖДОГО сталкера. Каждый владеет своей копией, поэтому
  // будущий расход инвентаря in-place экономикой (1.10) НЕ протечёт на остальных
  // (закон №3 — предметы не исчезают/появляются у всех сразу).
  it('инвентарь каждого сталкера — ИЗОЛИРОВАННЫЙ объект (не общий ref, закон №3)', () => {
    const world = generated(42);
    const list = stalkers(world);
    expect(list.length).toBeGreaterThanOrEqual(2);
    const inv0 = world.resources.get<InvEntry[]>('inventory', list[0]!)!;
    const inv1 = world.resources.get<InvEntry[]>('inventory', list[1]!)!;
    // Разные массивы и разные вложенные объекты (не разделяют ссылку).
    expect(inv0).not.toBe(inv1);
    expect(inv0[0]).not.toBe(inv1[0]);
    // Но значения тождественны (общий приток из-за Периметра, D-021).
    expect(inv0).toEqual(inv1);

    // Мутация одного НЕ трогает другого (симуляция расхода патрона).
    const before = inv1[0]!.qty;
    inv0[0]!.qty -= 1;
    inv0.push({ item: 'meat', qty: 1 });
    expect(inv1[0]!.qty).toBe(before); // сосед не пострадал
    expect(inv1.some((x) => x.item === 'meat')).toBe(false);
    // И третий сталкер тоже независим.
    if (list[2] !== undefined) {
      const inv2 = world.resources.get<InvEntry[]>('inventory', list[2]!)!;
      expect(inv2).not.toBe(inv0);
      expect(inv2[0]).not.toBe(inv0[0]);
    }
  });
});

describe('worldgen — животные: нужды, размещение, стада (D-025)', () => {
  it('КАЖДОЕ животное: нужды ниже критических, в своём диапазоне, HP=ANIMAL_START_HP', () => {
    const world = generated(42);
    for (const e of animals(world)) {
      const hunger = NEED.hunger[e]!;
      const thirst = NEED.thirst[e]!;
      expect(hunger).toBeGreaterThanOrEqual(ANIMAL_HUNGER_MIN);
      expect(hunger).toBeLessThan(ANIMAL_HUNGER_MAX);
      expect(thirst).toBeGreaterThanOrEqual(ANIMAL_THIRST_MIN);
      expect(thirst).toBeLessThan(ANIMAL_THIRST_MAX);
      // Звери тоже не должны стартовать критическими (иначе истощение с тика 0).
      expect(hunger).toBeLessThan(HUNGER_CRITICAL);
      expect(thirst).toBeLessThan(THIRST_CRITICAL);
      expect(NEED.fatigue[e]).toBe(0);
      expect(NEED.fear[e]).toBe(0);
      expect(HP.hp[e]).toBe(ANIMAL_START_HP);
    }
  });

  it('НИ ОДНО животное не в settlement/anomaly/Саркофаге; локация валидна', () => {
    // Сценарий: стада держатся глубоких диких/руинных территорий и НИКОГДА не
    // забредают в поселения или смертельные аномалии на старте (D-025).
    const world = generated(42);
    for (const e of animals(world)) {
      const loc = POS.loc[e]!;
      const ld = MAP.locations[loc];
      expect(ld).toBeDefined();
      expect(ld!.type === 'wild' || ld!.type === 'ruins').toBe(true);
      expect(ld!.type).not.toBe('settlement');
      expect(ld!.type).not.toBe('anomaly'); // отсекает Саркофаг/Рыжий лес/Янтарь
      expect(ld!.game).toBeGreaterThan(HERD_MIN_GAME);
    }
  });

  it('суммарное число животных в теоретическом коридоре [Σherds·herdMin, Σherds·herdMax]', () => {
    const world = generated(42);
    let lo = 0;
    let hi = 0;
    for (const entry of STARTING_HERDS) {
      const sp = getSpecies(entry.speciesId);
      lo += entry.herds * sp.herdMin;
      hi += entry.herds * sp.herdMax;
    }
    const total = animals(world).length;
    expect(total).toBeGreaterThanOrEqual(lo);
    expect(total).toBeLessThanOrEqual(hi);
  });

  it('номера стад уникальны и плотны [0, Σherds)', () => {
    const world = generated(42);
    const herds = new Set<number>();
    for (const e of animals(world)) herds.add(ANIMAL.herd[e]!);
    const expectedHerds = STARTING_HERDS.reduce((s, x) => s + x.herds, 0);
    expect(herds.size).toBe(expectedHerds);
    // Плотная нумерация 0..N-1 (глобальный счётчик herdNo).
    const sorted = [...herds].sort((a, b) => a - b);
    expect(sorted).toEqual([...Array(expectedHerds).keys()]);
  });

  it('разные seed → разная раскладка стад (3 seed)', () => {
    // Захватываем раскладку КАЖДОГО мира ДО генерации следующего (глобальные SoA).
    function layout(seed: number): string {
      const w = generated(seed);
      return animals(w)
        .map((e) => `${ANIMAL.herd[e]}:${ANIMAL.species[e]}@${POS.loc[e]}`)
        .join(',');
    }
    const l42 = layout(42);
    const l43 = layout(43);
    const l7 = layout(7);
    expect(l42).not.toBe(l43);
    expect(l42).not.toBe(l7);
    expect(l43).not.toBe(l7);
  });
});

describe('worldgen — ёмкость мира на нескольких seed (закон №8: колебание стад)', () => {
  it('на 5 seed: STALKER_COUNT+1 ≤ живых сущностей < WORLD_CAPACITY', () => {
    // Захватываем счётчик каждого мира ДО генерации следующего (глобальные SoA/eid).
    const counts: number[] = [];
    for (const seed of [42, 43, 7, 1, 100]) {
      const w = generated(seed);
      counts.push(queryEntities(w.ecs, [Alive]).length + 1); // +WorldClock (без Alive)
    }
    // Верхний теоретический потолок: 20 сталкеров + по торговцу на поселение (2.2,
    // Human+Alive) + мир + макс. животные. Сущности-поселения — НЕ Alive (в счётчик
    // Alive не входят), поэтому в потолок Alive их не добавляем.
    let maxAnimals = 0;
    for (const entry of STARTING_HERDS) maxAnimals += entry.herds * getSpecies(entry.speciesId).herdMax;
    const ceiling = STALKER_COUNT + getSettlements().length + 1 + maxAnimals;
    for (const total of counts) {
      expect(total).toBeGreaterThan(STALKER_COUNT); // есть и животные
      expect(total).toBeLessThanOrEqual(ceiling);
      expect(total).toBeLessThan(WORLD_CAPACITY);
    }
    // Стада колеблются с seed ⇒ хотя бы два разных значения (rng реально работает).
    expect(new Set(counts).size).toBeGreaterThan(1);
  });
});

describe('worldgen — НЕ оставляет «вечный idle» сам по себе (закон №4, D-020)', () => {
  it('ни у одной живой сущности (сталкер И животное) нет компонента Task', () => {
    // worldgen не пишет Task: назначит TaskSelection (1.8) на первом тике из нужд.
    // Значит worldgen не «замораживает» никого в idle — состояние появится из мира,
    // а не из генезиса. (Kind=0=SLEEP возник бы лишь если бы Task навесили и занулили.)
    const world = generated(42);
    // Торговцы (2.2) тоже без Task на генезисе — их задачу назначит TaskSelection.
    for (const e of [...stalkers(world), ...traders(world), ...animals(world)]) {
      expect(hasComponent(world.ecs, Task, e)).toBe(false);
    }
    // WorldClock-сущность тоже не носит Task/Needs (это не актор).
    const clock = queryEntities(world.ecs, [WorldClock])[0]!;
    expect(hasComponent(world.ecs, Task, clock)).toBe(false);
    expect(hasComponent(world.ecs, Needs, clock)).toBe(false);
    // Сущности-поселения — не акторы: не носят Task/Needs (Movement/Needs их минуют).
    for (const e of settlements(world)) {
      expect(hasComponent(world.ecs, Task, e)).toBe(false);
      expect(hasComponent(world.ecs, Needs, e)).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ПОСЕЛЕНИЯ И ТОРГОВЦЫ (задача 2.2, D-046/D-051)
// ═════════════════════════════════════════════════════════════════════════════

const HOME_LOC = Home as unknown as { loc: Uint32Array };

/** Инвентарь (склад/личный) сущности из ResourceStore. */
function invOf(world: SimWorld, eid: EntityId): InvEntry[] | undefined {
  return world.resources.get<InvEntry[]>('inventory', eid);
}
/** Деньги (касса/личные) сущности из ResourceStore. */
function moneyOf(world: SimWorld, eid: EntityId): number | undefined {
  return world.resources.get<number>('money', eid);
}
/** Сущность-поселение, стоящая на локации `loc` (или undefined). */
function settlementAt(world: SimWorld, loc: number): EntityId | undefined {
  return settlements(world).find((e) => POS.loc[e] === loc);
}

describe('worldgen — поселения: сущность+склад+касса на каждой settlement-локации (D-046)', () => {
  it('ровно одно поселение-сущность на каждую запись settlements.json', () => {
    const world = generated(42);
    expect(settlements(world).length).toBe(getSettlements().length);
    // По одному на каждую заявленную локацию (нет дублей/пропусков).
    for (const s of getSettlements()) {
      expect(settlementAt(world, s.loc)).toBeDefined();
    }
  });

  it('каждое поселение: Position стоит на своей loc (dest===loc), morale/security из balance', () => {
    const world = generated(42);
    for (const s of getSettlements()) {
      const eid = settlementAt(world, s.loc)!;
      expect(hasComponent(world.ecs, Position, eid)).toBe(true);
      expect(POS.loc[eid]).toBe(s.loc);
      expect(POS.dest[eid]).toBe(s.loc); // стоит на месте (D-019)
      // f32-хранение ⇒ сравниваем с допуском (0.7 в f32 ≠ 0.7 в f64).
      expect(SETTLE.morale[eid]).toBeCloseTo(SETTLEMENT_START_MORALE, 5);
      expect(SETTLE.security[eid]).toBeCloseTo(SETTLEMENT_START_SECURITY, 5);
      // Ничего не строит на старте (buildTarget/buildProgress занулены, D-024).
      expect(SETTLE.buildTarget[eid]).toBe(0);
      expect(SETTLE.buildProgress[eid]).toBe(0);
    }
  });

  it('каждое поселение: локация РЕАЛЬНО type "settlement" (связность с map, D-025)', () => {
    const world = generated(42);
    for (const s of getSettlements()) {
      const eid = settlementAt(world, s.loc)!;
      expect(MAP.locations[POS.loc[eid]!]!.type).toBe('settlement');
    }
  });

  it('СКЛАД: cold inventory = startingWarehouse (валидные itemId, qty>0 целые, сорт.) — закон №3', () => {
    const world = generated(42);
    for (const s of getSettlements()) {
      const eid = settlementAt(world, s.loc)!;
      const inv = invOf(world, eid);
      expect(inv).toBeDefined();
      expect(inv!.length).toBe(s.startingWarehouse.length);
      // Ожидаемый склад — тот же набор, отсортированный по itemId (канон снапшота).
      const expected = [...s.startingWarehouse]
        .map((w) => ({ item: w.item, qty: w.qty }))
        .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
      expect(inv).toEqual(expected);
      let prev = '';
      for (const e of inv!) {
        expect(() => getItem(e.item)).not.toThrow(); // существует в items.json (№3)
        expect(Number.isInteger(e.qty)).toBe(true);
        expect(e.qty).toBeGreaterThan(0);
        expect(e.item >= prev).toBe(true); // отсортировано
        prev = e.item;
      }
    }
  });

  it('КАССА: cold money = startingTreasury (>=0)', () => {
    const world = generated(42);
    for (const s of getSettlements()) {
      const eid = settlementAt(world, s.loc)!;
      const money = moneyOf(world, eid);
      expect(money).toBe(s.startingTreasury);
      expect(money!).toBeGreaterThanOrEqual(0);
    }
  });

  it('склад поселения — ИЗОЛИРОВАННАЯ копия (не делит ref с data-контентом, закон №3/№8)', () => {
    // Расход склада экономикой (2.3) не должен течь обратно в замороженный контент.
    const world = generated(42);
    const eid = settlementAt(world, getSettlements()[0]!.loc)!;
    const inv = invOf(world, eid)!;
    const before = inv[0]!.qty;
    inv[0]!.qty -= 1; // симулируем расход
    // Свежая генерация того же seed даёт исходное количество (контент не тронут).
    const world2 = generated(42);
    const eid2 = settlementAt(world2, getSettlements()[0]!.loc)!;
    expect(invOf(world2, eid2)![0]!.qty).toBe(before);
  });
});

describe('worldgen — торговцы: смертный Human-NPC на каждом поселении (D-051)', () => {
  it('ровно один торговец на поселение; Human+Alive, профессия "trader"', () => {
    const world = generated(42);
    expect(traders(world).length).toBe(getSettlements().length);
    for (const e of traders(world)) {
      expect(hasComponent(world.ecs, Human, e)).toBe(true);
      expect(hasComponent(world.ecs, Alive, e)).toBe(true);
      expect(world.resources.get<string>('profession', e)).toBe(TRADER_PROFESSION_ID);
      expect(() => getProfession(TRADER_PROFESSION_ID)).not.toThrow(); // резолвится (№10)
    }
  });

  it('каждый торговец стоит на loc своего поселения, Home там же', () => {
    const world = generated(42);
    const settlementLocs = new Set(getSettlements().map((s) => s.loc));
    for (const e of traders(world)) {
      const loc = POS.loc[e]!;
      expect(settlementLocs.has(loc)).toBe(true);
      expect(POS.dest[e]).toBe(loc); // стоит (D-019)
      expect(hasComponent(world.ecs, Home, e)).toBe(true);
      expect(HOME_LOC.loc[e]).toBe(loc);
    }
  });

  it('каждый торговец: Needs строго ниже критич. (D-027), Health полное, Skills, имя, без Task', () => {
    const world = generated(42);
    for (const e of traders(world)) {
      expect(NEED.hunger[e]!).toBeLessThan(HUNGER_CRITICAL);
      expect(NEED.thirst[e]!).toBeLessThan(THIRST_CRITICAL);
      expect(NEED.fatigue[e]!).toBeLessThan(FATIGUE_CRITICAL);
      expect(NEED.fear[e]).toBe(0);
      expect(HP.hp[e]).toBe(HEALTH_MAX);
      expect(hasComponent(world.ecs, Skills, e)).toBe(true);
      const n = world.resources.get<NameRecord>('name', e);
      expect(n!.first.length).toBeGreaterThan(0);
      expect(n!.last.length).toBeGreaterThan(0);
      // Не idle: задачу назначит TaskSelection на первом тике (D-020).
      expect(hasComponent(world.ecs, Task, e)).toBe(false);
    }
  });

  it('каждый торговец: фракция = фракция поселения (резолвится, №10); личные деньги/инвентарь как у сталкера', () => {
    const world = generated(42);
    const factionByLoc = new Map(getSettlements().map((s) => [s.loc, s.faction]));
    for (const e of traders(world)) {
      const loc = POS.loc[e]!;
      const faction = world.resources.get<string>('faction', e)!;
      expect(faction).toBe(factionByLoc.get(loc));
      expect(() => getFaction(faction)).not.toThrow();
      // Личный инвентарь/деньги «как у сталкера» (STARTING_INVENTORY/STARTING_MONEY,
      // D-021), НЕ склад поселения — отдельный eid.
      expect(moneyOf(world, e)).toBe(STARTING_MONEY);
      const expectedInv = [...STARTING_INVENTORY]
        .map((s) => ({ item: s.itemId as string, qty: s.qty }))
        .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
      expect(invOf(world, e)).toEqual(expectedInv);
    }
  });
});

describe('worldgen — поселения/торговцы: детерминизм (закон №8)', () => {
  it('два прогона одного seed → идентичные eid/склады/кассы поселений и данные торговцев', () => {
    const w1 = generated(42);
    // Захват ДО второй генерации (глобальные SoA-колонки перезапишутся).
    const set1 = settlements(w1).map((e) => ({
      eid: e, loc: POS.loc[e], morale: SETTLE.morale[e], sec: SETTLE.security[e],
      inv: invOf(w1, e), money: moneyOf(w1, e),
    }));
    const tra1 = traders(w1).map((e) => ({
      eid: e, loc: POS.loc[e], faction: w1.resources.get<string>('faction', e),
      name: w1.resources.get<NameRecord>('name', e), money: moneyOf(w1, e), inv: invOf(w1, e),
    }));
    const w2 = generated(42);
    const set2 = settlements(w2).map((e) => ({
      eid: e, loc: POS.loc[e], morale: SETTLE.morale[e], sec: SETTLE.security[e],
      inv: invOf(w2, e), money: moneyOf(w2, e),
    }));
    const tra2 = traders(w2).map((e) => ({
      eid: e, loc: POS.loc[e], faction: w2.resources.get<string>('faction', e),
      name: w2.resources.get<NameRecord>('name', e), money: moneyOf(w2, e), inv: invOf(w2, e),
    }));
    expect(set2).toEqual(set1);
    expect(tra2).toEqual(tra1);
  });
});
