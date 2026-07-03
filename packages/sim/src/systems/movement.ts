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
 * ── Причинность через ШТАМПЫ (закон №6, D-030/D-032; ретрофит 1.8) ────────────
 * БОЛЬШЕ НЕ сканируем лог (снят перф-хвост D-026: O(лог) filter на носителя за
 * тик). Причина берётся O(1) из полей компонентов (конвенция D-030 «id причины в
 * поле состояния»):
 *  • `move/departed.causedBy` = `Task.causeEvent` носителя — это `task/selected`,
 *    выбравший текущую задачу (штампует TaskSelection 1.8 при СМЕНЕ задачи, D-032).
 *    `0` (нет причины) → `null`. Для КАЖДОГО хопа ноги причина departed — тот же
 *    `task/selected` (задача не менялась ⇒ поле стабильно).
 *  • При СТАРТЕ перехода id только что опубликованного `move/departed` штампуется
 *    в `Position.moveCause` (`stampCause`), чтобы id причины дожил до прибытия.
 *  • `move/arrived.causedBy` = `Position.moveCause` — id departed ЭТОГО шага
 *    (снова O(1) из поля, `0` → `null`). Так цепочка каждого хопа замкнута:
 *    `task/selected → move/departed → move/arrived`.
 * Согласовано с docblock `Position.moveCause` (1.2b): поле хранит EventId
 * `move/departed`, начавшего переход, и читается при прибытии. Резолв без лога:
 * arrived.causedBy=departed.id, departed.causedBy=Task.causeEvent=task/selected.id.
 *
 * ПОРЯДОК В ТИКЕ (D-032): TaskSelection штампует `Task.causeEvent` РАНЬШЕ, чем
 * Movement его читает (TaskSelection < Movement в расписании), иначе departed
 * прочёл бы старую/нулевую причину.
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

import type { EventId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { queryEntities, hasComponent, stampCause } from '../core/ecs';
import { Position, Task } from '../core/components';
import { MIN_TRAVEL_TICKS } from '../balance/movement';
import { MAP_GRAPH, firstStep } from './pathfinding';

/** Типизированные SoA-колонки `Position` (loc/dest — ui32, etaTicks — f32,
 * moveCause — ui32: id departed текущего перехода, читается при прибытии, D-030). */
const POS = Position as unknown as {
  readonly loc: Uint32Array;
  readonly dest: Uint32Array;
  readonly etaTicks: Float32Array;
  readonly moveCause: Uint32Array;
};
/** Типизированные колонки `Task`: `targetLoc` — цель движения, `causeEvent` —
 * штамп причины (id `task/selected`, D-030), который Movement переносит в departed. */
const TASK = Task as unknown as {
  readonly targetLoc: Uint32Array;
  readonly causeEvent: Uint32Array;
};

/** ui32-поле причины (0 = «нет причины», D-031) → `EventId | null` для `causedBy`. */
function causeOrNull(id: number): EventId | null {
  return id === 0 ? null : (id as EventId);
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

        // Причина departed — штамп задачи (Task.causeEvent = id task/selected, D-030),
        // прочитанный O(1) из компонента, без скана лога.
        const id = bus.publish({
          type: 'move/departed',
          causedBy: causeOrNull(TASK.causeEvent[eid] as number),
          payload: {
            eid,
            from: loc as LocationId,
            to: step as LocationId,
          },
        });
        // Переносим id departed в Position.moveCause — доживёт до прибытия и станет
        // причиной arrived (D-030); stampCause даёт guard диапазона EventId (D-031).
        stampCause(Position, 'moveCause', eid, id);
      } else {
        // ── В ПУТИ ── списываем тик; при исчерпании — прибытие.
        const eta = (POS.etaTicks[eid] as number) - 1;
        POS.etaTicks[eid] = eta;
        if (eta > 0) continue;

        POS.loc[eid] = dest; // прибыл (loc === dest ⇒ снова «стоит»)
        // Причина arrived — id departed этого шага из Position.moveCause (O(1), D-030).
        bus.publish({
          type: 'move/arrived',
          causedBy: causeOrNull(POS.moveCause[eid] as number),
          payload: {
            eid,
            at: dest as LocationId,
          },
        });
      }
    }
  },
};
