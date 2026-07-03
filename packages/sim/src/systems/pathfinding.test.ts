/**
 * @module @zona/sim/systems/pathfinding.test
 *
 * Гейт детерминированного поиска пути (задача 1.4). Покрывает:
 *  - кратчайший путь на РЕАЛЬНОЙ карте (вынужденный, многозвенный);
 *  - выбор из двух реальных альтернатив по суммарной длине (не по числу хопов);
 *  - tie-break при РАВНЫХ по длине путях → стабильный меньший id узла;
 *  - приоритет реально более короткого маршрута над «меньшим id» (не жадность по id);
 *  - вырожденные случаи (from===to, недостижимость, узел вне диапазона);
 *  - воспроизводимость (закон №8): повтор даёт тот же путь.
 */

import { describe, it, expect } from 'vitest';
import { shortestPath, firstStep, MAP_GRAPH, type WeightedGraph } from './pathfinding';

/**
 * Строит неориентированный `WeightedGraph` из списка рёбер `[a,b,w]`. Соседи
 * сортируются по возрастанию (как в реальной карте) — фиксирует порядок обхода.
 */
function graphOf(nodeCount: number, edges: ReadonlyArray<readonly [number, number, number]>): WeightedGraph {
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  const w = new Map<string, number>();
  for (const [a, b, len] of edges) {
    adj[a]!.push(b);
    adj[b]!.push(a);
    w.set(`${Math.min(a, b)}-${Math.max(a, b)}`, len);
  }
  for (const list of adj) list.sort((x, y) => x - y);
  return {
    nodeCount,
    neighbors: (node) => adj[node] ?? [],
    weight: (a, b) => w.get(`${Math.min(a, b)}-${Math.max(a, b)}`) ?? Infinity,
  };
}

describe('shortestPath на реальной карте Зоны', () => {
  it('вынужденный путь 0→2 идёт через Свалку (loc 0 degree=1): [0,1,2]', () => {
    expect(shortestPath(MAP_GRAPH, 0, 2)).toEqual([0, 1, 2]);
    expect(firstStep(MAP_GRAPH, 0, 2)).toBe(1);
  });

  it('5→7 выбирает более короткий по ДЛИНЕ маршрут [5,6,7]=120, а не [5,4,7]=130', () => {
    expect(shortestPath(MAP_GRAPH, 5, 7)).toEqual([5, 6, 7]);
    expect(firstStep(MAP_GRAPH, 5, 7)).toBe(6);
  });

  it('3→7 = [3,4,7] (125 < 3→5→6→7=160)', () => {
    expect(shortestPath(MAP_GRAPH, 3, 7)).toEqual([3, 4, 7]);
    expect(firstStep(MAP_GRAPH, 3, 7)).toBe(4);
  });

  it('путь в тупик Саркофаг (9) достижим только по единственному маршруту 8→9', () => {
    const path = shortestPath(MAP_GRAPH, 8, 9);
    expect(path).toEqual([8, 9]);
    expect(firstStep(MAP_GRAPH, 8, 9)).toBe(9);
  });
});

describe('tie-break при равных по длине альтернативах (закон №8)', () => {
  // «Ромб»: 0→3 двумя равными путями 0-1-3 (2) и 0-2-3 (2). Ожидаем меньший id.
  const diamond = graphOf(4, [
    [0, 1, 1],
    [0, 2, 1],
    [1, 3, 1],
    [2, 3, 1],
  ]);

  it('равные пути → выбираем через МЕНЬШИЙ id узла: [0,1,3]', () => {
    expect(shortestPath(diamond, 0, 3)).toEqual([0, 1, 3]);
    expect(firstStep(diamond, 0, 3)).toBe(1);
  });

  it('стабильно при повторе (детерминизм)', () => {
    expect(shortestPath(diamond, 0, 3)).toEqual(shortestPath(diamond, 0, 3));
  });

  // Асимметричный ромб: ветка через БОЛЬШИЙ id (2) строго короче — берём её,
  // а не жадно меньший id. Доказывает, что tie-break — именно при РАВЕНСТВЕ.
  const skewed = graphOf(4, [
    [0, 1, 5],
    [0, 2, 1],
    [1, 3, 1],
    [2, 3, 1],
  ]);

  it('реально более короткий маршрут побеждает «меньший id»: [0,2,3]', () => {
    expect(shortestPath(skewed, 0, 3)).toEqual([0, 2, 3]);
    expect(firstStep(skewed, 0, 3)).toBe(2);
  });
});

describe('вырожденные случаи', () => {
  const line = graphOf(3, [[0, 1, 1]]); // узел 2 изолирован

  it('from === to → путь [from], firstStep undefined', () => {
    expect(shortestPath(MAP_GRAPH, 4, 4)).toEqual([4]);
    expect(firstStep(MAP_GRAPH, 4, 4)).toBeUndefined();
  });

  it('недостижимый узел → undefined', () => {
    expect(shortestPath(line, 0, 2)).toBeUndefined();
    expect(firstStep(line, 0, 2)).toBeUndefined();
  });

  it('узел вне диапазона → undefined', () => {
    expect(shortestPath(MAP_GRAPH, 0, 99)).toBeUndefined();
    expect(shortestPath(MAP_GRAPH, -1, 2)).toBeUndefined();
  });

  it('дробный / нецелый id узла → undefined (inBounds требует целое)', () => {
    expect(shortestPath(MAP_GRAPH, 0, 2.5)).toBeUndefined();
    expect(firstStep(MAP_GRAPH, 1.5, 2)).toBeUndefined();
  });

  it('firstStep(from===to) undefined даже если у узла есть соседи', () => {
    // Узел 5 — «хаб» (degree>1); путь в себя всё равно тривиален, шага нет.
    expect(shortestPath(MAP_GRAPH, 5, 5)).toEqual([5]);
    expect(firstStep(MAP_GRAPH, 5, 5)).toBeUndefined();
  });
});

describe('усиление QA: несвязный граф, длинные пути, guard веса', () => {
  it('несвязный граф (две компоненты): путь между компонентами → undefined', () => {
    // {0-1} и {2-3} — раздельные компоненты. firstStep не должен «выдумать» ребро.
    const split = graphOf(4, [
      [0, 1, 1],
      [2, 3, 1],
    ]);
    expect(shortestPath(split, 0, 3)).toBeUndefined();
    expect(firstStep(split, 0, 3)).toBeUndefined();
    // Внутри компоненты — работает.
    expect(shortestPath(split, 2, 3)).toEqual([2, 3]);
  });

  it('4-звенный путь на реальной карте детерминирован: 0→7 = [0,1,3,4,7]', () => {
    const p = shortestPath(MAP_GRAPH, 0, 7);
    expect(p).toEqual([0, 1, 3, 4, 7]); // 40+50+55+70 = 215
    expect(firstStep(MAP_GRAPH, 0, 7)).toBe(1);
    // Стабильность (закон №8): повтор идентичен.
    expect(shortestPath(MAP_GRAPH, 0, 7)).toEqual(p);
  });

  it('ТРИ равных по длине пути: tie-break стабильно берёт наименьшие id узлов', () => {
    // 0→4 тремя ветками длины 2: через 1, 2, 3. Побеждает наименьший промежуточный id (1).
    const trident = graphOf(5, [
      [0, 1, 1],
      [0, 2, 1],
      [0, 3, 1],
      [1, 4, 1],
      [2, 4, 1],
      [3, 4, 1],
    ]);
    expect(shortestPath(trident, 0, 4)).toEqual([0, 1, 4]);
    expect(firstStep(trident, 0, 4)).toBe(1);
  });

  it('MAP_GRAPH.weight на НЕсмежных узлах бросает (рассогласование карты — закон №3/№10)', () => {
    // 0 и 2 не смежны (0 соседствует только со Свалкой 1). weight зовётся Дейкстрой
    // лишь для соседей; прямой вызов на не-ребре обязан падать, а не врать числом.
    expect(() => MAP_GRAPH.weight(0, 2)).toThrow();
  });
});
