/**
 * @module @zona/sim/core/phase5-schema.test
 *
 * Гейт СХЕМ-фундамента Фазы 5 «Экосистема и Стратегия» (задача 5.0). Задача чисто
 * аддитивная (компоненты/поля/коды/сериализация, БЕЗ систем и БЕЗ поведения),
 * поэтому тесты сторожат ровно СХЕМУ и её сериализацию (закон №8):
 *  (а) round-trip WorldClock с тремя новыми полями эмиссии (serialize→deserialize→
 *      serialize даёт СТРУКТУРНО тот же снапшот; поля выживают через реестр);
 *  (б) round-trip нового компонента Sickness при ИСКУССТВЕННОЙ штамповке (в проде
 *      5.0 мембершип нулевой — болезни не штампуются до 5.8);
 *  (в) новые коды `TaskKind` (TAKE_SHELTER=11, TREAT=12) append-only и не
 *      конфликтуют с 0..10; коды `EmissionPhase`/`Disease` — тоже стабильны;
 *  (г) РЕГРЕСС-СТРАЖ: hashSnapshot ПУСТОГО мира == 481914ae ПОСЛЕ изменений схемы
 *      (пустой мир не носит WorldClock/Sickness ⇒ добавление сериализуемых полей
 *      его канонический снапшот не сдвигает — серилизатор пропускает компонент без
 *      живых носителей).
 *
 * ВАЖНО (нулевая мембершип не течёт в снапшот): регистрация ПУСТОЙ колонки Sickness
 * и расширение WorldClock не создают носителей сами по себе — living-снапшот меняется
 * ТОЛЬКО там, где носитель РЕАЛЬНО есть (singleton WorldClock в worldgen'нутом мире).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed, SnapshotJSON } from '@zona/shared';
import { createSimWorld } from './world';
import { spawnEntity, addComponent } from './ecs';
import { serialize, deserialize, hashSnapshot } from './snapshot';
import {
  WorldClock,
  Sickness,
  TaskKind,
  EmissionPhase,
  Disease,
} from './components';
import { worldgen } from '../worldgen';

/** Типизированный доступ к SoA-колонкам WorldClock (5 полей, Фаза 5). */
const CLOCK = WorldClock as unknown as {
  weather: Uint8Array;
  weatherSince: Uint32Array;
  zonePressure: Float32Array;
  emissionPhase: Uint8Array;
  phaseSince: Uint32Array;
};

/** Типизированный доступ к SoA-колонкам Sickness (Фаза 5). */
const SICK = Sickness as unknown as {
  disease: Uint8Array;
  severity: Float32Array;
  exposure: Float32Array;
  sinceTick: Uint32Array;
};

/** Хелпер: достать колонку компонента из снапшота (или undefined). */
function column(snap: SnapshotJSON, name: string): unknown {
  return (snap.components as Record<string, unknown>)[name];
}

describe('Фаза 5.0 — схемы-фундамент (аддитивно, без поведения)', () => {
  // ── (г) РЕГРЕСС-СТРАЖ пустого мира ─────────────────────────────────────────
  it('(г) пустой мир (createSimWorld без worldgen) == 481914ae ПОСЛЕ схем 5.0', () => {
    const empty = createSimWorld(0 as Seed);
    // Пустой мир не носит WorldClock/Sickness ⇒ новые сериализуемые поля его канон
    // не трогают (серилизатор пропускает компонент без живых носителей).
    expect(hashSnapshot(serialize(empty))).toBe('481914ae');
  });

  it('пустой мир не несёт колонок worldclock/sickness (нет носителей)', () => {
    const empty = createSimWorld(0 as Seed);
    const snap = serialize(empty);
    expect(column(snap, 'worldclock')).toBeUndefined();
    expect(column(snap, 'sickness')).toBeUndefined();
  });

  // ── (а) round-trip WorldClock с новыми полями эмиссии ──────────────────────
  it('(а) WorldClock round-trip: три поля эмиссии выживают serialize→deserialize→serialize', () => {
    const world = createSimWorld(7 as Seed);
    const clockEid = spawnEntity(world.ecs) as EntityId;
    addComponent(world.ecs, WorldClock, clockEid); // зануляет поля (D-024)
    // Ненулевые распознаваемые значения (все f32-точны: 0.5/0.75 = k/2^n).
    CLOCK.weather[clockEid as number] = 2;
    CLOCK.weatherSince[clockEid as number] = 100;
    CLOCK.zonePressure[clockEid as number] = 0.5;
    CLOCK.emissionPhase[clockEid as number] = EmissionPhase.ACTIVE; // 2
    CLOCK.phaseSince[clockEid as number] = 200;

    const snapA = serialize(world);
    // Колонка несёт РОВНО пять полей эмиссии в фиксированном порядке реестра.
    expect(column(snapA, 'worldclock')).toEqual({
      eids: [clockEid],
      fields: {
        weather: [2],
        weatherSince: [100],
        zonePressure: [0.5],
        emissionPhase: [2],
        phaseSince: [200],
      },
    });

    // Round-trip: restore → re-serialize даёт СТРУКТУРНО тождественный снапшот.
    const restored = deserialize(snapA);
    const snapB = serialize(restored);
    expect(snapB).toEqual(snapA);
    expect(hashSnapshot(snapB)).toBe(hashSnapshot(snapA));
  });

  // ── (б) round-trip Sickness при искусственной штамповке ────────────────────
  it('(б) Sickness round-trip: искусственно заштампованный носитель выживает', () => {
    const world = createSimWorld(9 as Seed);
    const eid = spawnEntity(world.ecs) as EntityId;
    addComponent(world.ecs, Sickness, eid); // зануляет поля (D-024)
    SICK.disease[eid as number] = 1; // сырой код-болезнь (5.8 введёт контент)
    SICK.severity[eid as number] = 0.25;
    SICK.exposure[eid as number] = 0.75;
    SICK.sinceTick[eid as number] = 50;

    const snapA = serialize(world);
    expect(column(snapA, 'sickness')).toEqual({
      eids: [eid],
      fields: {
        disease: [1],
        severity: [0.25],
        exposure: [0.75],
        sinceTick: [50],
      },
    });

    const restored = deserialize(snapA);
    const snapB = serialize(restored);
    expect(snapB).toEqual(snapA);
  });

  // ── (в) коды append-only не конфликтуют ────────────────────────────────────
  it('(в) TaskKind: TAKE_SHELTER=11, TREAT=12 добавлены в конец, коды 0..12 уникальны', () => {
    expect(TaskKind.TAKE_SHELTER).toBe(11);
    expect(TaskKind.TREAT).toBe(12);
    // Существующие коды 0..10 не сдвинуты (сторож append-only).
    expect(TaskKind.SEARCH).toBe(10);
    const codes = Object.values(TaskKind);
    expect(new Set(codes).size).toBe(codes.length); // все уникальны
    expect(codes).toEqual([...codes].sort((a, b) => a - b)); // плотно возрастают 0..12
    expect(codes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('(в) EmissionPhase/Disease: базовое состояние = 0, коды уникальны', () => {
    expect(EmissionPhase.BUILDING).toBe(0); // 0 совпадает с занулением addComponent
    const ep = Object.values(EmissionPhase);
    expect(ep).toEqual([0, 1, 2, 3]);
    expect(new Set(ep).size).toBe(ep.length);
    expect(Disease.HEALTHY).toBe(0);
  });

  // ── living-мир: worldgen штампует WorldClock с нулями эмиссии, Sickness — нет ─
  it('worldgen: WorldClock несёт нулевые поля эмиссии; Sickness никем не носится', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);

    const snap = serialize(world);
    const wc = column(snap, 'worldclock') as {
      eids: EntityId[];
      fields: Record<string, number[]>;
    };
    expect(wc.eids.length).toBe(1); // ровно один singleton
    // Поля эмиссии инициализированы нулём (5.0 — без цикла выброса).
    expect(wc.fields.zonePressure).toEqual([0]);
    expect(wc.fields.emissionPhase).toEqual([EmissionPhase.BUILDING]);
    expect(wc.fields.phaseSince).toEqual([0]);
    // Sickness в 5.0 не штампуется (мембершип нулевой) ⇒ колонки нет.
    expect(column(snap, 'sickness')).toBeUndefined();
  });
});
