/**
 * @module @zona/sim/systems/pathfinding
 *
 * Детерминированный поиск кратчайшего пути по взвешенному графу (задача 1.4).
 * Используется системой Movement (`movement.ts`), чтобы выбрать ПЕРВЫЙ шаг
 * маршрута от текущей локации к целевой. Модуль ЧИСТЫЙ: не импортирует ECS/шину/
 * данные напрямую — работает через абстракцию `WeightedGraph`, поэтому его легко
 * юнит-тестировать на синтетических графах (в т.ч. с равными альтернативами для
 * проверки tie-break). Адаптер над реальной картой (`MAP_GRAPH`) собирается ниже
 * из `data/index` — единственная привязка к контенту (закон №10).
 *
 * ── Алгоритм (Дейкстра, закон №8) ────────────────────────────────────────────
 * Граф мал (10 локаций), поэтому берём классический O(V²) Дейкстру на плотных
 * массивах, без бинарной кучи: на каждом шаге линейно ищем неулаженный узел с
 * минимальной дистанцией. Веса рёбер — `edge.len` (тики-минуты), строго > 0
 * (валидатор данных гарантирует len ∈ [1,240]), поэтому Дейкстра применим.
 *
 * ── Детерминизм и tie-break (закон №8) ───────────────────────────────────────
 * Два источника недетерминизма в Дейкстре — порядок ВЫБОРА узла при равных
 * дистанциях и порядок ФИКСАЦИИ предшественника при равных путях. Оба закрыты:
 *  1) выбор неулаженного: строгое `<` при обходе узлов ПО ВОЗРАСТАНИЮ id —
 *     при равной дистанции остаётся узел с МЕНЬШИМ id (tie-break по id узла);
 *  2) релаксация строгим `<` (а не `<=`): предшественник фиксируется ПЕРВЫМ
 *     достигшим минимума ребром. Поскольку узлы улаживаются в порядке
 *     (dist, id), при равных по длине альтернативах побеждает маршрут через
 *     раньше улаженный (= меньший id) узел. Итог полностью воспроизводим.
 * Списки соседей карты уже отсортированы по возрастанию (`data/index`), что
 * дополнительно фиксирует порядок релаксации.
 *
 * Пример:
 * ```ts
 * import { shortestPath, firstStep, MAP_GRAPH } from './pathfinding';
 * shortestPath(MAP_GRAPH, 0, 2); // [0, 1, 2] — через Свалку (0 degree=1)
 * firstStep(MAP_GRAPH, 0, 2);    // 1 — первый шаг маршрута
 * ```
 */

import type { LocationId } from '@zona/shared';
import { MAP, neighbors, edgeLen } from '../data/index';

/**
 * Взвешенный граф с плотной нумерацией узлов `0..nodeCount-1`. Абстракция, на
 * которой работает Дейкстра — не знает, откуда берутся узлы (карта, тест-фикстура).
 */
export interface WeightedGraph {
  /** Число узлов; допустимые id — целые `[0, nodeCount)`. */
  readonly nodeCount: number;
  /** Соседи узла. Порядок влияет только на tie-break при равных путях. */
  neighbors(node: number): readonly number[];
  /** Вес ребра `a—b` (> 0). Вызывается ТОЛЬКО для смежных `a`, `b`. */
  weight(a: number, b: number): number;
}

/** Узел вне диапазона `[0, nodeCount)` — не участвует в поиске. */
function inBounds(graph: WeightedGraph, node: number): boolean {
  return Number.isInteger(node) && node >= 0 && node < graph.nodeCount;
}

/**
 * Кратчайший путь `from → to` как массив узлов `[from, …, to]` (включая концы).
 * Возвращает:
 *  - `[from]`, если `from === to` (нулевой путь);
 *  - `undefined`, если `to` недостижим или любой из концов вне диапазона.
 *
 * Детерминирован (закон №8): выбор узла и предшественника — по правилам
 * tie-break из docblock модуля.
 */
export function shortestPath(
  graph: WeightedGraph,
  from: number,
  to: number,
): readonly number[] | undefined {
  if (!inBounds(graph, from) || !inBounds(graph, to)) return undefined;
  if (from === to) return [from];

  const n = graph.nodeCount;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const settled = new Array<boolean>(n).fill(false);
  dist[from] = 0;

  for (let iter = 0; iter < n; iter++) {
    // Выбор неулаженного узла с минимальной дистанцией; обход по возрастанию id
    // + строгое `<` ⇒ при равной дистанции берём МЕНЬШИЙ id (tie-break, закон №8).
    let u = -1;
    let best = Infinity;
    for (let v = 0; v < n; v++) {
      if (!settled[v] && (dist[v] as number) < best) {
        best = dist[v] as number;
        u = v;
      }
    }
    if (u === -1) break; // остаток недостижим
    if (u === to) break; // цель улажена — путь и предшественники зафиксированы
    settled[u] = true;

    for (const w of graph.neighbors(u)) {
      if (!inBounds(graph, w) || settled[w]) continue;
      const nd = (dist[u] as number) + graph.weight(u, w);
      // Строгое `<`: предшественника задаёт ПЕРВОЕ достигшее минимума ребро;
      // равные альтернативы (найденные позже, от большего id) не перебивают.
      if (nd < (dist[w] as number)) {
        dist[w] = nd;
        prev[w] = u;
      }
    }
  }

  if (!Number.isFinite(dist[to])) return undefined;

  // Реконструкция от `to` по предшественникам до `from`.
  const path: number[] = [];
  let cur = to;
  while (cur !== -1) {
    path.push(cur);
    if (cur === from) break;
    cur = prev[cur] as number;
  }
  if (path[path.length - 1] !== from) return undefined; // цепочка не сомкнулась
  path.reverse();
  return path;
}

/**
 * БЛИЖАЙШИЙ (по сумме весов рёбер = дистанции Дейкстры) узел, удовлетворяющий
 * `predicate`, достижимый из `from`. Возвращает `undefined`, если ни один
 * достижимый узел не проходит предикат. Используется экологией (Animals 1.9):
 * поиск ближайшей ВОДНОЙ локации при жажде и ближайшего КОРМНОГО угодья при
 * голоде — миграция из СОСТОЯНИЯ нужды (закон №2), а не по таймеру/рандому.
 *
 * Если `from` сам проходит предикат — возвращается `from` (дистанция 0), и
 * последующий `firstStep(from, from)` даст `undefined` (шаг не нужен: животное
 * уже там, где хотело). Детерминизм (закон №8): полный Дейкстра (веса > 0),
 * затем выбор минимальной дистанции строгим `<` при обходе узлов ПО ВОЗРАСТАНИЮ
 * id ⇒ при равной дистанции берётся МЕНЬШИЙ id (стабильный tie-break).
 */
export function nearestWhere(
  graph: WeightedGraph,
  from: number,
  predicate: (node: number) => boolean,
): number | undefined {
  if (!inBounds(graph, from)) return undefined;

  const n = graph.nodeCount;
  const dist = new Array<number>(n).fill(Infinity);
  const settled = new Array<boolean>(n).fill(false);
  dist[from] = 0;

  // Полный Дейкстра (улаживаем ВСЕ достижимые узлы — цели нет, ищем ближайшую
  // подходящую по предикату). Граф мал (10 узлов) ⇒ O(V²) дёшево (D-006).
  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    let best = Infinity;
    for (let v = 0; v < n; v++) {
      if (!settled[v] && (dist[v] as number) < best) {
        best = dist[v] as number;
        u = v;
      }
    }
    if (u === -1) break; // остаток недостижим
    settled[u] = true;
    for (const w of graph.neighbors(u)) {
      if (!inBounds(graph, w) || settled[w]) continue;
      const nd = (dist[u] as number) + graph.weight(u, w);
      if (nd < (dist[w] as number)) dist[w] = nd;
    }
  }

  // Ближайший узел, проходящий предикат: min dist, tie-break по МЕНЬШЕМУ id
  // (обход по возрастанию id + строгое `<`).
  let bestNode: number | undefined;
  let bestDist = Infinity;
  for (let v = 0; v < n; v++) {
    if (!Number.isFinite(dist[v])) continue;
    if (!predicate(v)) continue;
    if ((dist[v] as number) < bestDist) {
      bestDist = dist[v] as number;
      bestNode = v;
    }
  }
  return bestNode;
}

/**
 * Первый шаг кратчайшего пути `from → to` — узел сразу после `from`.
 * Возвращает `undefined`, если `from === to` (шаг не нужен) или `to` недостижим.
 * Это то, что Movement выставляет в `Position.dest` при departure.
 */
export function firstStep(
  graph: WeightedGraph,
  from: number,
  to: number,
): number | undefined {
  const path = shortestPath(graph, from, to);
  if (path === undefined || path.length < 2) return undefined;
  return path[1];
}

/**
 * Адаптер реального графа карты Зоны (`data/index`) под `WeightedGraph`. Узлы —
 * плотные `LocationId` (0..N-1), соседи и длины рёбер берутся из валидированного
 * контента (закон №10). `weight` вызывается Дейкстрой только для смежных узлов,
 * поэтому `edgeLen` здесь всегда определён; иначе — битые данные (ранний throw).
 */
export const MAP_GRAPH: WeightedGraph = {
  nodeCount: MAP.locations.length,
  neighbors(node: number): readonly number[] {
    return neighbors(node as LocationId);
  },
  weight(a: number, b: number): number {
    const len = edgeLen(a as LocationId, b as LocationId);
    if (len === undefined) {
      // Дейкстра релаксирует только по соседям — отсутствие ребра здесь
      // означает рассогласование adjacency/edgeLen в контенте.
      throw new Error(`pathfinding: нет ребра ${a}—${b} (рассогласование карты).`);
    }
    return len;
  },
};
