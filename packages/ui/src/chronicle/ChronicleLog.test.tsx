// @vitest-environment jsdom
/**
 * @module @zona/ui/chronicle/ChronicleLog.test
 *
 * jsdom-тесты ПАНЕЛИ ЛЕТОПИСИ (задача 4.4, D-068). Читается как «наблюдатель открыл хронику
 * мира»: строки «День N: <значимое событие>», клик по записи разворачивает причинную цепочку,
 * клик по имени → инспектор. Под прицелом:
 *  - пустой буфер → подсказка (значимых событий не было);
 *  - запись рендерит kind→подпись + subjects (e:→имя, f:→фракция) + loc→имя локации;
 *  - сортировка по дню/тику/id (свежие внизу);
 *  - клик по записи → раскрутка причин (вариант A, по окну лога); обрыв за окном помечен;
 *  - клик по имени субъекта → store.inspect(eid);
 *  - буфер летописи ЧИТАЕТСЯ из стора (chronicleLog), не из общего окна лога;
 *  - высокая значимость → яркая подача (data-significance);
 *  - чистые хелперы (chronicleKindLabel/buildEntries/unrollChainInWindow) — без DOM.
 *
 * Живой воркер НЕ поднимается: состояние стора выставляется напрямую (setState), как в
 * store.test/Inspector.test. getLocation/parseSubject — публичное чтение @zona/sim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { EntityId, EntityName, EventId, LocationId, SimEvent, Subject, Tick } from '@zona/shared';
import ChronicleLog, {
  chronicleKindLabel,
  buildEntries,
  unrollChainInWindow,
  isChronicle,
  CHAIN_TRUNCATED,
} from './ChronicleLog';
import { useUiStore } from '../store/store';

const NAMES: Record<number, EntityName> = {
  5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' },
  7: { first: 'Иван', last: 'Сорока', nickname: '' },
};

/** Летописная запись `chronicle/recorded`. */
function record(
  id: number,
  over: {
    eventId?: number;
    day?: number;
    tick?: number;
    significance?: number;
    kind?: string;
    subjects?: Subject[];
    loc?: number;
  } = {},
): SimEvent {
  const day = over.day ?? 0;
  return {
    id: id as never,
    tick: (over.tick ?? day * 1440 + 1) as Tick,
    type: 'chronicle/recorded',
    causedBy: (over.eventId ?? id - 1) as never,
    payload: {
      eventId: (over.eventId ?? id - 1) as EventId,
      day,
      significance: over.significance ?? 0.8,
      kind: over.kind ?? 'entity/died',
      subjects: over.subjects ?? (['e:5'] as Subject[]),
      ...(over.loc === undefined ? {} : { loc: over.loc as LocationId }),
    },
  } as SimEvent;
}

/** Значимое событие entity/died (первопричина записи) с causedBy на нужду. */
function diedEvent(id: number, causedBy: number | null): SimEvent {
  return {
    id: id as never,
    tick: 2 as Tick,
    type: 'entity/died',
    causedBy: causedBy as never,
    payload: { eid: 5 as EntityId, cause: 'starvation' },
  } as SimEvent;
}

/** Событие критической нужды (корень причинной цепочки). */
function needEvent(id: number): SimEvent {
  return {
    id: id as never,
    tick: 1 as Tick,
    type: 'needs/threshold',
    causedBy: null,
    payload: { eid: 5 as EntityId, need: 'hunger', level: 'critical' },
  } as SimEvent;
}

/** Радио-сообщение (озвучка эфира) — звено, которое цепочка обязана резолвить в ТЕКСТ. */
function radioEvent(id: number, causedBy: number | null): SimEvent {
  return {
    id: id as never,
    tick: 2 as Tick,
    type: 'radio/message',
    causedBy: causedBy as never,
    payload: {
      speakerEid: 5 as EntityId,
      subjects: [],
      loc: 1 as LocationId,
      templateId: 'entity/died|neutral|0',
      params: { subject: 7, loc: 1 },
      isFirsthand: true,
    },
  } as SimEvent;
}

function setStore(chronicleLog: SimEvent[], log: SimEvent[] = [], names = NAMES): void {
  useUiStore.setState({ chronicleLog, log, names, detail: null, selectedEid: null });
}

beforeEach(() => {
  setStore([]);
});
afterEach(() => {
  cleanup();
  useUiStore.setState({ chronicleLog: [], log: [], names: {}, detail: null, selectedEid: null });
});

// ── Чистые хелперы (без DOM) ──────────────────────────────────────────────────
describe('чистые хелперы', () => {
  it('isChronicle: только chronicle/recorded', () => {
    expect(isChronicle(record(1))).toBe(true);
    expect(isChronicle(needEvent(1))).toBe(false);
  });

  it('chronicleKindLabel: тип → подпись; неизвестный → сам код', () => {
    expect(chronicleKindLabel('entity/died')).toBe('гибель');
    expect(chronicleKindLabel('encounter/resolved')).toBe('бой');
    expect(chronicleKindLabel('settlement/abandoned')).toBe('поселение покинуто');
    expect(chronicleKindLabel('unknown/kind')).toBe('unknown/kind');
  });

  it('buildEntries: фильтрует не-летописные и сортирует по дню/тику/id', () => {
    // Намеренно вперемешку: день 2, день 0, день 1 + шум (needEvent не летопись).
    const entries = buildEntries([
      record(30, { day: 2, tick: 2880 }),
      needEvent(99),
      record(10, { day: 0, tick: 5 }),
      record(20, { day: 1, tick: 1500 }),
    ]);
    expect(entries.map((e) => e.id as unknown as number)).toEqual([10, 20, 30]);
  });

  it('unrollChainInWindow: идёт по causedBy назад по окну лога', () => {
    // record.eventId=10 (died) → causedBy 5 (need) → causedBy null (корень).
    const log = [needEvent(5), diedEvent(10, 5)];
    const { ids, truncated } = unrollChainInWindow(10, log);
    expect(ids).toEqual([10, 5]);
    expect(truncated).toBe(false);
  });

  it('unrollChainInWindow: причина вне окна → цепочка оборвана (truncated)', () => {
    // Событие 10 есть, но его причина 5 вытеснена из окна.
    const log = [diedEvent(10, 5)];
    const { ids, truncated } = unrollChainInWindow(10, log);
    expect(ids).toEqual([10]);
    expect(truncated).toBe(true);
  });

  it('unrollChainInWindow: стартовое событие вне окна → пустая цепочка + truncated', () => {
    const { ids, truncated } = unrollChainInWindow(10, []);
    expect(ids).toEqual([]);
    expect(truncated).toBe(true);
  });
});

// ── Рендер ────────────────────────────────────────────────────────────────────
describe('ChronicleLog — рендер', () => {
  it('пустой буфер → подсказка (значимых событий не было)', () => {
    setStore([]);
    render(<ChronicleLog />);
    expect(screen.getByTestId('chronicle-empty')).toBeTruthy();
  });

  it('запись: «День N: <kind> — <subject> · <loc>» с резолвом субъекта и локации', () => {
    setStore([record(2, { day: 3, kind: 'entity/died', subjects: ['e:5'] as Subject[], loc: 0 })]);
    render(<ChronicleLog />);
    const entry = screen.getByTestId('chronicle-entry');
    expect(entry.textContent).toContain('День 3');
    expect(entry.textContent).toContain('гибель'); // kind → подпись
    expect(entry.textContent).toContain('Лис'); // e:5 → кличка
    // loc=0 резолвится в имя локации из контента (не «#0»).
    expect(entry.textContent).not.toContain('#0');
  });

  it('субъект-фракция резолвится в «фракция X»', () => {
    setStore([record(2, { subjects: ['f:bandits'] as Subject[] })]);
    render(<ChronicleLog />);
    expect(screen.getByTestId('chronicle-entry').textContent).toContain('фракция bandits');
  });

  it('сортировка: свежие записи внизу (по дню)', () => {
    setStore([record(30, { day: 2, tick: 2880 }), record(10, { day: 0, tick: 5 })]);
    render(<ChronicleLog />);
    const rows = screen.getAllByTestId('chronicle-entry');
    expect(rows[0]!.textContent).toContain('День 0');
    expect(rows[1]!.textContent).toContain('День 2');
  });

  it('клик по записи → раскрутка причин (цепочка из окна лога)', () => {
    const rec = record(11, { eventId: 10, kind: 'entity/died' });
    const log = [needEvent(5), diedEvent(10, 5)];
    setStore([rec], log);
    render(<ChronicleLog />);
    // До клика цепочки нет.
    expect(screen.queryByTestId('chronicle-chain')).toBeNull();
    fireEvent.click(screen.getByTestId('chronicle-entry'));
    const chain = screen.getByTestId('chronicle-chain');
    // Две строки: гибель ← критическая нужда (EVENT_LABEL из инспектора).
    const rows = screen.getAllByTestId('chronicle-chain-row').map((n) => n.textContent);
    expect(rows.some((t) => t?.includes('гибель'))).toBe(true);
    expect(rows.some((t) => t?.includes('критическая нужда'))).toBe(true);
    expect(chain).toBeTruthy();
    // Повторный клик сворачивает.
    fireEvent.click(screen.getByTestId('chronicle-entry'));
    expect(screen.queryByTestId('chronicle-chain')).toBeNull();
  });

  it('раскрутка причин: обрыв за окном лога помечен', () => {
    const rec = record(11, { eventId: 10 });
    const log = [diedEvent(10, 5)]; // причина 5 вне окна
    setStore([rec], log);
    render(<ChronicleLog />);
    fireEvent.click(screen.getByTestId('chronicle-entry'));
    const marker = screen.getByTestId('chronicle-chain-truncated');
    expect(marker.textContent).toContain(CHAIN_TRUNCATED);
  });

  it('клик по имени субъекта → store.inspect(eid), запись НЕ разворачивается', () => {
    setStore([record(2, { subjects: ['e:7'] as Subject[] })]);
    render(<ChronicleLog />);
    const subj = screen.getByTestId('chronicle-subject');
    expect(subj.getAttribute('data-eid')).toBe('7');
    fireEvent.click(subj);
    expect(useUiStore.getState().selectedEid).toBe(7);
    // stopPropagation: клик по имени не должен раскрыть цепочку причин.
    expect(screen.queryByTestId('chronicle-chain')).toBeNull();
  });

  it('высокая значимость → яркая подача (data-significance=high)', () => {
    setStore([record(2, { significance: 0.9 }), record(3, { significance: 0.1, day: 1 })]);
    render(<ChronicleLog />);
    const rows = screen.getAllByTestId('chronicle-entry');
    expect(rows[0]!.getAttribute('data-significance')).toBe('high'); // sig 0.9
    expect(rows[1]!.getAttribute('data-significance')).toBe('low'); // sig 0.1
  });

  it('летопись читается из буфера chronicleLog, а НЕ из общего окна лога', () => {
    // Запись есть в общем логе, но НЕ в буфере летописи → панель её НЕ показывает.
    setStore([], [record(2, { day: 5 })]);
    render(<ChronicleLog />);
    expect(screen.getByTestId('chronicle-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('chronicle-entry').length).toBe(0);
  });

  it('детерминизм рендера: тот же буфер → идентичная разметка при двух прогонах', () => {
    const buf = [record(2, { day: 1, subjects: ['e:5'] as Subject[], loc: 0 })];
    setStore(buf, [needEvent(5), diedEvent(10, 5)]);
    const first = render(<ChronicleLog />).container.innerHTML;
    cleanup();
    setStore(buf, [needEvent(5), diedEvent(10, 5)]);
    const second = render(<ChronicleLog />).container.innerHTML;
    expect(second).toBe(first);
  });
});

// ── УСИЛЕНИЕ 4.4: инварианты раскрутки причин и сортировки ────────────────────
describe('раскрутка причин — инварианты цепочки (вариант A)', () => {
  it('цикл в causedBy НЕ вешает раскрутку (страж по длине окна ограничивает обход)', () => {
    // Патологический лог: 10←20←10 (взаимные причины) — в реальных логах НЕВОЗМОЖЕН
    // (causedBy.id строго < event.id ⇒ прогресс гарантирован), но гвард обязан защитить.
    // Инвариант: обход ЗАВЕРШАЕТСЯ и длина ограничена окном (`steps < log.length + 1`),
    // а не крутится бесконечно. (truncated тут false — обход упёрся в лимит шагов, не в
    // отсутствие звена; для реального лога без циклов это не проявляется.)
    const a = { ...diedEvent(10, 20) };
    const b = { ...diedEvent(20, 10), id: 20 as never };
    const { ids } = unrollChainInWindow(10, [a, b]);
    expect(ids.length).toBeLessThanOrEqual(3); // ограничено окном, зависания нет
    expect(ids[0]).toBe(10); // старт корректен
  });

  it('цепочка из 3 звеньев доходит до корня (causedBy===null), обрыва нет', () => {
    // record.eventId=30 (died) → 20 (радио) → 5 (нужда, корень null).
    const log = [needEvent(5), radioEvent(20, 5), diedEvent(30, 20)];
    const { ids, truncated } = unrollChainInWindow(30, log);
    expect(ids).toEqual([30, 20, 5]);
    expect(truncated).toBe(false); // достигнут корень — не обрыв
  });

  it('звенья цепочки резолвятся: radio → ТЕКСТ в «…», иное → подпись типа', () => {
    // Значимое событие record.eventId=30 (died) ← радио 20 ← нужда 5 (корень).
    const rec = record(31, { eventId: 30, kind: 'entity/died' });
    const log = [needEvent(5), radioEvent(20, 5), diedEvent(30, 20)];
    setStore([rec], log);
    render(<ChronicleLog />);
    fireEvent.click(screen.getByTestId('chronicle-entry'));
    const rows = screen.getAllByTestId('chronicle-chain-row').map((n) => n.textContent);
    // Радио-звено — человекочитаемый текст в кавычках (renderMessage, D-069), не «radio/message».
    expect(rows.some((t) => t?.includes('«') && t?.includes('»'))).toBe(true);
    expect(rows.some((t) => t?.includes('radio/message'))).toBe(false);
    // Не-радио звенья — подписи типа (гибель / критическая нужда).
    expect(rows.some((t) => t?.includes('гибель'))).toBe(true);
    expect(rows.some((t) => t?.includes('критическая нужда'))).toBe(true);
  });

  it('клик по ДРУГОЙ записи переключает раскрутку (одна открытая цепочка за раз)', () => {
    const recA = record(11, { eventId: 10, day: 0 });
    const recB = record(21, { eventId: 20, day: 1 });
    setStore([recA, recB], [diedEvent(10, null), diedEvent(20, null)]);
    render(<ChronicleLog />);
    const [rowA, rowB] = screen.getAllByTestId('chronicle-entry');
    // Открыли A → её цепочка видна, ровно одна.
    fireEvent.click(rowA!);
    expect(screen.getAllByTestId('chronicle-chain').length).toBe(1);
    expect(rowA!.getAttribute('data-open')).toBe('1');
    // Кликнули B → A сворачивается, открыта B (переключение, не накопление).
    fireEvent.click(rowB!);
    expect(screen.getAllByTestId('chronicle-chain').length).toBe(1);
    expect(rowA!.getAttribute('data-open')).toBe('0');
    expect(rowB!.getAttribute('data-open')).toBe('1');
  });
});

describe('сортировка записей — разрыв ничьих по тику и id', () => {
  it('один день, разные тики → раньше по тику выше', () => {
    const entries = buildEntries([
      record(10, { day: 4, tick: 4400 }),
      record(20, { day: 4, tick: 4100 }),
    ]);
    expect(entries.map((e) => e.id as unknown as number)).toEqual([20, 10]);
  });

  it('один день и тик → стабильный разрыв ничьей по id записи', () => {
    const entries = buildEntries([
      record(30, { day: 4, tick: 4200 }),
      record(15, { day: 4, tick: 4200 }),
    ]);
    expect(entries.map((e) => e.id as unknown as number)).toEqual([15, 30]);
  });
});

describe('порог значимости — граница яркой подачи (0.66)', () => {
  it('ровно 0.66 → high; 0.65 → low', () => {
    setStore([record(2, { significance: 0.66 }), record(3, { significance: 0.65, day: 1 })]);
    render(<ChronicleLog />);
    const rows = screen.getAllByTestId('chronicle-entry');
    expect(rows[0]!.getAttribute('data-significance')).toBe('high'); // ≥ порога
    expect(rows[1]!.getAttribute('data-significance')).toBe('low'); // ниже порога
  });
});

describe('панель — чистый читатель мира (закон №8: рендер не трогает симуляцию)', () => {
  it('рендер летописи НЕ мутирует стор и НЕ дёргает inspect (никаких телепортов данных)', () => {
    const buf = [record(2, { day: 1, subjects: ['e:5'] as Subject[], loc: 0 })];
    setStore(buf, [needEvent(5), diedEvent(10, 5)]);
    const beforeChron = useUiStore.getState().chronicleLog;
    const beforeSel = useUiStore.getState().selectedEid;
    render(<ChronicleLog />);
    // Ссылка буфера та же, выбор не тронут: панель ничего не создала и не выбрала сама.
    expect(useUiStore.getState().chronicleLog).toBe(beforeChron);
    expect(useUiStore.getState().selectedEid).toBe(beforeSel);
    expect(useUiStore.getState().selectedEid).toBeNull();
  });
});
