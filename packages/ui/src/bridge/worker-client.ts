/**
 * @module @zona/ui/bridge/worker-client
 *
 * ТИПИЗИРОВАННАЯ ОБЁРТКА над Web Worker'ом симуляции (задача 4.0, D-077). Прячет сырой
 * `new Worker(...)` + `postMessage` + `onmessage` за узким API: `post(UiToWorker)` шлёт
 * команду, а входящие `WorkerToUi` приходят в переданный обработчик. Так стор/панели не
 * знают о транспорте — только о контракте `@zona/shared/worker-protocol`.
 *
 * ── ЗАКОН №5 / D-077 (граница postMessage) ───────────────────────────────────
 * Через границу ходят ТОЛЬКО plain-сообщения протокола (`UiToWorker`/`WorkerToUi`).
 * Клиент НЕ импортирует `@zona/sim` — ядро живёт ИСКЛЮЧИТЕЛЬНО внутри воркера; UI-поток
 * видит лишь plain-виды/дельты (bitecs сюда не течёт).
 *
 * ── ЗАКОН №8 (детерминизм) ───────────────────────────────────────────────────
 * Все команды (`init`/`setSpeed`/`step`/`inspect`/`requestSnapshot`) влияют лишь на
 * ТЕМП/паузу/шаг/инспекцию — не на содержимое тиков. Клиент — тонкий транспорт, логики
 * симуляции не несёт.
 *
 * ── Инстанцирование воркера (Vite) ───────────────────────────────────────────
 * `new Worker(new URL('../worker/sim-worker.ts', import.meta.url), { type: 'module' })`
 * — канонический паттерн Vite для ES-module-воркеров: бандлер сам соберёт граф воркера
 * (включая `@zona/sim`) отдельным чанком. Создаётся ТОЛЬКО в рантайме браузера (main.tsx
 * → store.init); в jsdom-тестах воркер не создаётся (стор тестируется на фиксированных
 * данных без живого моста — DoD 4.0).
 */

import type { UiToWorker, WorkerToUi } from '@zona/shared';

/** Обработчик входящих сообщений воркера. */
export type WorkerMessageHandler = (msg: WorkerToUi) => void;

/** Узкий клиент моста: отправка команд + завершение воркера. */
export interface WorkerClient {
  /** Отправить команду воркеру (plain, D-077). */
  post(msg: UiToWorker): void;
  /** Остановить воркер и освободить ресурсы. */
  terminate(): void;
}

/**
 * Создать клиент над НОВЫМ воркером симуляции. `onMessage` вызывается на каждое
 * входящее `WorkerToUi` (стор применяет его к состоянию). Воркер — ES-module (Vite
 * соберёт граф, включая `@zona/sim`).
 */
export function createWorkerClient(onMessage: WorkerMessageHandler): WorkerClient {
  const worker = new Worker(new URL('../worker/sim-worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (ev: MessageEvent<WorkerToUi>) => onMessage(ev.data);

  return {
    post(msg: UiToWorker): void {
      worker.postMessage(msg);
    },
    terminate(): void {
      worker.terminate();
    },
  };
}
