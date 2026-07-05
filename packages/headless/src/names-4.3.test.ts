/**
 * @module @zona/headless/names-4.3.test
 *
 * МИНИ-ГЕЙТ экспортёра имён `exportNames` (задача 4.3, D-081) — лёгкий индекс
 * `eid → EntityName` для read-time резолва имён радиоэфира (панель RadioLog строит
 * `renderMessage.ctx.nameOf`, т.к. `EntityView`/лог имён не несут). Под прицелом —
 * та же тройка инвариантов, что у view-4.1 (D-076), плюс покрытие людей/трупов:
 *  - ДЕТЕРМИНИЗМ (закон №8): один seed → две НЕЗАВИСИМЫЕ Зоны → индекс имён бит-в-бит.
 *  - ЧИСТОЕ ЧТЕНИЕ (D-006/D-080): смотреть — не трогать. hashSnapshot до==после; голдены
 *    (день-1 seed42 429867e2, пустой мир 481914ae) целы — экспортёр вне конвейера.
 *  - PLAIN (закон №5): наружу — только `EntityName` (строки), JSON round-trip тождествен.
 *  - КОРРЕКТНОСТЬ: у каждого живого сталкера есть имя-фамилия (закон №4); у ПОГИБШЕГО
 *    (труп) имя СОХРАНЯЕТСЯ (эфир о покойнике всё ещё резолвится); животных индекс НЕ несёт.
 *
 * Про глобальное состояние bitecs — как view-4.1: каждый `it` строит свой мир и снимает
 * с него всё нужное ДО постройки следующего (worldgen перезаписывает общие SoA-колонки).
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
  exportNames,
  type SimWorld,
} from '@zona/sim';
import type { EntityId, EntityName } from '@zona/shared';

const DAY = TICKS_PER_DAY;

function build(seed: number): { world: SimWorld; run: (ticks: number) => void } {
  const world = createSimWorld(seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase3Systems(scheduler);
  return { world, run: (ticks) => scheduler.run(world, ticks) };
}

describe('exportNames: детерминизм (закон №8)', () => {
  it('seed 42, два независимых прогона по дню → индекс имён DEEP-EQUAL', () => {
    const a = build(42);
    a.run(DAY);
    const namesA = exportNames(a.world);

    const b = build(42);
    b.run(DAY);
    const namesB = exportNames(b.world);

    expect(namesB).toEqual(namesA);
    expect(Object.keys(namesA).length).toBeGreaterThan(0); // тест не холостой
  });

  it('exportNames одного мира дважды подряд — DEEP-EQUAL (не зависит от вызова)', () => {
    const a = build(7);
    a.run(DAY);
    expect(exportNames(a.world)).toEqual(exportNames(a.world));
  });

  it('другой seed → другой набор имён (индекс не константа)', () => {
    const a = build(42);
    a.run(DAY);
    const namesA = exportNames(a.world);
    const c = build(7);
    c.run(DAY);
    const namesC = exportNames(c.world);
    expect(namesC).not.toEqual(namesA);
  });
});

describe('exportNames: чистое чтение — голдены целы (D-006/D-080)', () => {
  it('hashSnapshot ДО == ПОСЛЕ exportNames (наблюдатель не участник)', () => {
    const a = build(42);
    a.run(DAY);
    const before = hashSnapshot(serialize(a.world));
    exportNames(a.world);
    exportNames(a.world);
    expect(hashSnapshot(serialize(a.world)), 'exportNames обязан быть чистым чтением').toBe(before);
  });

  it('ГОЛДЕН day1 seed42 = 429867e2 не сдвигается вызовом exportNames', () => {
    const a = build(42);
    a.run(DAY);
    expect(hashSnapshot(serialize(a.world))).toBe('429867e2');
    exportNames(a.world);
    expect(hashSnapshot(serialize(a.world)), 'exportNames осквернил голден-мир').toBe('429867e2');
  });

  it('пустой мир: индекс пуст, голден 481914ae цел', () => {
    const empty = createSimWorld(0);
    expect(hashSnapshot(serialize(empty))).toBe('481914ae');
    expect(exportNames(empty)).toEqual({});
    expect(hashSnapshot(serialize(empty)), 'exportNames оживил пустой мир').toBe('481914ae');
  });
});

describe('exportNames: plain-форма (закон №5)', () => {
  it('JSON round-trip тождествен (только строки, ни одного bitecs-объекта)', () => {
    const a = build(42);
    a.run(DAY);
    const names = exportNames(a.world);
    const rt = JSON.parse(JSON.stringify(names)) as Record<number, EntityName>;
    expect(rt).toEqual(names);
    // Каждая запись — тройка непустых строк формы EntityName.
    for (const key of Object.keys(names)) {
      const n = names[Number(key)]!;
      expect(typeof n.first).toBe('string');
      expect(typeof n.last).toBe('string');
      expect(typeof n.nickname).toBe('string');
    }
  });
});

describe('exportNames: корректность (люди/трупы/животные)', () => {
  it('у КАЖДОГО живого сталкера в индексе есть имя-фамилия (закон №4)', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const names = exportNames(a.world);
    for (const e of view.entities) {
      if (e.kind !== 'human' || !e.alive) continue;
      const n = names[e.eid as unknown as number];
      expect(n, `сталкер ${e.eid} обязан быть в индексе имён`).toBeDefined();
      expect(n!.first.length).toBeGreaterThan(0);
      expect(n!.last.length).toBeGreaterThan(0);
    }
  });

  it('имя ПОГИБШЕГО сталкера (труп) сохраняется в индексе; животных индекс не несёт', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const names = exportNames(a.world);

    const corpses = view.entities.filter((e) => e.kind === 'corpse');
    expect(corpses.length).toBeGreaterThan(0); // за день кто-то погиб
    // Хотя бы один труп — бывший сталкер (несёт Human ⇒ имя сохранено эфиру о покойнике).
    const namedCorpse = corpses.find((c) => names[c.eid as unknown as number] !== undefined);
    expect(namedCorpse, 'труп бывшего сталкера обязан сохранить имя').toBeDefined();

    // Живые животные имён не имеют — их eid в индексе отсутствуют.
    for (const an of view.entities.filter((e) => e.kind === 'animal')) {
      expect(names[an.eid as unknown as number]).toBeUndefined();
    }
  });

  it('несуществующего eid в индексе нет (индекс — ровно носители Human с именем)', () => {
    const a = build(42);
    a.run(DAY);
    const names = exportNames(a.world);
    expect(names[999999 as unknown as EntityId as unknown as number]).toBeUndefined();
  });
});
