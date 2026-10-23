import { Item, SKU, Utils } from '@tf2-automatic/tf2-format';
import { InventoryItemData } from '@tf2-automatic/item-service-data';

/**
 * Groups the cached items of an inventory by all of their attributes. The cache
 * stores only the attributes that differ from the default, so each item is
 * completed with the defaults first.
 */
export function groupInventoryItems(
  items: Record<string, Partial<Item>>,
): InventoryItemData[] {
  const groups = new Map<string, InventoryItemData>();

  for (const assetid in items) {
    const item: Item & { assetid?: string | null } = {
      ...Utils.getDefault(),
      ...items[assetid],
    };
    // An assetid, also one the cache holds, would keep equal items apart
    delete item.assetid;

    // The keys follow the default's order, so equal items give equal keys
    const key = JSON.stringify(item);

    let group = groups.get(key);
    if (group === undefined) {
      group = { sku: SKU.fromObject(item), ...item, assets: [] };
      groups.set(key, group);
    }
    group.assets.push(assetid);
  }

  return [...groups.values()];
}
