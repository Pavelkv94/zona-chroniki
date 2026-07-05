/**
 * @module @zona/headless/names-exclusion-4.3.test
 *
 * УСИЛЕНИЕ гейта `exportNames` (задача 4.3, D-081) — прицельно на инвариант «ИНДЕКС
 * ИМЁН несёт РОВНО носителей `Human` и НИЧЕГО кроме». names-4.3.test уже проверил
 * детерминизм/чистоту/plain/людей-трупов-животных; здесь дожимаем «не-Human НЕ течёт»:
 *  - НИ ОДНО поселение (Settlement) не попадает в индекс — у него нет имени сталкера,
 *    хотя оно видимо на карте (kind 'settlement'). Утечка = смешение объектов мира.
 *  - НИ ОДНО животное/аномальное поле — ключи индекса ⊆ носители Human (люди+трупы).
 *  - Мульти-seed: инвариант держится не на одном стартовом раскладе.
 *  - PLAIN-round-trip НЕ бросает (JSON.stringify/parse тождествен) на каждом seed.
 *
 * «Только Human» доказывается КРОСС-ЧЕКОМ с `exportWorldView`: каждый ключ индекса имён
 * ОБЯЗАН быть сущностью вида 'human' ИЛИ 'corpse' (оба — носители Human тега); появление
 * settlement/animal/поля среди ключей ⇒ утечка. Так не тянем приватный AnomalyField.
 *
 * Про глобальное bitecs — как view-4.1/names-4.3: каждый `it` строит свой мир и снимает
 * с него всё нужное ДО следующего (worldgen перезаписывает общие SoA-колонки).
 */

import { describe, it, expect } from 'vitest';
import {
  createSimWorld,
  createScheduler,
  registerPhase3Systems,
  worldgen,
  TICKS_PER_DAY,
  exportWorldView,
  exportNames,
  type SimWorld,
} from '@zona/sim';
import type { EntityName } from '@zona/shared';

const DAY = TICKS_PER_DAY;

function build(seed: number): { world: SimWorld; run: (ticks: number) => void } {
  const world = createSimWorld(seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase3Systems(scheduler);
  return { world, run: (ticks) => scheduler.run(world, ticks) };
}

describe('exportNames: индекс несёт РОВНО носителей Human (не-Human не течёт, D-081)', () => {
  it('поселения ВИДИМЫ на карте, но их eid НЕ в индексе имён (объекты не смешаны)', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const names = exportNames(a.world);

    const settlements = view.entities.filter((e) => e.kind === 'settlement');
    expect(settlements.length, 'мир Фазы 3 обязан иметь поселения (тест не холостой)').toBeGreaterThan(0);
    for (const s of settlements) {
      expect(
        names[s.eid as unknown as number],
        `поселение ${s.eid} просочилось в индекс имён сталкеров`,
      ).toBeUndefined();
    }
  });

  it('КАЖДЫЙ ключ индекса имён — сущность вида human|corpse (ни settlement/animal/поле)', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const names = exportNames(a.world);

    // Карта eid → kind по видимым сущностям (люди/трупы/животные/поселения).
    const kindOf = new Map<number, string>();
    for (const e of view.entities) kindOf.set(e.eid as unknown as number, e.kind);

    const keys = Object.keys(names).map(Number);
    expect(keys.length, 'индекс не должен быть пуст').toBeGreaterThan(0);
    for (const eid of keys) {
      const kind = kindOf.get(eid);
      // Носитель Human виден на карте как 'human' (жив) или 'corpse' (погиб) — иных быть
      // не может. undefined kind = ключ ссылается на сущность вне видимого набора (поле) ⇒
      // тоже утечка (аномальное поле/часы имени не несут).
      expect(
        kind === 'human' || kind === 'corpse',
        `ключ ${eid} индекса имён имеет kind=${kind ?? 'вне карты'} — не носитель Human`,
      ).toBe(true);
    }
  });

  it('инвариант держится на ДРУГИХ seed (7, 100): только human|corpse, plain round-trip не бросит', () => {
    for (const seed of [7, 100]) {
      const a = build(seed);
      a.run(DAY);
      const view = exportWorldView(a.world);
      const names = exportNames(a.world);

      const kindOf = new Map<number, string>();
      for (const e of view.entities) kindOf.set(e.eid as unknown as number, e.kind);

      for (const eid of Object.keys(names).map(Number)) {
        const kind = kindOf.get(eid);
        expect(
          kind === 'human' || kind === 'corpse',
          `seed ${seed}: ключ ${eid} kind=${kind ?? 'вне карты'} не Human`,
        ).toBe(true);
      }
      // Животных индекс не несёт — прямой контроль по видимым животным.
      for (const an of view.entities.filter((e) => e.kind === 'animal')) {
        expect(names[an.eid as unknown as number]).toBeUndefined();
      }
      // PLAIN: сериализация не бросает и тождественна (закон №5).
      let rt: Record<number, EntityName> | undefined;
      expect(() => {
        rt = JSON.parse(JSON.stringify(names)) as Record<number, EntityName>;
      }).not.toThrow();
      expect(rt).toEqual(names);
    }
  });
});
