/**
 * @module @zona/sim/core/scheduler
 *
 * Планировщик тиков (задача 0.2) — сердце цикла симуляции. Он владеет
 * УПОРЯДОЧЕННЫМ списком систем и на каждом тике исполняет те из них, чьё
 * `SystemSchedule` разрешает запуск, после чего фиксирует события тика на шине.
 *
 * ── Детерминизм (закон №8, D-006) ───────────────────────────────────────────
 * Планировщик НЕ измеряет время: ни `Date.now`, ни `performance.now` здесь нет
 * и быть не может — бюджет 1.6 мс/тик и любые тайминги живут исключительно в
 * `@zona/headless` (D-006). Порядок исполнения систем на тике = порядок их
 * РЕГИСТРАЦИИ (`register`), а не порядок, зависящий от хеша/Map. Поэтому один
 * seed → одна история: два прогона одного набора систем дают идентичный лог
 * вызовов и идентичные события.
 *
 * ── Условие запуска системы на тике T (due) ─────────────────────────────────
 * Система «due» на тике T, когда `(T - phase) % every === 0` И `T >= phase`,
 * где `phase = schedule.phase ?? 0`. То есть система с `every=10, phase=3`
 * срабатывает на тиках 3, 13, 23, … и НЕ на 0. `every=1` — каждый тик.
 * `every` и `phase` берутся ТОЛЬКО из `system.schedule` (закон №7: никаких
 * магических частот в коде планировщика).
 *
 * ── Персональный RNG (D-009) ────────────────────────────────────────────────
 * Для каждой due-системы контекст получает `world.rng.fork(`${name}@${T}`)`.
 * Метка форка включает НОМЕР ТИКА: без него `fork(name)`, пересчитываемый каждый
 * тик, давал бы одну и ту же последовательность на всех тиках (fork зависит
 * только от (label, rootSeed), D-004) — скрытый недетерминизм физиологии.
 * С тиком в метке поток различается по тикам, но полностью воспроизводим.
 *
 * ── Порядок фаз одного тика (`tickOnce` на `world.tick === T`) ───────────────
 *  1. Найти due-системы (по `schedule`), сохранив порядок регистрации.
 *  2. Для каждой в этом порядке собрать `ctx` и вызвать `update(ctx)`.
 *  3. `world.bus.endTick(T)` — перенести буфер событий тика в лог (D-005).
 *     Если система опубликовала событие с чужим tick, endTick бросит (ловит
 *     рассинхрон). Систему-публикацию мы не оборачиваем — она пишет через
 *     `ctx.bus`, а `tick` события шина берёт из `world.tick`, равного T.
 *  4. `world.tick = T + 1` — продвинуть время РОВНО на 1.
 *
 * ── Атомарность тика (всё-или-ничего) ───────────────────────────────────────
 * Цикл систем обёрнут в try/catch: если система бросит, планировщик вызывает
 * `world.bus.discardTick()` (отбросить недокоммиченный буфер) и ПРОБРАСЫВАЕТ
 * исключение, НЕ вызывая endTick и НЕ двигая `world.tick`. Итог: упавший тик не
 * оставляет следа (буфер чист, tick прежний), поэтому повторный `tickOnce`
 * безопасен и не даёт дублей в append-only логе. id отброшенных событий сгорают
 * (пропуски в EventId допустимы — контракт требует монотонности/уникальности,
 * не непрерывности, C-4; см. discardTick в events.ts).
 *
 * `run(world, ticks)` вызывает `tickOnce` ровно `ticks` раз. Без пауз, без
 * замера времени, без адаптивного пропуска систем — чистая детерминированная
 * последовательность тиков.
 *
 * Пример:
 * ```ts
 * const sched = createScheduler();
 * sched.register(perception);   // every 1
 * sched.register(hunger);       // every 10
 * const world = createSimWorld(42 as Seed);
 * sched.run(world, 100);        // 100 тиков; world.tick === 100
 * ```
 */

import type { Tick } from '@zona/shared';
import type { System, SystemCtx } from './system';
import type { SimWorld } from './world';

/**
 * Планировщик тиков. `register` задаёт систему и её место в порядке исполнения;
 * `tickOnce`/`run` прогоняют симуляцию. НИКАКОГО замера времени (D-006).
 */
export interface Scheduler {
  /**
   * Регистрирует систему. ПОРЯДОК РЕГИСТРАЦИИ = порядок исполнения на тике.
   * Валидирует: имя непустое и УНИКАЛЬНОЕ (иначе одинаковая метка форка rng
   * `${name}@${tick}` дала бы коллизию потоков + двойное исполнение → throw);
   * `every >= 1` целое (иначе деление/пустой шаг → throw); `phase >= 0` целое
   * (иначе отрицательная фаза ломает условие `T >= phase` → throw).
   */
  register(system: System): void;
  /** Зарегистрированные системы в порядке регистрации (копия, только чтение). */
  systems(): readonly System[];
  /**
   * Выполнить РОВНО один тик на текущем `world.tick`: due-системы (в порядке
   * регистрации) → `bus.endTick(tick)` → `world.tick += 1`.
   */
  tickOnce(world: SimWorld): void;
  /**
   * Прогнать `ticks` тиков подряд (вызвать `tickOnce` `ticks` раз). Без замера
   * времени (D-006). `ticks < 0` → throw; `ticks === 0` — ничего не делает.
   */
  run(world: SimWorld, ticks: number): void;
}

/**
 * true, если система `system` должна исполниться на тике `tick`.
 * Условие (D-009/расписание): `(tick - phase) % every === 0` И `tick >= phase`,
 * где `phase = schedule.phase ?? 0`. `every`/`phase` только из `schedule`
 * (закон №7). `every >= 1` и `phase >= 0` гарантированы валидацией в `register`.
 */
function isDue(system: System, tick: Tick): boolean {
  const phase = system.schedule.phase ?? 0;
  if (tick < phase) return false;
  return (tick - phase) % system.schedule.every === 0;
}

/**
 * Собирает контекст для одного запуска системы (D-009). `rng` форкается с
 * меткой `${name}@${tick}`, поэтому различается по тикам, оставаясь
 * детерминированным. `bus` — шина мира; `world`/`tick` — состояние и его номер.
 */
function buildCtx(world: SimWorld, system: System, tick: Tick): SystemCtx {
  return {
    world,
    bus: world.bus,
    rng: world.rng.fork(`${system.name}@${tick}`),
    tick,
  };
}

/** Создаёт пустой планировщик. */
export function createScheduler(): Scheduler {
  // Порядок в массиве = порядок исполнения (закон №8): никаких Map/Set в самом
  // цикле, чтобы не зависеть от порядка итерации ключей.
  const registered: System[] = [];
  // Индекс имён для O(1)-проверки уникальности (D-009): имя = метка форка rng
  // `${name}@${tick}`; два одноимённых системы получили бы ИДЕНТИЧНЫЙ ctx.rng
  // (скрытая коллизия физиологии) и исполнились бы дважды. Только контроль
  // дублей — на порядок исполнения не влияет (итерируем registered, не Set).
  const names = new Set<System['name']>();

  // tickOnce объявлен как замыкание (а не метод через `this`), чтобы `run` мог
  // звать его напрямую — устойчиво к деструктуризации `const { run } = sched`.
  const tickOnce = (world: SimWorld): void => {
    const tick = world.tick;
    // Фаза 1–2: due-системы в порядке регистрации, каждой — свежий ctx.
    // АТОМАРНОСТЬ ТИКА: если любая система бросит, откатываем буфер событий
    // (discardTick) и пробрасываем исключение, НЕ вызывая endTick и НЕ двигая
    // world.tick. Тик либо целиком зафиксирован, либо не оставил следа — иначе
    // недокоммиченные события повисли бы в буфере и при повторе tickOnce
    // закоммитились бы дважды (дубль в append-only логе, нарушение №8/№3).
    try {
      for (let i = 0; i < registered.length; i++) {
        const system = registered[i] as System;
        if (!isDue(system, tick)) continue;
        system.update(buildCtx(world, system, tick));
      }
    } catch (err) {
      // Откат буфера текущего тика: eventSeq не откатывается (id сгорают —
      // допустимо, C-4), лог не тронут, world.tick прежний. Повтор безопасен.
      world.bus.discardTick();
      throw err;
    }
    // Фаза 3: фиксируем события тика (D-005). endTick сверит, что все события
    // буфера имеют tick === текущему; иначе бросит (рассинхрон планировщика).
    world.bus.endTick(tick);
    // Фаза 4: продвигаем время ровно на 1.
    world.tick = tick + 1;
  };

  return {
    register(system: System): void {
      // Имя — метка форка rng `${name}@${tick}` (D-009) и должно быть уникально:
      // дубль дал бы двум системам ИДЕНТИЧНЫЙ ctx.rng (коллизия физиологии) плюс
      // двойное исполнение. Пустое имя запрещаем — бессмысленная метка форка.
      if (system.name === '') {
        throw new RangeError('Scheduler.register: пустое имя системы запрещено.');
      }
      if (names.has(system.name)) {
        throw new RangeError(
          `Scheduler.register: система с именем "${system.name}" уже ` +
            `зарегистрирована; имена должны быть уникальны (метка rng.fork, D-009).`,
        );
      }
      const { every, phase } = system.schedule;
      // every < 1 (0, -1, дробное < 1) недопустимо: `% every` при 0 даёт NaN
      // (NaN === 0 → false, система молча никогда не сработала бы), а
      // отрицательный период не имеет смысла. Явный throw ловит ошибку сборки
      // расписания на регистрации, а не тихо.
      if (!Number.isInteger(every) || every < 1) {
        throw new RangeError(
          `Scheduler.register: система "${system.name}" имеет every=${every}; ` +
            `требуется целое every >= 1.`,
        );
      }
      // phase по умолчанию 0; если задана — обязана быть целой и неотрицательной.
      // Отрицательная фаза сдвинула бы условие `tick >= phase` и дала бы запуск
      // на «отрицательных» тиках (зафиксированное поведение: запрещаем).
      if (phase !== undefined && (!Number.isInteger(phase) || phase < 0)) {
        throw new RangeError(
          `Scheduler.register: система "${system.name}" имеет phase=${phase}; ` +
            `требуется целое phase >= 0.`,
        );
      }
      names.add(system.name);
      registered.push(system);
    },

    systems(): readonly System[] {
      // Копия: внешний код не должен переставлять/удалять зарегистрированные
      // системы (это изменило бы порядок исполнения и, следовательно, историю).
      return registered.slice();
    },

    tickOnce,

    run(world: SimWorld, ticks: number): void {
      if (!Number.isInteger(ticks) || ticks < 0) {
        throw new RangeError(
          `Scheduler.run: ticks=${ticks}; требуется целое ticks >= 0.`,
        );
      }
      // Ровно `ticks` вызовов tickOnce. Никакого performance.now/Date.now,
      // никаких пауз/адаптивности (D-006, закон №8).
      for (let i = 0; i < ticks; i++) {
        tickOnce(world);
      }
    },
  };
}
