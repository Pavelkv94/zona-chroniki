/**
 * @module @zona/sim/systems/population-influx
 *
 * Система PopulationInflux (задача 2.14, D-061) — ПРИЧИННЫЙ приток населения из-за
 * Периметра. Закрывает демо-петлю Фазы 1 (D-043 «спираль смерти»: без притока мир
 * вымирает от естественной убыли). Общение — только через ECS-компоненты, «холодный»
 * ResourceStore и шину с `causedBy` (закон №6): система никого не зовёт напрямую.
 *
 * ── ГЛАВНЫЙ ТЕСТ (закон №1) ───────────────────────────────────────────────────
 * Всё работает БЕЗ игрока. Привлекательность Зоны выведена из СОБЫТИЙ МИРА (находки
 * артефактов, экспорт хабара, смерти, бандитизм), а не из присутствия игрока; новички
 * входят в ФИКСИРОВАННУЮ точку входа (Кордон, ENTRY_LOCATION), НЕ «возле игрока».
 *
 * ── ПРИЧИННОСТЬ: ПОРОГ, НЕ «X% спавн/тик» (закон №2) ──────────────────────────
 * Раз в `INFLUX_CADENCE` тиков система читает ОКНО последних `INFLUX_WINDOW_TICKS`
 * тиков ЗАФИКСИРОВАННОГО лога и складывает ДЕТЕРМИНИРОВАННУЮ привлекательность
 * (веса — balance/population, закон №7):
 *   притягивают: `artifact/spawned` (+W_ARTIFACT_SPAWNED), `artifact/collected`
 *     (+W_ARTIFACT_COLLECTED), `item/exported` (+W_EXPORT);
 *   отталкивают: `entity/died` (−W_DEATH), бандитская стычка человек-vs-человек
 *     (`encounter/started` с людьми ПО ОБЕ стороны) (−W_BANDITRY).
 * При `attractiveness >= INFLUX_THRESHOLD` приходит ГРУППА `[GROUP_MIN, GROUP_MAX]`
 * новичков. Порог/привлекательность — чистая арифметика над логом (rng на ФАКТ
 * притока НЕ влияет — закон №2). Окно == шаг ⇒ каждое событие учитывается ровно раз
 * (см. balance/population: иначе один артефакт множил бы приток каждый шаг — взрыв).
 *
 * ── ГЕНЕРАЦИЯ ЛИЧНОСТИ (D-021, D-059) ─────────────────────────────────────────
 * Размер группы — seeded rng (`ctx.rng`, форк `PopulationInflux@tick`, категория
 * «генерация мира», как размер стада worldgen; допустимо законом №2). КАЖДЫЙ новичок
 * рождается ЕДИНОЙ точкой рождения `spawnStalker` (D-059) — ТЕМ ЖЕ кодом, что стартовая
 * когорта worldgen ⇒ новичок = стартовый сталкер бит-в-бит: Position(Кордон)/Needs<крит
 * (D-027)/Health(полное)/Skills/Home(Кордон)/Human/Alive + холодные имя/фракция(loners)/
 * профессия(seeded из пула)/деньги/инвентарь; БЕЗ Task (назначит TaskSelection, D-020 —
 * не idle, закон №4). loc/home = ENTRY_LOCATION (Кордон, закон №1).
 *
 * ── usedNames — ИНДЕКСНЫЕ ключи ЖИВЫХ людей (находка QA 2.14a, D-059) ──────────
 * `spawnStalker.usedNames` — Set ключей `"<firstIdx>|<lastIdx>"` (ИНДЕКСЫ в NAMES,
 * НЕ строки). Чтобы новичок не столкнулся с ИМЕНЕМ уже ЖИВУЩЕГО NPC, мы пред-заполняем
 * Set индексными ключами живых людей (имя→индекс через NAMES). Строки "first last"
 * pickName НЕ увидел бы. Однофамильцы (совпал только first ИЛИ только last) допустимы —
 * как в worldgen. При исчерпании пула пробинг pickName всё равно завершится.
 *
 * ── ЛЕДЖЕР МАССЫ (закон №3, D-045) — новичок приходит С ИСТОЧНИКОМ ────────────
 * Инвентарь и деньги новичка ФИЗИЧЕСКИ внесены из-за Периметра (не из воздуха). На
 * КАЖДОГО новичка эмитится `item/broughtIn { who, items:[[itemId,qty]…], money }`
 * (`causedBy` = id его `population/arrived`) — приток извне замкнутой экономики.
 * Дельта леджера (предметы+деньги) РАВНА росту тоталов мира (spawnStalker кладёт ровно
 * эти inventory/money на eid новичка) ⇒ EconomyInvariant держится (проверено тестом
 * mass==ledger). worldgen стартовый набор НЕ леджерит (базлайн t0, D-045) — а вот
 * приток ПОСЛЕ t0 обязан, иначе масса выросла бы «из воздуха».
 *
 * ── ПРИЧИННОСТЬ СОБЫТИЙ (закон №6, D-030) ─────────────────────────────────────
 * `population/arrived.causedBy = null`: привлекательность — АГРЕГАТ окна событий,
 * единой прослеживаемой причины нет ⇒ прибытие есть КОРЕНЬ причинной цепочки (как
 * `animal/born`/`artifact/spawned`/`item/produced` — все пороговые события из
 * состояния мира). `reason` несёт человекочитаемое объяснение (привлекательность и
 * вклад слагаемых). `item/broughtIn.causedBy` = id `population/arrived` новичка.
 *
 * ── ДЕТЕРМИНИЗМ / RESUME (закон №8) ───────────────────────────────────────────
 * Окно лога проходится в порядке публикаций (стабилен); привлекательность —
 * детерминированная свёртка; usedNames строится обходом `queryEntities([Human,Alive])`
 * (сорт. по eid). rng — только размер группы (seeded форк по имени+тику). Хранимого
 * таймера нет: решение на тике t зависит лишь от ЗАФИКСИРОВАННОГО лога до t−1 и
 * состояния ⇒ непрерывный прогон ≡ split save/load (лог событий переживает
 * сериализацию, D-045). Тот же seed + история → тот же приток.
 *
 * ── НЕ В КОНВЕЙЕРЕ (голдены Фазы 1) ───────────────────────────────────────────
 * PopulationInflux НЕ регистрируется в registerPhase1Systems и не создаётся worldgen —
 * подключит интеграция Фазы 2 (2.16). Текущий pipeline её НЕ гоняет ⇒ голдены Фазы 1
 * (sim:100days 37a19d72, пустой мир 481914ae) НЕ сдвигаются. Экспортируется как System
 * из @zona/sim для прогона в отдельном планировщике (headless-инвариант 2.14).
 */

import type { EntityId, EventId, FactionId, ItemId, LocationId, Tick } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import type { SimWorld } from '../core/world';
import { queryEntities, hasComponent, existsEntity } from '../core/ecs';
import { Human, Alive } from '../core/components';
import { spawnStalker } from '../worldgen';
import { NAMES } from '../data/index';
import {
  ENTRY_LOCATION,
  STARTING_FACTION_ID,
  STARTING_PROFESSION_IDS,
  STARTING_INVENTORY,
  STARTING_MONEY,
} from '../balance/worldgen';
import {
  INFLUX_CADENCE,
  INFLUX_WINDOW_TICKS,
  W_ARTIFACT_SPAWNED,
  W_ARTIFACT_COLLECTED,
  W_EXPORT,
  W_DEATH,
  W_BANDITRY,
  INFLUX_THRESHOLD,
  GROUP_MIN,
  GROUP_MAX,
} from '../balance/population';

/** Ключи ResourceStore учёта массы новичка (D-046, единообразны с NPC/поселениями). */
const INVENTORY_KEY = 'inventory';
const MONEY_KEY = 'money';

// ── Инвариант «окно == шаг» (канарейка перебаланса, как cadence у Animals) ────
//
// Оценки притока смотрят на непересекающиеся, стыкующиеся отрезки лога только когда
// окно РАВНО шагу — иначе событие учитывалось бы в нескольких оценках (двойной счёт →
// взрыв населения) или образовались бы «слепые» промежутки между окнами (пропуск
// притягивающих событий). Падаем ГРОМКО при рассинхроне констант (закон №8).
if (INFLUX_WINDOW_TICKS !== INFLUX_CADENCE) {
  throw new Error(
    `PopulationInflux: окно (${INFLUX_WINDOW_TICKS}) должно равняться шагу (${INFLUX_CADENCE}), ` +
      `иначе события лога учитываются в притоке не ровно один раз. Правьте balance/population.ts.`,
  );
}

/** Единица инвентаря (та же форма, что пишет worldgen/системы, сорт. по item). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Имя новичка в ResourceStore (D-007). Форма — как у worldgen (first/last/nickname). */
interface NameRecord {
  readonly first: string;
  readonly last: string;
  readonly nickname: string;
}

/**
 * Разбор привлекательности: счётчики слагаемых окна и итоговый `score`. Экспортируется
 * (через `computeAttractiveness`) для объяснимости решения (reason, D-030) и тестов.
 */
export interface Attractiveness {
  /** Родилось артефактов в полях (`artifact/spawned`) за окно. */
  readonly artifactsSpawned: number;
  /** Подобрано артефактов NPC (`artifact/collected`) за окно. */
  readonly artifactsCollected: number;
  /** Экспортных сделок за Периметр (`item/exported`) за окно. */
  readonly exports: number;
  /** Смертей (`entity/died`) за окно. */
  readonly deaths: number;
  /** Бандитских стычек человек-vs-человек (`encounter/started`, люди по обе стороны). */
  readonly banditry: number;
  /** Взвешенная сумма (притягивающие − отталкивающие). */
  readonly score: number;
}

/**
 * true, если стычка `encounter/started` — БАНДИТИЗМ (человек-vs-человек): хотя бы ДВЕ
 * стороны содержат ЖИВОГО-или-бывшего человека (тег `Human`, переживает смерть — D-041,
 * труп остаётся Human). Охота человек-vs-зверь (люди только на одной стороне) под
 * критерий НЕ подпадает ⇒ не отпугивает приток. SEAM для 2.11 (грабежи ROB): критерий
 * уже верен для человек-vs-человек, спец-кода при подключении не потребуется.
 */
function isBanditryEncounter(
  world: SimWorld,
  sides: ReadonlyArray<readonly EntityId[]>,
): boolean {
  let humanSides = 0;
  for (const side of sides) {
    let hasHuman = false;
    for (const eid of side) {
      // Существование проверяем ДО адресации: сторона могла нести уже удалённый eid.
      if (existsEntity(world.ecs, eid) && hasComponent(world.ecs, Human, eid)) {
        hasHuman = true;
        break;
      }
    }
    if (hasHuman) humanSides++;
    if (humanSides >= 2) return true;
  }
  return false;
}

/**
 * Детерминированно вычисляет привлекательность Зоны по ОКНУ лога `[fromTick, toTick]`
 * (оба включительно). Обходит события окна через индекс шины (`bus.at` по тикам
 * fromTick..toTick — O(событий окна), перф 2.16b), считает слагаемые и взвешенную
 * сумму (порядок счёта не важен — коммутативно). Read-only: мир/лог не трогает.
 * ЭКСПОРТИРУЕТСЯ для тестов и объяснимого reason (D-030).
 */
export function computeAttractiveness(
  world: SimWorld,
  bus: EventBus,
  fromTick: Tick,
  toTick: Tick,
): Attractiveness {
  let artifactsSpawned = 0;
  let artifactsCollected = 0;
  let exports = 0;
  let deaths = 0;
  let banditry = 0;

  // Обход ОКНА через индекс шины `bus.at(t)` (перф, 2.16b): O(событий окна) вместо
  // `bus.log` (полная копия+скан всего лога на каждый вызов ⇒ O(тиков × лога) за
  // прогон). Порядок счёта не важен (счётчики/суммы коммутативны) ⇒ результат
  // тождествен прежнему проходу по log — хэши/голдены целы. `bus.at` отдаёт события
  // тика по возрастанию id (индекс наполнен в порядке публикаций).
  for (let t = fromTick; t <= toTick; t++) {
    for (const ev of bus.at(t as Tick)) {
      switch (ev.type) {
        case 'artifact/spawned':
          artifactsSpawned++;
          break;
        case 'artifact/collected':
          artifactsCollected++;
          break;
        case 'item/exported':
          exports++;
          break;
        case 'entity/died':
          deaths++;
          break;
        case 'encounter/started':
          if (isBanditryEncounter(world, ev.payload.sides)) banditry++;
          break;
        default:
          break; // прочие события привлекательность не меняют
      }
    }
  }

  const score =
    W_ARTIFACT_SPAWNED * artifactsSpawned +
    W_ARTIFACT_COLLECTED * artifactsCollected +
    W_EXPORT * exports -
    W_DEATH * deaths -
    W_BANDITRY * banditry;

  return { artifactsSpawned, artifactsCollected, exports, deaths, banditry, score };
}

/**
 * Строит Set ИНДЕКСНЫХ ключей `"<firstIdx>|<lastIdx>"` полных имён ЖИВЫХ людей
 * (закон №4: новичок не должен совпасть полным именем с живущим NPC). Обход
 * `queryEntities([Human, Alive])` (сорт. по eid, закон №8); имя→индексы через
 * заранее построенные карты NAMES.first/last (O(1) на человека). Имя вне пула
 * (не должно случаться — все имена из NAMES) пропускается. Строки НЕ кладём:
 * pickName сверяет ИНДЕКСНЫЙ ключ (D-059).
 */
function buildUsedNames(world: SimWorld): Set<string> {
  const firstIdx = new Map<string, number>();
  NAMES.first.forEach((s, i) => firstIdx.set(s, i));
  const lastIdx = new Map<string, number>();
  NAMES.last.forEach((s, i) => lastIdx.set(s, i));

  const used = new Set<string>();
  for (const eid of queryEntities(world.ecs, [Human, Alive])) {
    const name = world.resources.get<NameRecord>('name', eid);
    if (name === undefined) continue;
    const fi = firstIdx.get(name.first);
    const li = lastIdx.get(name.last);
    if (fi === undefined || li === undefined) continue;
    used.add(`${fi}|${li}`);
  }
  return used;
}

/** Свежая отсортированная по itemId копия стартового набора новичка (D-059, без aliasing). */
function newcomerInventory(): InventoryEntry[] {
  return STARTING_INVENTORY.map((s) => ({ item: s.itemId, qty: s.qty })).sort((a, b) =>
    a.item < b.item ? -1 : a.item > b.item ? 1 : 0,
  );
}

/** Человекочитаемое объяснение притока (D-030, закон объяснимости решений). */
function influxReason(a: Attractiveness, group: number): string {
  return (
    `приток ${group}: привлекательность ${a.score} >= порог ${INFLUX_THRESHOLD} ` +
    `(артефактов: ${a.artifactsSpawned}, подобрано: ${a.artifactsCollected}, ` +
    `экспортов: ${a.exports}, смертей: ${a.deaths}, бандитизм: ${a.banditry})`
  );
}

/**
 * Система PopulationInflux (`every: INFLUX_CADENCE`). На due-тике оценивает
 * привлекательность окна и при достижении порога приводит группу новичков в Кордон
 * (каждый через spawnStalker + леджер item/broughtIn источника «из-за Периметра»).
 */
export const PopulationInflux: System = {
  name: 'PopulationInflux',
  schedule: { every: INFLUX_CADENCE },
  update(ctx: SystemCtx): void {
    const { world, bus, rng, tick } = ctx;

    // Окно = последние INFLUX_WINDOW_TICKS ЗАФИКСИРОВАННЫХ тиков: [tick−W, tick−1].
    // Читаем только закоммиченный лог (до tick−1), поэтому верхняя граница tick−1.
    // На старте (tick < W) нижняя граница клампится к 0; при tick=0 окно пусто.
    const toTick = (tick - 1) as Tick;
    const fromTick = Math.max(0, tick - INFLUX_WINDOW_TICKS) as Tick;
    const attr = computeAttractiveness(world, bus, fromTick, toTick);

    if (attr.score < INFLUX_THRESHOLD) return; // ниже порога — притока нет (закон №2)

    // Размер группы — seeded «генерация мира» (D-021): rng допустим на ЛИЧНОСТЬ/число,
    // но НЕ на факт притока (тот причинен порогом выше). [GROUP_MIN, GROUP_MAX] включ.
    const group = rng.int(GROUP_MIN, GROUP_MAX + 1);
    const reason = influxReason(attr, group);

    // Общий Set индексных ключей имён ЖИВЫХ людей: новичок не совпадёт полным именем
    // с живущим NPC (и между собой — spawnStalker дописывает выбранные в Set).
    const usedNames = buildUsedNames(world);

    for (let i = 0; i < group; i++) {
      // Новичок = стартовый сталкер (D-059): вход в Кордон, фракция loners, профессия —
      // seeded из пула, деньги/инвентарь «из-за Периметра». spawnStalker потратит rng
      // (нужды/навыки/имя/профессия) — тот же контракт, что worldgen.
      const eid: EntityId = spawnStalker(world, rng, {
        loc: ENTRY_LOCATION as LocationId,
        home: ENTRY_LOCATION as LocationId,
        faction: STARTING_FACTION_ID as FactionId,
        profession: { kind: 'pick', from: STARTING_PROFESSION_IDS },
        money: STARTING_MONEY,
        inventory: newcomerInventory,
        usedNames,
      });

      // Прибытие — КОРЕНЬ причинной цепочки (агрегат окна, единой причины нет → null).
      const arrivedId: EventId = bus.publish({
        type: 'population/arrived',
        causedBy: null,
        payload: { eid, loc: ENTRY_LOCATION as LocationId, reason },
      });

      // ЛЕДЖЕР (D-045, закон №3): инвентарь+деньги новичка внесены из-за Периметра.
      // Читаем РОВНО то, что spawnStalker положил на eid (своя копия, D-059) ⇒ дельта
      // леджера == рост тоталов мира, EconomyInvariant держится. causedBy = прибытие.
      const inv = world.resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
      const money = world.resources.get<number>(MONEY_KEY, eid) ?? 0;
      const items: ReadonlyArray<readonly [ItemId, number]> = inv.map((e) => [e.item, e.qty]);
      bus.publish({
        type: 'item/broughtIn',
        causedBy: arrivedId,
        payload: { who: eid, items, money },
      });
    }
  },
};
