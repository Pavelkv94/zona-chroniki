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
 * 'inventory') и СТАТИЧЕСКИЕ свойства локаций из data (water/game/forage/danger).
 * Живые животные (носители Animal+Alive) — как цели охоты. TaskSelection НЕ читает глобальное состояние мира в обход восприятия и НЕ
 * зовёт другие системы напрямую: общение — через компоненты и шину (закон №6).
 * Угроза влияет на выбор ЧЕРЕЗ `Needs.fear` (его поднимает Perception 1.7 от
 * co-located угрозы) — поэтому отдельного чтения `contacts` здесь нет: страх уже
 * инкапсулирует «рядом зверь», а формулы оценок опираются на него (см. FLEE).
 *
 * ── Оценки (веса ТОЛЬКО из balance/utility.ts, закон №7) ─────────────────────
 * Нужды нормируются делением на NEED_MAX ∈ [0..1]; safety(loc)=1-danger. Формулы:
 *   SLEEP  = W.fatigue·fatigue + (night?W.night:0) + safety·W.safe
 *   EAT    = (W.hunger + W.food)·hunger    (ТОЛЬКО если в инвентаре есть еда)
 *   DRINK  = W.thirst·thirst + waterHere·W.water
 *   HUNT   = W.hunger·hunger + gameAbund·W.game + survival·W.skill
 *            − fear·W.fear − (night?W.nightHunt:0)  (ТОЛЬКО если есть достижимая дичь)
 *   FLEE   = W.fleeFear·fear
 *   FORAGE = FALLBACK_SCORE_FLOOR + W.forageBase·forageAbund   (fallback, всегда >0)
 *   REST   = W.restBase + W.fatigue·fatigue·REST_FATIGUE_FACTOR (fallback, всегда >0)
 *   WORK   = W.work·safety·max(0, 1−maxNeed)   (ТОЛЬКО носитель Job И день, задача 2.4)
 * EAT без еды и HUNT без достижимой дичи ИСКЛЮЧАЮТСЯ из argmax (−∞): нельзя есть
 * то, чего нет (закон №3), и нельзя охотиться там, где дичи нет. WORK ИСКЛЮЧЁН (−∞)
 * у безработных (нет Job) и ночью (работник спит, а не выходит на смену) — поведение
 * не-Job NPC не меняется. `maxNeed` = самая высокая нужда: любая критическая нужда/
 * страх гасит WORK к нулю и пропускает вперёд EAT/DRINK/SLEEP/HUNT/FLEE (сначала
 * выжить, потом смена); спокойный сытый работник днём выбирает WORK НАД fallback'ами
 * (эмерджентный «рабочий день» БЕЗ явного расписания — закон №1/№2). Два fallback'а
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
 * (порядок enum: SLEEP<EAT<DRINK<FORAGE<HUNT<REST<FLEE<WORK), а НЕ rng-tie-break:
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
 *   WORK           → Job.workplace (рабочее место; если уже там — на месте).
 * Ближайшая loc считается детерминированным Дейкстрой (pathfinding), tie по
 * стоимости — меньший id локации.
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

import type { EntityId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { queryEntities, hasComponent, addComponent, stampCause } from '../core/ecs';
import { Position, Needs, Task, Skills, Home, Animal, Human, Alive, Job, TaskKind } from '../core/components';
import { MAP, getLocation, getItem, neighbors } from '../data/index';
import { MAP_GRAPH, shortestPath } from './pathfinding';
import { NEED_MAX } from '../balance/needs';
import { W, FALLBACK_SCORE_FLOOR, REST_FATIGUE_FACTOR } from '../balance/utility';
import { isNight } from './daynight';

/** Ключ ResourceStore со списком инвентаря (D-007); форма — см. worldgen. */
const INVENTORY_KEY = 'inventory';

/** Единица инвентаря (та же форма, что пишет worldgen 1.3). */
interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
}

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const POS = Position as unknown as { readonly loc: Uint32Array };
const NEED = Needs as unknown as {
  readonly hunger: Float32Array;
  readonly thirst: Float32Array;
  readonly fatigue: Float32Array;
  readonly fear: Float32Array;
};
const SKILL = Skills as unknown as { readonly survival: Float32Array };
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

/** Соседняя локация с наименьшим danger (tie — меньший id). Если соседей нет — сама `loc`. */
function safestNeighbor(loc: number): LocationId {
  const nbs = neighbors(loc as LocationId);
  let best = loc as LocationId;
  let bestDanger = Infinity;
  for (const nb of nbs) {
    const d = getLocation(nb).danger;
    if (d < bestDanger) {
      bestDanger = d;
      best = nb;
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
      const foodInInv = hasFood(world.resources.get<InventoryEntry[]>(INVENTORY_KEY, eid));

      // Цели-кандидаты (нужны и для оценок, и для записи выбранной задачи).
      const homeLoc = hasComponent(ecs, Home, eid) ? (HOME.loc[eid] as LocationId) : (loc as LocationId);
      const hunt = nearestHunt(loc, animalLocs, animalsByLoc);
      const drinkLoc = waterHere ? (loc as LocationId) : (nearestLoc(loc, WATER_LOCS) ?? (loc as LocationId));
      const fleeLoc = safestNeighbor(loc);
      const gameAbund = hunt !== null ? getLocation(hunt.loc).game : 0;
      // Трудоустройство (задача 2.4): носительство Job = «работает на поселение».
      // У безработных Job нет ⇒ WORK недоступен (score −∞), поведение не-Job NPC не
      // меняется. workplace — loc рабочего места (цель WORK); задан только при hasJob.
      const hasJob = hasComponent(ecs, Job, eid);
      const workplace = hasJob ? (JOB.workplace[eid] as LocationId) : (loc as LocationId);

      // ── Оценки (веса из balance/utility, закон №7) ─────────────────────────
      const sSleep = W.fatigue * fatigue + (night ? W.night : 0) + safety * W.safe;
      // EAT масштабируется голодом (D-034): при hunger≈0 → ~0 (не переедаем), при
      // голоде бонус W.food поднимает EAT над HUNT (доесть запас раньше охоты).
      const sEat = foodInInv ? (W.hunger + W.food) * hunger : -Infinity;
      const sDrink = W.thirst * thirst + waterHere * W.water;
      const sHunt =
        hunt !== null
          ? W.hunger * hunger +
            gameAbund * W.game +
            survival * W.skill -
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
