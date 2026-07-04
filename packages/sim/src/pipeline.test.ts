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
import {
  registerPhase1Systems,
  PHASE1_SYSTEMS,
  registerPhase2Systems,
  PHASE2_SYSTEMS,
} from './pipeline';

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

// ═════════════════════════════════════════════════════════════════════════════
// ИНВАРИАНТ ПОРЯДКА ФАЗЫ 2 (капстоун 2.16a, D-064). Конвейер расширен до 17
// систем; порядок обязан СОХРАНИТЬ 8 стыков Фазы 1 и удовлетворить новые стыки
// причинности Фазы 2. Тест — по ДАННЫМ массива PHASE2_SYSTEMS (как PHASE1_SYSTEMS),
// т.к. порядок массива = порядок регистрации = порядок исполнения (scheduler.ts).
// ═════════════════════════════════════════════════════════════════════════════
describe('registerPhase2Systems: сборка конвейера Фазы 2 (D-064)', () => {
  const scheduler = createScheduler();
  registerPhase2Systems(scheduler);
  const registered = scheduler.systems();
  const names = registered.map((s) => s.name);

  it('регистрирует ровно 17 систем Фазы 2 в каноническом порядке', () => {
    const expected = [
      'Weather',
      'ArtifactSpawn',
      'Needs',
      'Perception',
      'RobberyMemory',
      'TaskSelection',
      'Movement',
      'TaskEffects',
      'Trade',
      'ArtifactSearch',
      'Encounters',
      'Animals',
      'Economy',
      'Export',
      'PopulationInflux',
      'MemoryDecay',
      'Death',
    ];
    expect(names).toEqual(expected);
    expect(registered.length).toBe(17);
    // Список данными (PHASE2_SYSTEMS) и фактическая регистрация совпадают.
    expect(PHASE2_SYSTEMS.map((s) => s.name)).toEqual(expected);
  });

  it('СОХРАНЯЕТ все 8 стыков причинности Фазы 1 (D-032) в расширенном конвейере', () => {
    const idx = (name: string): number => {
      const i = indexByName(names, name);
      expect(i, `система ${name} должна быть зарегистрирована`).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(idx('Needs')).toBeLessThan(idx('Death'));
    expect(idx('Perception')).toBeLessThan(idx('TaskSelection'));
    expect(idx('Perception')).toBeLessThan(idx('Encounters'));
    expect(idx('Perception')).toBeLessThan(idx('Animals'));
    expect(idx('TaskSelection')).toBeLessThan(idx('Movement'));
    expect(idx('Encounters')).toBeLessThan(idx('Death'));
    expect(idx('Movement')).toBeLessThan(idx('TaskEffects'));
    expect(idx('Movement')).toBeLessThan(idx('Animals'));
  });

  it('удовлетворяет НОВЫЕ стыки причинности Фазы 2 (D-064)', () => {
    const idx = (name: string): number => indexByName(names, name);
    // ArtifactSpawn рождает артефакт в лут поля ДО того, как TaskSelection оценит
    // SEARCH и ArtifactSearch подберёт (ArtifactSpawn<TaskSelection<ArtifactSearch).
    expect(idx('ArtifactSpawn')).toBeLessThan(idx('TaskSelection'));
    expect(idx('TaskSelection')).toBeLessThan(idx('ArtifactSearch'));
    // RobberyMemory (реактив at(tick−1)) обновляет avoidLoc/relations ДО выбора маршрута.
    expect(idx('RobberyMemory')).toBeLessThan(idx('TaskSelection'));
    // NPC стоит у поселения/поля/склада ПОСЛЕ Movement → Trade/ArtifactSearch/Economy.
    expect(idx('Movement')).toBeLessThan(idx('Trade'));
    expect(idx('Movement')).toBeLessThan(idx('ArtifactSearch'));
    expect(idx('Movement')).toBeLessThan(idx('Economy'));
    // Economy пополняет склад производством ДО того, как Export вывезет хабар.
    expect(idx('Economy')).toBeLessThan(idx('Export'));
    // Encounters снимает лут с проигравшего ДО Death (труп пуст, масса не задвоена, D-060).
    expect(idx('Encounters')).toBeLessThan(idx('Death'));
  });

  it('Weather — первой (фон среды), Death — последней (снимает Alive/Task с добитых)', () => {
    expect(indexByName(names, 'Weather')).toBe(0);
    expect(indexByName(names, 'Death')).toBe(names.length - 1);
  });

  it('конвейер Фазы 2 — надмножество Фазы 1 (все 9 систем Фазы 1 присутствуют)', () => {
    for (const s of PHASE1_SYSTEMS) {
      expect(names).toContain(s.name);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// НЕГАТИВНЫЙ КОНТУР ФАЗЫ 2 (капстоун 2.16a, D-064). Позитивные it-блоки выше
// сверяют индексы КАНОНА; здесь доказываем, что сам НАБОР стыков-данных реально
// ЛОВИТ перестановку — переставь мысленно две системы, и валидатор обязан
// покраснеть. Стыки — ВСЕ 8 Фазы 1 + ВСЕ новые Фазы 2 (D-064), как ДАННЫЕ; тест
// стоит на PHASE2_SYSTEMS (порядок массива = порядок исполнения), а не на копии.
// ═════════════════════════════════════════════════════════════════════════════
const PHASE2_CAUSALITY_JOINTS: ReadonlyArray<readonly [producer: string, consumer: string]> = [
  // — сохранённые 8 стыков Фазы 1 —
  ['Needs', 'Death'],
  ['Perception', 'TaskSelection'],
  ['Perception', 'Encounters'],
  ['Perception', 'Animals'],
  ['TaskSelection', 'Movement'],
  ['Encounters', 'Death'],
  ['Movement', 'TaskEffects'],
  ['Movement', 'Animals'],
  // — новые стыки Фазы 2 (D-064) —
  ['ArtifactSpawn', 'TaskSelection'], // артефакт в луте поля ДО оценки SEARCH
  ['TaskSelection', 'ArtifactSearch'], // цель SEARCH выбрана ДО подбора
  ['ArtifactSpawn', 'ArtifactSearch'], // родить ДО подбора (транзитивно, но проверяем явно)
  ['RobberyMemory', 'TaskSelection'], // обход места грабежа виден выбору цели
  ['Movement', 'Trade'], // НПС стоит у поселения ПОСЛЕ хода
  ['Movement', 'ArtifactSearch'], // НПС стоит у поля ПОСЛЕ хода
  ['Movement', 'Economy'], // census труда по итоговым позициям тика
  ['Economy', 'Export'], // склад пополнен производством ДО вывоза
];

/** Все ли стыки Фазы 2 соблюдены (producer раньше consumer) в данном порядке. */
function phase2CausalityHolds(order: readonly string[]): boolean {
  return PHASE2_CAUSALITY_JOINTS.every(([producer, consumer]) => {
    const p = order.indexOf(producer);
    const c = order.indexOf(consumer);
    return p >= 0 && c >= 0 && p < c;
  });
}

/** Копия порядка с переставленными местами двух систем (по именам). */
function swap2(order: readonly string[], a: string, b: string): string[] {
  return order.map((n) => (n === a ? b : n === b ? a : n));
}

describe('инвариант порядка Фазы 2 ловит перестановки (негативный контур D-064)', () => {
  const canonical = PHASE2_SYSTEMS.map((s) => s.name);

  it('валидатор пропускает КАНОНИЧЕСКИЙ порядок Фазы 2 (17 систем)', () => {
    expect(phase2CausalityHolds(canonical)).toBe(true);
  });

  it('РЕАЛЬНАЯ регистрация Фазы 2 удовлетворяет ВСЕ 16 стыков разом', () => {
    const scheduler = createScheduler();
    registerPhase2Systems(scheduler);
    const actual = scheduler.systems().map((s) => s.name);
    expect(phase2CausalityHolds(actual)).toBe(true);
    expect(actual).toEqual(canonical);
  });

  it('Death перед Encounters — валидатор ЛОВИТ (лут снят бы с уже сделанного трупа, D-060)', () => {
    // Death должна быть строго ПОСЛЕ Encounters (труп пуст, масса не задвоена).
    expect(phase2CausalityHolds(swap2(canonical, 'Encounters', 'Death'))).toBe(false);
  });

  it('ArtifactSearch перед Movement — валидатор ЛОВИТ (подбор до прибытия к полю)', () => {
    expect(phase2CausalityHolds(swap2(canonical, 'Movement', 'ArtifactSearch'))).toBe(false);
  });

  it('ArtifactSpawn ПОСЛЕ TaskSelection — валидатор ЛОВИТ (артефакт невидим оценке SEARCH)', () => {
    expect(phase2CausalityHolds(swap2(canonical, 'ArtifactSpawn', 'TaskSelection'))).toBe(false);
  });

  it('RobberyMemory ПОСЛЕ TaskSelection — валидатор ЛОВИТ (обход грабежа виден лишь через тик)', () => {
    expect(phase2CausalityHolds(swap2(canonical, 'RobberyMemory', 'TaskSelection'))).toBe(false);
  });

  it('Export перед Economy — валидатор ЛОВИТ (вывезли бы склад до производства цикла)', () => {
    expect(phase2CausalityHolds(swap2(canonical, 'Economy', 'Export'))).toBe(false);
  });

  it('Trade перед Movement — валидатор ЛОВИТ (сделка у ещё не пришедшего НПС)', () => {
    expect(phase2CausalityHolds(swap2(canonical, 'Movement', 'Trade'))).toBe(false);
  });

  it('Economy перед Movement — валидатор ЛОВИТ (census труда по устаревшим позициям)', () => {
    expect(phase2CausalityHolds(swap2(canonical, 'Movement', 'Economy'))).toBe(false);
  });

  it('Death в самое начало — валидатор ЛОВИТ (рвёт Needs<Death и Encounters<Death разом)', () => {
    const broken = canonical.filter((n) => n !== 'Death');
    broken.unshift('Death');
    expect(phase2CausalityHolds(broken)).toBe(false);
  });

  it('ЛЮБАЯ соседняя перестановка, рвущая стык, ловится (сплошной проход по 17 позициям)', () => {
    // Доказательство «плотности» набора стыков: перебираем ВСЕ соседние пары и
    // требуем, чтобы канон был локальным минимумом — каждая перестановка, реально
    // меняющая относительный порядок пары из стыка, ловится валидатором. Пары,
    // не входящие ни в один стык, законно остаются валидными (не ложное срабатывание).
    let jointBreakingSwapsCaught = 0;
    for (let i = 0; i < canonical.length - 1; i++) {
      const a = canonical[i]!;
      const b = canonical[i + 1]!;
      const swapped = swap2(canonical, a, b);
      const breaksAJoint = PHASE2_CAUSALITY_JOINTS.some(
        ([p, c]) => (p === a && c === b) || (p === b && c === a),
      );
      if (breaksAJoint) {
        expect(phase2CausalityHolds(swapped), `перестановка ${a}<->${b} обязана ловиться`).toBe(false);
        jointBreakingSwapsCaught++;
      }
    }
    // Как минимум несколько соседних пар — реальные стыки (тест не холостой).
    expect(jointBreakingSwapsCaught).toBeGreaterThanOrEqual(3);
  });
});
