import {
  backoffDelay,
  localBackoff,
  strictestSettings,
} from './inventory-rate-limit';

describe('strictestSettings', () => {
  it('uses the largest minTime', () => {
    expect(
      strictestSettings([
        { minTime: 4000 },
        { minTime: 6000 },
        { minTime: 2000 },
      ]),
    ).toEqual({ minTime: 6000 });
  });
});

describe('backoffDelay', () => {
  it('doubles from 30s up to 3 minutes', () => {
    expect([1, 2, 3, 4, 5].map(backoffDelay)).toEqual([
      30000, 60000, 120000, 180000, 180000,
    ]);
  });
});

describe('localBackoff', () => {
  it('steps down one level on success', async () => {
    const backoff = localBackoff();
    await backoff.increase();
    await backoff.increase();
    await backoff.decrease(1000);
    await backoff.increase();

    const remaining = await backoff.remaining();
    expect(remaining).toBeGreaterThan(55000);
    expect(remaining).toBeLessThanOrEqual(60000);
  });

  it('holds the gap to the next request after a success', async () => {
    const backoff = localBackoff();
    await backoff.decrease(1000);

    const remaining = await backoff.remaining();
    expect(remaining).toBeGreaterThan(900);
    expect(remaining).toBeLessThanOrEqual(1000);
  });
});
