/**
 * @module @zona/sim/systems/movement
 *
 * Система Movement (задача 1.4, B.1) — перемещение сущностей по графу локаций.
 * Читает намерение из компонента `Task` (её ставит TaskSelection 1.8 — Movement
 * ТОЛЬКО читает, не пишет Task) и двигает носителя `Position` к `Task.targetLoc`
 * кратчайшим путём (детерминированный Дейкстра, `pathfinding.ts`). Общение —
 * только через ECS-компоненты и шину событий с `causedBy` (закон №6): напрямую
 * другие системы не вызываются.
 *
 * ── Модель транзита (D-019, без sentinel) ────────────────────────────────────
 * `Position.dest === loc` ⇒ сущность СТОИТ; `dest !== loc` ⇒ в пути, `etaTicks` —
 * сколько тиков осталось до `dest`. На каждом тике сущность в РОВНО одной ветке:
 *  • СТОИТ и цель ≠ loc → departure: `dest = первый_шаг`, `etaTicks = edgeLen`,
 *    публикуется `move/departed`. (Списывания eta в этот тик НЕТ.)
 *  • В ПУТИ → `etaTicks -= 1`; при `etaTicks <= 0` прибытие: `loc = dest`,
 *    публикуется `move/arrived`.
 * Одиночный переход занимает РОВНО `edgeLen` тиков (departure на тике T →
 * arrival на T+edgeLen). Мультихоп рождается естественно: прибыв в промежуточный
 * узел (`loc = dest`), на СЛЕДУЮЩЕМ тике сущность снова «стоит» и делает departure
 * к следующему шагу — между хопами один тик-передышка на узле (по контракту B.1
 * «на следующем тике departs дальше»).
 *
 * ── Цель движения ────────────────────────────────────────────────────────────
 * Цель = `Task.targetLoc` носителя, ЕСЛИ у него есть компонент `Task`. Нет Task
 * или `targetLoc === loc` ⇒ сущность не движется (событий нет). Movement НЕ знает
 * таксономию видов задач и не решает, «нужна ли локация» этому виду — это забота
 * TaskSelection (1.8), которая для задач без перемещения выставляет
 * `targetLoc = loc` (сущность стоит). Так Movement свободен от магии видов задач
 * (закон №7) и не залезает в чужую зону.
 *
 * ── Кратчайший путь и danger (D-025) ─────────────────────────────────────────
 * Путь — строго кратчайший по `edgeLen`. Взвешивание danger — забота
 * TaskSelection (какую локацию выбрать целью), а не Movement. Кратчайший путь
 * САМ не заходит в тупик Саркофаг (loc 9, degree=1): узел степени 1 не лежит на
 * кратчайшем маршруте между двумя другими узлами. Поэтому спец-обработки «не гнать
 * в тупик» не требуется — она вытекает из кратчайшего пути.
 *
 * ── Скорость ─────────────────────────────────────────────────────────────────
 * `etaTicks = max(MIN_TRAVEL_TICKS, edgeLen)` (константа-пол из balance/movement,
 * закон №7; edgeLen ≥ 1, поэтому фактически = edgeLen). Множители ночь/усталость
 * (balance/movement) в 1.4 СОЗНАТЕЛЬНО не применяются: они связали бы Movement с
 * WorldClock/Needs и нарушили «идёт ровно edgeLen тиков». Их подключит тюнинг
 * позже через sim-architect.
 *
 * ── Причинность (закон №6, замкнутые цепочки) ────────────────────────────────
 * `move/arrived.causedBy` → последний `move/departed` этого eid в логе (departure
 * текущего шага). `move/departed.causedBy` зависит от того, ПЕРВЫЙ это хоп ноги
 * или промежуточный:
 *  • ПЕРВЫЙ хоп (нога только началась): причина — самый свежий committed
 *    `task/selected` этого eid, У КОТОРОГО `payload.targetLoc === текущему
 *    Task.targetLoc` (именно то событие 1.8, что задало эту цель). Матч по
 *    (eid И targetLoc) снимает риск прилипания СТАРОГО task/selected (иной цели).
 *    Нет такого — `null` (не прилепляем чужую цель).
 *  • ПРОМЕЖУТОЧНЫЙ хоп (departs, только что прибыв в промежуточный узел, цель
 *    дальше): причина — последний `move/arrived` этого eid (промежуточное
 *    прибытие). Так цепочка мультихопа замыкается без разрывов:
 *    `task/selected → dep1 → arr1 → dep2 → arr2 → …`.
 * Различение хопов: если самый свежий совпадающий `task/selected` НОВЕЕ последнего
 * `move/arrived` (или прибытий ещё не было) — это первый хоп новой ноги; иначе мы
 * departs после промежуточного прибытия → промежуточный хоп.
 *
 * ТАЙМИНГ (финализируется при 1.8): контракт TaskSelection 1.8 — `task/selected`
 * должен быть ЗАКОММИЧЕН до тика departure. Сейчас Movement матчит по (eid,
 * targetLoc) из committed-лога, что робастно и без stale независимо от точного
 * тика публикации; точный тайминг/связь at(tick-1) закрепит 1.8.
 *
 * ── Инвариант цели (F-2, закон №4 — латентный idle) ──────────────────────────
 * Если `firstStep` не найден (targetLoc вне диапазона/недостижим), сущность стоит
 * молча БЕЗ событий (Movement не падает — граф связен, для валидных целей такого
 * не бывает). Контракт: TaskSelection (1.8) ОБЯЗАНА давать только валидный
 * достижимый `targetLoc`; молчаливый вечный простой из-за невалидной цели
 * ловится world-инвариантом гейта 1.13 («0 idle > N тиков»), а не крашем здесь.
 *
 * rng НЕ используется: путь детерминирован графом (закон №2 — случайность только
 * там, где есть физиологический разброс; у движения его нет).
 */

import type { EntityId, EventId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import { queryEntities, hasComponent } from '../core/ecs';
import { Position, Task } from '../core/components';
import { MIN_TRAVEL_TICKS } from '../balance/movement';
import { MAP_GRAPH, firstStep } from './pathfinding';

/** Тип события выбора задачи (TaskSelection 1.8). Ещё не в union `SimEvent` —
 * ссылаемся по строке; поиск в логе идёт по этому дискриминанту (см. departure). */
const TASK_SELECTED_TYPE = 'task/selected';

/** Типизированные SoA-колонки `Position` (loc/dest — ui32, etaTicks — f32). */
const POS = Position as unknown as {
  readonly loc: Uint32Array;
  readonly dest: Uint32Array;
  readonly etaTicks: Float32Array;
};
/** Типизированная колонка `Task.targetLoc` (ui32) — Movement читает только её. */
const TASK = Task as unknown as { readonly targetLoc: Uint32Array };

/**
 * Ищет id самого свежего committed `task/selected` этого `eid`, У КОТОРОГО
 * `payload.targetLoc === target`. Тип ещё не в union `SimEvent` — читаем
 * `type`/`payload` ослабленно. Матч по (eid И targetLoc) исключает прилипание
 * старого события с другой целью. Скан с конца → первое совпадение = самое свежее.
 * Нет — `null`.
 */
function findMatchingTaskSelected(
  bus: EventBus,
  eid: EntityId,
  target: number,
): EventId | null {
  const log = bus.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const ev = log[i];
    if (ev === undefined) continue;
    // `ev.type` — string в шапке; сравнение с ещё-не-union литералом безопасно.
    const type: string = ev.type;
    if (type !== TASK_SELECTED_TYPE) continue;
    const payload = ev.payload as unknown as { readonly eid?: number; readonly targetLoc?: number };
    if (payload.eid === eid && payload.targetLoc === target) return ev.id;
  }
  return null;
}

/**
 * Ищет id ПОСЛЕДНЕГО события типа `type` для сущности `eid` в append-only логе.
 * Скан с конца → первое совпадение = самое свежее (максимальный id). Используется
 * для `move/departed` (причина прибытия — departure текущего шага) и `move/arrived`
 * (промежуточное прибытие — причина следующего departure). Нет — `null`.
 */
function findLastMoveEvent(
  bus: EventBus,
  eid: EntityId,
  type: 'move/departed' | 'move/arrived',
): EventId | null {
  const log = bus.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const ev = log[i];
    if (ev === undefined) continue;
    if (ev.type === type && ev.payload.eid === eid) return ev.id;
  }
  return null;
}

/**
 * Причина события `move/departed` для `eid`, идущего к `target` (закон №6).
 * Различает первый хоп ноги (причина — совпадающий `task/selected`) и
 * промежуточный (причина — последнее `move/arrived`), см. docblock модуля.
 */
function departureCause(bus: EventBus, eid: EntityId, target: number): EventId | null {
  const selId = findMatchingTaskSelected(bus, eid, target);
  const arrId = findLastMoveEvent(bus, eid, 'move/arrived');
  // Совпадающий task/selected новее последнего прибытия (или прибытий не было) ⇒
  // это ПЕРВЫЙ хоп ноги, начатой этим task/selected → его и указываем причиной.
  if (selId !== null && (arrId === null || selId > arrId)) return selId;
  // Иначе departs после промежуточного прибытия → цепляем цепочку к нему.
  if (arrId !== null) return arrId;
  // Ни цели-события, ни прошлых прибытий (departure из истока без task/selected).
  return null;
}

/**
 * Система Movement (`every: 1`). Обходит носителей `Position` детерминированно
 * (queryEntities сортирует по eid, закон №8) и для каждого выполняет ровно один
 * шаг модели транзита (departure ↔ decrement/arrival).
 */
export const Movement: System = {
  name: 'Movement',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const movers = queryEntities(world.ecs, [Position]);

    for (const eid of movers) {
      const loc = POS.loc[eid] as number;
      const dest = POS.dest[eid] as number;

      if (dest === loc) {
        // ── СТОИТ ── цель берём из Task (если носитель Task); иначе не движется.
        if (!hasComponent(world.ecs, Task, eid)) continue;
        const target = TASK.targetLoc[eid] as number;
        if (target === loc) continue; // цель достигнута/совпадает — стоит

        const step = firstStep(MAP_GRAPH, loc, target);
        if (step === undefined) continue; // недостижимо (связный граф — не случится)

        const eta = Math.max(MIN_TRAVEL_TICKS, MAP_GRAPH.weight(loc, step));
        POS.dest[eid] = step;
        POS.etaTicks[eid] = eta;

        const cause = departureCause(bus, eid, target);
        bus.publish({
          type: 'move/departed',
          causedBy: cause,
          payload: {
            eid,
            from: loc as LocationId,
            to: step as LocationId,
          },
        });
      } else {
        // ── В ПУТИ ── списываем тик; при исчерпании — прибытие.
        const eta = (POS.etaTicks[eid] as number) - 1;
        POS.etaTicks[eid] = eta;
        if (eta > 0) continue;

        POS.loc[eid] = dest; // прибыл (loc === dest ⇒ снова «стоит»)
        const cause = findLastMoveEvent(bus, eid, 'move/departed');
        bus.publish({
          type: 'move/arrived',
          causedBy: cause,
          payload: {
            eid,
            at: dest as LocationId,
          },
        });
      }
    }
  },
};
