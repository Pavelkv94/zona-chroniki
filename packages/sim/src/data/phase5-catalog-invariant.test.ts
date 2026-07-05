/**
 * @module @zona/sim/data/phase5-catalog-invariant.test
 *
 * КАТАЛОГ-ИНВАРИАНТ и РЕГРЕСС-КАНАРЕЙКА популяции Фазы 5 (задача 5.1, законы №1/№10).
 * Два сюжета:
 *  1) «библиотекарь Зоны» — по новым id (зомби, медкит, части туш, инфекция) каталоги
 *     отдают КОРРЕКТНУЮ запись, а по несуществующему id — предсказуемо бросают (тот же
 *     паттерн, что и до Фазы 5); плотность id-видов не порвана.
 *  2) «мир до людей» — worldgen на seed42 материализует РОВНО те же стада, что и до
 *     добавления бестиария: ни одной особи id>=2 (спавн хищников/зомби — задачи 5.6/5.7).
 *     Точный ПОШТУЧНЫЙ пин (27 оленей + 8 кабанов = 35) ловит утечку контента в спавн
 *     тоньше, чем «множество видов = {0,1}»: если новый вид сдвинул размеры стад или
 *     RNG worldgen — падает здесь, не только на snapshot-голденах.
 */

import { describe, it, expect } from 'vitest';
import type { Seed } from '@zona/shared';
import {
  SPECIES,
  DISEASES,
  getSpecies,
  getItem,
  getDisease,
  getFaction,
} from './index';
import { createSimWorld } from '../core/world';
import { queryEntities } from '../core/ecs';
import { Animal } from '../core/components';
import { worldgen } from '../worldgen';

const ANIMAL = Animal as unknown as { species: Uint8Array };

describe('Фаза 5.1 — каталог-инвариант: новые id резолвятся, чужие бросают', () => {
  it('getSpecies по id зомби(5) отдаёт reanimated-хищника, вне диапазона — бросок', () => {
    const zombie = getSpecies(5);
    expect(zombie.key).toBe('zombie');
    expect(zombie.reanimated).toBe(true);
    expect(zombie.predator).toBe(true);
    expect(() => getSpecies(999)).toThrow(/нет вида 999/);
  });

  it('id видов плотны 0..N-1 (индекс = id) — каталог без дыр', () => {
    SPECIES.forEach((s, i) => expect(s.id).toBe(i));
    // Стартовые id стабильны: олень 0, кабан 1 (спавн worldgen опирается на них).
    expect(getSpecies(0).key).toBe('deer');
    expect(getSpecies(1).key).toBe('boar');
  });

  it('getItem: медкит и форедж — реальные предметы; части туш kind:part', () => {
    expect(getItem('medkit').kind).toBe('medical');
    expect(getItem('forage_food').kind).toBe('food');
    for (const id of ['pseudodog_paw', 'bloodsucker_tentacle', 'chimera_claw']) {
      expect(getItem(id).kind).toBe('part');
    }
    expect(() => getItem('__нетпредмета__')).toThrow(/неизвестный предмет/);
  });

  it('каждая часть-туша из species.partItem РЕЗОЛВИТСЯ в реальный предмет (закон №3)', () => {
    // Замыкаем цепь «туша → предмет»: ни одна ссылка не висит в пустоту.
    for (const s of SPECIES) {
      if (s.partItem !== undefined) {
        expect(() => getItem(s.partItem!)).not.toThrow();
        expect(getItem(s.partItem!).kind).toBe('part');
      }
    }
  });

  it('getDisease резолвит каждый реальный id, чужой — бросок', () => {
    for (const d of DISEASES) {
      expect(getDisease(d.id).id).toBe(d.id);
    }
    expect(() => getDisease('__нетболезни__')).toThrow(/неизвестная болезнь/);
  });

  it('getFaction: Долг несёт диспозицию crusader, чужая фракция — бросок', () => {
    expect(getFaction('duty').stance).toBe('crusader');
    expect(() => getFaction('__нетфракции__')).toThrow(/неизвестная фракция/);
  });
});

describe('Фаза 5.1 — РЕГРЕСС популяции: бестиарий не протёк в спавн (закон №1/голдены)', () => {
  it('worldgen(seed42) спавнит РОВНО 27 оленей + 8 кабанов = 35, ни одного id>=2', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const eids = queryEntities(world.ecs, [Animal]);
    const bySpecies: Record<number, number> = {};
    for (const e of eids) {
      const sp = ANIMAL.species[e]!;
      bySpecies[sp] = (bySpecies[sp] ?? 0) + 1;
    }
    // Поштучный пин: добавление 4 видов в species.json НЕ сдвинуло стартовые стада.
    expect(eids.length).toBe(35);
    expect(bySpecies).toEqual({ 0: 27, 1: 8 });
    // Ни одного хищника/зомби (id>=2) не материализовано.
    for (const key of Object.keys(bySpecies)) {
      expect(Number(key)).toBeLessThanOrEqual(1);
    }
  });
});
