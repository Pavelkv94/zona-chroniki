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
 * Фаза 0: реальных систем ещё нет, поэтому лог пуст (`events === 0`) — это
 * зафиксировано осознанно, как и в `cli.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { runHeadless } from './cli';

describe('smoke: один день, seed=42 — ядро стартует и воспроизводимо', () => {
  const opts = { days: 1, seed: 42, metrics: false } as const;

  it('два вызова runHeadless дают идентичный snapshotHash (закон №8)', () => {
    const a = runHeadless({ ...opts });
    const b = runHeadless({ ...opts });
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.snapshotHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('прогон валиден: неотрицательный ms, лог Фазы 0 пуст', () => {
    const r = runHeadless({ ...opts });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.events).toBe(0);
  });
});
