import { RequiredItemAttributes } from '../types';

export class SKU {
  static fromObject(item: RequiredItemAttributes): string {
    let sku = `${item.defindex};${item.quality}`;

    if (typeof item.effect === 'number') {
      sku += `;u${item.effect}`;
    }
    if (item.australium === true) {
      sku += ';australium';
    }
    if (item.craftable === false) {
      sku += ';uncraftable';
    }
    if (item.tradable === false) {
      sku += ';untradable';
    }
    if (item.paint) {
      sku += `;p${item.paint}`;
    }
    if (item.wear) {
      sku += `;w${item.wear}`;
    }
    if (typeof item.paintkit === 'number') {
      sku += `;pk${item.paintkit}`;
    }
    if (item.elevated === true) {
      sku += ';strange';
    }
    if (typeof item.killstreak === 'number' && item.killstreak !== 0) {
      sku += `;kt-${item.killstreak}`;
    }
    if (typeof item.sheen === 'number') {
      sku += `;ks-${item.sheen}`;
    }
    if (typeof item.killstreaker === 'number') {
      sku += `;ke-${item.killstreaker}`;
    }
    if (typeof item.target === 'number') {
      sku += `;td-${item.target}`;
    }
    if (item.festivized === true) {
      sku += ';festive';
    }
    if (typeof item.crateSeries === 'number') {
      sku += `;c${item.crateSeries}`;
    }
    if (typeof item.output === 'number') {
      sku += `;od-${item.output}`;
    }
    if (typeof item.outputQuality === 'number') {
      sku += `;oq-${item.outputQuality}`;
    }

    return sku;
  }

  static fromString(sku: string): RequiredItemAttributes {
    const item: RequiredItemAttributes = {
      defindex: -1,
      quality: -1,
    };

    const length = sku.length;
    let start = 0;
    let numValue = 0;
    let sign = 1;

    // Extract only defindex and quality
    for (let i = 0; i < length; i++) {
      const charCode = sku.charCodeAt(i);
      if (charCode === 45) {
        sign = -1;
      } else if (charCode <= 57) {
        // We know that defindex and quality should only be numbers, so we
        // just assume that it is the character '0' to '9'.
        numValue = numValue * 10 + (charCode - 48) * sign;
      } else if (charCode === 59) {
        // Found the seperator ';' ASCII 59
        if (start === 0) {
          // First time we found the seperator, so this is the defindex
          item.defindex = numValue;
          // Reset numValue for the next part
          numValue = 0;
          sign = 1;
          // Update the start defindex for the next part
          start = i + 1;
        } else if (start !== 0) {
          // Second time we found the seperator, so this is the quality
          start = i + 1;
          break;
        }
      }
    }

    // We have to set the quality outside of the loop because there may not be a second seperator
    item.quality = numValue;

    // Now process remaining attributes
    while (start < length) {
      let separatorIndex = length;
      let numIndex: number | undefined = undefined;
      let numValue = 0;

      // Loop through the remaining part of the SKU
      for (let i = start; i < length; i++) {
        if (sku.charAt(i) === ';') {
          // Found seperator, break the loop to process the attribute
          separatorIndex = i;
          break;
        } else {
          // Check if the character is less than 57 (ASCII for '9')
          const charCode = sku.charCodeAt(i);
          if (charCode <= 57) {
            // The character should be either a number or a hyphen (but we don't
            // care about validating it)
            if (numIndex === undefined) {
              // Set the index, everything after should be a number
              numIndex = i;
            }

            // Check if the character is a number
            if (charCode >= 48) {
              // It is a number, accumulate the numeric value
              numValue = numValue * 10 + (charCode - 48);
            }
          }
        }
      }

      const partLength = (numIndex || separatorIndex) - start;

      // Handle without numeric values first
      switch (partLength) {
        case 11:
          item.craftable = false;
          break;
        case 10:
          if (sku.charAt(start) === 'a') {
            item.australium = true;
          } else {
            item.tradable = false;
          }
          break;
        case 7:
          if (sku.charAt(start) === 's') {
            item.elevated = true;
          } else {
            item.festivized = true;
          }
          break;
        case 2:
          switch (sku.charAt(start + 1)) {
            case 't':
              item.killstreak = numValue;
              break;
            case 's':
              item.sheen = numValue;
              break;
            case 'e':
              item.killstreaker = numValue;
              break;
            case 'd':
              if (sku.charAt(start) === 't') {
                item.target = numValue;
              } else {
                item.output = numValue;
              }
              break;
            case 'q':
              item.outputQuality = numValue;
              break;
            case 'k':
              item.paintkit = numValue;
              break;
          }
          break;
        default: {
          const prefix = sku.charAt(start);
          switch (prefix) {
            case 'u':
              item.effect = numValue;
              break;
            case 'w':
              item.wear = numValue;
              break;
            case 'p':
              item.paint = numValue;
              break;
            case 'c':
              item.crateSeries = numValue;
              break;
          }
        }
      }

      start = separatorIndex + 1;
    }

    return item;
  }
}
