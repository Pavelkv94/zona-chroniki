/**
 * @module @zona/ui/worker/sim-worker
 *
 * WEB WORKER, крутящий headless-`@zona/sim` вне UI-потока (задача 4.0, D-077/D-078).
 * ЕДИНСТВЕННОЕ место, где `@zona/ui` импортирует ядро симуляции: воркер собирает ОДИН
 * мир, продвигает его в реальном времени по темпу наблюдателя и шлёт наружу plain-виды/
 * дельты через `postMessage`. UI-поток НИКОГДА не блокируется симуляцией (GDD §13.1).
 *
 * ── ⚠ РОВНО ОДИН МИР НА ВОРКЕР (заметка 4.1) ─────────────────────────────────
 * SoA-колонки компонентов bitecs ГЛОБАЛЬНЫ НА ПРОЦЕСС (модульные синглтоны реестра).
 * Два `SimWorld` в одном воркере ЗАТЁРЛИ БЫ данные друг друга (общие колонки). Поэтому
 * воркер держит РОВНО ОДИН активный мир: `init` заменяет предыдущий целиком (новый
 * `createSimWorld` от seed ИЛИ `deserialize(snapshot)`). Нужна вторая симуляция —
 * второй воркер (второй процесс/поток → своя копия глобальных колонок).
 *
 * ── ЗАКОН №5 (граница postMessage, D-077) ────────────────────────────────────
 * `@zona/sim` (headless) импортируется ВНУТРИ воркера и гоняется здесь; НАРУЖУ едут
 * только plain-формы `@zona/shared` (`exportWorldView`/`exportEntityDetail`/`serialize`
 * → `WorkerToUi`). НИ ОДИН bitecs-тип не пересекает `postMessage`. `@zona/ui` (React) в
 * воркер не импортируется — воркер headless-совместим по духу (только sim + DOM Worker API).
 *
 * ── ЗАКОН №8 (детерминизм): реальное время → ТЕМП, не содержимое ──────────────
 * `performance.now` здесь — ДРАЙВЕР ТЕМПА (сколько тиков продвинуть за реальный кадр),
 * как замер `ms` в headless-CLI (D-006): он решает КОЛИЧЕСТВО тиков, но НЕ содержимое
 * каждого — каждый тик считает тот же seeded-конвейер `registerPhase3Systems`. «Тот же
 * seed + тот же номер тика → тот же хэш» держится независимо от того, как быстро/рвано
 * наблюдатель прокрутил время (пауза/×600/шаг). Внутри тика ни `Date.now`, ни
 * `performance.now` не участвуют (закон №8 — это в `@zona/sim`, не тронут).
 *
 * ── D-078 (дельты + throttle) ────────────────────────────────────────────────
 * Мир может идти на сотни тиков/сек (×600), но UI обновляется с THROTTLE `SEND_HZ`
 * (~15 Гц): раз в кадр воркер экспортирует `WorldView`, шлёт `viewDelta` (только
 * изменения, `diffView`) + `logDelta` (новые события лога) + периодически `stats`.
 * Первый снимок после init — полный `view`; дальше — дельты.
 */

import {
  createSimWorld,
  createScheduler,
  registerPhase3Systems,
  worldgen,
  serialize,
  deserialize,
  exportWorldView,
  exportEntityDetail,
  type SimWorld,
  type Scheduler,
} from '@zona/sim';
import type {
  EntityId,
  Seed,
  UiToWorker,
  WorkerToUi,
  WorldView,
} from '@zona/shared';
import { diffView } from '../bridge/delta';

/**
 * Минимальный тип области видимости dedicated-воркера. Объявлен ЛОКАЛЬНО (а не через
 * `lib: webworker`), чтобы не конфликтовать с `lib: DOM` пакета `@zona/ui` (обе
 * библиотеки определяют `self`/`postMessage`). Рантайм-поведение обеспечивает Vite,
 * который бандлит этот файл как модуль-воркер.
 */
interface WorkerScope {
  postMessage(message: WorkerToUi): void;
  addEventListener(
    type: 'message',
    listener: (ev: { readonly data: UiToWorker }) => void,
  ): void;
}
const ctx = self as unknown as WorkerScope;

/** Частота отправки обновлений в UI (throttle, D-078): ~15 Гц. */
const SEND_HZ = 15;
/** Интервал кадра воркера в мс (пейсинг темпа + троттлинг отправки). */
const FRAME_MS = 1000 / SEND_HZ;
/**
 * Верхний предел тиков за ОДИН кадр (предохранитель темпа). При ×600 и подвисании
 * кадра аккумулятор не должен заставить воркер прогнать десятки тысяч тиков разом
 * (заморозило бы воркер). Кадры «проскальзывают» — это UI-пейсинг, не содержимое
 * симуляции (закон №8 цел: пропущенные тики просто досчитаются позже/шагом).
 */
const MAX_TICKS_PER_FRAME = 2000;
/** Как часто (в кадрах) слать `stats` (~раз в секунду при 15 Гц). */
const STATS_EVERY_FRAMES = SEND_HZ;

/** Активная симуляция воркера (РОВНО ОДНА, см. docblock). */
interface Sim {
  readonly world: SimWorld;
  readonly scheduler: Scheduler;
  readonly seed: Seed;
}

let sim: Sim | null = null;
/** Темп: sim-тиков за реальную секунду. `0` — пауза. */
let ticksPerRealSecond = 0;
/** Дробный остаток тиков между кадрами (аккумулятор пейсинга). */
let tickAccumulator = 0;
/** Прошлый снимок, к которому вычисляется дельта (D-078). `null` ⇒ шлём полный `view`. */
let lastSentView: WorldView | null = null;
/** Длина лога, до которой события уже отправлены наблюдателю (курсор `logDelta`). */
let sentLogLen = 0;
/** Счётчик кадров (для периодического `stats`). */
let frameCount = 0;
/** Метка времени прошлого кадра пейсинга (`performance.now`, драйвер ТЕМПА). */
let lastFrameTime = 0;
/** Хэндл интервала кадра (единственный таймер воркера). */
let frameTimer: ReturnType<typeof setInterval> | null = null;

/** Собрать ЖИВОЙ мир Фазы 3 (тот же конвейер, что headless-CLI). */
function buildFreshWorld(seed: Seed): Sim {
  const world = createSimWorld(seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase3Systems(scheduler);
  return { world, scheduler, seed };
}

/** Восстановить мир из снапшота (resume); планировщик собирается заново (stateless). */
function buildFromSnapshot(seed: Seed, snapshotJson: Parameters<typeof deserialize>[0]): Sim {
  const world = deserialize(snapshotJson);
  const scheduler = createScheduler();
  registerPhase3Systems(scheduler);
  return { world, scheduler, seed };
}

/**
 * Экспортировать текущий мир и отправить наблюдателю: первый снимок — полный `view`,
 * далее — `viewDelta` (D-078). Затем `logDelta` (новые события лога с прошлой отправки).
 * `measuredMs` — время продвижения тиков этого кадра (для `stats`), 0 если тиков не было.
 */
function pushUpdate(current: Sim, measuredMs: number, forceStats: boolean): void {
  const view = exportWorldView(current.world);

  if (lastSentView === null) {
    ctx.postMessage({ type: 'view', view });
  } else {
    const delta = diffView(lastSentView, view);
    // Пустая дельта (ничего не изменилось и часы совпали) — не шлём мусор.
    const clockSame =
      delta.tick === lastSentView.tick && delta.weather === lastSentView.weather;
    if (delta.changed.length > 0 || delta.removed.length > 0 || !clockSame) {
      ctx.postMessage({
        type: 'viewDelta',
        tick: delta.tick,
        day: delta.day,
        weather: delta.weather,
        changed: delta.changed,
        removed: delta.removed,
      });
    }
  }
  lastSentView = view;

  // logDelta: новые события append-only лога (курсор sentLogLen). Лог упорядочен по
  // EventId; хвост от sentLogLen — ровно новые события (закон №8 — порядок сохранён).
  const log = current.world.bus.log;
  if (log.length > sentLogLen) {
    ctx.postMessage({ type: 'logDelta', events: log.slice(sentLogLen) });
    sentLogLen = log.length;
  }

  frameCount++;
  if (forceStats || frameCount % STATS_EVERY_FRAMES === 0) {
    ctx.postMessage({
      type: 'stats',
      tick: current.world.tick,
      entityCount: view.entities.length,
      tickMs: measuredMs,
    });
  }
}

/**
 * Кадр пейсинга (не чаще `SEND_HZ`): по прошедшему реальному времени и темпу
 * `ticksPerRealSecond` вычислить, сколько тиков продвинуть, прогнать их и отправить
 * обновление. На паузе (`ticksPerRealSecond === 0`) тики не двигаются — обновление не
 * шлётся (кроме первого полного `view`, который отправлен на init).
 */
function frame(): void {
  const current = sim;
  if (current === null) return;

  const now = performance.now();
  const dtSeconds = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  if (ticksPerRealSecond <= 0) {
    // Пауза: аккумулятор не растёт, тики не идут.
    tickAccumulator = 0;
    return;
  }

  tickAccumulator += dtSeconds * ticksPerRealSecond;
  let ticks = Math.floor(tickAccumulator);
  if (ticks <= 0) return;
  tickAccumulator -= ticks;
  if (ticks > MAX_TICKS_PER_FRAME) ticks = MAX_TICKS_PER_FRAME;

  const start = performance.now();
  current.scheduler.run(current.world, ticks);
  const measuredMs = performance.now() - start;

  pushUpdate(current, measuredMs, false);
}

/** Запустить кадровый таймер (если ещё не запущен). */
function ensureFrameTimer(): void {
  if (frameTimer !== null) return;
  lastFrameTime = performance.now();
  frameTimer = setInterval(frame, FRAME_MS);
}

/** Обработка команды наблюдателя (UiToWorker). */
function handleCommand(msg: UiToWorker): void {
  switch (msg.type) {
    case 'init': {
      // Заменяем мир ЦЕЛИКОМ (ровно один мир на воркер). Сброс курсоров отправки.
      sim = msg.snapshot ? buildFromSnapshot(msg.seed, msg.snapshot) : buildFreshWorld(msg.seed);
      ticksPerRealSecond = 0; // старт на паузе — наблюдатель сам задаёт темп
      tickAccumulator = 0;
      lastSentView = null; // первый push будет полным `view`
      // Resume: не заливаем всю историю лога как «новые» — курсор в конец текущего лога.
      sentLogLen = sim.world.bus.log.length;
      frameCount = 0;
      // Немедленный полный снимок мира после сборки/восстановления.
      pushUpdate(sim, 0, true);
      ensureFrameTimer();
      return;
    }
    case 'setSpeed': {
      ticksPerRealSecond = msg.ticksPerRealSecond > 0 ? msg.ticksPerRealSecond : 0;
      // Сбрасываем аккумулятор и метку времени: смена темпа не должна «выстрелить»
      // накопленными за паузу тиками разом.
      tickAccumulator = 0;
      lastFrameTime = performance.now();
      return;
    }
    case 'step': {
      const current = sim;
      if (current === null || msg.ticks <= 0) return;
      const ticks = Math.min(Math.floor(msg.ticks), MAX_TICKS_PER_FRAME);
      const start = performance.now();
      current.scheduler.run(current.world, ticks);
      const measuredMs = performance.now() - start;
      pushUpdate(current, measuredMs, true);
      return;
    }
    case 'inspect': {
      const current = sim;
      if (current === null) return;
      const detail = exportEntityDetail(current.world, msg.eid as EntityId);
      ctx.postMessage({ type: 'detail', detail });
      return;
    }
    case 'requestSnapshot': {
      const current = sim;
      if (current === null) return;
      const data = serialize(current.world);
      ctx.postMessage({ type: 'snapshot', data, seed: current.seed, tick: current.world.tick });
      return;
    }
    default: {
      // Исчерпывающая проверка union'а: неизвестная команда — тип-ошибка на компиляции.
      const _exhaustive: never = msg;
      void _exhaustive;
    }
  }
}

ctx.addEventListener('message', (ev) => handleCommand(ev.data));
