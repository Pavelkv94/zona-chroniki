/**
 * Юниты визуального маппинга карты (задача 4.2): чистые аксессоры тип→форма,
 * принадлежность→цвет, состояние→модификатор + СТРОГИЙ валидатор полноты конфига
 * против контента `@zona/sim` (все локации/фракции/kinds покрыты; топология рёбер
 * не разошлась с map.json). Робастность: неизвестный kind/faction → фолбэк, не throw.
 *
 * Данные `map.json`/`factions.json` читаются relative-импортом ТОЛЬКО в тесте (не в
 * рантайме карты): это проверка контента до релиза, не рантайм-зависимость от
 * приватной топологии /sim (закон №5 — карта в рантайме опирается лишь на public API).
 */

import { describe, it, expect } from 'vitest';
import mapData from '../../../sim/src/data/map.json';
import factionsData from '../../../sim/src/data/factions.json';
import {
  VISUAL_CONFIG,
  FALLBACK_COLOR,
  FALLBACK_GLYPH,
  colorForEntity,
  combatAlpha,
  glyphForKind,
  isSleeping,
  isWounded,
  nodeLayout,
  validateVisualConfig,
  type CoverageExpectation,
} from './visual-config';
import { TaskKind } from '@zona/sim';

// Все объявленные виды сущностей (union append-only + будущие мутанты/зомби).
const ALL_KINDS: readonly string[] = ['human', 'animal', 'corpse', 'settlement', 'mutant', 'zombie'];

function coverage(): CoverageExpectation {
  return {
    locationIds: mapData.locations.map((l) => l.id),
    factionIds: factionsData.factions.map((f) => f.id),
    kinds: ALL_KINDS,
    edges: mapData.edges.map((e) => [e.a, e.b] as [number, number]),
  };
}

describe('validateVisualConfig — полнота против /sim', () => {
  it('нет проблем: все локации/фракции/kinds покрыты, рёбра зеркалят map.json', () => {
    expect(validateVisualConfig(VISUAL_CONFIG, coverage())).toEqual([]);
  });

  it('раскладка покрывает КАЖДУЮ локацию map.json', () => {
    for (const loc of mapData.locations) {
      expect(nodeLayout(VISUAL_CONFIG, loc.id)).not.toBeNull();
    }
  });

  it('ловит недостающую локацию в раскладке', () => {
    const exp = coverage();
    const problems = validateVisualConfig(VISUAL_CONFIG, {
      ...exp,
      locationIds: [...exp.locationIds, 999],
    });
    expect(problems.some((p) => p.includes('999'))).toBe(true);
  });

  it('ловит недостающую фракцию и недостающий kind', () => {
    const exp = coverage();
    const problems = validateVisualConfig(VISUAL_CONFIG, {
      ...exp,
      factionIds: [...exp.factionIds, 'ghost'],
      kinds: [...exp.kinds, 'dragon'],
    });
    expect(problems.some((p) => p.includes('ghost'))).toBe(true);
    expect(problems.some((p) => p.includes('dragon'))).toBe(true);
  });

  it('ловит расхождение топологии рёбер', () => {
    const exp = coverage();
    const problems = validateVisualConfig(VISUAL_CONFIG, {
      ...exp,
      edges: [...exp.edges, [0, 9]],
    });
    expect(problems.some((p) => p.includes('рёбра разошлись'))).toBe(true);
  });

  it('ловит УДАЛЁННОЕ ребро (карта потеряла тропу — визуал не должен молча уцелеть)', () => {
    const exp = coverage();
    const problems = validateVisualConfig(VISUAL_CONFIG, {
      ...exp,
      edges: exp.edges.slice(1), // одна тропа исчезла из map.json
    });
    expect(problems.some((p) => p.includes('рёбра разошлись'))).toBe(true);
  });

  it('визуал зеркалит map.json ровно по числу троп (ни лишних, ни забытых)', () => {
    expect(VISUAL_CONFIG.edges.length).toBe(mapData.edges.length);
  });

  it('КАЖДАЯ из 10 локаций map.json имеет координату раскладки', () => {
    expect(mapData.locations).toHaveLength(10);
    for (const loc of mapData.locations) {
      const pos = nodeLayout(VISUAL_CONFIG, loc.id);
      expect(pos, `локация ${loc.id} (${loc.name}) без раскладки`).not.toBeNull();
      expect(pos!.x).toBeGreaterThanOrEqual(0);
      expect(pos!.x).toBeLessThanOrEqual(1);
      expect(pos!.y).toBeGreaterThanOrEqual(0);
      expect(pos!.y).toBeLessThanOrEqual(1);
    }
  });

  it('КАЖДАЯ фракция factions.json имеет цвет (не фолбэк)', () => {
    for (const f of factionsData.factions) {
      const color = colorForEntity(VISUAL_CONFIG, { kind: 'human', faction: f.id });
      expect(color, `фракция ${f.id} без своего цвета`).not.toBe(FALLBACK_COLOR);
      expect(VISUAL_CONFIG.factions[f.id]?.color).toBe(color);
    }
  });

  it('КАЖДЫЙ видимый kind EntityView (human/animal/corpse/settlement) имеет собственный глиф', () => {
    for (const kind of ['human', 'animal', 'corpse', 'settlement'] as const) {
      // Собственный, а не фолбэк: запись реально присутствует в конфиге.
      expect(VISUAL_CONFIG.kinds[kind], `kind ${kind} без глифа`).toBeDefined();
      expect(glyphForKind(VISUAL_CONFIG, kind)).not.toBe(FALLBACK_GLYPH);
    }
  });
});

describe('glyphForKind — форма=тип, фолбэк на неизвестное', () => {
  it('известные виды → форма из конфига', () => {
    expect(glyphForKind(VISUAL_CONFIG, 'human').shape).toBe('circle');
    expect(glyphForKind(VISUAL_CONFIG, 'animal').shape).toBe('triangle');
    expect(glyphForKind(VISUAL_CONFIG, 'mutant').shape).toBe('diamond');
    expect(glyphForKind(VISUAL_CONFIG, 'zombie').shape).toBe('cross');
    expect(glyphForKind(VISUAL_CONFIG, 'settlement').shape).toBe('square');
  });
  it('размеры в диапазоне читаемости 8..12 px', () => {
    for (const k of ALL_KINDS) {
      const g = glyphForKind(VISUAL_CONFIG, k);
      expect(g.sizePx).toBeGreaterThanOrEqual(8);
      expect(g.sizePx).toBeLessThanOrEqual(12);
    }
  });
  it('труп → свой глиф (кружок 8px), не путается с живым человеком по размеру', () => {
    const corpse = glyphForKind(VISUAL_CONFIG, 'corpse');
    const human = glyphForKind(VISUAL_CONFIG, 'human');
    expect(corpse.shape).toBe('circle');
    expect(corpse.sizePx).toBe(8);
    // труп мельче живого — визуально «осел» на землю.
    expect(corpse.sizePx).toBeLessThan(human.sizePx);
  });
  it('неизвестный вид → FALLBACK_GLYPH (не throw)', () => {
    expect(glyphForKind(VISUAL_CONFIG, 'chimera')).toBe(FALLBACK_GLYPH);
    // Даже пустая строка/мусор не роняет карту.
    expect(glyphForKind(VISUAL_CONFIG, '')).toBe(FALLBACK_GLYPH);
  });
  it('детерминизм: тот же kind → тот же (идентичный) глиф', () => {
    expect(glyphForKind(VISUAL_CONFIG, 'human')).toBe(glyphForKind(VISUAL_CONFIG, 'human'));
    expect(glyphForKind(VISUAL_CONFIG, 'nope')).toBe(glyphForKind(VISUAL_CONFIG, 'nope'));
  });
});

describe('colorForEntity — цвет=принадлежность, нейтраль по виду', () => {
  it('живой человек с фракцией → цвет фракции', () => {
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'human', faction: 'loners' })).toBe(
      VISUAL_CONFIG.factions.loners?.color,
    );
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'human', faction: 'bandits' })).toBe(
      VISUAL_CONFIG.factions.bandits?.color,
    );
  });
  it('животное → коричневая нейтраль; труп → серая (принадлежность неважна)', () => {
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'animal', faction: null })).toBe(
      VISUAL_CONFIG.neutralColors.animal,
    );
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'corpse', faction: 'loners' })).toBe(
      VISUAL_CONFIG.neutralColors.corpse,
    );
  });
  it('мутант/зомби (живые, без фракции) → свои нейтральные цвета, не фракционные', () => {
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'mutant', faction: null })).toBe(
      VISUAL_CONFIG.neutralColors.mutant,
    );
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'zombie', faction: null })).toBe(
      VISUAL_CONFIG.neutralColors.zombie,
    );
  });
  it('труп ВСЕГДА серый, даже если при жизни был во фракции (принадлежность после смерти не важна)', () => {
    for (const f of factionsData.factions) {
      expect(colorForEntity(VISUAL_CONFIG, { kind: 'corpse', faction: f.id })).toBe(
        VISUAL_CONFIG.neutralColors.corpse,
      );
    }
  });
  it('неизвестная фракция у человека → фолбэк-цвет', () => {
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'human', faction: 'sect' })).toBe(FALLBACK_COLOR);
  });
  it('неизвестный вид без фракции → фолбэк-цвет (не throw)', () => {
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'chimera', faction: null })).toBe(FALLBACK_COLOR);
  });
  it('поселение → СВОЙ нейтральный цвет (структурный тон), ОТЛИЧНЫЙ от фолбэка', () => {
    // export.ts отдаёт settlement с faction=null; colorForEntity даёт neutralColors.settlement
    // (фикс находки QA 4.2) — визуально отличимо от неизвестного вида (FALLBACK). Форма — квадрат.
    const c = colorForEntity(VISUAL_CONFIG, { kind: 'settlement', faction: null });
    expect(c).toBe(VISUAL_CONFIG.neutralColors.settlement);
    expect(c).not.toBe(FALLBACK_COLOR);
    expect(glyphForKind(VISUAL_CONFIG, 'settlement').shape).toBe('square');
  });
  it('фракц-цвет ТОЛЬКО у живого человека: животное с (гипотетической) фракцией → нейтраль', () => {
    // Гейт kind==='human' (фикс латентной находки QA 4.2): не-люди не окрашиваются по фракции,
    // даже если экспортёр когда-нибудь навесит непустую фракцию.
    expect(colorForEntity(VISUAL_CONFIG, { kind: 'animal', faction: 'loners' })).toBe(
      VISUAL_CONFIG.neutralColors.animal,
    );
  });
  it('детерминизм: тот же EntityView → тот же цвет', () => {
    const e = { kind: 'human', faction: 'duty' };
    expect(colorForEntity(VISUAL_CONFIG, e)).toBe(colorForEntity(VISUAL_CONFIG, e));
  });
});

describe('модификаторы состояния — чистые предикаты', () => {
  it('isWounded: живой ниже порога → true; труп/выше порога → false', () => {
    expect(isWounded(VISUAL_CONFIG, 0.3, true)).toBe(true);
    expect(isWounded(VISUAL_CONFIG, 0.3, false)).toBe(false);
    expect(isWounded(VISUAL_CONFIG, 0.5, true)).toBe(false);
  });
  it('isWounded: РОВНО на пороге → ещё не ранен (строгое <), при HP=0 живой → ранен', () => {
    const thr = VISUAL_CONFIG.modifiers.woundedThreshold;
    expect(isWounded(VISUAL_CONFIG, thr, true)).toBe(false); // граница: 0.4 не считается «ранен»
    expect(isWounded(VISUAL_CONFIG, 0, true)).toBe(true); // при смерти, но ещё жив → кольцо
    expect(isWounded(VISUAL_CONFIG, 0, false)).toBe(false); // мёртвый не «ранен»
  });
  it('isSleeping: задача SLEEP → true, иначе/нет задачи → false', () => {
    expect(isSleeping(TaskKind.SLEEP)).toBe(true);
    expect(isSleeping(TaskKind.EAT)).toBe(false);
    expect(isSleeping(null)).toBe(false);
  });
  it('combatAlpha: в диапазоне [minAlpha..1], детерминирован по времени', () => {
    const { minAlpha } = VISUAL_CONFIG.modifiers.combatBlink;
    for (const t of [0, 130, 260, 390, 520]) {
      const a = combatAlpha(VISUAL_CONFIG, t);
      expect(a).toBeGreaterThanOrEqual(minAlpha - 1e-9);
      expect(a).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(combatAlpha(VISUAL_CONFIG, 42)).toBe(combatAlpha(VISUAL_CONFIG, 42));
  });
});
