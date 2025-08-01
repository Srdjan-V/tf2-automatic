import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { BotService } from '../bot/bot.service';
import { InventoryCallback } from 'steam-tradeoffer-manager';
import SteamID from 'steamid';
import { Inventory } from '@tf2-automatic/bot-data';
import Bottleneck from 'bottleneck';
import { calculateBackoff } from '@tf2-automatic/queue';

@Injectable()
export class InventoriesService {
  private readonly logger = new Logger(InventoriesService.name);

  private readonly manager = this.botService.getManager();

  private readonly limiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 1000,
    highWater: 3,
    strategy: Bottleneck.strategy.OVERFLOW,
  });

  private attempts = 0;
  private attemptAt = 0;

  constructor(private readonly botService: BotService) {}

  async getInventory(
    steamid: SteamID,
    appid: number,
    contextid: number,
    tradableOnly = true,
  ): Promise<Inventory> {
    return this.limiter
      .schedule(async () => {
        const difference = this.attemptAt - Date.now();
        if (difference > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, difference);
          });
        }

        return this.fetchInventory(steamid, appid, contextid, tradableOnly)
          .then((inventory) => {
            this.attempts = 0;
            return inventory;
          })
          .catch((err) => {
            if (err instanceof UnauthorizedException) {
              this.attempts = 0;
            } else {
              this.attempts++;
              this.attemptAt = Date.now() + calculateBackoff(this.attempts);
            }

            throw err;
          });
      })
      .catch((err) => {
        if (err instanceof Bottleneck.BottleneckError) {
          throw new HttpException(
            'Too many pending requests to load an inventory',
            429,
          );
        }

        throw err;
      });
  }

  private async fetchInventory(
    steamid: SteamID,
    appid: number,
    contextid: number,
    tradableOnly = true,
  ): Promise<Inventory> {
    return new Promise((resolve, reject) => {
      this.logger.debug(
        `Getting inventory ${steamid}/${appid}/${contextid}?tradableOnly=${tradableOnly}...`,
      );

      const callback: InventoryCallback = (err, items) => {
        const inventory = items as unknown as Inventory;

        if (err) {
          if (
            err.message === 'HTTP error 401' ||
            err.message === 'This profile is private.'
          ) {
            this.logger.warn(
              `Error getting inventory: ${err.message} (inventory is private)`,
            );
            return reject(new UnauthorizedException('Inventory is private'));
          }

          this.logger.warn(`Error getting inventory: ${err.message}`);

          if (
            err.message.startsWith('HTTP error 4') &&
            err.message.length === 14
          ) {
            return reject(
              new HttpException(
                'Steam returned ' + err.message,
                err.message === 'HTTP error 429'
                  ? HttpStatus.TOO_MANY_REQUESTS
                  : HttpStatus.FAILED_DEPENDENCY,
              ),
            );
          }

          return reject(err);
        }

        this.logger.debug(
          `Got inventory ${steamid}/${appid}/${contextid} with ${inventory.length} items`,
        );
        resolve(inventory);
      };

      if (steamid.getSteamID64() === this.botService.getSteamID64()) {
        this.manager.getInventoryContents(
          appid,
          contextid,
          tradableOnly,
          callback,
        );
      } else {
        this.manager.getUserInventoryContents(
          steamid,
          appid,
          contextid,
          tradableOnly,
          callback,
        );
      }
    });
  }
}
