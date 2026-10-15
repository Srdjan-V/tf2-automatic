import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotService } from '../bot/bot.service';
import { InventoryCallback } from 'steam-tradeoffer-manager';
import SteamID from 'steamid';
import { Inventory } from '@tf2-automatic/bot-data';
import Bottleneck from 'bottleneck';
import Redis from 'ioredis';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { LockDuration, Locker } from '@tf2-automatic/locking';
import { Redis as RedisConfig } from '@tf2-automatic/config';
import {
  Config,
  InventoryConfig,
  SteamAccountConfig,
} from '../common/config/configuration';
import {
  Backoff,
  localBackoff,
  RateLimitSettings,
  redisBackoff,
  strictestSettings,
  toBottleneckSettings,
} from './inventory-rate-limit';

/**
 * Steam rate limits its inventory endpoint per IP. With Redis configured, every
 * bot on the same rate limit key shares one limiter and one backoff; without it
 * each bot only limits itself.
 */
@Injectable()
export class InventoriesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoriesService.name);

  private readonly manager = this.botService.getManager();

  private readonly settings: RateLimitSettings;
  private readonly limiter: Bottleneck;
  private readonly backoff: Backoff;

  // Set when the limit is shared through Redis
  private readonly shared?: {
    redis: Redis;
    key: string;
    // Identifies this bot's entry among the settings of bots sharing the key
    botName: string;
  };

  constructor(
    private readonly botService: BotService,
    configService: ConfigService<Config>,
    // Only provided when Redis is configured
    @Optional() redisService?: RedisService,
  ) {
    const config = configService.getOrThrow<InventoryConfig>('inventory');
    this.settings = { minTime: config.minTime };

    const options: Bottleneck.ConstructorOptions = {
      ...toBottleneckSettings(this.settings),
      highWater: 3,
      strategy: Bottleneck.strategy.OVERFLOW,
    };

    if (!redisService) {
      this.limiter = new Bottleneck(options);
      this.backoff = localBackoff();
      return;
    }

    const key = 'inventory-rate-limit:' + config.rateLimitKey;
    const redis = redisService.getOrThrow();
    const redisConfig = configService.getOrThrow<RedisConfig.Config>('redis');

    // Bottleneck opens its own connections, as in bptf-manager
    this.limiter = new Bottleneck({
      ...options,
      id: key,
      datastore: 'ioredis',
      clientOptions: {
        ...redisConfig,
        keyPrefix: redisConfig.keyPrefix + 'bottleneck:',
      },
    });
    this.limiter.on('error', (err) => {
      this.logger.warn(`Inventory rate limiter error: ${err.message}`);
    });
    this.backoff = redisBackoff(redis, key);
    this.shared = {
      redis,
      key,
      botName: configService.getOrThrow<SteamAccountConfig>('steam').username,
    };
  }

  /**
   * Bots on the same key may be configured differently. Each one records its
   * settings at boot and applies the strictest across all of them; the lock
   * keeps two bots booting together from overwriting each other's result.
   */
  async onModuleInit() {
    const shared = this.shared;
    if (!shared) {
      this.logger.log(
        `Redis not configured, inventory rate limit is local ${JSON.stringify(this.settings)}`,
      );
      return;
    }

    const settingsKey = shared.key + ':settings';

    await new Locker(shared.redis).using(
      [settingsKey],
      LockDuration.SHORT,
      async () => {
        await shared.redis.hset(
          settingsKey,
          shared.botName,
          JSON.stringify(this.settings),
        );

        const all = Object.values(await shared.redis.hgetall(settingsKey)).map(
          (raw) => JSON.parse(raw) as RateLimitSettings,
        );
        const settings = strictestSettings(all);

        await this.limiter.updateSettings(toBottleneckSettings(settings));
        this.logger.log(
          `Applied shared inventory rate limit "${shared.key}" ${JSON.stringify(settings)}`,
        );
      },
    );
  }

  async onModuleDestroy() {
    await this.limiter.disconnect();
  }

  async getInventory(
    steamid: SteamID,
    appid: number,
    contextid: number,
    tradableOnly = true,
  ): Promise<Inventory> {
    return this.limiter
      .schedule(async () => {
        // Waiting here holds the limiter slot, so with a shared limit every bot
        // on the key backs off together
        const difference = await this.backoff.remaining();
        if (difference > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, difference);
          });
        }

        return this.fetchInventory(steamid, appid, contextid, tradableOnly)
          .then(async (inventory) => {
            await this.updateBackoff(() => this.backoff.reset());
            return inventory;
          })
          .catch(async (err) => {
            if (err instanceof UnauthorizedException) {
              await this.updateBackoff(() => this.backoff.reset());
            } else {
              await this.updateBackoff(() => this.backoff.increase());
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

  private async updateBackoff(update: () => Promise<void>): Promise<void> {
    try {
      await update();
    } catch (err) {
      this.logger.warn(
        `Failed to update inventory backoff: ${(err as Error).message}`,
      );
    }
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
