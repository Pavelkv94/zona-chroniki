// @vitest-environment node
/**
 * @module @zona/ui/worker/sim-worker.names-delta.test
 *
 * ИНТЕГРАЦИОННЫЙ гейт ДЕЛЬТЫ ИМЁН реального воркера (задача 4.3, D-081). До сих пор
 * курсор `sentNameSig` sim-worker.ts был непокрыт: store.test проверял МЕРЖ в сторе,
 * names-4.3.test — сам `exportNames`, но «воркер шлёт РОВНО прибавку, а не весь map
 * каждый кадр» и «init СБРАСЫВАЕТ курсор» держались только на чтении кода. Здесь гоняем
 * НАСТОЯЩИЙ модуль воркера с поддельным `self`, ловим `postMessage` и доказываем:
 *  - INIT шлёт ОДНО сообщение `names` с ПОЛНЫМ набором имён мира (курсор пуст).
 *  - STEP НЕ пересылает уже отправленные имена: любой последующий `names` несёт ТОЛЬКО
 *    НОВЫЕ eid (курсор работает) — а не весь индекс заново (иначе трафик рос бы линейно).
 *  - Повторный INIT ОБНУЛЯЕТ курсор ⇒ снова полный набор (тот же seed → тот же набор).
 *
 * Мир крутится headless В ПРОЦЕССЕ (тот же конвейер, что CLI): `self`/`setInterval`
 * подделаны, чтобы (а) модуль вообще импортировался в node, (б) кадровый таймер не тикал
 * фоном во время теста (тики двигаем ЯВНО командой `step`). Закон №8: content тиков не
 * трогаем — только наблюдаем, что и как воркер выкладывает на границу postMessage.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { EntityName, Seed, UiToWorker, WorkerToUi } from '@zona/shared';

type NamesMsg = Extract<WorkerToUi, { type: 'names' }>;

const posted: WorkerToUi[] = [];
let listener: ((ev: { readonly data: UiToWorker }) => void) | null = null;

/** Прогнать команду через воркер и вернуть сообщения, выложенные ИМ на postMessage. */
function send(cmd: UiToWorker): WorkerToUi[] {
  posted.length = 0;
  listener!({ data: cmd });
  return [...posted];
}

/** Сообщения `names` из пачки. */
function namesOf(msgs: WorkerToUi[]): NamesMsg[] {
  return msgs.filter((m): m is NamesMsg => m.type === 'names');
}

const SEED = 42 as unknown as Seed;

beforeAll(async () => {
  // Поддельная область воркера ДО импорта: модуль на верхнем уровне читает `self` и вешает
  // слушателя message. В node без этого `self` не определён (ReferenceError на импорте).
  const fakeSelf = {
    postMessage: (m: WorkerToUi): void => {
      posted.push(m);
    },
    addEventListener: (_type: 'message', l: (ev: { readonly data: UiToWorker }) => void): void => {
      listener = l;
    },
  };
  vi.stubGlobal('self', fakeSelf);
  // Кадровый таймер воркера не должен тикать фоном — тики двигаем явным `step`.
  vi.stubGlobal('setInterval', () => 0 as unknown as ReturnType<typeof setInterval>);
  await import('./sim-worker');
  expect(listener, 'воркер обязан подписаться на message при загрузке').not.toBeNull();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('sim-worker: дельта имён — курсор шлёт РОВНО прибавку (D-081)', () => {
  it('init → один names с полным набором; step НИКОГДА не пересылает известное имя', () => {
    const initMsgs = send({ type: 'init', seed: SEED });
    const initNames = namesOf(initMsgs);
    expect(initNames, 'init обязан выложить ровно одно сообщение names').toHaveLength(1);

    const full: Readonly<Record<number, EntityName>> = initNames[0]!.names;
    const known = new Set(Object.keys(full));
    expect(known.size, 'полный набор имён не должен быть пуст').toBeGreaterThan(0);

    // Двигаем мир ЯВНО и следим: воркер не смеет переслать уже отправленный eid.
    for (let k = 0; k < 6; k++) {
      const stepMsgs = send({ type: 'step', ticks: 240 });
      for (const nm of namesOf(stepMsgs)) {
        for (const key of Object.keys(nm.names)) {
          expect(
            known.has(key),
            `воркер повторно прислал имя eid ${key} — курсор сломан (шлёт не дельту, а весь map)`,
          ).toBe(false);
          known.add(key); // новоприбывший — теперь известен
        }
      }
    }
  });

  it('повторный init СБРАСЫВАЕТ курсор → снова полный набор (тот же seed → тот же набор ключей)', () => {
    const first = namesOf(send({ type: 'init', seed: SEED }));
    expect(first).toHaveLength(1);
    const firstKeys = Object.keys(first[0]!.names).sort();
    expect(firstKeys.length).toBeGreaterThan(0);

    // Второй init на том же seed: если бы курсор НЕ чистился, дельта была бы пуста (0
    // сообщений names). Он чистится ⇒ снова полный набор, тождественный первому.
    const second = namesOf(send({ type: 'init', seed: SEED }));
    expect(second, 'повторный init обязан заново выложить полный набор имён').toHaveLength(1);
    expect(Object.keys(second[0]!.names).sort()).toEqual(firstKeys);
  });
});
