/**
 * @module @zona/sim/data/phase5-content.test
 *
 * ПОЗИТИВНЫЕ гейты контента Фазы 5 (задача 5.1, законы №3/№7/№10): новые ВИДЫ
 * (хищники/зомби с флагами экосистемы), ПРЕДМЕТЫ (части туш/форедж/медикамент),
 * БОЛЕЗНИ и стратегическая диспозиция фракций грузятся, валидируются и связны с
 * каталогами (prey/partItem резолвимы). Плюс РЕГРЕСС-СТРАЖ закона №1/голденов:
 * worldgen НЕ спавнит новые виды (спавн хищников/зомби — задачи 5.6/5.7), поэтому
 * добавление их определений в species.json не сдвигает популяцию стартовых видов.
 */

import { describe, it, expect } from 'vitest';
import type { Seed } from '@zona/shared';
import {
  SPECIES,
  ITEMS,
  DISEASES,
  FACTIONS,
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

describe('Фаза 5.1 — новые виды и флаги экосистемы', () => {
  it('хищники и зомби заведены с ключами', () => {
    const keys = SPECIES.map((s) => s.key);
    for (const k of ['pseudodog', 'bloodsucker', 'chimera', 'zombie']) {
      expect(keys).toContain(k);
    }
  });

  it('deer/boar — явные травоядные (grazes:true, predator:false, moveDriver:herd)', () => {
    for (const key of ['deer', 'boar']) {
      const s = SPECIES.find((x) => x.key === key)!;
      expect(s.grazes).toBe(true);
      expect(s.predator).toBe(false);
      expect(s.moveDriver).toBe('herd');
    }
  });

  it('хищники: predator:true, grazes:false, непустой prey; зомби reanimated', () => {
    for (const key of ['pseudodog', 'bloodsucker', 'chimera', 'zombie']) {
      const s = SPECIES.find((x) => x.key === key)!;
      expect(s.predator).toBe(true);
      expect(s.grazes).toBe(false);
      expect(s.prey!.length).toBeGreaterThan(0);
    }
    expect(SPECIES.find((x) => x.key === 'zombie')!.reanimated).toBe(true);
    // Зомби НЕ пасётся (распад голодом = срок жизни, не размножается grazes-путём).
    expect(SPECIES.find((x) => x.key === 'zombie')!.grazes).toBe(false);
    expect(SPECIES.find((x) => x.key === 'bloodsucker')!.nocturnal).toBe(true);
  });

  it('prey резолвится: каждый ключ — существующий вид ЛИБО "human"', () => {
    const speciesKeys = new Set(SPECIES.map((s) => s.key));
    for (const s of SPECIES) {
      for (const p of s.prey ?? []) {
        expect(p === 'human' || speciesKeys.has(p)).toBe(true);
      }
    }
  });

  it('partItem резолвится в items.json и согласован с partYield (закон №3)', () => {
    for (const s of SPECIES) {
      const hasItem = s.partItem !== undefined;
      const hasYield = s.partYield !== undefined;
      expect(hasItem).toBe(hasYield);
      if (hasItem) {
        expect(() => getItem(s.partItem!)).not.toThrow();
        expect(getItem(s.partItem!).kind).toBe('part');
        expect(Number.isInteger(s.partYield) && s.partYield! > 0).toBe(true);
      }
    }
  });

  it('gestationTicks всех видов кратен каденции Animals (30) — иначе load бросит', () => {
    for (const s of SPECIES) expect(s.gestationTicks % 30).toBe(0);
  });
});

describe('Фаза 5.1 — предметы (части/форедж/медикамент)', () => {
  it('части туш заведены kind:part с basePrice>0 (трофей учёным §4.5)', () => {
    for (const id of ['pseudodog_paw', 'bloodsucker_tentacle', 'chimera_claw']) {
      const it = getItem(id);
      expect(it.kind).toBe('part');
      expect(it.basePrice).toBeGreaterThan(0);
    }
  });

  it('forage_food — растительная еда с nutrition>0 (P-5)', () => {
    const f = getItem('forage_food');
    expect(f.kind).toBe('food');
    expect(f.nutrition!).toBeGreaterThan(0);
  });

  it('есть медикамент для TREAT (kind:medical)', () => {
    expect(ITEMS.some((it) => it.kind === 'medical')).toBe(true);
  });
});

describe('Фаза 5.1 — болезни (diseases.json)', () => {
  it('простуда coldBorne и инфекция от контакта заведены', () => {
    expect(DISEASES.length).toBeGreaterThanOrEqual(2);
    const cold = DISEASES.find((d) => d.coldBorne);
    expect(cold).toBeDefined();
    const infection = DISEASES.find((d) => !d.coldBorne && d.transmissibility > 0);
    expect(infection).toBeDefined();
  });

  it('поля болезней в допустимых диапазонах', () => {
    for (const d of DISEASES) {
      expect(d.transmissibility).toBeGreaterThanOrEqual(0);
      expect(d.transmissibility).toBeLessThanOrEqual(1);
      expect(d.lethality).toBeGreaterThanOrEqual(0);
      expect(d.lethality).toBeLessThanOrEqual(1);
      expect(d.severityRate).toBeGreaterThan(0);
      expect(Number.isInteger(d.recoveryTicks) && d.recoveryTicks > 0).toBe(true);
    }
  });

  it('getDisease резолвит по id, бросает на неизвестном', () => {
    expect(() => getDisease(DISEASES[0]!.id)).not.toThrow();
    expect(() => getDisease('__нетболезни__')).toThrow();
  });

  it('DISEASES заморожены (иммутабельность наружу)', () => {
    expect(Object.isFrozen(DISEASES)).toBe(true);
    expect(Object.isFrozen(DISEASES[0])).toBe(true);
  });
});

describe('Фаза 5.1 — стратегическая диспозиция фракций (stance)', () => {
  it('Долг = crusader (§4.2), диспозиции из enum или опущены', () => {
    expect(getFaction('duty').stance).toBe('crusader');
    const valid = new Set([undefined, 'defensive', 'aggressive', 'crusader']);
    for (const f of FACTIONS) expect(valid.has(f.stance)).toBe(true);
  });
});

describe('Фаза 5.1 — РЕГРЕСС: worldgen НЕ спавнит новые виды (законы №1/голдены)', () => {
  it('в мире после worldgen только стартовые виды deer(0)/boar(1)', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const animalEids = queryEntities(world.ecs, [Animal]);
    expect(animalEids.length).toBeGreaterThan(0); // стада есть
    const spawnedSpecies = new Set<number>();
    for (const e of animalEids) spawnedSpecies.add(ANIMAL.species[e]!);
    // Ни один хищник/зомби (id>=2) не материализован — их спавн в 5.6/5.7.
    for (const sp of spawnedSpecies) {
      expect(sp).toBeLessThanOrEqual(1);
      expect(getSpecies(sp).predator).toBe(false);
    }
    expect([...spawnedSpecies].sort()).toEqual([0, 1]);
  });
});
