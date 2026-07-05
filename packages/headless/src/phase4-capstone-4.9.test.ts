/**
 * @module @zona/headless/phase4-capstone-4.9.test
 *
 * ФИНАЛЬНЫЙ ГЕЙТ Фазы 4 (задача 4.9) — сквозной holistic-инвариант границы наблюдателя,
 * читаемый как сцена Зоны, а не как проверка полей. Отдельные экспортёры уже закрыты
 * (view-4.1: exportWorldView/exportEntityDetail; names-4.3: exportNames), но КАЖДЫЙ по
 * отдельности. Здесь закрепляем СИЛЬНЕЕ: наблюдатель, открывший разом ВСЕ три окна в мир
 * на одном и том же живом тике (лёгкий снимок карты + индекс имён + тяжёлое досье по
 * КАЖДОЙ сущности), не оставляет в Зоне ни следа — snapshot-хэш до == после (D-006/D-080,
 * законы №5/№8). Это ловит гипотетическую перекрёстную мутацию (общий кэш/ленивое поле),
 * которую пер-экспортёрные тесты пропустили бы поодиночке.
 *
 * ── ВАЖНО ПРО ГЛОБАЛЬНОЕ СОСТОЯНИЕ bitecs ─────────────────────────────────────
 * SoA-колонки компонентов ГЛОБАЛЬНЫ на процесс: постройка второго мира перезаписывает их.
 * Поэтому каждый тест строит свой мир и снимает с него всё нужное ВНУТРИ одного `it`.
 */

import { describe, it, expect } from 'vitest';
import {
  createSimWorld,
  createScheduler,
  registerPhase3Systems,
  worldgen,
  serialize,
  hashSnapshot,
  TICKS_PER_DAY,
  exportWorldView,
  exportEntityDetail,
  exportNames,
  type SimWorld,
} from '@zona/sim';
import type { WorldView, EntityDetail, EntityName } from '@zona/shared';

const DAY = TICKS_PER_DAY;

/** Живой конвейер Фазы 3 = тот же мир, что гоняет CLI (D-076). */
function build(seed: number): { world: SimWorld; run: (ticks: number) => void } {
  const world = createSimWorld(seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase3Systems(scheduler);
  return { world, run: (ticks) => scheduler.run(world, ticks) };
}

describe('Финальный гейт 4.9: наблюдатель открывает разом ВСЕ окна в Зону — и мир не дрогнул', () => {
  it('exportWorldView + exportNames + exportEntityDetail(каждой сущности) вместе: hashSnapshot ДО == ПОСЛЕ', () => {
    const a = build(42);
    a.run(DAY);
    const before = hashSnapshot(serialize(a.world));

    // Один тик — три окна сразу: карта, имена, досье по КАЖДОМУ, кого видно.
    const view = exportWorldView(a.world);
    const names = exportNames(a.world);
    for (const e of view.entities) exportEntityDetail(a.world, e.eid);
    // И для eid из индекса имён — тоже (пересечение путей резолва).
    for (const key of Object.keys(names)) exportEntityDetail(a.world, Number(key) as never);

    expect(
      hashSnapshot(serialize(a.world)),
      'совместный вызов трёх экспортёров осквернил мир — перекрёстная мутация',
    ).toBe(before);
    // Тест не холостой: мир населён, все три окна что-то показали.
    expect(view.entities.length).toBeGreaterThan(0);
    expect(Object.keys(names).length).toBeGreaterThan(0);
  });

  it('все три экспортёра — чистые функции: два вызова на неизменном мире DEEP-EQUAL', () => {
    const a = build(7);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const heroEid = view.entities.find((e) => e.kind === 'human' && e.alive)?.eid;
    if (heroEid === undefined) throw new Error('worldgen без живого сталкера — мир сломан');

    expect(exportWorldView(a.world)).toEqual(view);
    expect(exportNames(a.world)).toEqual(exportNames(a.world));
    expect(exportEntityDetail(a.world, heroEid)).toEqual(exportEntityDetail(a.world, heroEid));
  });

  it('граница ECS↔UI (закон №5): три проекции JSON-round-trip тождественны (только plain-формы)', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const names = exportNames(a.world);
    const heroEid = view.entities.find((e) => e.kind === 'human' && e.alive)!.eid;
    const detail = exportEntityDetail(a.world, heroEid);

    const viewRT = JSON.parse(JSON.stringify(view)) as WorldView;
    const namesRT = JSON.parse(JSON.stringify(names)) as Record<number, EntityName>;
    const detailRT = JSON.parse(JSON.stringify(detail)) as EntityDetail;

    // Round-trip тождествен ⇒ нет функций/циклов/bitecs-объектов (те схлопнулись бы в {}).
    expect(viewRT).toEqual(view);
    expect(namesRT).toEqual(names);
    expect(detailRT).toEqual(detail);
  });
});
