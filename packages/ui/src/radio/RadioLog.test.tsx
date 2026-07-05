// @vitest-environment jsdom
/**
 * @module @zona/ui/radio/RadioLog.test
 *
 * jsdom-тесты ПАНЕЛИ ЭФИРА (задача 4.3, D-069/D-081). Читается как «наблюдатель у рации»:
 * из окна лога стора всплывают реплики сталкеров, слухи помечены «непроверено», клик по
 * имени зовёт инспектора, а лента ведёт себя вежливо при чтении прошлого. Под прицелом:
 *  - ИНТЕГРАЦИЯ renderMessage (3.4): `radio/message` с известными именами → строка
 *    `[День N, ЧЧ:ММ] Имя: текст` (имя из name-map D-081, локация из getLocation).
 *  - СЛУХ (`radio/relayed`/isFirsthand=false) визуально помечен (курсив/приглушён).
 *  - ФИЛЬТР по типу (сообщения/слухи) прячет соответствующие строки.
 *  - Клик по ИМЕНИ → store.inspect(speakerEid) с верным eid (D-076).
 *  - УМНЫЙ АВТОСКРОЛЛ: прокрутил вверх → лента не дёргается, всплывает кнопка «вниз».
 *  - ПУСТОЙ лог → панель без падения; ОКНО рендера не рисует весь огромный лог.
 *
 * Живой воркер НЕ поднимается: состояние стора выставляется напрямую (setState), как в
 * store.test/App.layout.test. renderMessage/getLocation — публичное чтение @zona/sim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { EntityId, EntityName, LocationId, SimEvent, Tick } from '@zona/shared';
import RadioLog, { buildRows, timeLabel, makeNameOf } from './RadioLog';
import { useUiStore } from '../store/store';

/** Радио-сообщение (личная озвучка) для лога. */
function msg(
  id: number,
  over: {
    tick?: number;
    speakerEid?: number;
    templateId?: string;
    params?: Record<string, unknown>;
  } = {},
): SimEvent {
  return {
    id: id as never,
    tick: (over.tick ?? 2) as Tick,
    type: 'radio/message',
    causedBy: null,
    payload: {
      speakerEid: (over.speakerEid ?? 5) as EntityId,
      subjects: [],
      loc: 1 as LocationId,
      templateId: over.templateId ?? 'entity/died|neutral|0',
      params: over.params ?? { subject: 7, loc: 1 },
      isFirsthand: true,
    },
  } as SimEvent;
}

/** Слух (ретрансляция) для лога. */
function relayed(id: number, over: { tick?: number; speakerEid?: number } = {}): SimEvent {
  return {
    id: id as never,
    tick: (over.tick ?? 3) as Tick,
    type: 'radio/relayed',
    causedBy: 1 as never,
    payload: {
      speakerEid: (over.speakerEid ?? 6) as EntityId,
      subjects: [],
      loc: 1 as LocationId,
      sourceMessageId: 1 as never,
      hop: 1,
      templateId: 'entity/died|neutral|0',
      params: { subject: 7, loc: 1 },
      isFirsthand: false,
    },
  } as SimEvent;
}

const NAMES: Record<number, EntityName> = {
  5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' },
  6: { first: 'Пётр', last: 'Волков', nickname: '' },
  7: { first: 'Иван', last: 'Сорока', nickname: 'Сорока' },
};

/** Иное (не радио) событие — панель обязана его игнорировать. */
function noise(id: number): SimEvent {
  return { id: id as never, tick: 1 as Tick, type: 'sim/tickStarted', causedBy: null, payload: { tick: 1 as Tick } } as SimEvent;
}

function setStore(log: SimEvent[], names: Record<number, EntityName> = NAMES): void {
  useUiStore.setState({ log, names, view: null, detail: null, selectedEid: null });
}

beforeEach(() => {
  setStore([]);
});
afterEach(() => {
  cleanup();
  useUiStore.setState({ log: [], names: {}, selectedEid: null });
});

// ── Чистая сборка строк (без DOM) ─────────────────────────────────────────────
describe('buildRows — сборка строк эфира (чистая, интеграция renderMessage/имён)', () => {
  it('radio/message с известными именами → строка «Лис» + резолв субъекта/локации', () => {
    const rows = buildRows([msg(1, { tick: 2 })], NAMES, { showFirsthand: true, showRumors: true });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.time).toBe('День 0, 00:02'); // tick 2 → день 0, 00:02
    expect(r.speaker).toBe('Лис'); // кличка приоритетнее имени-фамилии
    expect(r.rumor).toBe(false);
    // Текст собран из шаблона entity/died|neutral|0 = "{subject} погиб. {loc}."
    expect(r.text).toBe('Сорока погиб. Свалка.'); // subject 7 → «Сорока», loc 1 → «Свалка»
  });

  it('говорящий без клички → «Имя Фамилия»; неизвестный eid → «#eid»', () => {
    const rows = buildRows([msg(1, { speakerEid: 6 })], NAMES, { showFirsthand: true, showRumors: true });
    expect(rows[0]!.speaker).toBe('Пётр Волков');
    const unknown = buildRows([msg(2, { speakerEid: 999 })], NAMES, { showFirsthand: true, showRumors: true });
    expect(unknown[0]!.speaker).toBe('#999');
  });

  it('radio/relayed помечен слухом (rumor=true); не-радио события игнорируются', () => {
    const rows = buildRows([noise(1), relayed(2), msg(3)], NAMES, { showFirsthand: true, showRumors: true });
    expect(rows.map((r) => r.id)).toEqual([2, 3]); // noise отфильтрован
    expect(rows.find((r) => r.id === 2)!.rumor).toBe(true);
    expect(rows.find((r) => r.id === 3)!.rumor).toBe(false);
  });

  it('фильтр по типу: только слухи / только сообщения', () => {
    const log = [msg(1), relayed(2)];
    expect(buildRows(log, NAMES, { showFirsthand: false, showRumors: true }).map((r) => r.id)).toEqual([2]);
    expect(buildRows(log, NAMES, { showFirsthand: true, showRumors: false }).map((r) => r.id)).toEqual([1]);
    expect(buildRows(log, NAMES, { showFirsthand: false, showRumors: false })).toEqual([]);
  });

  it('окно рендера: из 250 радио-строк остаются последние 200 (лог огромен)', () => {
    const log: SimEvent[] = [];
    for (let i = 1; i <= 250; i++) log.push(msg(i));
    const rows = buildRows(log, NAMES, { showFirsthand: true, showRumors: true });
    expect(rows).toHaveLength(200);
    expect(rows[0]!.id).toBe(51); // 1..50 вытеснены окном
    expect(rows.at(-1)!.id).toBe(250);
  });
});

describe('timeLabel / makeNameOf — чистые хелперы', () => {
  it('timeLabel: тик → «День N, ЧЧ:ММ»', () => {
    expect(timeLabel(0)).toBe('День 0, 00:00');
    expect(timeLabel(1502)).toBe('День 1, 01:02'); // 1440 + 62 мин
  });
  it('makeNameOf: строка пробрасывается как есть', () => {
    const nameOf = makeNameOf(NAMES);
    expect(nameOf('банда')).toBe('банда');
    expect(nameOf(5)).toBe('Лис');
  });
});

// ── DOM: рендер, слух, фильтр, клик, пустота ─────────────────────────────────
describe('RadioLog — рендер панели (DOM)', () => {
  it('пустой лог → «тишина в эфире», без падения и без строк', () => {
    setStore([]);
    render(<RadioLog />);
    expect(screen.getByText(/тишина в эфире/)).toBeTruthy();
    expect(screen.queryAllByTestId('radio-row')).toHaveLength(0);
  });

  it('строка эфира выводит время, имя и текст; слух помечен курсивом', () => {
    setStore([msg(1, { tick: 2 }), relayed(2, { tick: 3 })]);
    render(<RadioLog />);
    const rows = screen.getAllByTestId('radio-row');
    expect(rows).toHaveLength(2);
    // Первая — личное сообщение (не слух), несёт имя и время.
    expect(within(rows[0]!).getByTestId('radio-speaker').textContent).toBe('Лис');
    expect(rows[0]!.textContent).toContain('[День 0, 00:02]');
    expect(rows[0]!.getAttribute('data-rumor')).toBe('0');
    // Вторая — слух: помечен data-rumor + курсив.
    expect(rows[1]!.getAttribute('data-rumor')).toBe('1');
    expect(rows[1]!.style.fontStyle).toBe('italic');
    expect(rows[1]!.textContent).toContain('(слух)');
  });

  it('чекбокс «слухи» прячет ретрансляции; «сообщения» — личные реплики', () => {
    setStore([msg(1), relayed(2)]);
    render(<RadioLog />);
    expect(screen.getAllByTestId('radio-row')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('radio-filter-rumors')); // снять слухи
    let rows = screen.getAllByTestId('radio-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-rumor')).toBe('0');

    fireEvent.click(screen.getByTestId('radio-filter-rumors')); // вернуть
    fireEvent.click(screen.getByTestId('radio-filter-firsthand')); // снять сообщения
    rows = screen.getAllByTestId('radio-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-rumor')).toBe('1');
  });

  it('клик по имени говорящего → store.inspect(speakerEid) с верным eid', () => {
    setStore([msg(1, { speakerEid: 5 })]);
    render(<RadioLog />);
    expect(useUiStore.getState().selectedEid).toBeNull();
    fireEvent.click(screen.getByTestId('radio-speaker'));
    // inspect выделяет eid в сторе (команда воркеру — no-op без моста, но выбор виден).
    expect(useUiStore.getState().selectedEid).toBe(5);
  });
});

// ── Умный автоскролл ──────────────────────────────────────────────────────────
describe('RadioLog — умный автоскролл (прокрутил вверх → не дёргаем)', () => {
  /**
   * Придать элементу «геометрию» прокрутки (jsdom не раскладывает и глотает scrollTop):
   * scrollHeight/clientHeight — фиксированы, scrollTop — реальное читаемо-пишемое поле.
   */
  function fakeGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }

  it('при прокрутке вверх новая строка НЕ прокручивает ленту вниз и показывает кнопку «вниз»', () => {
    setStore([msg(1)]);
    render(<RadioLog />);
    const box = screen.getByTestId('radio-scroll');
    fakeGeometry(box, 1000, 100);

    // Пользователь ушёл вверх (далеко от низа).
    box.scrollTop = 0;
    fireEvent.scroll(box);
    expect(screen.getByTestId('radio-jump')).toBeTruthy(); // кнопка возврата всплыла

    // Пришла новая реплика — лента не должна дёрнуться к низу.
    setStore([msg(1), msg(2, { tick: 4 })]);
    expect(box.scrollTop).toBe(0);
    expect(screen.getByTestId('radio-jump')).toBeTruthy();
  });

  it('кнопка «вниз» возвращает к низу и снимает себя', () => {
    setStore([msg(1)]);
    render(<RadioLog />);
    const box = screen.getByTestId('radio-scroll');
    fakeGeometry(box, 1000, 100);

    box.scrollTop = 0;
    fireEvent.scroll(box);
    const jump = screen.getByTestId('radio-jump');
    fireEvent.click(jump);
    expect(box.scrollTop).toBe(1000); // прыгнули к низу (scrollHeight)
    expect(screen.queryByTestId('radio-jump')).toBeNull(); // кнопка убралась
  });
});
