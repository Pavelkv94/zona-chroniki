/**
 * @module @zona/headless/smoke.test
 *
 * SMOKE-гейт Фазы 0 (задача 0.7): самый быстрый сигнал «ядро запускается и
 * детерминировано». Один игровой день, seed=42 — тот же прогон, что и скрипт
 * `npm run smoke`. Здесь мы проверяем ДЕТЕРМИНИЗМ МЕЖДУ ВЫЗОВАМИ: `runHeadless`,
 * запущенный дважды в одном процессе, обязан вернуть один и тот же
 * `snapshotHash` (закон №8). Это дублирует не глубокий гейт из
 * `determinism.test.ts`, а даёт дешёвый «канарейку»-тест, который CI (когда
 * появится) сможет гонять первым.
 *
 * Фаза 1 (1.12): мир ОЖИЛ — worldgen + 9 систем, поэтому лог НЕ пуст
 * (`events > 0`). Это зафиксировано осознанно, как и в `cli.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { runHeadless, type CliOptions } from './cli';

describe('smoke: один день, seed=42 — живой мир стартует и воспроизводим', () => {
  const opts: CliOptions = { days: 1, seed: 42, metrics: false, logMode: 'none' };

  it('два вызова runHeadless дают идентичный snapshotHash (закон №8)', () => {
    const a = runHeadless({ ...opts });
    const b = runHeadless({ ...opts });
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.snapshotHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('прогон валиден: неотрицательный ms, живой мир породил события', () => {
    const r = runHeadless({ ...opts });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.events).toBeGreaterThan(0);
  });
});
