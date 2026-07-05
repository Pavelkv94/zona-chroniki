/**
 * @module @zona/ui/map/geometry
 *
 * ЧИСТАЯ ГЕОМЕТРИЯ карты: перевод нормированной раскладки в пиксели, интерполяция
 * позиции сущности вдоль ребра loc→dest, кластерная раскладка перекрытых глифов в
 * узле и хит-тест клика. Всё — детерминированные функции без DOM/состояния: карта
 * остаётся ЧИТАТЕЛЕМ (закон №8), геометрия тестируется без canvas/воркера.
 *
 * Система координат — ПИКСЕЛИ canvas (y вниз). Нормированная раскладка [0..1] из
 * `visual-config.json` масштабируется под текущий размер холста с полями (padding),
 * чтобы крайние узлы (Кордон/Саркофаг) не липли к границе.
 */

import type { NodeLayout } from './visual-config';

/** Точка в пикселях холста. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Перевод нормированной [0..1] позиции узла в пиксели с полями `pad` по краям.
 * `w`/`h` — размер холста. Крайние координаты (0 и 1) ложатся на `pad` и `size-pad`.
 */
export function layoutToPixels(pos: NodeLayout, w: number, h: number, pad: number): Point {
  return {
    x: pad + pos.x * (w - 2 * pad),
    y: pad + pos.y * (h - 2 * pad),
  };
}

/** Линейная интерполяция точки: t=0 → a, t=1 → b. */
export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Прогресс сущности вдоль ребра из остатка пути `etaTicks` и полной длины перехода
 * `totalTicks` (тиков, когда движение началось). t = (total-eta)/total, кламп [0..1]:
 *  - eta == total (только вышел)   → 0 (в узле `loc`);
 *  - eta == 0     (прибыл)         → 1 (в узле `dest`).
 * total <= 0 (нет данных о длине) → 1 (считаем прибывшим, чтобы не застрять в `loc`).
 */
export function edgeProgress(etaTicks: number, totalTicks: number): number {
  if (totalTicks <= 0) return 1;
  const t = (totalTicks - etaTicks) / totalTicks;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Смещение i-го глифа из `count` в узле, чтобы перекрытые сущности не сливались.
 * Один в узле (count<=1) → центр (0,0). Иначе — равномерно по кольцу радиуса `radius`
 * (детерминированно от индекса: угол = 2π·i/count, старт сверху). Кластеризация —
 * презентация, не влияет на состояние (закон №8).
 */
export function clusterOffset(index: number, count: number, radius: number): Point {
  if (count <= 1) return { x: 0, y: 0 };
  const angle = (2 * Math.PI * index) / count - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/** Кандидат хит-теста: сущность с экранной позицией и радиусом попадания. */
export interface HitCandidate {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
  /** Радиус попадания в пикселях (обычно половина размера глифа + запас). */
  readonly r: number;
}

/**
 * Хит-тест клика (`cx`,`cy`) по глифам: возвращает eid БЛИЖАЙШЕЙ сущности, чей круг
 * попадания накрыл точку, иначе `null`. При равенстве расстояний — меньший индекс
 * (детерминизм). Чистая функция над снимком экранных позиций.
 */
export function hitTest(candidates: readonly HitCandidate[], cx: number, cy: number): number | null {
  let bestEid: number | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dx = c.x - cx;
    const dy = c.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist <= c.r && dist < bestDist) {
      bestDist = dist;
      bestEid = c.eid;
    }
  }
  return bestEid;
}
