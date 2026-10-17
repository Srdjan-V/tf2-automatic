import { ItemsGameItem } from '@tf2-automatic/item-service-data';
import { mergeDefinitionPrefab } from './schema.utils';

describe('mergeDefinitionPrefab', () => {
  // Trimmed from items_game: "Results Are In Taunt" (1109) uses the two prefabs "valve taunt".
  const prefabs: Record<string, Partial<ItemsGameItem>> = {
    valve: { item_quality: 'unique' },
    taunt: {
      item_class: 'no_entity',
      capabilities: { nameable: '1', can_craft_if_purchased: '1' },
    },
  };

  it('keeps what every one of several prefabs gives', () => {
    const item: Partial<ItemsGameItem> = {};

    mergeDefinitionPrefab(
      item,
      { name: 'Results Are In Taunt', prefab: 'valve taunt' },
      prefabs,
    );

    expect(item).toEqual({
      name: 'Results Are In Taunt',
      item_quality: 'unique',
      item_class: 'no_entity',
      capabilities: { nameable: '1', can_craft_if_purchased: '1' },
    });
  });

  it('lets the first of several prefabs win, and the item win over both', () => {
    const item: Partial<ItemsGameItem> = {};

    mergeDefinitionPrefab(
      item,
      { name: 'Item', prefab: 'first second', item_slot: 'misc' },
      {
        first: { item_class: 'from_first', item_slot: 'from_first' },
        second: { item_class: 'from_second', item_quality: 'from_second' },
      },
    );

    expect(item).toEqual({
      name: 'Item',
      item_class: 'from_first',
      item_quality: 'from_second',
      item_slot: 'misc',
    });
  });

  it('merges a single prefab', () => {
    const item: Partial<ItemsGameItem> = {};

    mergeDefinitionPrefab(item, { name: 'Taunt', prefab: 'taunt' }, prefabs);

    expect(item.capabilities).toEqual({
      nameable: '1',
      can_craft_if_purchased: '1',
    });
  });
});
