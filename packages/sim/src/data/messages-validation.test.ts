/**
 * @module @zona/sim/data/messages-validation.test
 *
 * НЕГАТИВНЫЕ гейты загрузчика радио-шаблонов (задача 3.4, D-069, закон №10 fail-fast):
 * доказывают, что `validateMessages` РЕАЛЬНО БРОСАЕТ `DataError` на битом контенте, а
 * не «проходит по недосмотру». Валидатор приватный — подсовываем БИТЫЙ `messages.json`
 * через `vi.doMock` и заново импортируем `./index`: загрузка модуля обязана упасть до
 * старта симуляции (пустой пул / неизвестный плейсхолдер / HTML-тег / нет 'neutral' /
 * пул < 15 не должны молча просочиться в эфир). Каждый кейс изолирован `vi.resetModules`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realMessages from './messages.json';

type MessagesJson = typeof realMessages;

/** Глубокая копия реального контента — мутируем её, не трогая исходный JSON. */
function cloneMessages(): MessagesJson {
  return JSON.parse(JSON.stringify(realMessages)) as MessagesJson;
}

/** Импортирует './index' СВЕЖИМ (после doMock) и ждёт падения валидатора. */
async function expectLoadRejects(re: RegExp): Promise<void> {
  await expect(import('./index')).rejects.toThrow(re);
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock('./messages.json');
  vi.resetModules();
});

describe('messages.json — fail-fast на битом радио-контенте (закон №10/№5, D-069)', () => {
  it('реальный messages.json грузится без ошибок (позитивный контроль)', async () => {
    const mod = await import('./index');
    expect(mod.MESSAGES.templates['entity/died']).toBeDefined();
    expect(mod.MESSAGES.temperaments).toContain('neutral');
  });

  it('пустой пул шаблонов → DataError', async () => {
    const bad = cloneMessages();
    (bad.templates['entity/died'] as Record<string, string[]>).neutral = [];
    vi.doMock('./messages.json', () => ({ default: bad }));
    await expectLoadRejects(/пул пуст/);
  });

  it('неизвестный плейсхолдер {name} → DataError (закон №10)', async () => {
    const bad = cloneMessages();
    (bad.templates['entity/died'] as { neutral: string[] }).neutral[0] = '{name} погиб. {loc}.';
    vi.doMock('./messages.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестный плейсхолдер "\{name\}"/);
  });

  it('HTML-разметка в шаблоне → DataError (закон №5: сообщение = plain-строка)', async () => {
    const bad = cloneMessages();
    (bad.templates['entity/died'] as { neutral: string[] }).neutral[0] = '<b>{subject}</b> погиб.';
    vi.doMock('./messages.json', () => ({ default: bad }));
    await expectLoadRejects(/разметка\/HTML запрещена/);
  });

  it('нет обязательного пула neutral у типа события → DataError', async () => {
    const bad = cloneMessages();
    delete (bad.templates['entity/died'] as Record<string, unknown>).neutral;
    vi.doMock('./messages.json', () => ({ default: bad }));
    await expectLoadRejects(/нет обязательного пула "neutral"/);
  });

  it('пул < 15 шаблонов на тип → DataError (GDD §8.3)', async () => {
    const bad = cloneMessages();
    // Оставляем только один короткий neutral-пул, прочие темпераменты убираем.
    bad.templates['entity/died'] = { neutral: ['{subject} погиб. {loc}.'] } as MessagesJson['templates']['entity/died'];
    vi.doMock('./messages.json', () => ({ default: bad }));
    await expectLoadRejects(/< минимума 15/);
  });

  it('темперамент вне списка temperaments → DataError', async () => {
    const bad = cloneMessages();
    (bad.templates['entity/died'] as Record<string, string[]>).grumpy = ['{subject}. {loc}.'];
    vi.doMock('./messages.json', () => ({ default: bad }));
    await expectLoadRejects(/не объявлен в temperaments/);
  });

  it('temperaments без обязательного neutral → DataError', async () => {
    const bad = cloneMessages();
    (bad as { temperaments: string[] }).temperaments = ['panicky', 'veteran', 'talker'];
    vi.doMock('./messages.json', () => ({ default: bad }));
    await expectLoadRejects(/нет обязательного фолбэка "neutral"/);
  });

  it('version не целое >0 → DataError', async () => {
    const bad = cloneMessages();
    (bad as { version: number }).version = 0;
    vi.doMock('./messages.json', () => ({ default: bad }));
    await expectLoadRejects(/version должен быть целым >0/);
  });
});
