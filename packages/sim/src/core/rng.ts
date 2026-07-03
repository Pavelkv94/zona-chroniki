/**
 * @module @zona/sim/core/rng
 *
 * Seeded PRNG ядра — ЕДИНСТВЕННЫЙ разрешённый источник случайности в симуляции
 * (закон №2: `Math.random` запрещён). Детерминизм: одинаковый seed → одинаковая
 * последовательность (закон №8). RNG предназначен только для физиологии
 * (разброс выстрела и т.п.) и генерации мира, но не для «X% шанс события» —
 * события возникают из состояния мира (закон №2).
 *
 * ── Базовый генератор: mulberry32 ──────────────────────────────────────────
 * mulberry32 — 32-битный генератор с состоянием в одном uint32. Быстрый, без
 * аллокаций в горячем цикле (SoA-дружелюбен), период 2^32. Его «магические»
 * константы — ЧАСТЬ АЛГОРИТМА (constants of a well-known mixing function), а НЕ
 * балансовые параметры мира: менять их нельзя и в /sim/balance им не место
 * (закон №7 касается баланса, не внутренностей PRNG). Ниже они помечены как
 * MULBERRY32_* и обоснованы происхождением алгоритма.
 *
 * ── fork: независимые подпотоки (D-004) ────────────────────────────────────
 * `fork(label)` выводит seed ребёнка как `hash(label) ^ rootSeed` (FNV-1a от
 * label), а НЕ из текущего state родителя. Ключевой инвариант: продвижение
 * родителя (`parent.next()`) ПОСЛЕ fork не меняет последовательность ребёнка —
 * ребёнок зависит только от пары (label, rootSeed). Это развязывает системы:
 * добавление вызовов RNG в одной системе не ломает истории других (риск C-2).
 * Каждая система берёт `world.rng.fork(system.name)` и владеет своим потоком.
 *
 * ── state и сериализация (для 0.5) ─────────────────────────────────────────
 * `state` — текущее внутреннее uint32-состояние (геттер нормализует наружу
 * через `>>> 0`; внутри `next()` держит знаковый int32 ради скорости — битовый
 * паттерн тот же). `restoreRng(seed, state)` воссоздаёт генератор, продолжающий
 * последовательность ровно с этого state.
 *
 * ОТКРЫТЫЙ ХВОСТ ДЛЯ 0.5 (аналог D-008): подпоток из `fork(label)` имеет seed,
 * ВЫВЕДЕННЫЙ из (label, rootSeed), а НЕ хранит его как корневой. Публичный
 * контракт `Rng` отдаёт наружу только `state`, но не seed подпотока. Поэтому
 * для восстановления форкнутого потока сериализация 0.5 ОБЯЗАНА сохранить либо
 * сам `label` (и переисполнить `parent.fork(label)`), либо явно seed подпотока —
 * одного `state` недостаточно, т.к. без seed восстановленный поток не сможет
 * форкать своих детей идентично оригиналу (fork зависит от rootSeed, D-004).
 * Именно для этого `restoreRng` принимает `seed` явным аргументом.
 *
 * Пример:
 * ```ts
 * const rng = createRng(42 as Seed);
 * const perc = rng.fork('perception');   // подпоток восприятия
 * const dmg = perc.range(0.8, 1.2);       // множитель разброса
 * const i = perc.int(0, weapons.length);  // индекс в [0, len)
 * const saved = perc.state;               // для save/load (0.5)
 * const perc2 = restoreRng(perc.seed, saved); // продолжит с того же места
 * ```
 * (Примечание: `rng.seed` наружу контрактом не выдаётся; `restoreRng` берёт seed
 *  из сериализованной пары. Внутри модуля seed хранится для читаемости.)
 */

import type { Seed } from '@zona/shared';

/**
 * Публичный контракт генератора. Минимален и стабилен: другие системы зависят
 * от него (ломающие изменения — через sim-architect).
 */
export interface Rng {
  /** Следующее псевдослучайное число в [0, 1). Продвигает state. */
  next(): number;
  /**
   * Целое в [minIncl, maxExcl). НИКОГДА не возвращает maxExcl.
   * Требует minIncl < maxExcl, иначе бросает (пустой/инвертированный диапазон).
   */
  int(minIncl: number, maxExcl: number): number;
  /** Float в [min, max). Требует min <= max. */
  range(min: number, max: number): number;
  /** Равновероятный элемент непустого массива. Пустой массив → throw. */
  pick<T>(arr: readonly T[]): T;
  /**
   * Независимый подпоток. seed ребёнка = hash(label) ^ rootSeed (D-004):
   * НЕ зависит от текущего state родителя. Один и тот же label от одного корня
   * всегда даёт один и тот же подпоток.
   */
  fork(label: string): Rng;
  /** Текущее внутреннее uint32-состояние (для сериализации 0.5). */
  readonly state: number;
}

// ── Алгоритмические константы mulberry32 (часть алгоритма, НЕ баланс) ────────
// Происхождение: стандартная реализация mulberry32 (Tommy Ettinger, public
// domain). Эти значения фиксированы определением функции смешивания и не
// подлежат тюнингу — менять их = ломать сам генератор, а не «балансировать».
/** Инкремент состояния на каждый шаг (нечётная константа, обход полного цикла). */
const MULBERRY32_INCREMENT = 0x6d2b79f5;
/** OR-маска множителя во втором раунде смешивания: `Math.imul(…, 61 | t)`. */
const MULBERRY32_ROUND2_OR = 61;
/** XOR-сдвиг №1 в смешивании. */
const MULBERRY32_SHIFT1 = 15;
/** XOR-сдвиг №2 в смешивании. */
const MULBERRY32_SHIFT2 = 7;
/** XOR-сдвиг №3 (финальный вывод). */
const MULBERRY32_SHIFT3 = 14;
/** Делитель для перевода uint32 → [0,1): 2^32. */
const UINT32_RANGE = 4294967296; // 0x1_0000_0000

// ── Константы FNV-1a (часть хеш-алгоритма для fork, НЕ баланс) ───────────────
// FNV-1a 32-бит: offset basis и prime — стандартные значения спецификации FNV.
/** FNV-1a offset basis (32-бит). */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a prime (32-бит). */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a хеш строки label → uint32. Детерминирован и не зависит от порядка
 * итерации коллекций (закон №8): проходит кодовые единицы строки по порядку.
 * Используется только для вывода seed подпотока в `fork`.
 */
function fnv1a(label: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    // h * FNV_PRIME в 32-битной арифметике без переполнения double:
    // Math.imul даёт корректное 32-битное умножение.
    h = Math.imul(h, FNV_PRIME);
  }
  // Приводим к uint32 (>>> 0).
  return h >>> 0;
}

/**
 * Реализация Rng поверх mulberry32. Состояние — единственное изменяемое поле
 * `_state` (uint32). Никаких аллокаций в `next` (закон производительности).
 */
class Mulberry32Rng implements Rng {
  /** Внутреннее uint32-состояние генератора. */
  private _state: number;
  /** Корневой seed этого потока (для вывода детей в fork). Uint32. */
  private readonly _seed: number;

  constructor(seed: number, state: number) {
    // Оба нормализуем к uint32, чтобы отрицательные/дробные seed были валидны.
    this._seed = seed >>> 0;
    this._state = state >>> 0;
  }

  /** Корневой seed потока (uint32). Внутренний доступ для fork/restore. */
  get seed(): number {
    return this._seed;
  }

  get state(): number {
    // Нормализуем наружу к uint32: `next()` хранит state через `| 0` (знаковый
    // int32 ради скорости), но контракт обещает uint32 — без `>>> 0` значения
    // > 0x7FFFFFFF утекали бы отрицательными и ломали сериализацию 0.5. Битовый
    // паттерн при этом тот же, последовательность next() не меняется.
    return this._state >>> 0;
  }

  next(): number {
    // ── mulberry32 (одна итерация) ──
    // Продвигаем состояние на фиксированный инкремент.
    this._state = (this._state + MULBERRY32_INCREMENT) | 0;
    let t = this._state;
    // Раунд смешивания: XOR-сдвиг + умножение на нечётную величину (t | 1).
    t = Math.imul(t ^ (t >>> MULBERRY32_SHIFT1), t | 1);
    // Второй раунд: подмешиваем ещё одно произведение (XOR коммутативен, форма
    // `t ^ (t + …)` эквивалентна каноничной `(t + …) ^ t`).
    t ^= t + Math.imul(t ^ (t >>> MULBERRY32_SHIFT2), t | MULBERRY32_ROUND2_OR);
    // Финальный XOR-сдвиг и перевод в [0,1) делением на 2^32.
    return ((t ^ (t >>> MULBERRY32_SHIFT3)) >>> 0) / UINT32_RANGE;
  }

  int(minIncl: number, maxExcl: number): number {
    if (!(minIncl < maxExcl)) {
      throw new RangeError(
        `Rng.int: пустой/инвертированный диапазон [${minIncl}, ${maxExcl}); нужно minIncl < maxExcl`,
      );
    }
    // next() ∈ [0,1) ⇒ произведение ∈ [0, span) ⇒ +min ∈ [min, max); floor
    // никогда не достигает maxExcl (закон контракта: max эксклюзивен).
    const span = maxExcl - minIncl;
    return minIncl + Math.floor(this.next() * span);
  }

  range(min: number, max: number): number {
    if (!(min <= max)) {
      throw new RangeError(
        `Rng.range: инвертированный диапазон [${min}, ${max}); нужно min <= max`,
      );
    }
    return min + this.next() * (max - min);
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) {
      throw new RangeError('Rng.pick: массив пуст');
    }
    // arr.length >= 1 ⇒ int(0, len) валиден и вернёт индекс в [0, len).
    return arr[this.int(0, arr.length)] as T;
  }

  fork(label: string): Rng {
    // D-004: seed ребёнка выводится из (label, rootSeed), НЕ из текущего state.
    // Поэтому продвижение родителя после fork не влияет на детей.
    const childSeed = (fnv1a(label) ^ this._seed) >>> 0;
    return createRng(childSeed as Seed);
  }
}

/**
 * Создаёт генератор от seed. Начальное состояние === seed (uint32): первая
 * `next()` уже смешивает его. Детерминирован (зависит только от seed).
 */
export function createRng(seed: Seed): Rng {
  const s = seed >>> 0;
  return new Mulberry32Rng(s, s);
}

/**
 * Восстанавливает генератор, продолжающий последовательность с сохранённого
 * `state`. `seed` нужен, чтобы `fork` восстановленного потока давал те же
 * подпотоки, что и оригинал (fork зависит от rootSeed, D-004). Используется
 * сериализацией 0.5.
 */
export function restoreRng(seed: Seed, state: number): Rng {
  return new Mulberry32Rng(seed >>> 0, state >>> 0);
}
