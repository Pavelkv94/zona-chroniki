/**
 * @module @zona/sim/worldgen
 *
 * Стартовая генерация мира (задача 1.3). Вызывается РОВНО ОДИН РАЗ при сборке мира
 * (headless-CLI 1.12), ДО первого тика планировщика. Населяет пустой `SimWorld`
 * сущностью-миром (WorldClock singleton), 20 сталкерами в Кордоне и стадами
 * животных в глубоких диких/руинных локациях.
 *
 * ── Закон №1 (мир живёт без игрока) ──────────────────────────────────────────
 * Игрока НЕТ. Сталкеры расставляются в ENTRY_LOCATION (Кордон, D-025) — точке
 * входа в Зону из-за Периметра, а НЕ «возле игрока». Дальше их распорядок задаёт
 * TaskSelection (1.8) из нужд/обстановки, не скрипт.
 *
 * ── Закон №2 / детерминизм (закон №8) ────────────────────────────────────────
 * Вся случайность генерации — из ОДНОГО подпотока `world.rng.fork('worldgen')`
 * (stateless-форк от seed, D-004/D-009), потребляемого в ФИКСИРОВАННОМ порядке
 * обхода. Это «генерация мира» (легальная категория rng, как погода D-028), а не
 * «X% шанс события у сущности». Одинаковый seed → идентичный мир (eid, имена,
 * позиции, инвентарь, навыки, стада).
 *
 * ── Закон №3 (ничего из воздуха) — ИСТОЧНИК стартового инвентаря (D-021) ──────
 * ПМ + патроны + консервы + вода + бинт и стартовые деньги каждого сталкера
 * ФИЗИЧЕСКИ ВНЕСЕНЫ ИЗ-ЗА ПЕРИМЕТРА при входе в Зону (GDD 4.7 приток одиночек со
 * снаряжением) — это внешний источник, а не эмиссия из ничего. Набор и суммы — в
 * balance/worldgen (STARTING_INVENTORY / STARTING_MONEY); каждый itemId существует
 * в items.json. Мясо/шкуры животных появятся позже физически (разделка туш, 1.10).
 *
 * ── Закон №4 (NPC с именем-фамилией; без idle) ───────────────────────────────
 * Каждый сталкер получает НЕПУСТЫЕ first И last из пула NAMES + кличку; полные
 * дубли (first+last) избегаются линейным пробингом (однофамильцы допустимы —
 * задокументировано). Состояния idle worldgen не создаёт: задачу назначит
 * TaskSelection на первом тике (D-020), поэтому компонент Task здесь НЕ ставится.
 *
 * Фракция/профессия сталкера — КОНТЕНТ в /sim/data (factions.json/professions.json,
 * закон №10); balance/worldgen хранит лишь ССЫЛКИ-id (STARTING_FACTION_ID /
 * STARTING_PROFESSION_IDS), а worldgen кладёт id в ResourceStore. Валидность id
 * (резолв через getFaction/getProfession) закреплена тестом связности balance↔data.
 *
 * Зависимости (что читает): balance/worldgen (числа/ссылки расстановки), balance/needs
 * (HEALTH_MAX), data (MAP, NAMES, getSpecies), core/components (SoA),
 * core/ecs (spawn/addComponent), world.resources (холодные данные, D-007).
 *
 * Пример:
 * ```ts
 * const world = createSimWorld(42 as Seed);
 * worldgen(world);        // мир заселён; готов к scheduler.tick()
 * ```
 */

import type { EntityId, FactionId, ItemId, LocationId } from '@zona/shared';
import type { SimWorld } from './core/world';
import type { Rng } from './core/rng';
import { spawnEntity, addComponent } from './core/ecs';
import {
  Position,
  Needs,
  Health,
  Skills,
  Home,
  Animal,
  WorldClock,
  Human,
  Alive,
  WEATHER_CODE,
} from './core/components';
import { MAP, NAMES, getSpecies } from './data/index';
import { HEALTH_MAX } from './balance/needs';
import {
  STALKER_COUNT,
  STARTING_FACTION_ID,
  STARTING_PROFESSION_IDS,
  STARTING_INVENTORY,
  STARTING_MONEY,
  ENTRY_LOCATION,
  STARTING_HERDS,
  HERD_MIN_GAME,
  HERD_MAX_DANGER,
  ANIMAL_START_HP,
  ANIMAL_HUNGER_MIN,
  ANIMAL_HUNGER_MAX,
  ANIMAL_THIRST_MIN,
  ANIMAL_THIRST_MAX,
  STARTING_HUNGER_MIN,
  STARTING_HUNGER_MAX,
  STARTING_THIRST_MIN,
  STARTING_THIRST_MAX,
  STARTING_FATIGUE_MIN,
  STARTING_FATIGUE_MAX,
  SKILL_MIN,
  SKILL_MAX,
} from './balance/worldgen';

// ── Типизированные проекции SoA-колонок ──────────────────────────────────────
// bitecs-компонент — объект-хранилище { field: TypedArray } (см. core/ecs). Наружу
// его форма не типизирована (ComponentRef = Record<string,FieldArray>), поэтому
// проецируем в узкие типы для записи. Идентичность объекта = идентичность компонента
// (addComponent регистрирует членство и зануляет поля, D-024).
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
const ANIMAL = Animal as unknown as { species: Uint8Array; herd: Uint32Array };
const CLOCK = WorldClock as unknown as { weather: Uint8Array; weatherSince: Uint32Array };

/** Запись имени сталкера в ResourceStore (D-007). first/last непусты (закон №4). */
interface NameRecord {
  readonly first: string;
  readonly last: string;
  /** Кличка (позывной). В Фазе 1 — детерминированный выбор из пула; привязка к
   *  чертам характера появится с TaskSelection/traits (1.8+). */
  readonly nickname: string;
}

/** Единица инвентаря в ResourceStore: ссылка на предмет + количество (закон №3). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/**
 * Заселяет пустой мир стартовым состоянием Зоны. Идемпотентности НЕ гарантирует —
 * вызывать РОВНО ОДИН РАЗ на свежесозданном `createSimWorld(seed)` до первого тика.
 * Мутирует `world` (ECS-сущности + ResourceStore) и НЕ публикует событий: источник
 * предметов задокументирован (D-021), генезис — корень причинности.
 */
export function worldgen(world: SimWorld): void {
  // ЕДИНЫЙ детерминированный подпоток генерации (D-004/D-021). Потребляется строго
  // в порядке ниже: мир → сталкеры → стада. Любая перестановка сломала бы seed→мир.
  const rng = world.rng.fork('worldgen');

  spawnWorldClock(world);
  spawnStalkers(world, rng);
  spawnHerds(world, rng);
}

// ── Сущность-мир: WorldClock singleton ───────────────────────────────────────

/**
 * Создаёт сущность-носитель WorldClock (D-019, singleton). Стартовая погода —
 * 'clear' (код 0), `weatherSince = 0`. Ровно ОДИН носитель: система Weather (1.6)
 * бросает при >1 (D-028), поэтому worldgen создаёт его единожды.
 */
function spawnWorldClock(world: SimWorld): void {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, WorldClock, eid); // зануляет поля (D-024)
  CLOCK.weather[eid] = WEATHER_CODE.clear; // ясно на старте (индекс 0)
  CLOCK.weatherSince[eid] = 0;
}

// ── Сталкеры (20, Кордон) ────────────────────────────────────────────────────

/**
 * Расставляет STALKER_COUNT сталкеров в ENTRY_LOCATION (Кордон, loc 0 — стартово
 * безопасен, D-025). Каждый: Position(стоит в Кордоне), Needs (ниже критических,
 * D-027), Health (полное), Skills (разброс), Home(Кордон), теги Human+Alive;
 * холодные данные (имя/фракция/профессия/деньги/инвентарь) — в ResourceStore.
 * Task НЕ ставится: назначит TaskSelection на первом тике (D-020).
 */
function spawnStalkers(world: SimWorld, rng: Rng): void {
  const usedNames = new Set<string>(); // «first|last» — избегаем полных дублей

  for (let i = 0; i < STALKER_COUNT; i++) {
    const eid = spawnEntity(world.ecs);

    // Position: стоит в Кордоне (dest===loc ⇒ без движения, D-019).
    addComponent(world.ecs, Position, eid);
    POS.loc[eid] = ENTRY_LOCATION;
    POS.dest[eid] = ENTRY_LOCATION;
    POS.etaTicks[eid] = 0;

    // Needs: строго ниже критических порогов (D-027); страха нет.
    addComponent(world.ecs, Needs, eid);
    NEED.hunger[eid] = rng.range(STARTING_HUNGER_MIN, STARTING_HUNGER_MAX);
    NEED.thirst[eid] = rng.range(STARTING_THIRST_MIN, STARTING_THIRST_MAX);
    NEED.fatigue[eid] = rng.range(STARTING_FATIGUE_MIN, STARTING_FATIGUE_MAX);
    NEED.fear[eid] = 0;

    // Health: входят в Зону здоровыми (D-021).
    addComponent(world.ecs, Health, eid);
    HP.hp[eid] = HEALTH_MAX;

    // Skills: детерминированный разброс в разумных границах.
    addComponent(world.ecs, Skills, eid);
    SKILL.shooting[eid] = rng.range(SKILL_MIN, SKILL_MAX);
    SKILL.survival[eid] = rng.range(SKILL_MIN, SKILL_MAX);
    SKILL.stealth[eid] = rng.range(SKILL_MIN, SKILL_MAX);

    // Home: база — Кордон (сон/хранение).
    addComponent(world.ecs, Home, eid);
    HOME.loc[eid] = ENTRY_LOCATION;

    // Теги.
    addComponent(world.ecs, Human, eid);
    addComponent(world.ecs, Alive, eid);

    // Холодные данные (D-007). Имя — непустые first+last (закон №4) + кличка.
    const name = pickName(rng, usedNames);
    world.resources.set<NameRecord>('name', eid, name);
    world.resources.set<FactionId>('faction', eid, STARTING_FACTION_ID);
    world.resources.set<string>('profession', eid, rng.pick(STARTING_PROFESSION_IDS));
    world.resources.set<number>('money', eid, STARTING_MONEY);
    // СВЕЖИЙ инвентарь на КАЖДОГО сталкера (новый массив + новые {item,qty}): каждый
    // владеет своей копией. Иначе (общий массив) расход инвентаря in-place экономикой
    // (1.10) менял бы предметы у ВСЕХ сразу — исчезновение/появление из воздуха (№3).
    world.resources.set<readonly InventoryEntry[]>('inventory', eid, buildStartingInventory());
  }
}

/**
 * Строит СВЕЖУЮ копию стартового инвентаря (новый массив + новые объекты
 * `{item, qty}`) — вызывается на КАЖДОГО сталкера, чтобы владельцы не разделяли
 * ссылку (см. spawnStalkers: расход in-place экономикой 1.10 иначе течёт из
 * воздуха, закон №3). ОТСОРТИРОВАН по itemId (закон №8 — стабильный канон
 * снапшота). Источник — «внесено из-за Периметра» (D-021, docblock модуля). Все
 * itemId валидны в items.json (тест связности balance↔data).
 */
function buildStartingInventory(): InventoryEntry[] {
  return STARTING_INVENTORY.map((s) => ({ item: s.itemId, qty: s.qty }))
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

/**
 * Детерминированно выбирает имя (first+last+кличка), избегая ПОЛНЫХ дублей
 * (first+last) через линейный пробинг по фамилии/имени БЕЗ доп. rng-вызовов
 * (сохраняет позицию в потоке детерминированной). Однофамильцы (одна фамилия,
 * разные имена) допустимы — пул 20×20 покрывает 20 сталкеров с запасом; при
 * гипотетическом исчерпании пробинг всё равно завершится (полный обход комбинаций).
 */
function pickName(rng: Rng, used: Set<string>): NameRecord {
  const first = NAMES.first;
  const last = NAMES.last;
  let fi = rng.int(0, first.length);
  let li = rng.int(0, last.length);
  // Кличка — детерминированный позывной из пула шаблонов (привязка к чертам — 1.8+).
  const pattern = rng.pick(NAMES.nicknamePatterns);
  const nickname = rng.pick(pattern.options);

  // Пробинг по (li, затем fi) — детерминированный обход комбинаций без rng.
  for (let step = 0; step < first.length * last.length; step++) {
    const key = `${fi}|${li}`;
    if (!used.has(key)) {
      used.add(key);
      break;
    }
    li = (li + 1) % last.length;
    if (li === 0) fi = (fi + 1) % first.length;
  }
  return { first: first[fi] as string, last: last[li] as string, nickname };
}

// ── Стада животных (wild/ruins, game>порога) ─────────────────────────────────

/**
 * Заселяет стада по STARTING_HERDS. Пригодные локации: type ∈ {wild, ruins},
 * game > HERD_MIN_GAME и danger < HERD_MAX_DANGER (D-025 — глубокие дикие
 * территории, но НЕ смертельные зоны; исключение выражено через ДАННЫЕ, не
 * хардкод-id). Каждое стадо получает УНИКАЛЬНЫЙ номер (глобальный счётчик),
 * локацию (rng.pick) и размер ∈ [herdMin, herdMax] вида. Особи: Position(в
 * локации стада), Needs (низкие), Health, Animal(species,herd), тег Alive.
 */
function spawnHerds(world: SimWorld, rng: Rng): void {
  const eligible = eligibleHerdLocations();
  // Пустой набор пригодных локаций = ошибка контента/баланса: стадам негде жить.
  if (eligible.length === 0) {
    throw new Error(
      'worldgen: нет пригодных локаций для стад (wild/ruins с game > HERD_MIN_GAME).',
    );
  }

  let herdNo = 0; // глобальный уникальный номер стада (детерминирован порядком обхода)
  // STARTING_HERDS обходится в объявленном порядке (по возрастанию speciesId) —
  // порядок фиксирован в balance, поток rng детерминирован.
  for (const entry of STARTING_HERDS) {
    const species = getSpecies(entry.speciesId); // бросит на неизвестном виде
    for (let h = 0; h < entry.herds; h++) {
      const loc = rng.pick(eligible);
      const size = rng.int(species.herdMin, species.herdMax + 1); // включительно herdMax
      const herd = herdNo++;
      for (let a = 0; a < size; a++) {
        spawnAnimal(world, rng, species.id, herd, loc);
      }
    }
  }
}

/**
 * Пригодные для стад локации (D-025): habitat wild/ruins, game > HERD_MIN_GAME и
 * danger < HERD_MAX_DANGER. Смертельные зоны (Саркофаг danger=1.0) исключаются
 * ПО ДАННЫМ (`loc.danger`), а не по хардкод-id — future-proof для новых карт.
 * Отсортированы по возрастанию id (детерминизм, закон №8) — rng.pick воспроизводим.
 */
function eligibleHerdLocations(): readonly LocationId[] {
  const out: LocationId[] = [];
  for (const loc of MAP.locations) {
    const habitat = loc.type === 'wild' || loc.type === 'ruins';
    if (habitat && loc.game > HERD_MIN_GAME && loc.danger < HERD_MAX_DANGER) {
      out.push(loc.id as LocationId);
    }
  }
  // MAP.locations уже по возрастанию id (плотный индекс), порядок сохранён.
  return out;
}

/** Создаёт одну особь стада `herd` вида `speciesId` в локации `loc`. */
function spawnAnimal(
  world: SimWorld,
  rng: Rng,
  speciesId: number,
  herd: number,
  loc: LocationId,
): void {
  const eid = spawnEntity(world.ecs);

  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // стоит (D-019)
  POS.etaTicks[eid] = 0;

  addComponent(world.ecs, Needs, eid);
  NEED.hunger[eid] = rng.range(ANIMAL_HUNGER_MIN, ANIMAL_HUNGER_MAX);
  NEED.thirst[eid] = rng.range(ANIMAL_THIRST_MIN, ANIMAL_THIRST_MAX);
  NEED.fatigue[eid] = 0;
  NEED.fear[eid] = 0;

  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = ANIMAL_START_HP;

  addComponent(world.ecs, Animal, eid);
  ANIMAL.species[eid] = speciesId;
  ANIMAL.herd[eid] = herd;

  addComponent(world.ecs, Alive, eid);
}
