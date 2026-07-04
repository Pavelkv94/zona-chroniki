/**
 * @module @zona/sim/narrative/render.test
 *
 * Юниты чистого форматтера радио-сообщений (задача 3.4, D-069):
 *  - подстановка params (имя через ctx / loc / count / item) → ожидаемая строка;
 *  - окраска темперамента: один тип события звучит РАЗНО у paникёра/ветерана;
 *  - неизвестный/битый templateId → мягкий фолбэк БЕЗ throw;
 *  - откат отсутствующего темперамента на пул 'neutral';
 *  - строка PLAIN (без разметки/остаточных плейсхолдеров, закон №5);
 *  - детерминизм (одинаковый вход → одинаковый выход, закон №8).
 * Всё headless, без rng/DOM.
 */

import { describe, it, expect } from 'vitest';
import {
  renderMessage,
  makeTemplateId,
  parseTemplateId,
  type RenderContext,
} from './render';
import { MESSAGES, getTemplate, getTemplatePool } from '../data/index';

// Простые детерминированные резолверы: eid→имя из таблицы, строку — как есть.
const NAMES: Record<number, string> = { 42: 'Сергей Лисенко', 7: 'Ворон' };
const LOCS = ['Кордон', 'Свалка', 'Агропром'];
const ctx: RenderContext = {
  nameOf: (r) => (typeof r === 'number' ? (NAMES[r] ?? `#${r}`) : r),
  locOf: (l) => LOCS[l] ?? `loc#${l}`,
  itemOf: (id) => (id === 'art_medusa' ? 'Медуза' : id),
};

describe('renderMessage — подстановка params', () => {
  it('подставляет subject(имя по eid), loc и остаётся plain', () => {
    const out = renderMessage(
      { templateId: 'entity/died|neutral|0', params: { subject: 42, loc: 1 } },
      ctx,
    );
    // Шаблон neutral#0: "{subject} погиб. {loc}."
    expect(out).toBe('Сергей Лисенко погиб. Свалка.');
    expect(out).not.toMatch(/[{}<>]/); // нет остаточных плейсхолдеров/разметки
  });

  it('подставляет count в encounter/started', () => {
    const out = renderMessage(
      { templateId: 'encounter/started|neutral|0', params: { loc: 1, count: 3 } },
      ctx,
    );
    // "Контакт. {loc}, вижу {count}."
    expect(out).toBe('Контакт. Свалка, вижу 3.');
  });

  it('подставляет item через ctx.itemOf', () => {
    const out = renderMessage(
      { templateId: 'artifact/collected|neutral|0', params: { item: 'art_medusa', loc: 0 } },
      ctx,
    );
    // "Поднял {item}. {loc}."
    expect(out).toBe('Поднял Медуза. Кордон.');
  });

  it('строку-имя в params.subject пробрасывает как есть', () => {
    const out = renderMessage(
      { templateId: 'population/arrived|neutral|0', params: { subject: 'Новичок Икс', loc: 0 } },
      ctx,
    );
    expect(out).toContain('Новичок Икс');
  });
});

describe('renderMessage — окраска темперамента', () => {
  it('паникёр и ветеран об одной смерти дают РАЗНЫЕ строки', () => {
    const params = { subject: 42, loc: 1 };
    const panicky = renderMessage({ templateId: 'entity/died|panicky|0', params }, ctx);
    const veteran = renderMessage({ templateId: 'entity/died|veteran|0', params }, ctx);
    expect(panicky).not.toBe(veteran);
    // Оба содержат имя субъекта — факт один, окраска разная.
    expect(panicky).toContain('Сергей Лисенко');
    expect(veteran).toContain('Сергей Лисенко');
  });
});

describe('renderMessage — фолбэки (не throw)', () => {
  it('битый templateId (не 3 поля) → строка помех', () => {
    const out = renderMessage({ templateId: 'мусор', params: {} }, ctx);
    expect(out).toBe('…в эфире только треск помех…');
  });

  it('неизвестный eventType → строка помех', () => {
    const out = renderMessage({ templateId: 'нет/такого|neutral|0', params: {} }, ctx);
    expect(out).toBe('…в эфире только треск помех…');
  });

  it('несуществующий темперамент → откат на пул neutral того же события', () => {
    const out = renderMessage(
      { templateId: 'entity/died|неттакого|0', params: { subject: 42, loc: 1 } },
      ctx,
    );
    const expected = renderMessage(
      { templateId: 'entity/died|neutral|0', params: { subject: 42, loc: 1 } },
      ctx,
    );
    expect(out).toBe(expected);
  });

  it('индекс вне диапазона → первый шаблон пула (не помехи)', () => {
    const out = renderMessage(
      { templateId: 'entity/died|neutral|999', params: { subject: 42, loc: 1 } },
      ctx,
    );
    expect(out).not.toBe('…в эфире только треск помех…');
    expect(out).toContain('Сергей Лисенко');
  });

  it('отсутствующий параметр подставляет нейтральный дефолт (нет висящих {})', () => {
    const out = renderMessage({ templateId: 'entity/died|neutral|0', params: {} }, ctx);
    expect(out).not.toMatch(/[{}]/);
    expect(out).toContain('кто-то'); // subject-дефолт
    expect(out).toContain('где-то'); // loc-дефолт
  });
});

describe('renderMessage — детерминизм и plain (законы №8/№5)', () => {
  it('одинаковый вход → одинаковый выход (дважды)', () => {
    const entry = { templateId: 'loot/transferred|talker|0', params: { subject: 7, loc: 1 } } as const;
    expect(renderMessage(entry, ctx)).toBe(renderMessage(entry, ctx));
  });

  it('НИ ОДИН шаблон контента не оставляет разметки/висящих плейсхолдеров', () => {
    // Рендерим ВСЕ шаблоны со всеми params — выход обязан быть чистым текстом.
    const full = { speaker: 7, subject: 42, loc: 1, count: 2, item: 'art_medusa' };
    for (const evt of Object.keys(MESSAGES.templates).sort()) {
      const byTemp = MESSAGES.templates[evt]!;
      for (const temp of Object.keys(byTemp).sort()) {
        const pool = byTemp[temp]!;
        for (let i = 0; i < pool.length; i++) {
          const out = renderMessage({ templateId: makeTemplateId(evt, temp, i), params: full }, ctx);
          expect(out).not.toMatch(/[{}<>]/);
          expect(out.length).toBeGreaterThan(0);
          // sanity: совпадает с прямым доступом к шаблону (тот же index).
          expect(getTemplate(evt, temp, i)).toBeDefined();
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ 3.4: покрытие пулов (7 типов × 4 темперамента непусты; 'neutral' —
// фолбэк у КАЖДОГО типа), окраска РАЗНАЯ на каждом типе, детерминизм на всём контенте.
// Читается как «эфир Зоны звучит по-разному, но всегда есть базовый тон».
// ═══════════════════════════════════════════════════════════════════════════

/** 7 narrative-worthy типов + 4 темперамента (D-069, GDD §8.3). */
const EXPECTED_TYPES: readonly string[] = [
  'encounter/started', 'encounter/resolved', 'entity/died', 'loot/transferred',
  'artifact/collected', 'settlement/abandoned', 'population/arrived',
];
const EXPECTED_TEMPERAMENTS: readonly string[] = ['neutral', 'panicky', 'veteran', 'talker'];

describe('покрытие пулов — 7 типов × 4 темперамента (D-069, GDD §8.3)', () => {
  it('контент содержит РОВНО ожидаемые 7 narrative-типов', () => {
    expect(Object.keys(MESSAGES.templates).sort()).toEqual([...EXPECTED_TYPES].sort());
  });

  it('у КАЖДОГО типа все 4 темперамента объявлены и пул НЕПУСТ', () => {
    for (const type of EXPECTED_TYPES) {
      for (const temp of EXPECTED_TEMPERAMENTS) {
        const pool = getTemplatePool(type, temp);
        expect(pool, `${type}/${temp}: пул отсутствует`).toBeDefined();
        expect(pool!.length, `${type}/${temp}: пул пуст`).toBeGreaterThan(0);
        // Каждый шаблон — непустая строка (иначе рендер вернул бы пустой эфир).
        for (const t of pool!) expect(t.length, `${type}/${temp}: пустой шаблон`).toBeGreaterThan(0);
      }
    }
  });

  it("'neutral' присутствует у КАЖДОГО типа — на него откатывается рендер (фолбэк)", () => {
    for (const type of EXPECTED_TYPES) {
      // Несуществующий темперамент обязан деградировать в neutral, а НЕ в помехи.
      const viaBogus = renderMessage(
        { templateId: makeTemplateId(type, 'НЕТТАКОГО', 0), params: { subject: 42, loc: 1, count: 2, item: 'art_medusa' } },
        ctx,
      );
      const viaNeutral = renderMessage(
        { templateId: makeTemplateId(type, 'neutral', 0), params: { subject: 42, loc: 1, count: 2, item: 'art_medusa' } },
        ctx,
      );
      expect(viaBogus, `${type}: нет фолбэка на neutral`).toBe(viaNeutral);
      expect(viaBogus, `${type}: neutral деградировал в помехи`).not.toBe('…в эфире только треск помех…');
    }
  });

  it('окраска РАЗНАЯ: 4 темперамента одного типа звучат не одинаково', () => {
    const params = { speaker: 7, subject: 42, loc: 1, count: 2, item: 'art_medusa' };
    for (const type of EXPECTED_TYPES) {
      const variants = EXPECTED_TEMPERAMENTS.map((temp) =>
        renderMessage({ templateId: makeTemplateId(type, temp, 0), params }, ctx),
      );
      // Хотя бы два разных тона (не «робот» из GDD §8.3) — темпераменты реально красят.
      expect(new Set(variants).size, `${type}: все темпераменты дали ОДНУ строку`).toBeGreaterThan(1);
    }
  });

  it('детерминизм на ВСЁМ контенте: каждый шаблон рендерится стабильно (2×)', () => {
    const params = { speaker: 7, subject: 42, loc: 1, count: 2, item: 'art_medusa' };
    for (const type of EXPECTED_TYPES) {
      for (const temp of EXPECTED_TEMPERAMENTS) {
        const pool = getTemplatePool(type, temp)!;
        for (let i = 0; i < pool.length; i++) {
          const entry = { templateId: makeTemplateId(type, temp, i), params };
          expect(renderMessage(entry, ctx), `${type}/${temp}/${i}`).toBe(renderMessage(entry, ctx));
        }
      }
    }
  });
});

describe('makeTemplateId / parseTemplateId', () => {
  it('round-trip', () => {
    const id = makeTemplateId('entity/died', 'veteran', 3);
    expect(id).toBe('entity/died|veteran|3');
    expect(parseTemplateId(id)).toEqual({ eventType: 'entity/died', temperament: 'veteran', index: 3 });
  });

  it('битый id → null', () => {
    expect(parseTemplateId('a|b')).toBeNull();
    expect(parseTemplateId('a|b|-1')).toBeNull();
    expect(parseTemplateId('a|b|x')).toBeNull();
    expect(parseTemplateId('|b|0')).toBeNull();
  });
});
