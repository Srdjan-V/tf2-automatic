import { ItemsGameItem } from '@tf2-automatic/item-service-data';

export function mergeDefinitionPrefab(
  writeItem: Partial<ItemsGameItem>,
  sourceItem: Partial<ItemsGameItem>,
  schemaPrefabs: Record<string, Partial<ItemsGameItem>>,
) {
  if (sourceItem.prefab) {
    const prefabs = sourceItem.prefab.split(' ');

    // Iterate backwards so earlier prefabs are applied over later ones
    for (let i = prefabs.length - 1; i >= 0; i--) {
      const prefab = prefabs[i];
      const match = schemaPrefabs[prefab];

      if (match) {
        mergeDefinitionPrefab(writeItem, match, schemaPrefabs);
      }
    }

    // Several prefabs are merged on their own first, so the first one listed wins; they still have
    // to reach the item, or every multi-prefab item ("valve taunt") loses its capabilities.
    if (write !== writeItem) {
      recursiveInheritKeyValues(writeItem, write);
    }
  }

  recursiveInheritKeyValues(writeItem, sourceItem);

  delete writeItem.prefab;
}

export function recursiveInheritKeyValues(
  writeItem: Partial<ItemsGameItem>,
  sourceItem: Partial<ItemsGameItem>,
) {
  for (const key in sourceItem) {
    if (key === 'prefab') {
      continue;
    }

    const value = sourceItem[key];
    if (value === null) {
      delete writeItem[key];
    } else if (typeof value === 'object') {
      if (writeItem[key] === undefined || typeof writeItem[key] !== 'object') {
        writeItem[key] = {};
      }

      recursiveInheritKeyValues(writeItem[key], value);
    } else {
      writeItem[key] = value;
    }
  }

  return writeItem;
}
