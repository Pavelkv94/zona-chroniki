/**
 * @module @zona/sim/pipeline.test
 *
 * ИНВАРИАНТ ПОРЯДКА СИСТЕМ (задача 1.12, D-032/D-034). Порядок исполнения систем
 * на тике = порядок регистрации (scheduler.ts). Он КРИТИЧЕН: производитель штампа/
 * компонента обязан идти РАНЬШЕ потребителя в том же тике, иначе потребитель
 * прочтёт значение прошлого тика (внутритиковая невидимость). Перестановка ломает
 * причинность — здесь она закреплена тестом индексов: любое будущее изменение
 * порядка, нарушающее стык, покраснит этот файл.
 */

import { describe, it, expect } from 'vitest';
import { createScheduler } from './core/scheduler';
import { registerPhase1Systems, PHASE1_SYSTEMS } from './pipeline';

/** Индекс системы по имени в порядке регистрации; -1, если не зарегистрирована. */
function indexByName(names: readonly string[], name: string): number {
  return names.indexOf(name);
}

describe('registerPhase1Systems: сборка конвейера Фазы 1', () => {
  const scheduler = createScheduler();
  registerPhase1Systems(scheduler);
  const registered = scheduler.systems();
  const names = registered.map((s) => s.name);

  it('регистрирует ровно 9 систем Фазы 1', () => {
    const expected = [
      'Weather',
      'Needs',
      'Perception',
      'TaskSelection',
      'Movement',
      'TaskEffects',
      'Encounters',
      'Animals',
      'Death',
    ];
    expect(names).toEqual(expected);
    expect(registered.length).toBe(9);
    // Список данными (PHASE1_SYSTEMS) и фактическая регистрация совпадают.
    expect(PHASE1_SYSTEMS.map((s) => s.name)).toEqual(expected);
  });

  it('порядок удовлетворяет ИНВАРИАНТ ПРИЧИННОСТИ (производитель < потребитель, D-032)', () => {
    const idx = (name: string): number => {
      const i = indexByName(names, name);
      expect(i, `система ${name} должна быть зарегистрирована`).toBeGreaterThanOrEqual(0);
      return i;
    };

    // Needs штампует lethalCause (истощение) → Death читает его.
    expect(idx('Needs')).toBeLessThan(idx('Death'));
    // Perception собирает contacts/fear → выбор задачи, детект столкновения, поведение стада.
    expect(idx('Perception')).toBeLessThan(idx('TaskSelection'));
    expect(idx('Perception')).toBeLessThan(idx('Encounters'));
    expect(idx('Perception')).toBeLessThan(idx('Animals'));
    // TaskSelection штампует Task.causeEvent/dest → Movement ставит departure.causedBy.
    expect(idx('TaskSelection')).toBeLessThan(idx('Movement'));
    // Encounters штампует lethalCause (бой) → Death читает его.
    expect(idx('Encounters')).toBeLessThan(idx('Death'));
    // Movement двигает/приводит → TaskEffects применяет эффекты «на месте».
    expect(idx('Movement')).toBeLessThan(idx('TaskEffects'));
    // Movement обновляет позиции → Animals ведёт экологию стада по свежим позициям.
    expect(idx('Movement')).toBeLessThan(idx('Animals'));
  });

  it('Weather — первой (фон среды), Death — последней (снимает Alive/Task с добитых)', () => {
    expect(indexByName(names, 'Weather')).toBe(0);
    expect(indexByName(names, 'Death')).toBe(names.length - 1);
  });
});

// ── НЕГАТИВНЫЙ КОНТУР: перестановка ломает причинность (тест ЛОВИТ) ────────────
// Стыки причинности как ДАННЫЕ (производитель < потребитель, D-032). Валидатор
// ниже проверяет ПРОИЗВОЛЬНЫЙ порядок; канон обязан пройти, а нарочно испорченные
// перестановки — обязаны провалиться. Это доказывает, что тест реально стоит на
// страже: любое будущее «тихое» изменение порядка, рвущее стык, покраснит файл.
const CAUSALITY_JOINTS: ReadonlyArray<readonly [producer: string, consumer: string]> = [
  ['Needs', 'Death'], // истощение штампует lethalCause → Death читает
  ['Perception', 'TaskSelection'], // contacts/fear → выбор задачи
  ['Perception', 'Encounters'], // contacts → детект столкновения
  ['Perception', 'Animals'], // contacts → бегство/поведение стада
  ['TaskSelection', 'Movement'], // Task.causeEvent/dest → departure.causedBy
  ['Encounters', 'Death'], // бой штампует lethalCause → Death читает
  ['Movement', 'TaskEffects'], // прибытие/позиция → эффекты «на месте»
  ['Movement', 'Animals'], // свежие позиции → экология стада
];

/** Копия порядка с переставленными местами двух систем (по именам). */
function swap(order: readonly string[], a: string, b: string): string[] {
  return order.map((n) => (n === a ? b : n === b ? a : n));
}

/** Все ли стыки причинности соблюдены в данном порядке (producer раньше consumer). */
function causalityHolds(order: readonly string[]): boolean {
  return CAUSALITY_JOINTS.every(([producer, consumer]) => {
    const p = order.indexOf(producer);
    const c = order.indexOf(consumer);
    return p >= 0 && c >= 0 && p < c;
  });
}

describe('инвариант порядка ловит нарушения (негативный контур D-032)', () => {
  const canonical = PHASE1_SYSTEMS.map((s) => s.name);

  it('валидатор пропускает КАНОНИЧЕСКИЙ порядок', () => {
    expect(causalityHolds(canonical)).toBe(true);
  });

  it('перестановка Death перед Needs — валидатор ЛОВИТ (Needs<Death нарушен)', () => {
    const broken = canonical.filter((n) => n !== 'Death');
    broken.unshift('Death'); // Death в самое начало, до Needs/Encounters
    expect(causalityHolds(broken)).toBe(false);
  });

  it('перестановка Movement перед TaskSelection — валидатор ЛОВИТ', () => {
    expect(causalityHolds(swap(canonical, 'TaskSelection', 'Movement'))).toBe(false);
  });

  it('перестановка Perception в самый конец — валидатор ЛОВИТ (3 стыка рвутся)', () => {
    const broken = canonical.filter((n) => n !== 'Perception');
    broken.push('Perception');
    expect(causalityHolds(broken)).toBe(false);
  });

  it('TaskEffects перед Movement — валидатор ЛОВИТ (эффекты до прибытия)', () => {
    expect(causalityHolds(swap(canonical, 'TaskEffects', 'Movement'))).toBe(false);
  });

  it('РЕАЛЬНАЯ регистрация удовлетворяет ВСЕ стыки причинности разом', () => {
    const scheduler = createScheduler();
    registerPhase1Systems(scheduler);
    const actual = scheduler.systems().map((s) => s.name);
    expect(causalityHolds(actual)).toBe(true);
    // И это ИМЕННО канонический список (порядок = порядок исполнения).
    expect(actual).toEqual(canonical);
  });
});
