/**
 * @module @zona/sim/spawn-stalker.test
 *
 * Гейт извлечённой `spawnStalker` (рефактор 2.14a, D-059) — переиспользуемого
 * рождения ОДНОГО человека, которым worldgen (1.3) заселяет когорту/торговцев, а
 * PopulationInflux (2.14/D-051) позже — новоприбывших. Покрывает DoD рефактора:
 *  - ДЕТЕРМИНИЗМ (закон №8): один seed/rng-подпоток → тождественный сталкер
 *    (имя/навыки/нужды/инвентарь/профессия/деньги);
 *  - КОНТРАКТ: Position(стоит) + Needs(<крит, D-027) + Health(полное) + Skills +
 *    Home + Human + Alive + имя(непустые first/last) + инвентарь; БЕЗ Task (D-020);
 *  - SEAM 2.14: loc/home управляют размещением (вход = ENTRY_LOCATION);
 *  - ИНВЕНТАРЬ — независимые копии (не aliasing, закон №3): фабрика зовётся на КАЖДОГО;
 *  - ПРОФЕССИЯ: kind:'pick' берёт из пула (тратит rng), kind:'fixed' — ровно заданный
 *    id (rng не трогает) — отсюда бит-в-бит совпадение потоков когорты/торговца.
 *
 * SoA-колонки — глобальные singleton'ы по eid: где два мира делят eid, состояние
 * первого захватывается в примитивы/строку ДО генерации второго (как worldgen.test).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, FactionId, Seed } from '@zona/shared';
import { createSimWorld, type SimWorld } from './core/world';
import type { Rng } from './core/rng';
import { hasComponent } from './core/ecs';
import {
  Position,
  Needs,
  Health,
  Skills,
  Home,
  Task,
  Human,
  Alive,
} from './core/components';
import {
  HUNGER_CRITICAL,
  THIRST_CRITICAL,
  FATIGUE_CRITICAL,
  HEALTH_MAX,
} from './balance/needs';
import { STARTING_MONEY, STARTING_PROFESSION_IDS, ENTRY_LOCATION } from './balance/worldgen';
import { NAMES } from './data/index';
import { spawnStalker, type SpawnStalkerConfig } from './worldgen';
import type { ItemId, LocationId } from '@zona/shared';

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
const HOME = Home as unknown as { loc: Uint32Array };

interface NameRecord {
  first: string;
  last: string;
  nickname: string;
}
interface InvEntry {
  item: string;
  qty: number;
}

/** Фабрика свежего инвентаря (две единицы, отсортировано) — своя копия на NPC. */
function freshInventory(): { item: ItemId; qty: number }[] {
  return [
    { item: 'ammo_9mm' as ItemId, qty: 16 },
    { item: 'pm' as ItemId, qty: 1 },
  ];
}

/** Конфиг стартового сталкера (pick-профессия) с настраиваемым размещением. */
function cohortCfg(
  usedNames: Set<string>,
  loc: LocationId = ENTRY_LOCATION as LocationId,
): SpawnStalkerConfig {
  return {
    loc,
    home: loc,
    faction: 'loners' as FactionId,
    profession: { kind: 'pick', from: STARTING_PROFESSION_IDS },
    money: STARTING_MONEY,
    inventory: freshInventory,
    usedNames,
  };
}

/** Полный снимок данных одного NPC (для сравнения детерминизма). */
function snapshotNpc(world: SimWorld, eid: EntityId) {
  return {
    loc: POS.loc[eid], dest: POS.dest[eid], eta: POS.etaTicks[eid],
    hunger: NEED.hunger[eid], thirst: NEED.thirst[eid], fatigue: NEED.fatigue[eid], fear: NEED.fear[eid],
    hp: HP.hp[eid], sh: SKILL.shooting[eid], su: SKILL.survival[eid], st: SKILL.stealth[eid],
    home: HOME.loc[eid],
    name: world.resources.get<NameRecord>('name', eid),
    faction: world.resources.get<string>('faction', eid),
    profession: world.resources.get<string>('profession', eid),
    money: world.resources.get<number>('money', eid),
    inv: world.resources.get<InvEntry[]>('inventory', eid),
  };
}

describe('spawnStalker — детерминизм (закон №8)', () => {
  it('тот же seed/подпоток → тождественный сталкер (имя/навыки/нужды/инвентарь/профессия)', () => {
    const wA = createSimWorld(77 as Seed);
    const rA = wA.rng.fork('spawn');
    const eidA = spawnStalker(wA, rA, cohortCfg(new Set()));
    const snapA = snapshotNpc(wA, eidA); // захват ДО второй генерации (глобальные SoA)

    const wB = createSimWorld(77 as Seed);
    const rB = wB.rng.fork('spawn');
    const eidB = spawnStalker(wB, rB, cohortCfg(new Set()));
    expect(eidB).toBe(eidA); // тот же порядок спавна ⇒ тот же eid (D-011)
    expect(snapshotNpc(wB, eidB)).toEqual(snapA);
  });

  it('разные seed → разный сталкер (rng реально работает)', () => {
    const wA = createSimWorld(1 as Seed);
    const eidA = spawnStalker(wA, wA.rng.fork('spawn'), cohortCfg(new Set()));
    const nameA = wA.resources.get<NameRecord>('name', eidA)!;
    const skA = SKILL.shooting[eidA];

    const wB = createSimWorld(2 as Seed);
    const eidB = spawnStalker(wB, wB.rng.fork('spawn'), cohortCfg(new Set()));
    const nameB = wB.resources.get<NameRecord>('name', eidB)!;
    // Хотя бы что-то различается (имя ИЛИ навык) — потоки не склеены.
    const differs =
      `${nameA.first}|${nameA.last}` !== `${nameB.first}|${nameB.last}` || skA !== SKILL.shooting[eidB];
    expect(differs).toBe(true);
  });
});

describe('spawnStalker — контракт NPC (D-020/D-027, законы №3/№4)', () => {
  it('Position(стоит) + Needs(<крит) + Health(полное) + Skills + Home + Human + Alive; БЕЗ Task', () => {
    const world = createSimWorld(42 as Seed);
    const eid = spawnStalker(world, world.rng.fork('spawn'), cohortCfg(new Set()));

    expect(hasComponent(world.ecs, Position, eid)).toBe(true);
    expect(POS.dest[eid]).toBe(POS.loc[eid]); // стоит (D-019)
    expect(POS.etaTicks[eid]).toBe(0);

    expect(NEED.hunger[eid]!).toBeLessThan(HUNGER_CRITICAL);
    expect(NEED.thirst[eid]!).toBeLessThan(THIRST_CRITICAL);
    expect(NEED.fatigue[eid]!).toBeLessThan(FATIGUE_CRITICAL);
    expect(NEED.fear[eid]).toBe(0);

    expect(HP.hp[eid]).toBe(HEALTH_MAX);
    expect(hasComponent(world.ecs, Skills, eid)).toBe(true);
    expect(hasComponent(world.ecs, Home, eid)).toBe(true);
    expect(hasComponent(world.ecs, Human, eid)).toBe(true);
    expect(hasComponent(world.ecs, Alive, eid)).toBe(true);

    const n = world.resources.get<NameRecord>('name', eid)!;
    expect(n.first.length).toBeGreaterThan(0);
    expect(n.last.length).toBeGreaterThan(0);
    expect(n.nickname.length).toBeGreaterThan(0);

    // Не idle: задачу назначит TaskSelection на первом тике (D-020).
    expect(hasComponent(world.ecs, Task, eid)).toBe(false);
  });
});

describe('spawnStalker — SEAM размещения для 2.14 (D-051)', () => {
  it('loc/home управляют размещением (вход в произвольную loc, Home там же)', () => {
    const world = createSimWorld(5 as Seed);
    const entry = 3 as LocationId;
    const eid = spawnStalker(world, world.rng.fork('spawn'), {
      ...cohortCfg(new Set()),
      loc: entry,
      home: entry,
    });
    expect(POS.loc[eid]).toBe(entry);
    expect(POS.dest[eid]).toBe(entry);
    expect(HOME.loc[eid]).toBe(entry);
  });

  it('деньги/фракция берутся из конфига (внесены извне, D-021)', () => {
    const world = createSimWorld(5 as Seed);
    const eid = spawnStalker(world, world.rng.fork('spawn'), {
      ...cohortCfg(new Set()),
      faction: 'loners' as FactionId,
      money: 1234,
    });
    expect(world.resources.get<number>('money', eid)).toBe(1234);
    expect(world.resources.get<string>('faction', eid)).toBe('loners');
  });
});

describe('spawnStalker — профессия: pick vs fixed (сохранение потока rng)', () => {
  it('kind:"pick" → id из пула STARTING_PROFESSION_IDS', () => {
    const world = createSimWorld(9 as Seed);
    const eid = spawnStalker(world, world.rng.fork('spawn'), cohortCfg(new Set()));
    expect(STARTING_PROFESSION_IDS).toContain(world.resources.get<string>('profession', eid));
  });

  it('kind:"fixed" → ровно заданный id и НЕ тратит rng.pick (тот же поток, что без профессии)', () => {
    // Ключ бит-в-бит совпадения торговца: fixed-профессия не продвигает rng. Значит
    // ПОСЛЕ спавна с fixed-профессией подпоток стоит там же, где стоял бы, если бы
    // профессия не выбиралась вовсе. Проверяем через СЛЕДУЮЩИЙ вызов rng: два спавна
    // fixed-профессии из одного seed дают идентичный поток (имя следующего NPC).
    const wA = createSimWorld(11 as Seed);
    const rA = wA.rng.fork('spawn');
    const fixedCfg: SpawnStalkerConfig = {
      ...cohortCfg(new Set()),
      profession: { kind: 'fixed', id: 'trader' },
    };
    const e1 = spawnStalker(wA, rA, fixedCfg);
    expect(wA.resources.get<string>('profession', e1)).toBe('trader');
    // Следующий NPC из ТОГО ЖЕ потока — фиксируем его имя как отпечаток позиции rng.
    const e2 = spawnStalker(wA, rA, { ...fixedCfg, usedNames: new Set() });
    const fingerprint = JSON.stringify(wA.resources.get<NameRecord>('name', e2));

    const wB = createSimWorld(11 as Seed);
    const rB = wB.rng.fork('spawn');
    spawnStalker(wB, rB, { ...fixedCfg }); // тоже fixed, тоже без rng.pick
    const e2b = spawnStalker(wB, rB, { ...fixedCfg, usedNames: new Set() });
    expect(JSON.stringify(wB.resources.get<NameRecord>('name', e2b))).toBe(fingerprint);
  });
});

describe('spawnStalker — инвентарь: независимые копии (закон №3, не aliasing)', () => {
  it('каждый NPC получает СВОЮ копию; мутация одного не трогает соседа', () => {
    const world = createSimWorld(3 as Seed);
    const rng = world.rng.fork('spawn');
    const used = new Set<string>();
    const e0 = spawnStalker(world, rng, cohortCfg(used));
    const e1 = spawnStalker(world, rng, cohortCfg(used));

    const inv0 = world.resources.get<InvEntry[]>('inventory', e0)!;
    const inv1 = world.resources.get<InvEntry[]>('inventory', e1)!;
    // Разные массивы и разные вложенные объекты.
    expect(inv0).not.toBe(inv1);
    expect(inv0[0]).not.toBe(inv1[0]);
    expect(inv0).toEqual(inv1); // но значения тождественны

    const before = inv1[0]!.qty;
    inv0[0]!.qty -= 1;
    inv0.push({ item: 'meat', qty: 1 });
    expect(inv1[0]!.qty).toBe(before); // сосед не пострадал
    expect(inv1.some((x) => x.item === 'meat')).toBe(false);
  });

  // Фабрика — ЕДИНСТВЕННЫЙ мост к леджеру item/broughtIn (2.14/D-052): 2.14
  // заледжерит «внесено из-за Периметра» по возвращённому eid. Если spawnStalker
  // дёрнет фабрику дважды (или ноль раз), 2.14 удвоит/потеряет источник — предметы
  // из воздуха (закон №3). Контракт docblock'а: РОВНО один вызов на NPC.
  it('фабрика инвентаря вызывается РОВНО один раз на NPC (мост к леджеру broughtIn, D-052)', () => {
    const world = createSimWorld(4 as Seed);
    let calls = 0;
    const countingInventory = () => {
      calls += 1;
      return freshInventory();
    };
    const rng = world.rng.fork('spawn');
    const used = new Set<string>();
    spawnStalker(world, rng, { ...cohortCfg(used), inventory: countingInventory });
    expect(calls).toBe(1);
    // И на второго NPC — ещё ровно один вызов (не «один на всю когорту»).
    spawnStalker(world, rng, { ...cohortCfg(used), inventory: countingInventory });
    expect(calls).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// УСИЛЕНИЕ 2.14a (QA): порядок/ЧИСЛО rng-вызовов, коллизия имён через usedNames,
// loc≠home как независимые ручки seam'а, валидность eid. Голдены Фазы 1 доказывают
// бит-в-бит эквивалентность инлайну ЦЕЛИКОМ; эти тесты локализуют, ГДЕ именно
// сломается поток, если кто-то тронет порядок потребления rng (D-059 п.3).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rng-обёртка, ЛОГИРУЮЩАЯ имя каждого high-level вызова (next/int/range/pick) в
 * порядке потребления. Делегирует реальному потоку (значения настоящие,
 * детерминизм не нарушен). Так тест фиксирует ТОЧНУЮ форму потока spawnStalker:
 * нужды×3(range) → навыки×3(range) → имя(int,int,pick,pick) → [профессия pick].
 * pick реального потока внутри дёргает int САМ, но это int ВНУТРЕННЕГО rng —
 * в лог обёртки он не попадает (считаем ровно вызовы, сделанные spawnStalker).
 */
function tracingRng(inner: Rng): { rng: Rng; log: string[] } {
  const log: string[] = [];
  const rng: Rng = {
    next(): number {
      log.push('next');
      return inner.next();
    },
    int(a: number, b: number): number {
      log.push('int');
      return inner.int(a, b);
    },
    range(a: number, b: number): number {
      log.push('range');
      return inner.range(a, b);
    },
    pick<T>(arr: readonly T[]): T {
      log.push('pick');
      return inner.pick(arr);
    },
    fork(label: string): Rng {
      return inner.fork(label);
    },
    get state(): number {
      return inner.state;
    },
  };
  return { rng, log };
}

describe('spawnStalker — форма потока rng (порядок и число вызовов, D-059 п.3)', () => {
  // Ожидаемый скелет для КОГОРТЫ (профессия pick): 6× range (3 нужды + 3 навыка),
  // затем имя = int,int,pick,pick (fi, li, шаблон клички, опция клички), затем
  // профессия = ещё один pick, затем ЛИЧНОСТЬ (задача 3.3, D-071 — В КОНЦЕ):
  // temperament = int (взвешенный выбор ОДНИМ rng.int) → talkativeness = range.
  // Любая вставка/перестановка rng-вызова сдвинула бы голдены — тут она провалит
  // ИМЕННО этот assert, локализуя регрессию.
  const NEEDS_AND_SKILLS = ['range', 'range', 'range', 'range', 'range', 'range'];
  const NAME = ['int', 'int', 'pick', 'pick'];
  const PERSONALITY = ['int', 'range']; // temperament (взвеш. int) → talkativeness (range)

  it('kind:"pick" (когорта): range×6 → int,int,pick,pick → pick(профессия) → int,range(личность)', () => {
    const world = createSimWorld(42 as Seed);
    const { rng, log } = tracingRng(world.rng.fork('spawn'));
    spawnStalker(world, rng, cohortCfg(new Set()));
    expect(log).toEqual([...NEEDS_AND_SKILLS, ...NAME, 'pick', ...PERSONALITY]);
  });

  it('kind:"fixed" (торговец): тот же поток БЕЗ финального pick профессии', () => {
    const world = createSimWorld(42 as Seed);
    const { rng, log } = tracingRng(world.rng.fork('spawn'));
    spawnStalker(world, rng, {
      ...cohortCfg(new Set()),
      profession: { kind: 'fixed', id: 'trader' },
    });
    // Ровно на ОДИН pick короче когорты — «fixed профессию rng не выбирает».
    expect(log).toEqual([...NEEDS_AND_SKILLS, ...NAME, ...PERSONALITY]);
    expect(log.filter((c) => c === 'pick')).toHaveLength(2); // только клички
  });

  it('fixed ровно на один rng-вызов короче pick (счётчик, не только форма)', () => {
    const wPick = createSimWorld(1 as Seed);
    const tPick = tracingRng(wPick.rng.fork('spawn'));
    spawnStalker(wPick, tPick.rng, cohortCfg(new Set()));

    const wFixed = createSimWorld(1 as Seed);
    const tFixed = tracingRng(wFixed.rng.fork('spawn'));
    spawnStalker(wFixed, tFixed.rng, {
      ...cohortCfg(new Set()),
      profession: { kind: 'fixed', id: 'trader' },
    });
    expect(tPick.log.length - tFixed.log.length).toBe(1);
  });
});

describe('spawnStalker — usedNames предотвращает коллизию полных имён (закон №4)', () => {
  // ВНИМАНИЕ (QA-находка 2.14a, low): docblock SpawnStalkerConfig.usedNames обещает
  // Set ключей «first|last» (имена-строки), но pickName РЕАЛЬНО кладёт/проверяет
  // ключ «fi|li» — ИНДЕКСЫ в NAMES.first/NAMES.last. Внутри одного прогона это
  // эквивалентно (в names.json нет строк-дублей ⇒ индекс↔имя биективны), поэтому
  // голдены/дедуп когорты целы. Но для 2.14 (PopulationInflux): если новый caller
  // по документации пред-заполнит Set РЕАЛЬНЫМИ именами уже живущих NPC, чтобы не
  // столкнуться с ними, — pickName эти строки НЕ УВИДИТ (сверяет индексы). Тест
  // кодирует ФАКТИЧЕСКИЙ ключ (индексный), а не документированный (строковый).
  it('занятый ключ "fi|li" → пробинг выдаёт ДРУГОЕ полное имя (кличка та же — пробинг без rng)', () => {
    const seed = 123 as Seed;
    // Сначала узнаём, какое полное имя spawnStalker выдал бы «первым» на этом seed.
    const wA = createSimWorld(seed);
    const eA = spawnStalker(wA, wA.rng.fork('spawn'), cohortCfg(new Set()));
    const nameA = wA.resources.get<NameRecord>('name', eA)!;
    const keyA = `${nameA.first}|${nameA.last}`;
    const nickA = nameA.nickname; // захват ДО второй генерации (глобальные SoA)
    // Реальный ключ дедупликации — ИНДЕКСНЫЙ (fi|li); строки уникальны ⇒ indexOf точен.
    const idxKey = `${NAMES.first.indexOf(nameA.first)}|${NAMES.last.indexOf(nameA.last)}`;

    // Тот же seed → тот же fresh-поток выбрал бы ТО ЖЕ имя первым. Но idxKey уже занят:
    // линейный пробинг ОБЯЗАН уехать на другую комбинацию (fi|li ⇒ другое first|last).
    const wB = createSimWorld(seed);
    const eB = spawnStalker(wB, wB.rng.fork('spawn'), cohortCfg(new Set([idxKey])));
    const nameB = wB.resources.get<NameRecord>('name', eB)!;
    expect(`${nameB.first}|${nameB.last}`).not.toBe(keyA); // коллизия исключена
    // Кличка выбирается ДО пробинга и rng-нейтральна к нему ⇒ идентична (доказывает,
    // что пробинг НЕ тратит rng — иначе поток когорты съехал бы, D-059 п.3).
    expect(nameB.nickname).toBe(nickA);
  });

  it('SEAM-РИСК 2.14: пред-заполнение Set РЕАЛЬНЫМ именем (как в docblock) НЕ мешает коллизии', () => {
    // Документирует расхождение контракта: caller, следующий docblock'у usedNames
    // («Set first|last»), пред-заполняет строкой-именем — pickName её игнорирует
    // (сверяет индексный ключ) и всё равно может выдать это же имя. Тест ФИКСИРУЕТ
    // текущее поведение как известное (не «случайность»), чтобы фикс в проде (или
    // правка docblock'а) осознанно менял этот assert. Продакшн не трогаем (2.14a).
    const seed = 123 as Seed;
    const wA = createSimWorld(seed);
    const eA = spawnStalker(wA, wA.rng.fork('spawn'), cohortCfg(new Set()));
    const nameA = wA.resources.get<NameRecord>('name', eA)!;
    const stringKey = `${nameA.first}|${nameA.last}`; // ключ «как в docblock»

    const wB = createSimWorld(seed);
    const eB = spawnStalker(wB, wB.rng.fork('spawn'), cohortCfg(new Set([stringKey])));
    const nameB = wB.resources.get<NameRecord>('name', eB)!;
    // Строковый ключ не распознан ⇒ имя НЕ изменилось (совпадает с A). Это баг seam'а
    // для 2.14, а НЕ для worldgen (worldgen сам кладёт индексные ключи, у него целостно).
    expect(`${nameB.first}|${nameB.last}`).toBe(stringKey);
  });

  it('общий usedNames на серию спавнов → ни одного полного дубля в когорте', () => {
    const world = createSimWorld(42 as Seed);
    const rng = world.rng.fork('spawn');
    const used = new Set<string>();
    const keys = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const e = spawnStalker(world, rng, cohortCfg(used));
      const n = world.resources.get<NameRecord>('name', e)!;
      keys.add(`${n.first}|${n.last}`);
    }
    expect(keys.size).toBe(10); // 10 РАЗНЫХ полных имён
  });
});

describe('spawnStalker — seam размещения loc≠home + валидность eid (D-051)', () => {
  it('loc и home — НЕЗАВИСИМЫЕ ручки: вход в loc, база — иная home', () => {
    // 2.14: новичок входит в точку входа (loc), но его база (Home) может быть иной.
    // Продакшн сейчас всегда loc===home, но seam обязан их РАЗЛИЧАТЬ, не склеивать.
    const world = createSimWorld(8 as Seed);
    const entry = 0 as LocationId;
    const base = 4 as LocationId;
    const eid = spawnStalker(world, world.rng.fork('spawn'), {
      ...cohortCfg(new Set()),
      loc: entry,
      home: base,
    });
    expect(POS.loc[eid]).toBe(entry);
    expect(POS.dest[eid]).toBe(entry); // стоит на точке входа (D-019), не движется
    expect(HOME.loc[eid]).toBe(base); // но база — ДРУГАЯ локация
  });

  it('возвращённый eid валиден: несёт Human+Alive+Position; серия спавнов → разные eid', () => {
    const world = createSimWorld(7 as Seed);
    const rng = world.rng.fork('spawn');
    const used = new Set<string>();
    const eids = [0, 1, 2, 3].map(() => spawnStalker(world, rng, cohortCfg(used)));
    expect(new Set(eids).size).toBe(eids.length); // каждый спавн — свой eid
    for (const e of eids) {
      expect(hasComponent(world.ecs, Human, e)).toBe(true);
      expect(hasComponent(world.ecs, Alive, e)).toBe(true);
      expect(hasComponent(world.ecs, Position, e)).toBe(true);
    }
  });

  it('kind:"pick" из пула ОДНОГО элемента → детерминированно тот элемент', () => {
    const world = createSimWorld(6 as Seed);
    const only = STARTING_PROFESSION_IDS[0]!;
    const eid = spawnStalker(world, world.rng.fork('spawn'), {
      ...cohortCfg(new Set()),
      profession: { kind: 'pick', from: [only] },
    });
    expect(world.resources.get<string>('profession', eid)).toBe(only);
  });
});
