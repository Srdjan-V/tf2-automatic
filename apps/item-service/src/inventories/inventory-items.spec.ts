import { groupInventoryItems } from './inventory-items';

describe('groupInventoryItems', () => {
  it('fills every attribute and groups equal items with their assets', () => {
    const groups = groupInventoryItems({
      '1': { defindex: 5021, quality: 6 },
      '2': { defindex: 5021, quality: 6, assetid: '2' } as never,
      '3': { defindex: 200, quality: 11, killstreak: 3, parts: [64] },
    });

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      sku: '5021;6',
      defindex: 5021,
      quality: 6,
      craftable: true,
      tradable: true,
      australium: false,
      festivized: false,
      effect: null,
      wear: null,
      paintkit: null,
      killstreak: 0,
      target: null,
      output: null,
      outputQuality: null,
      elevated: false,
      crateSeries: null,
      paint: null,
      parts: [],
      spells: [],
      sheen: null,
      killstreaker: null,
      inputs: null,
      quantity: 1,
      assets: ['1', '2'],
    });
    expect(groups[1]).toMatchObject({
      defindex: 200,
      killstreak: 3,
      parts: [64],
      assets: ['3'],
    });
  });

  it('keeps items apart that differ only in an extra attribute', () => {
    const groups = groupInventoryItems({
      '1': { defindex: 200, quality: 11, parts: [64] },
      '2': { defindex: 200, quality: 11, parts: [70] },
    });

    expect(groups.map((group) => group.sku)).toEqual(['200;11', '200;11']);
    expect(groups.map((group) => group.assets)).toEqual([['1'], ['2']]);
  });
});
