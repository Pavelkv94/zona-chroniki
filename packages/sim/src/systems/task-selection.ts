/**
 * @module @zona/sim/systems/task-selection
 *
 * Система TaskSelection (задача 1.8, B.4, D-020) — utility-AI выбор ТЕКУЩЕЙ задачи
 * каждого живого человека из СОСТОЯНИЯ мира (нужды × навыки × обстановка), а не по
 * скрипту/расписанию. Это «мозг распорядка дня»: сон/еда/питьё/охота/бегство/отдых
 * рождаются эмерджентно из взвешенных оценок, без явного графика (закон №1 — мир
 * живёт без игрока; закон №2 — причинность, НЕ «X% шанс»).
 *
 * ── Что читает (только воспринятое/своё, закон №6) ───────────────────────────
 * Position.loc, Needs (hunger/thirst/fatigue/fear), Home.loc, Skills.survival,
 * Job.workplace (носитель Job — трудоустроен, задача 2.4), инвентарь (ResourceStore
 * 'inventory'; из него выводится ПОВОД торговать — нехватка эссеншелов/избыток на
 * сбыт, задача 2.6) и СТАТИЧЕСКИЕ свойства локаций из data (water/game/forage/danger).
 * Живые животные (носители Animal+Alive) — как цели охоты; поселения (Settlement+
 * Position) — как цели торговли; аномальные поля (AnomalyField+Position) с артефактом
 * на наземном луте ('inventory' поля, D-046) — как цели SEARCH (задача 2.10).
 * TaskSelection НЕ читает глобальное состояние мира в обход восприятия и НЕ
 * зовёт другие системы напрямую: общение — через компоненты и шину (закон №6).
 * Угроза-ЗВЕРЬ влияет на выбор ЧЕРЕЗ `Needs.fear` (его поднимает Perception 1.7 от
 * co-located угрозы), поэтому для FLEE отдельного чтения `contacts` не нужно. Для
 * ГРАБЕЖА (ROB, задача 2.12) жертва берётся ИМЕННО из `contacts` наблюдателя (закон
 * №1 — бандит видит только воспринятое, не читает весь мир): её наблюдаемая роль
 * (`'faction'`/`'profession'` в ResourceStore) и видимое снаряжение задают оценку, а
 * ЦЕННОСТЬ её инвентаря бандиту НЕ видна (анти-чит, D-049 — см. ROB ниже).
 *
 * ── ГРАБЁЖ (ROB, задача 2.12, D-049/D-062, закон №2 — детерминированно, НЕ «X% шанс») ─
 * ROB выбирают ТОЛЬКО акторы ХИЩНОЙ фракции (диспозиция `predatory` из factions.json,
 * data-driven, закон №10 — НЕ хардкод id 'bandits'). Оценка ЛУЧШЕЙ видимой жертвы:
 *   sRob = W.robGain·lootProxy − W.robRisk·targetStrength − W.robRel·relationPenalty
 * где lootProxy — оценка добычи по РОЛИ цели (профессия/фракция, БЕЗ чтения её
 * инвентаря — анти-чит); targetStrength — наблюдаемая сила (боевой навык × видимое
 * оружие + hp + со-локейт СОЮЗНИКИ той же фракции: группа → сила ↑ → sRob ↓ ⇒ бандит
 * ИЗБЕГАЕТ групп, грабит одиночек, эмерджентно); relationPenalty — max(личное
 * отношение, репутация фракции цели) из субстрата 2.15 (не грабить союзника/своего).
 * Жертва — co-located СТОЯЩИЙ живой человек НЕ-хищной фракции (согласовано с гейтом боя
 * Encounters 2.11). Не хищник / нет жертвы ⇒ sRob=−∞ (ROB вне argmax). Стартовая
 * когорта worldgen — 'loners' (не хищники) ⇒ ROB дремлет, голдены Фазы 1 не сдвигаются.
 *
 * ── Оценки (веса ТОЛЬКО из balance/utility.ts, закон №7) ─────────────────────
 * Нужды нормируются делением на NEED_MAX ∈ [0..1]; safety(loc)=1-danger. Формулы:
 *   SLEEP  = W.fatigue·fatigue + (night?W.night:0) + safety·W.safe
 *   EAT    = (W.hunger + W.food)·hunger    (ТОЛЬКО если в инвентаре есть еда)
 *   DRINK  = W.thirst·thirst + waterHere·W.water
 *   HUNT   = (W.hunger + gameAbund·W.game + survival·W.skill)·hunger
 *            − fear·W.fear − (night?W.nightHunt:0)  (ТОЛЬКО если есть достижимая дичь;
 *            вклад «удобства» охоты домножен на голод — сытый не охотится, 5.2)
 *   FLEE   = W.fleeFear·fear
 *   FORAGE = FALLBACK_SCORE_FLOOR + W.forageBase·forageAbund   (fallback; ДОБЫВАЕТ
 *            forage_food из среды в TaskEffects, 5.2 — не мгновенный эффект)
 *   REST   = W.restBase + W.fatigue·fatigue·REST_FATIGUE_FACTOR (fallback, всегда >0)
 *   WORK   = W.work·safety·max(0, 1−maxNeed)   (ТОЛЬКО носитель Job И день, задача 2.4)
 *   TRADE  = W.trade·safety·max(0, 1−maxNeed)  (ТОЛЬКО повод в инвентаре И день, задача 2.6)
 *   SEARCH = W.search·safety·max(0, 1−maxNeed) (ТОЛЬКО достижимое поле с артефактом И день, задача 2.10)
 * EAT без еды и HUNT без достижимой дичи ИСКЛЮЧАЮТСЯ из argmax (−∞): нельзя есть
 * то, чего нет (закон №3), и нельзя охотиться там, где дичи нет. WORK ИСКЛЮЧЁН (−∞)
 * у безработных (нет Job) и ночью (работник спит, а не выходит на смену) — поведение
 * не-Job NPC не меняется. TRADE ИСКЛЮЧЁН (−∞) без ПОВОДА в инвентаре (нет нехватки
 * эссеншелов и нет избытка на сбыт), при пустом множестве достижимых поселений (D-026)
 * и ночью (рынок закрыт) — иначе NPC пошёл бы к поселению «в пустоту». `maxNeed` =
 * самая высокая нужда: любая критическая нужда/страх гасит WORK и TRADE к нулю и
 * пропускает вперёд EAT/DRINK/SLEEP/HUNT/FLEE (сначала выжить, потом смена/торговля);
 * спокойный сытый работник днём выбирает WORK НАД fallback'ами, а спокойный NPC с
 * поводом — TRADE (эмерджентный «рабочий день»/«торговый выход» БЕЗ явного расписания —
 * закон №1/№2). Два fallback'а
 * (FORAGE/REST) СТРОГО положительны, поэтому argmax НИКОГДА не пуст — idle
 * невозможен (закон №4, D-020).
 *
 * Привлекательность EAT ПРОПОРЦИОНАЛЬНА голоду `(W.hunger+W.food)·hunger`, а НЕ
 * плоское слагаемое: при `hunger≈0` EAT→0 и проигрывает fallback'у (сытый НЕ ест
 * впустую — иначе TaskEffects 1.8e сжёг бы запас еды на нуле голода, необоснованная
 * потеря ресурса, спирит закона №3). При реальном голоде бонус `W.food` (тоже
 * масштабированный голодом) поднимает EAT НАД HUNT — рационально доесть запас,
 * прежде чем идти на риск охоты (D-034).
 *
 * ── Детерминированный argmax (закон №8, D-020) ───────────────────────────────
 * Выбор — задача с наибольшей оценкой. При РАВЕНСТВЕ — МЕНЬШИЙ код TaskKind
 * (порядок enum: SLEEP<EAT<DRINK<FORAGE<HUNT<REST<FLEE<WORK<TRADE<ROB<SEARCH; SEARCH=10 —
 * ПОСЛЕДНИЙ код, ROB=9 перед ним; на точном равенстве уступают меньшему коду), а НЕ rng-tie-break:
 * кандидаты обходятся в порядке возрастания кода со строгим `>`, поэтому первый
 * достигший максимума (меньший код) удерживает выбор. rng в решении НЕ участвует
 * (закон №2: случайность — только физиология, здесь её нет).
 *
 * ── Валидная достижимая цель (D-026) ─────────────────────────────────────────
 * У выбранной задачи цель ОБЯЗАНА быть валидной и достижимой (иначе Movement 1.4
 * молча простоял бы — латентный idle). Правила:
 *   EAT/FORAGE/REST → target = текущая loc (на месте);
 *   SLEEP          → target = Home.loc (дом; если уже дома — на месте);
 *   DRINK          → ближайшая loc с водой по edgeLen (текущая, если с водой);
 *   HUNT           → ближайшая loc с живой дичью; targetEid = min-eid особь в ней;
 *   FLEE           → соседняя loc с наименьшим danger (tie — min id);
 *   WORK           → Job.workplace (рабочее место; если уже там — на месте);
 *   TRADE          → ближайшее поселение (Settlement+Position; если уже там — на месте);
 *   ROB            → target = жертва (targetEid), targetLoc = её loc (== loc грабителя,
 *                    жертва co-located ⇒ Movement no-op, бой завяжет Encounters 2.11);
 *   SEARCH         → ближайшее аномальное поле с артефактом на луте (если уже там — на месте).
 * Ближайшая loc считается детерминированным Дейкстрой (pathfinding), tie по
 * стоимости — меньший id локации.
 *
 * ── ОБХОД МАРШРУТА (задача 2.13, D-050/D-063 — читается ЗДЕСЬ) ────────────────
 * NPC, помеченный обходом (`avoidLoc` в ResourceStore после ограбления, addAvoid 2.13),
 * НЕ ВЫБИРАЕТ избегаемую локацию ЦЕЛЬЮ движения, пока `untilTick > tick`. Механизм —
 * ИСКЛЮЧЕНИЕ избегаемых loc из множеств КАНДИДАТОВ-ЦЕЛЕЙ ПЕРЕД поиском ближайшей (тот же
 * приём, что фильтр FLEE по safestNeighbor): дичь (`animalLocs`), вода (`WATER_LOCS`),
 * поселения (`settlementLocs`), поля с артефактом (`artifactFieldLocs`) прогоняются через
 * `notAvoided`; сосед для FLEE выбирается из НЕизбегаемых. Если единственный кандидат
 * задачи избегаем — `nearestLoc` вернёт `undefined`/`null` ⇒ соответствующая оценка
 * становится −∞ (HUNT/TRADE/SEARCH исключаются из argmax), и NPC выбирает ДРУГУЮ задачу
 * или другую (неизбегаемую) цель того же вида — маршрут огибает опасное место. НЕ
 * фильтруется: текущая loc (задачи-на-месте EAT/FORAGE/REST и питьё в воде под ногами —
 * обход про маршрут, не про запрет стоять) и дом (SLEEP → Home.loc). Тупик обхода (ВСЕ
 * соседи/кандидаты избегаемы) — деградирует к выбору без фильтра (выживание/движение
 * важнее обхода, закон №4 — не idle). NO-OP-ГАРАНТИЯ (голдены Фазы 1): у NPC без
 * avoid-записей `getAvoids` пуст ⇒ `notAvoided` отдаёт исходные списки (та же ссылка),
 * предикат FLEE не передаётся ⇒ путь выбора задач байт-в-байт прежний. В живом мире
 * avoidLoc пуст у всех (RobberyMemory не в конвейере, ROB дремлет) ⇒ обход не влияет.
 *
 * ── Смена задачи и штамп причинности (D-030/D-032) ───────────────────────────
 * Task пишется и `task/selected` публикуется ТОЛЬКО когда выбранная тройка
 * (kind,targetLoc,targetEid) ОТЛИЧАЕТСЯ от текущего Task (или Task ещё нет). Пока
 * состояние ведёт к той же задаче — ни события, ни перештампа (борт объёма событий,
 * стабильные causedBy, D-032). При смене: пишем Task, `startedTick=tick`, публикуем
 * `task/selected` (causedBy=null — корень) и ШТАМПУЕМ возвращённый EventId в
 * `Task.causeEvent` (`stampCause`, D-030), откуда Movement (1.4) берёт его O(1) как
 * `move/departed.causedBy` — без скана лога.
 *
 * Порядок в тике (D-032): TaskSelection ДО Movement (производитель штампа раньше
 * потребителя), иначе Movement прочёл бы старую причину.
 */

import type { Contact, EntityId, FactionId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { queryEntities, hasComponent, existsEntity, addComponent, stampCause } from '../core/ecs';
import { Position, Needs, Task, Skills, Health, Home, Animal, Human, Alive, Job, Settlement, AnomalyField, TaskKind } from '../core/components';
import { MAP, getLocation, getItem, getProfession, neighbors, isPredatoryFaction } from '../data/index';
import { MAP_GRAPH, shortestPath } from './pathfinding';
import { NEED_MAX, HEALTH_MAX } from '../balance/needs';
import {
  W,
  FALLBACK_SCORE_FLOOR,
  REST_FATIGUE_FACTOR,
  ROB_LOOT_BASE,
  ROB_LOOT_MERCHANT_BONUS,
  ROB_STRENGTH_WEAPON,
  ROB_STRENGTH_HP,
  ROB_STRENGTH_ALLY,
  MERCHANT_WORK_TASK,
} from '../balance/utility';
import {
  ESSENTIAL_FOOD_MIN,
  ESSENTIAL_AMMO_MIN,
  TRADE_KEEP_FOOD,
  TRADE_KEEP_AMMO,
  TRADE_KEEP_WEAPON,
  TRADE_KEEP_DRINK,
  TRADE_KEEP_MEDICAL,
} from '../balance/economy';
import { getRelation as getMemoryRelation, factionReputation, entitySubject, getAvoids, isAvoided } from './memory';
import { isNight } from './daynight';

/** Ключ ResourceStore со списком видимых контактов наблюдателя (Perception 1.7, D-023). */
const CONTACTS_KEY = 'contacts';

/** Ключ ResourceStore с фракцией NPC (D-007; наблюдаемая роль/принадлежность). */
const FACTION_KEY = 'faction';

/** Ключ ResourceStore с профессией NPC (D-007; наблюдаемая роль). */
const PROFESSION_KEY = 'profession';

/** Ключ ResourceStore со списком инвентаря (D-007); форма — см. worldgen. */
const INVENTORY_KEY = 'inventory';

/** Единица инвентаря (та же форма, что пишет worldgen 1.3). */
interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
}

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const POS = Position as unknown as { readonly loc: Uint32Array; readonly dest: Uint32Array };
const NEED = Needs as unknown as {
  readonly hunger: Float32Array;
  readonly thirst: Float32Array;
  readonly fatigue: Float32Array;
  readonly fear: Float32Array;
};
const SKILL = Skills as unknown as { readonly survival: Float32Array; readonly shooting: Float32Array };
const HP = Health as unknown as { readonly hp: Float32Array };
const HOME = Home as unknown as { readonly loc: Uint32Array };
const JOB = Job as unknown as { readonly workplace: Uint32Array };
const TSK = Task as unknown as {
  kind: Uint8Array;
  targetLoc: Uint32Array;
  targetEid: Uint32Array;
  startedTick: Uint32Array;
};

/** Локации с водой — статическое свойство карты, считается один раз на модуль. */
const WATER_LOCS: readonly LocationId[] = MAP.locations
  .filter((l) => l.water)
  .map((l) => l.id as LocationId);

/** Кандидат охоты: ближайшая loc с живой дичью и конкретная жертва в ней. */
interface HuntTarget {
  readonly loc: LocationId;
  readonly eid: EntityId;
}

/**
 * Стоимость кратчайшего пути `from → to` по edgeLen (сумма весов рёбер). 0 при
 * `from === to`; `Infinity`, если недостижимо. Детерминирована (Дейкстра, закон №8).
 */
function pathCost(from: number, to: number): number {
  if (from === to) return 0;
  const path = shortestPath(MAP_GRAPH, from, to);
  if (path === undefined) return Infinity;
  let cost = 0;
  for (let i = 1; i < path.length; i++) {
    cost += MAP_GRAPH.weight(path[i - 1] as number, path[i] as number);
  }
  return cost;
}

/**
 * Ближайшая (по pathCost) локация из `targets`, tie — меньший id локации.
 * `undefined`, если ни одна не достижима. Обход `targets` по возрастанию id +
 * строгое `<` фиксирует tie-break (закон №8).
 */
function nearestLoc(from: number, targets: readonly LocationId[]): LocationId | undefined {
  let best: LocationId | undefined;
  let bestCost = Infinity;
  for (const t of targets) {
    const c = pathCost(from, t);
    if (c < bestCost) {
      bestCost = c;
      best = t;
    }
  }
  return best;
}

/** true, если в инвентаре есть съедобное (kind food) с qty>0 (закон №3 — не из воздуха). */
function hasFood(inv: readonly InventoryEntry[] | undefined): boolean {
  if (inv === undefined) return false;
  for (const e of inv) {
    if (e.qty > 0 && getItem(e.item).kind === 'food') return true;
  }
  return false;
}

/**
 * Резерв «на руках» по виду при ПРОДАЖЕ: столько единиц NPC оставляет себе, всё
 * сверх — избыток на сбыт. Совпадает с политикой исполнения Trade (systems/trade.ts,
 * задача 2.5), чтобы НАМЕРЕНИЕ торговать (2.6) не расходилось с реальной сделкой:
 * оценивать TRADE как «есть что продать» надо по тем же порогам, по которым Trade
 * действительно сбудет излишек. Виды без записи (резерв 0) считаются полностью
 * избыточными.
 */
function reserveForKind(kind: string): number {
  switch (kind) {
    case 'weapon':
      return TRADE_KEEP_WEAPON;
    case 'food':
      return TRADE_KEEP_FOOD;
    case 'drink':
      return TRADE_KEEP_DRINK;
    case 'ammo':
      return TRADE_KEEP_AMMO;
    case 'medical':
      return TRADE_KEEP_MEDICAL;
    default:
      return 0;
  }
}

/**
 * ПРИЧИННЫЙ повод торговать (закон №2, НЕ «X% шанс») — выводится ДЕТЕРМИНИРОВАННО из
 * состояния инвентаря NPC, теми же порогами, которыми Trade (2.5) исполнит сделку:
 *   • НЕХВАТКА эссеншелов — food-единиц < ESSENTIAL_FOOD_MIN ИЛИ ammo < ESSENTIAL_AMMO_MIN
 *     (NPC пойдёт ДОКУПИТЬ провизию/патроны у поселения);
 *   • ИЗБЫТОК на сбыт — любой предмет с qty сверх резерва по виду (reserveForKind)
 *     (NPC пойдёт СБЫТЬ лишнее поселению).
 * Нет ни того, ни другого ⇒ повода нет (torговля не нужна) — тогда sTrade = −∞ (как
 * EAT без еды: не выбираем задачу «в пустоту», D-034/закон №3). Обход массива инвентаря
 * (стабильный порядок worldgen/Trade — сорт. по itemId) детерминирован; результат не
 * зависит от порядка (сумма ассоциативна, «любой избыток» — дизъюнкция), закон №8.
 * `undefined`-инвентарь (нет складской записи) → повода нет (не гоним в пустой поход).
 */
function hasTradeReason(inv: readonly InventoryEntry[] | undefined): boolean {
  if (inv === undefined) return false;
  let food = 0;
  let ammo = 0;
  let surplus = false;
  for (const e of inv) {
    if (e.qty <= 0) continue;
    const kind = getItem(e.item).kind;
    if (kind === 'food') food += e.qty;
    else if (kind === 'ammo') ammo += e.qty;
    if (e.qty > reserveForKind(kind)) surplus = true;
  }
  return surplus || food < ESSENTIAL_FOOD_MIN || ammo < ESSENTIAL_AMMO_MIN;
}

/**
 * true, если на наземном луте (`'inventory'`, D-046) аномального поля лежит артефакт
 * (`kind === 'artifact'`) с qty>0 — тот, который ArtifactSpawn (2.9, D-054) родил и
 * положил на eid поля. Основа ПРИЧИННОСТИ SEARCH (закон №2): NPC идёт к полю, только
 * если там ФИЗИЧЕСКИ есть что подобрать (не «X% находки»). Обход массива инвентаря
 * (стабильный порядок — сорт. по item) детерминирован; результат порядко-независим
 * (дизъюнкция), закон №8.
 */
function fieldHasArtifact(inv: readonly InventoryEntry[] | undefined): boolean {
  if (inv === undefined) return false;
  for (const e of inv) {
    if (e.qty > 0 && getItem(e.item).kind === 'artifact') return true;
  }
  return false;
}

/**
 * Ближайшая цель охоты для наблюдателя в `loc`: локация с живой дичью, минимальная
 * по pathCost (tie — меньший id), и min-eid особь в ней (детерминированная жертва,
 * закон №8). `null`, если живой дичи нигде нет/недостижима — тогда HUNT не выбирается.
 * `animalsByLoc` — предпосчитанная на тик карта loc → отсортированные по eid особи.
 */
function nearestHunt(
  loc: number,
  animalLocs: readonly LocationId[],
  animalsByLoc: ReadonlyMap<number, readonly EntityId[]>,
): HuntTarget | null {
  const targetLoc = nearestLoc(loc, animalLocs);
  if (targetLoc === undefined) return null;
  const herd = animalsByLoc.get(targetLoc) as readonly EntityId[];
  // herd отсортирован по eid (queryEntities сортирует) ⇒ [0] = min eid (закон №8).
  return { loc: targetLoc, eid: herd[0] as EntityId };
}

/**
 * Соседняя локация с наименьшим danger (tie — меньший id). Если соседей нет — сама `loc`.
 * `avoid` (задача 2.13, обход маршрута): избегаемые соседи ИСКЛЮЧАЮТСЯ из выбора — жертва
 * не бежит в помеченную локацию. `undefined` (нет активного обхода) ⇒ прежний путь
 * байт-в-байт (голдены целы). Если ВСЕ соседи избегаемы (тупик обхода) — падаем на выбор
 * БЕЗ фильтра (выживание/движение важнее обхода: не стоять столбом при страхе, закон №4).
 */
function safestNeighbor(loc: number, avoid?: (l: number) => boolean): LocationId {
  const nbs = neighbors(loc as LocationId);
  let best = loc as LocationId;
  let bestDanger = Infinity;
  for (const nb of nbs) {
    if (avoid !== undefined && avoid(nb)) continue; // избегаемого соседа не рассматриваем
    const d = getLocation(nb).danger;
    if (d < bestDanger) {
      bestDanger = d;
      best = nb;
    }
  }
  // Все соседи избегаемы (best не сдвинулся с loc, хотя соседи есть) ⇒ выбор без фильтра.
  if (avoid !== undefined && best === (loc as LocationId) && nbs.length > 0) {
    for (const nb of nbs) {
      const d = getLocation(nb).danger;
      if (d < bestDanger) {
        bestDanger = d;
        best = nb;
      }
    }
  }
  return best;
}

/** Выбранная жертва грабежа: конкретная цель и её (= грабителя) локация. */
interface RobTarget {
  readonly eid: EntityId;
  readonly loc: LocationId;
  readonly score: number;
}

/**
 * true, если в инвентаре ВИДНО оружие (kind `weapon`, qty>0) — та же логика первого
 * оружия, что в encounter-резолвере. Это ВИДИМОЕ снаряжение цели (оружие на виду,
 * законная наблюдаемость, закон №1/D-049) для оценки её СИЛЫ — НЕ оценка ценности
 * добычи (её грабитель не видит; см. `lootProxyOf`, анти-чит).
 */
function hasVisibleWeapon(inv: readonly InventoryEntry[] | undefined): boolean {
  if (inv === undefined) return false;
  for (const e of inv) {
    if (e.qty > 0 && getItem(e.item).kind === 'weapon') return true;
  }
  return false;
}

/**
 * НАБЛЮДАЕМАЯ оценка добычи цели `target` (lootProxy, D-049) — по её РОЛИ, БЕЗ чтения
 * инвентаря жертвы (АНТИ-ЧИТ: бандит не видит чужой карман). База + надбавка за
 * торговую профессию (торговец видимо тащит товар; торговость — data-driven по
 * professions.json, закон №10). НАМЕРЕННО не принимает инвентарь параметром — доступа
 * к чужому 'inventory' здесь нет.
 */
function lootProxyOf(resources: SystemCtx['world']['resources'], target: EntityId): number {
  let proxy = ROB_LOOT_BASE;
  const prof = resources.get<string>(PROFESSION_KEY, target);
  if (prof !== undefined && getProfession(prof).workTasks.includes(MERCHANT_WORK_TASK)) {
    proxy += ROB_LOOT_MERCHANT_BONUS;
  }
  return proxy;
}

/**
 * НАБЛЮДАЕМАЯ сила цели `target` (targetStrength, D-049): боевой навык × ВИДИМОЕ оружие
 * + здоровье + со-локейт союзники (`allies` — предпосчитано вызывающим). Группа союзников
 * → высокая сила → sRob вниз ⇒ бандит избегает групп, грабит одиночек (эмерджентно).
 */
function targetStrengthOf(
  ecs: SystemCtx['world']['ecs'],
  resources: SystemCtx['world']['resources'],
  target: EntityId,
  allies: number,
): number {
  const inv = resources.get<InventoryEntry[]>(INVENTORY_KEY, target);
  const armed = hasVisibleWeapon(inv);
  const shooting = hasComponent(ecs, Skills, target) ? (SKILL.shooting[target] as number) : 0;
  const hpNorm = hasComponent(ecs, Health, target) ? (HP.hp[target] as number) / HEALTH_MAX : 0;
  return (armed ? shooting * ROB_STRENGTH_WEAPON : 0) + hpNorm * ROB_STRENGTH_HP + allies * ROB_STRENGTH_ALLY;
}

/**
 * relationPenalty (D-049) грабителя `robber` к цели `target` из СУБСТРАТА 2.15
 * (memory.ts): max(личное отношение к сущности, репутация её фракции). Положительное
 * (союзник/друг) → большой штраф (не грабить своих); отрицательное (враг) → штраф < 0
 * (охотнее грабить врага). Нейтрал (нет записей) → 0.
 */
function robRelationPenalty(
  resources: SystemCtx['world']['resources'],
  robber: EntityId,
  target: EntityId,
  targetFaction: FactionId | undefined,
): number {
  const personal = getMemoryRelation(resources, robber, entitySubject(target));
  const facRep = targetFaction !== undefined ? factionReputation(resources, robber, targetFaction) : 0;
  return Math.max(personal, facRep);
}

/**
 * Лучшая (max sRob) жертва грабежа для ХИЩНОГО `robber` из его ВИДИМЫХ контактов
 * (Perception, закон №1 — не читаем весь мир). Кандидат — co-located СТОЯЩИЙ живой
 * человек НЕ-хищной фракции (согласовано с гейтом цели Encounters 2.11, D-060: тот же
 * бой требует co-located+стоящих). Обход контактов по возрастанию target (сорт.) +
 * строгое `>` ⇒ tie → меньший eid (закон №8). `null`, если валидной жертвы нет ⇒ sRob=−∞.
 */
function bestRobTarget(
  ctx: SystemCtx,
  robber: EntityId,
  loc: number,
  humansByLoc: ReadonlyMap<number, readonly EntityId[]>,
): RobTarget | null {
  const { world } = ctx;
  const ecs = world.ecs;
  const contacts = world.resources.get<readonly Contact[]>(CONTACTS_KEY, robber);
  if (contacts === undefined || contacts.length === 0) return null;

  let best: RobTarget | null = null;
  for (const c of contacts) {
    const t = c.target;
    // Валидная достижимая жертва: живой человек, co-located и СТОЯЩИЙ (гейт боя 2.11).
    if (t === robber) continue;
    if (!existsEntity(ecs, t)) continue;
    if (!hasComponent(ecs, Human, t) || !hasComponent(ecs, Alive, t)) continue;
    if ((POS.loc[t] as number) !== loc) continue; // только co-located (не «на подходе»)
    if ((POS.dest[t] as number) !== loc) continue; // цель стоит (иначе бой не завяжется)

    const tFaction = world.resources.get<FactionId>(FACTION_KEY, t);
    if (tFaction !== undefined && isPredatoryFaction(tFaction)) continue; // не грабим своих-хищников

    // Союзники цели: co-located живые люди ТОЙ ЖЕ фракции (кроме самой цели).
    let allies = 0;
    if (tFaction !== undefined) {
      const roster = humansByLoc.get(loc);
      if (roster !== undefined) {
        for (const other of roster) {
          if (other === t) continue;
          if (world.resources.get<FactionId>(FACTION_KEY, other) === tFaction) allies++;
        }
      }
    }

    const loot = lootProxyOf(world.resources, t);
    const strength = targetStrengthOf(ecs, world.resources, t, allies);
    const penalty = robRelationPenalty(world.resources, robber, t, tFaction);
    const score = W.robGain * loot - W.robRisk * strength - W.robRel * penalty;

    if (best === null || score > best.score) {
      best = { eid: t, loc: loc as LocationId, score };
    }
  }
  return best;
}

/**
 * Система TaskSelection (`every: 1`). Для каждого живого человека считает оценки
 * задач из состояния, берёт детерминированный argmax, вычисляет валидную цель и —
 * ТОЛЬКО при смене задачи — пишет Task, публикует `task/selected` и штампует причину.
 */
export const TaskSelection: System = {
  name: 'TaskSelection',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus, tick } = ctx;
    const ecs = world.ecs;
    const night = isNight(tick);

    // ── Живая дичь на этот тик: loc → отсортированные по eid особи (min eid = [0]).
    // queryEntities сортирует по eid ⇒ бакеты уже отсортированы (закон №8).
    const animalsByLoc = new Map<number, EntityId[]>();
    for (const a of queryEntities(ecs, [Animal, Alive])) {
      const l = POS.loc[a] as number;
      let bucket = animalsByLoc.get(l);
      if (bucket === undefined) {
        bucket = [];
        animalsByLoc.set(l, bucket);
      }
      bucket.push(a);
    }
    // Локации с дичью — по возрастанию id (детерминизм tie-break охоты, закон №8).
    const animalLocs = Array.from(animalsByLoc.keys()).sort((a, b) => a - b) as LocationId[];

    // ── Локации поселений (цель TRADE, задача 2.6): loc каждой сущности-поселения
    // (Settlement+Position), по возрастанию id. Один раз до цикла NPC, как animalLocs.
    // Пусто ⇒ TRADE недостижим (nearestLoc вернул бы null) ⇒ sTrade=−∞ (D-026).
    const settlementLocSet = new Set<number>();
    for (const s of queryEntities(ecs, [Settlement])) settlementLocSet.add(POS.loc[s] as number);
    const settlementLocs = Array.from(settlementLocSet).sort((a, b) => a - b) as LocationId[];

    // ── Локации аномальных полей С АРТЕФАКТОМ на земле (цель SEARCH, задача 2.10):
    // поле (AnomalyField+Position), на луте которого лежит артефакт (закон №2 —
    // причина из состояния мира, не «X% находки»). Собираем один раз до цикла NPC,
    // как settlementLocs/animalLocs, по возрастанию id (детерминизм tie-break,
    // закон №8). Пусто ⇒ SEARCH недостижим (nearestLoc вернул бы null) ⇒ sSearch=−∞.
    // ТЕКУЩИЙ worldgen НЕ создаёт носителей AnomalyField (до 2.16) ⇒ это множество
    // всегда пусто на живом прогоне ⇒ SEARCH никогда не выбирается ⇒ голдены Фазы 1
    // не сдвигаются (D-057).
    const artifactFieldLocSet = new Set<number>();
    for (const f of queryEntities(ecs, [AnomalyField, Position])) {
      const inv = world.resources.get<InventoryEntry[]>(INVENTORY_KEY, f);
      if (fieldHasArtifact(inv)) artifactFieldLocSet.add(POS.loc[f] as number);
    }
    const artifactFieldLocs = Array.from(artifactFieldLocSet).sort((a, b) => a - b) as LocationId[];

    // ── Живые люди по локациям (для подсчёта СОЮЗНИКОВ цели грабежа, задача 2.12).
    // Только читается хищными акторами при оценке ROB; queryEntities сорт. по eid ⇒
    // бакеты детерминированы (закон №8). Пусто/не хищник ⇒ ветка ROB не трогает это.
    const humansByLoc = new Map<number, EntityId[]>();
    for (const h of queryEntities(ecs, [Human, Alive, Position])) {
      const l = POS.loc[h] as number;
      let bucket = humansByLoc.get(l);
      if (bucket === undefined) {
        bucket = [];
        humansByLoc.set(l, bucket);
      }
      bucket.push(h);
    }

    for (const eid of queryEntities(ecs, [Human, Alive, Needs])) {
      const loc = POS.loc[eid] as number;
      const locData = getLocation(loc as LocationId);

      // Нормированные нужды [0..1] и обстановка.
      const hunger = (NEED.hunger[eid] as number) / NEED_MAX;
      const thirst = (NEED.thirst[eid] as number) / NEED_MAX;
      const fatigue = (NEED.fatigue[eid] as number) / NEED_MAX;
      const fear = (NEED.fear[eid] as number) / NEED_MAX;
      const safety = 1 - locData.danger;
      const survival = hasComponent(ecs, Skills, eid) ? (SKILL.survival[eid] as number) : 0;
      const waterHere = locData.water ? 1 : 0;
      const inv = world.resources.get<InventoryEntry[]>(INVENTORY_KEY, eid);
      const foodInInv = hasFood(inv);

      // ── Обход маршрута (задача 2.13, D-050/D-063) ──────────────────────────
      // Локации, которые NPC ИЗБЕГАЕТ (пометил после ограбления, addAvoid 2.13):
      // активная запись (untilTick>tick) ИСКЛЮЧАЕТ локацию из КАНДИДАТОВ-ЦЕЛЕЙ
      // движения (NPC «не идёт туда»), пока срок не истёк (MemoryDecay снимет). Текущая
      // loc для задач-НА-МЕСТЕ (EAT/FORAGE/REST/питьё в воде под ногами) НЕ фильтруется:
      // обход — про МАРШРУТ (куда идти), а не про запрет находиться там, где уже стоишь.
      // У всех, кто не был ограблен, `avoids` пуст ⇒ `notAvoided` возвращает исходный
      // список (та же ссылка), `avoid`-предикат не передаётся ⇒ выбор задач байт-в-байт
      // прежний (голдены Фазы 1 целы — в живом мире avoidLoc всегда пуст).
      const avoids = getAvoids(world.resources, eid);
      const hasAvoids = avoids.length > 0;
      const avoidLoc = (l: number): boolean => hasAvoids && isAvoided(world.resources, eid, l, tick);
      const notAvoided = (locs: readonly LocationId[]): readonly LocationId[] =>
        hasAvoids ? locs.filter((l) => !avoidLoc(l)) : locs;

      // Цели-кандидаты (нужны и для оценок, и для записи выбранной задачи).
      const homeLoc = hasComponent(ecs, Home, eid) ? (HOME.loc[eid] as LocationId) : (loc as LocationId);
      const hunt = nearestHunt(loc, notAvoided(animalLocs), animalsByLoc);
      const drinkLoc = waterHere
        ? (loc as LocationId)
        : (nearestLoc(loc, notAvoided(WATER_LOCS)) ?? (loc as LocationId));
      const fleeLoc = safestNeighbor(loc, hasAvoids ? avoidLoc : undefined);
      const gameAbund = hunt !== null ? getLocation(hunt.loc).game : 0;
      // Трудоустройство (задача 2.4): носительство Job = «работает на поселение».
      // У безработных Job нет ⇒ WORK недоступен (score −∞), поведение не-Job NPC не
      // меняется. workplace — loc рабочего места (цель WORK); задан только при hasJob.
      const hasJob = hasComponent(ecs, Job, eid);
      const workplace = hasJob ? (JOB.workplace[eid] as LocationId) : (loc as LocationId);
      // Торговля (задача 2.6): ближайшее ДОСТИЖИМОЕ поселение — цель TRADE. `undefined`,
      // если поселений в мире нет ИЛИ ни одно не достижимо (D-026) ⇒ TRADE исключён.
      const nearestSettlement =
        settlementLocs.length > 0 ? nearestLoc(loc, notAvoided(settlementLocs)) : undefined;
      // Повод торговать — причинно из инвентаря (нехватка эссеншелов ИЛИ избыток).
      const canTrade = nearestSettlement !== undefined && !night && hasTradeReason(inv);
      // Поход за артефактом (задача 2.10): ближайшее ДОСТИЖИМОЕ поле с артефактом на
      // земле — цель SEARCH. `undefined`, если таких полей нет ИЛИ недостижимы (D-026)
      // ⇒ SEARCH исключён. Повод причинен: артефакт ФИЗИЧЕСКИ лежит на луте поля.
      const nearestArtifactField =
        artifactFieldLocs.length > 0 ? nearestLoc(loc, notAvoided(artifactFieldLocs)) : undefined;
      const canSearch = nearestArtifactField !== undefined && !night;
      // Грабёж (задача 2.12, D-049/D-062): ROB доступен ТОЛЬКО членам ХИЩНОЙ фракции
      // (диспозиция `predatory` из factions.json — data-driven, закон №10; worldgen
      // спавнит всех как 'loners' ⇒ не хищники ⇒ ROB дремлет, голдены Фазы 1 стабильны).
      // Жертва — ВИДИМАЯ достижимая (bestRobTarget по contacts, закон №1). Нет хищной
      // диспозиции или нет валидной жертвы ⇒ robTarget=null ⇒ sRob=−∞.
      const myFaction = world.resources.get<FactionId>(FACTION_KEY, eid);
      const isPredator = myFaction !== undefined && isPredatoryFaction(myFaction);
      const robTarget = isPredator ? bestRobTarget(ctx, eid, loc, humansByLoc) : null;

      // ── Оценки (веса из balance/utility, закон №7) ─────────────────────────
      const sSleep = W.fatigue * fatigue + (night ? W.night : 0) + safety * W.safe;
      // EAT масштабируется голодом (D-034): при hunger≈0 → ~0 (не переедаем), при
      // голоде бонус W.food поднимает EAT над HUNT (доесть запас раньше охоты).
      const sEat = foodInInv ? (W.hunger + W.food) * hunger : -Infinity;
      const sDrink = W.thirst * thirst + waterHere * W.water;
      // HUNT (P-5/5.2 калибровка FORAGE↔HUNT): тяга к охоте ПРИЧИННО управляется
      // ГОЛОДОМ — «удобство» охоты (обилие дичи gameAbund, навык survival) даёт вклад
      // ТОЛЬКО когда есть нужда в еде (домножено на hunger). СЫТЫЙ (hunger≈0) ⇒ sHunt→
      // −fear−night ≤ 0 < sForage ⇒ предпочтёт СОБИРАТЕЛЬСТВО (растит. еда из среды,
      // 5.2) охоте: давление на стада падает, охота становится ДОПОЛНЕНИЕМ (голоден и
      // нет запаса → охотится; с запасом → EAT перебивает HUNT, D-034). До 5.2 (без
      // возобновляемой не-мясной еды) охоту нельзя было унять весом game без слома
      // выживания людей (см. W.game 2.16c); теперь корень устранён контентом/кодом.
      // Стартовая формула; тонкий тюнинг — balance-analyst.
      const sHunt =
        hunt !== null
          ? (W.hunger + gameAbund * W.game + survival * W.skill) * hunger -
            fear * W.fear -
            (night ? W.nightHunt : 0)
          : -Infinity;
      const sFlee = W.fleeFear * fear;
      const sForage = FALLBACK_SCORE_FLOOR + W.forageBase * locData.forage;
      const sRest = W.restBase + W.fatigue * fatigue * REST_FATIGUE_FACTOR;
      // WORK (задача 2.4): ТОЛЬКО носитель Job и ТОЛЬКО днём. `needCalm` = 1−самая
      // высокая нужда (clamp ≥0): любая критическая нужда/страх гасит WORK к нулю и
      // пропускает вперёд EAT/DRINK/SLEEP/HUNT/FLEE (сначала выжить, потом смена).
      // Ночью и у безработных WORK исключён из argmax (−∞), как EAT без еды.
      const needCalm = Math.max(0, 1 - Math.max(hunger, thirst, fatigue, fear));
      const sWork = hasJob && !night ? W.work * safety * needCalm : -Infinity;
      // TRADE (задача 2.6): ТОЛЬКО при причинном поводе (canTrade — есть повод +
      // достижимое поселение + день). Гейт `safety · needCalm` как у WORK: торговля —
      // не выживание, любая критическая нужда/страх гасят TRADE к нулю и пропускают
      // вперёд EAT/DRINK/SLEEP/HUNT/FLEE; спокойный NPC у безопасного поселения выберет
      // TRADE над FORAGE/REST-фоллбэком (сбыть излишек/докупить эссеншел). Нет повода/
      // поселений/ночь ⇒ −∞ (исключён из argmax, как EAT без еды).
      const sTrade = canTrade ? W.trade * safety * needCalm : -Infinity;
      // SEARCH (задача 2.10): ТОЛЬКО при достижимом поле с артефактом (canSearch) +
      // день. Гейт `safety · needCalm` как у WORK/TRADE: артефакт — не выживание,
      // любая критическая нужда/страх гасят SEARCH к нулю и пропускают вперёд EAT/
      // DRINK/SLEEP/HUNT/FLEE. Вес W.search выше W.trade (жадность за дорогим хабаром
      // перебивает рутинную торговлю у спокойного NPC), но needCalm держит его ниже
      // выживания. Нет поля/ночь ⇒ −∞ (исключён из argmax, как EAT без еды).
      const sSearch = canSearch ? W.search * safety * needCalm : -Infinity;
      // ROB (задача 2.12, D-049): sRob = W.robGain·lootProxy − W.robRisk·targetStrength
      // − W.robRel·relationPenalty, посчитан на ЛУЧШЕЙ видимой жертве (bestRobTarget).
      // В ОТЛИЧИЕ от WORK/TRADE/SEARCH — БЕЗ гейта needCalm/safety: грабёж — стратегия
      // выживания хищника; конкуренцию с голодом/страхом ведут EAT/FLEE своими оценками
      // (испуганный бандит выберет FLEE=1.5·fear над ROB). Нет жертвы/не хищник ⇒ −∞.
      const sRob = robTarget !== null ? robTarget.score : -Infinity;

      // ── argmax по возрастанию кода TaskKind + строгое `>` ⇒ tie → меньший код
      // (D-020, НЕ rng). Порядок массива ОБЯЗАН быть по возрастанию кода.
      const candidates: ReadonlyArray<readonly [TaskKind, number]> = [
        [TaskKind.SLEEP, sSleep],
        [TaskKind.EAT, sEat],
        [TaskKind.DRINK, sDrink],
        [TaskKind.FORAGE, sForage],
        [TaskKind.HUNT, sHunt],
        [TaskKind.REST, sRest],
        [TaskKind.FLEE, sFlee],
        [TaskKind.WORK, sWork],
        [TaskKind.TRADE, sTrade],
        [TaskKind.ROB, sRob],
        [TaskKind.SEARCH, sSearch],
      ];
      let kind: TaskKind = TaskKind.FORAGE;
      let best = -Infinity;
      for (const [k, s] of candidates) {
        if (s > best) {
          best = s;
          kind = k;
        }
      }

      // ── Валидная достижимая цель выбранной задачи (D-026) ──────────────────
      let targetLoc: LocationId = loc as LocationId;
      let targetEid = 0 as EntityId;
      switch (kind) {
        case TaskKind.SLEEP:
          targetLoc = homeLoc;
          break;
        case TaskKind.DRINK:
          targetLoc = drinkLoc;
          break;
        case TaskKind.HUNT:
          // hunt!==null гарантировано: иначе sHunt=-∞ и HUNT не выбран.
          targetLoc = (hunt as HuntTarget).loc;
          targetEid = (hunt as HuntTarget).eid;
          break;
        case TaskKind.FLEE:
          targetLoc = fleeLoc;
          break;
        case TaskKind.WORK:
          // hasJob гарантировано: иначе sWork=−∞ и WORK не выбран. Цель — рабочее
          // место (Job.workplace); уже на месте ⇒ targetLoc==loc (Movement no-op).
          targetLoc = workplace;
          break;
        case TaskKind.TRADE:
          // canTrade гарантирует nearestSettlement!==undefined (иначе sTrade=−∞ и TRADE
          // не выбран). Цель — ближайшее поселение; уже на месте ⇒ targetLoc==loc
          // (Movement no-op, Trade сработает у стоящего NPC). targetEid не нужен —
          // Trade находит поселение по loc сам (systems/trade.ts).
          targetLoc = nearestSettlement as LocationId;
          break;
        case TaskKind.ROB:
          // robTarget!==null гарантировано: иначе sRob=−∞ и ROB не выбран. Цель — жертва
          // (targetEid) в её локации (== loc грабителя, т.к. кандидат co-located).
          // Encounters (2.11, D-060) находит бой по (loc,targetEid) у стоящего грабителя
          // и стоящей co-located жертвы — согласовано с гейтом цели bestRobTarget.
          targetLoc = (robTarget as RobTarget).loc;
          targetEid = (robTarget as RobTarget).eid;
          break;
        case TaskKind.SEARCH:
          // canSearch гарантирует nearestArtifactField!==undefined (иначе sSearch=−∞ и
          // SEARCH не выбран). Цель — ближайшее поле с артефактом; уже на месте ⇒
          // targetLoc==loc (Movement no-op, ArtifactSearch сработает у стоящего NPC).
          // targetEid НЕ ставится — ArtifactSearch (2.10) находит поле по loc сам
          // (мирроринг Trade, D-056): лут поля транзитен (подбор его опустошает),
          // поэтому хранить eid конкретного поля в задаче хрупко (устареет при
          // опустошении), а loc-резолвинг всегда берёт поле с реальным лутом.
          targetLoc = nearestArtifactField as LocationId;
          break;
        // EAT/FORAGE/REST — на месте (target = loc, уже проставлено).
        default:
          break;
      }

      // ── Смена задачи (D-032): пишем/публикуем/штампуем ТОЛЬКО при отличии ───
      const hasTask = hasComponent(ecs, Task, eid);
      const changed =
        !hasTask ||
        (TSK.kind[eid] as number) !== kind ||
        (TSK.targetLoc[eid] as number) !== targetLoc ||
        (TSK.targetEid[eid] as number) !== targetEid;
      if (!changed) continue;

      if (!hasTask) addComponent(ecs, Task, eid); // зануляет поля (D-024)
      TSK.kind[eid] = kind;
      TSK.targetLoc[eid] = targetLoc;
      TSK.targetEid[eid] = targetEid;
      TSK.startedTick[eid] = tick;

      const id = bus.publish({
        type: 'task/selected',
        causedBy: null,
        payload:
          targetEid !== 0
            ? { eid, kind, targetLoc, targetEid }
            : { eid, kind, targetLoc },
      });
      stampCause(Task, 'causeEvent', eid, id);
    }
  },
};
