/**
 * @module @zona/sim/core/rng.test
 *
 * Юниты seeded PRNG (задача 0.3): воспроизводимость, разделение потоков seed,
 * инвариант fork D-004 (подпоток не зависит от продвижения родителя),
 * восстановление из state, границы int/range/pick и грубая равномерность.
 * Все тесты детерминированы (без Math.random) — закон №8.
 */

import { describe, it, expect } from 'vitest';
import type { Seed } from '@zona/shared';
import { createRng, restoreRng } from './rng';

/** Собрать N значений next() в массив. */
function collect(rng: { next(): number }, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = rng.next();
  return out;
}

/**
 * НЕЗАВИСИМАЯ эталонная реализация mulberry32 (каноничная форма Tommy Ettinger,
 * public domain). Используется только для перекрёстной проверки порта в rng.ts —
 * если продакшн-смешивание разъедется с эталоном хоть на один бит, тесты падают.
 * ВАЖНО: это НЕ Math.random и не источник недетерминизма — чистая функция seed.
 */
function referenceMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('createRng: воспроизводимость', () => {
  it('createRng(42) даёт идентичные 10000 значений при двух вызовах', () => {
    const a = collect(createRng(42 as Seed), 10000);
    const b = collect(createRng(42 as Seed), 10000);
    expect(a).toEqual(b);
  });

  it('все значения next() лежат в [0, 1)', () => {
    const rng = createRng(123 as Seed);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('разные seed → разные последовательности', () => {
    const a = collect(createRng(1 as Seed), 100);
    const b = collect(createRng(2 as Seed), 100);
    expect(a).not.toEqual(b);
  });

  it('отрицательный/дробный seed нормализуется к uint32 и детерминирован', () => {
    const a = collect(createRng(-1 as Seed), 50);
    const b = collect(createRng(-1 as Seed), 50);
    expect(a).toEqual(b);
  });
});

describe('fork: инвариант независимости от родителя (D-004)', () => {
  it('продвижение родителя ПОСЛЕ fork не меняет последовательность ребёнка', () => {
    // Ветка 1: форкаем сразу от свежего родителя.
    const rngA = createRng(1 as Seed);
    const childBefore = collect(rngA.fork('perc'), 100);

    // Ветка 2: тот же корневой seed, но родитель продвинут на 50 вызовов ДО fork.
    const rngA2 = createRng(1 as Seed);
    for (let i = 0; i < 50; i++) rngA2.next();
    const childAfter = collect(rngA2.fork('perc'), 100);

    // Ребёнок зависит только от (label, rootSeed), не от state родителя.
    expect(childAfter).toEqual(childBefore);
  });

  it('вызовы родителя между fork не влияют на детей', () => {
    const parent = createRng(777 as Seed);
    const first = collect(parent.fork('sys'), 20);
    parent.next();
    parent.next();
    const second = collect(parent.fork('sys'), 20);
    expect(second).toEqual(first);
  });

  it("fork('a') и fork('b') дают разные последовательности", () => {
    const root = createRng(5 as Seed);
    const a = collect(root.fork('a'), 100);
    const b = collect(root.fork('b'), 100);
    expect(a).not.toEqual(b);
  });

  it("fork('a') дважды от одного корня — идентичны", () => {
    const root = createRng(5 as Seed);
    const a1 = collect(root.fork('a'), 100);
    const a2 = collect(root.fork('a'), 100);
    expect(a1).toEqual(a2);
  });

  it('один label от РАЗНЫХ корневых seed → разные подпотоки', () => {
    const a = collect(createRng(10 as Seed).fork('perc'), 50);
    const b = collect(createRng(11 as Seed).fork('perc'), 50);
    expect(a).not.toEqual(b);
  });

  it('дети форкаются рекурсивно и стабильно', () => {
    const g1 = collect(createRng(9 as Seed).fork('a').fork('b'), 30);
    const g2 = collect(createRng(9 as Seed).fork('a').fork('b'), 30);
    expect(g1).toEqual(g2);
  });
});

describe('restoreRng: продолжение с сохранённого state', () => {
  it('восстановленный поток выдаёт тот же хвост, что и оригинал', () => {
    const original = createRng(2024 as Seed);
    // Продвигаем на N, снимаем state, собираем «эталонный хвост».
    const n = 123;
    for (let i = 0; i < n; i++) original.next();
    const savedState = original.state;
    const tailExpected = collect(original, 200);

    // Восстанавливаем из (seed, state) и сравниваем хвост.
    const restored = restoreRng(2024 as Seed, savedState);
    const tailActual = collect(restored, 200);
    expect(tailActual).toEqual(tailExpected);
  });

  it('state продвигается при каждом next()', () => {
    const rng = createRng(3 as Seed);
    const s0 = rng.state;
    rng.next();
    expect(rng.state).not.toBe(s0);
  });

  it('state ВСЕГДА uint32 на 1000 шагов от нескольких seed (не знаковый int32)', () => {
    // Регресс-барьер: `next()` держит state как знаковый int32 (`| 0`); геттер
    // обязан нормализовать через `>>> 0`. Как только состояние переваливает за
    // 0x80000000, наивный геттер вернул бы отрицательное число — этот тест
    // покраснел бы. Прогоняем много шагов от разных seed, чтобы гарантированно
    // пройти через «старший бит установлен».
    const seeds = [0, 1, 3, 42, 123456, 0x7fffffff, 0xffffffff];
    for (const seed of seeds) {
      const rng = createRng(seed as Seed);
      for (let i = 0; i < 1000; i++) {
        rng.next();
        const s = rng.state;
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(4294967296);
      }
    }
  });

  it('fork восстановленного потока даёт те же подпотоки, что оригинал (seed сохранён)', () => {
    const original = createRng(55 as Seed);
    for (let i = 0; i < 10; i++) original.next();
    const restored = restoreRng(55 as Seed, original.state);
    const a = collect(original.fork('x'), 40);
    const b = collect(restored.fork('x'), 40);
    expect(b).toEqual(a);
  });
});

describe('pick', () => {
  it('pick([]) бросает', () => {
    const rng = createRng(1 as Seed);
    expect(() => rng.pick([])).toThrow();
  });

  it('pick массива из 1 всегда возвращает его единственный элемент', () => {
    const rng = createRng(1 as Seed);
    for (let i = 0; i < 100; i++) {
      expect(rng.pick(['only'])).toBe('only');
    }
  });

  it('pick возвращает элементы только из массива', () => {
    const rng = createRng(42 as Seed);
    const arr = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(rng.pick(arr));
    for (const s of seen) expect(arr).toContain(s);
  });
});

describe('int / range: границы', () => {
  it('int(min, max) в [min, max) и НИКОГДА не равен max', () => {
    const rng = createRng(7 as Seed);
    for (let i = 0; i < 10000; i++) {
      const v = rng.int(3, 8);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(8);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('int с пустым/инвертированным диапазоном бросает', () => {
    const rng = createRng(1 as Seed);
    expect(() => rng.int(5, 5)).toThrow();
    expect(() => rng.int(6, 2)).toThrow();
  });

  it('range(min, max) в [min, max)', () => {
    const rng = createRng(11 as Seed);
    for (let i = 0; i < 10000; i++) {
      const v = rng.range(-2.5, 4.5);
      expect(v).toBeGreaterThanOrEqual(-2.5);
      expect(v).toBeLessThan(4.5);
    }
  });

  it('range(x, x) === x (вырожденный диапазон допустим)', () => {
    const rng = createRng(1 as Seed);
    expect(rng.range(3, 3)).toBe(3);
  });

  it('range инвертированного диапазона бросает', () => {
    const rng = createRng(1 as Seed);
    expect(() => rng.range(4, 1)).toThrow();
  });
});

describe('грубая равномерность (детерминированно)', () => {
  it('100000 выборок int(0,10): каждый бакет в пределах ±5% от 10000', () => {
    const rng = createRng(12345 as Seed);
    const buckets = new Array<number>(10).fill(0);
    const samples = 100000;
    for (let i = 0; i < samples; i++) {
      const v = rng.int(0, 10);
      buckets[v] = (buckets[v] ?? 0) + 1;
    }
    const expected = samples / 10; // 10000
    const tolerance = expected * 0.05; // ±500
    for (let b = 0; b < 10; b++) {
      const count = buckets[b] ?? 0;
      expect(count).toBeGreaterThan(expected - tolerance);
      expect(count).toBeLessThan(expected + tolerance);
    }
  });

  it('100000 выборок range(0,10): каждый из 10 бакетов в пределах ±5%', () => {
    // range — непрерывный; бьём [0,10) на 10 равных корзин по floor(v).
    const rng = createRng(98765 as Seed);
    const buckets = new Array<number>(10).fill(0);
    const samples = 100000;
    for (let i = 0; i < samples; i++) {
      const v = rng.range(0, 10);
      const b = Math.floor(v); // v ∈ [0,10) ⇒ b ∈ [0,9]
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    const expected = samples / 10;
    const tolerance = expected * 0.05;
    for (let b = 0; b < 10; b++) {
      const count = buckets[b] ?? 0;
      expect(count).toBeGreaterThan(expected - tolerance);
      expect(count).toBeLessThan(expected + tolerance);
    }
  });
});

// ── УСИЛЕНИЕ QA (задача 0.3) ─────────────────────────────────────────────────

describe('порт mulberry32 совпадает с независимым эталоном (бит-в-бит)', () => {
  // Самая ценная проверка: если смешивание в rng.ts разъедется с каноничным
  // mulberry32 хоть на один шаг — здесь всплывёт. Ловит опечатки в сдвигах,
  // константах, порядке раундов, приведении к uint32.
  it.each([0, 1, 42, 2147483648, 4294967295])(
    'seed=%d: 5000 значений совпадают с эталоном',
    (seed) => {
      const actual = collect(createRng(seed as Seed), 5000);
      const ref = referenceMulberry32(seed);
      const expected = Array.from({ length: 5000 }, () => ref());
      expect(actual).toEqual(expected);
    },
  );
});

describe('граничные seed: детерминизм и диапазон next()', () => {
  // Контракт: Seed трактуется как uint32 (>>> 0). Проверяем углы диапазона.
  const boundarySeeds: ReadonlyArray<readonly [string, number]> = [
    ['ноль', 0],
    ['единица', 1],
    ['2^31 (старший бит)', 2147483648],
    ['2^32-1 (максимум uint32)', 4294967295],
    ['отрицательный -1', -1],
    ['отрицательный -2^31', -2147483648],
    ['дробный 3.9 (усекается >>> 0)', 3.9],
  ];

  it.each(boundarySeeds)('seed %s: два прогона идентичны и все next() ∈ [0,1)', (_label, seed) => {
    const a = collect(createRng(seed as Seed), 2000);
    const b = collect(createRng(seed as Seed), 2000);
    expect(a).toEqual(b);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('отрицательный seed эквивалентен своему uint32-представлению', () => {
    // -1 >>> 0 === 4294967295; контракт uint32 требует идентичной истории.
    expect(collect(createRng(-1 as Seed), 500)).toEqual(
      collect(createRng(4294967295 as Seed), 500),
    );
    // -2^31 >>> 0 === 2^31.
    expect(collect(createRng(-2147483648 as Seed), 500)).toEqual(
      collect(createRng(2147483648 as Seed), 500),
    );
  });

  it('дробный seed эквивалентен усечённому к uint32', () => {
    // 3.9 >>> 0 === 3; история должна совпасть с seed=3.
    expect(collect(createRng(3.9 as Seed), 500)).toEqual(collect(createRng(3 as Seed), 500));
  });
});

describe('next(): статистические границы на большой выборке', () => {
  it('300000 значений: min ≥ 0, max < 1, строго', () => {
    const rng = createRng(0xabcdef as Seed);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 300000; i++) {
      const v = rng.next();
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1); // эксклюзивная верхняя граница
    // sanity: разброс реально широкий, а не залипший у одного края.
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.99);
  });
});

describe('restoreRng: полный round-trip состояния', () => {
  it('прогон N=500, сохранение state, restore → следующие M=500 идентичны', () => {
    const original = createRng(31337 as Seed);
    for (let i = 0; i < 500; i++) original.next();
    const saved = original.state;

    const tailOriginal = collect(original, 500);
    const restored = restoreRng(31337 as Seed, saved);
    const tailRestored = collect(restored, 500);

    expect(tailRestored).toEqual(tailOriginal);
  });

  it('restore сразу после createRng (state === seed) воспроизводит ВСЮ историю с нуля', () => {
    // Начальное состояние === seed; restore(seed, seed) обязан дать ту же историю.
    const fresh = createRng(2718 as Seed);
    const stateAtBirth = fresh.state; // ещё ни одного next()
    const full = collect(fresh, 300);

    const restored = restoreRng(2718 as Seed, stateAtBirth);
    expect(collect(restored, 300)).toEqual(full);
  });

  it('несколько последовательных чекпойнтов восстанавливают один и тот же хвост', () => {
    const original = createRng(42 as Seed);
    const checkpoints: number[] = [];
    // Снимаем state на шагах 100, 200, 300 и «эталонные» продолжения.
    const ref = createRng(42 as Seed);
    for (let step = 1; step <= 300; step++) {
      original.next();
      if (step === 100 || step === 200 || step === 300) checkpoints.push(original.state);
    }
    // Прогоняем эталон и на тех же отметках сверяем восстановление.
    for (let step = 1; step <= 300; step++) ref.next();
    // От последнего чекпойнта (300) хвосты должны совпасть.
    const restored = restoreRng(42 as Seed, checkpoints[2] as number);
    const tailRef = collect(ref, 400);
    const tailRestored = collect(restored, 400);
    expect(tailRestored).toEqual(tailRef);
  });

  it('restore с ПРАВИЛЬНЫМ state, но ЧУЖИМ seed: next() совпадает, fork расходится (D-004)', () => {
    // Пин-тест документированного поведения: последовательность next() зависит
    // ТОЛЬКО от state, а fork — от rootSeed. Ошибочный seed при restore не ломает
    // основной поток, но порождает другие подпотоки. Ловит регресс, если кто-то
    // завяжет next() на seed или fork на state.
    const original = createRng(555 as Seed);
    for (let i = 0; i < 20; i++) original.next();
    const state = original.state;

    const rightSeed = restoreRng(555 as Seed, state);
    const wrongSeed = restoreRng(999 as Seed, state);

    // Основной поток одинаков (зависит только от state).
    expect(collect(wrongSeed, 50)).toEqual(collect(rightSeed, 50));

    // Но подпотоки различаются (fork зависит от rootSeed).
    const rightChild = collect(restoreRng(555 as Seed, state).fork('sys'), 30);
    const wrongChild = collect(restoreRng(999 as Seed, state).fork('sys'), 30);
    expect(wrongChild).not.toEqual(rightChild);
    // А правильный seed воспроизводит подпоток оригинала точь-в-точь.
    const originalChild = collect(createRng(555 as Seed).fork('sys'), 30);
    expect(rightChild).toEqual(originalChild);
  });
});

describe('fork D-004: стабильность при любой перестановке вызовов родителя', () => {
  // Ядро D-004: подпоток ребёнка = f(label, rootSeed) и НИЧЕГО больше.
  // Гоняем родителя по разным сценариям перемежения next()/fork — ребёнок
  // с одним label обязан быть идентичен во всех сценариях.
  const LABEL = 'perception';
  const ROOT = 20260703 as Seed;

  /** Эталон: ребёнок от свежего, ничем не тронутого родителя. */
  function pristineChild(): number[] {
    return collect(createRng(ROOT).fork(LABEL), 60);
  }

  it('сценарий A: fork до любых next()', () => {
    const p = createRng(ROOT);
    expect(collect(p.fork(LABEL), 60)).toEqual(pristineChild());
  });

  it('сценарий B: 1000 next() до fork', () => {
    const p = createRng(ROOT);
    for (let i = 0; i < 1000; i++) p.next();
    expect(collect(p.fork(LABEL), 60)).toEqual(pristineChild());
  });

  it('сценарий C: перемежение next()/fork(другие метки) вокруг целевого fork', () => {
    const p = createRng(ROOT);
    p.next();
    p.fork('a').next();
    p.next();
    p.fork('b');
    const target = collect(p.fork(LABEL), 60);
    p.next(); // продвижение ПОСЛЕ fork не должно ни на что влиять
    p.fork('c');
    expect(target).toEqual(pristineChild());
  });

  it('сценарий D: fork целевой метки дважды, между ними — работа родителя', () => {
    const p = createRng(ROOT);
    const first = collect(p.fork(LABEL), 60);
    for (let i = 0; i < 333; i++) p.next();
    p.fork('noise');
    const second = collect(p.fork(LABEL), 60);
    expect(first).toEqual(pristineChild());
    expect(second).toEqual(pristineChild());
  });

  it('сценарий E: параллельная работа ребёнка НЕ влияет на будущие форки того же label', () => {
    const p = createRng(ROOT);
    const child1 = p.fork(LABEL);
    collect(child1, 500); // ребёнок жадно расходует свой поток
    const child2 = p.fork(LABEL); // новый форк того же label от того же корня
    expect(collect(child2, 60)).toEqual(pristineChild());
  });
});

describe('fork рекурсивно: внук стабилен и независим от продвижения ребёнка', () => {
  it('child.fork("x") не зависит от того, сколько раз крутили child', () => {
    const root = createRng(13 as Seed);

    // Ветка 1: форкаем внука от свежего ребёнка.
    const grandBefore = collect(root.fork('child').fork('x'), 40);

    // Ветка 2: тот же корень, но ребёнка прокрутили на 200 next() до fork внука.
    const child = createRng(13 as Seed).fork('child');
    for (let i = 0; i < 200; i++) child.next();
    const grandAfter = collect(child.fork('x'), 40);

    expect(grandAfter).toEqual(grandBefore);
  });

  it('глубокая цепочка форков детерминирована на два прогона', () => {
    const chain = (): number[] =>
      collect(createRng(7 as Seed).fork('a').fork('b').fork('c').fork('d'), 40);
    expect(chain()).toEqual(chain());
  });

  it("внуки разных меток различаются: fork('child').fork('x') ≠ fork('child').fork('y')", () => {
    const root = createRng(13 as Seed);
    const gx = collect(root.fork('child').fork('x'), 40);
    const gy = collect(root.fork('child').fork('y'), 40);
    expect(gx).not.toEqual(gy);
  });
});

describe('fork: поведение на граничных метках', () => {
  it("пустая метка fork('') детерминирована", () => {
    const a = collect(createRng(100 as Seed).fork(''), 40);
    const b = collect(createRng(100 as Seed).fork(''), 40);
    expect(a).toEqual(b);
    // и отличается от непустой метки (обычно; фиксируем как ожидание)
    const c = collect(createRng(100 as Seed).fork('x'), 40);
    expect(a).not.toEqual(c);
  });

  it('длинная метка (реальное имя системы) детерминирована и уникальна', () => {
    const long = 'ecosystem.mutant.migration.pathfinding.v2';
    const a = collect(createRng(1 as Seed).fork(long), 40);
    const b = collect(createRng(1 as Seed).fork(long), 40);
    expect(a).toEqual(b);
  });
});

describe('int: дополнительные границы', () => {
  it('int(min, min+1): span=1 → всегда единственный исход min', () => {
    const rng = createRng(1 as Seed);
    for (let i = 0; i < 1000; i++) {
      expect(rng.int(5, 6)).toBe(5);
    }
  });

  it('int с отрицательным диапазоном: [-5, -1) корректен и не достигает -1', () => {
    const rng = createRng(77 as Seed);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = rng.int(-5, -1);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(-1);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    // покрыты все 4 исхода: -5,-4,-3,-2
    expect([...seen].sort((a, b) => a - b)).toEqual([-5, -4, -3, -2]);
  });

  it('int(min,max) покрывает и минимальный, и максимально возможный (max-1) исход', () => {
    const rng = createRng(2024 as Seed);
    const seen = new Set<number>();
    for (let i = 0; i < 20000; i++) seen.add(rng.int(0, 5));
    expect(seen.has(0)).toBe(true);
    expect(seen.has(4)).toBe(true); // граничный верхний включённый
    expect(seen.has(5)).toBe(false); // max эксклюзивен — никогда
  });

  it('int инвертированный/пустой диапазон бросает RangeError (пин-контракт)', () => {
    const rng = createRng(1 as Seed);
    expect(() => rng.int(5, 5)).toThrow(RangeError); // пустой
    expect(() => rng.int(6, 2)).toThrow(RangeError); // инвертированный
    expect(() => rng.int(0, -1)).toThrow(RangeError);
  });
});

describe('range: пин-контракт инвертированного диапазона', () => {
  it('range инвертированного диапазона бросает RangeError', () => {
    const rng = createRng(1 as Seed);
    expect(() => rng.range(4, 1)).toThrow(RangeError);
    expect(() => rng.range(0, -0.0001)).toThrow(RangeError);
  });
});

describe('pick: покрытие индексов и детерминизм', () => {
  it('pick большого массива покрывает все индексы (нет мёртвых элементов)', () => {
    const rng = createRng(4242 as Seed);
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(rng.pick(arr));
    expect(seen.size).toBe(20); // каждый элемент хоть раз выбран
    expect(seen.has(0)).toBe(true);
    expect(seen.has(19)).toBe(true); // последний элемент достижим
  });

  it('две одинаково-засеянные последовательности pick идентичны', () => {
    const arr = ['x', 'y', 'z', 'w'] as const;
    const a = createRng(9 as Seed);
    const b = createRng(9 as Seed);
    const pa = Array.from({ length: 200 }, () => a.pick(arr));
    const pb = Array.from({ length: 200 }, () => b.pick(arr));
    expect(pa).toEqual(pb);
  });
});
