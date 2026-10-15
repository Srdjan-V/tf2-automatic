import { strictestSettings } from './inventory-rate-limit';

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
