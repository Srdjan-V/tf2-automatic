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
import Bottleneck, { type BottleneckOptions } from 'bottleneck';
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

// Backoff left that a request waits for instead of failing. It covers the gap
// to the previous request, which the backoff also holds
const MAX_BACKOFF_WAIT = 5000;

// Bottleneck only frees a clustered slot when its job expires, so a bot that
// stops mid-request would hold the shared slot forever. It covers the longest
// backoff wait (3 minutes) plus the pages of a large inventory
const SLOT_EXPIRATION = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

/**
 * Steam rate limits its inventory endpoint per IP. With Redis configured, every
 * bot on the same rate limit key shares one limiter and one backoff; without it
 * each bot only limits itself.
 */
@Injectable()
export class InventoriesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoriesService.name);

  private readonly manager = this.botService.getManager();

  // The settings in use, the strictest of all bots when shared
  private settings: RateLimitSettings;
  private lastRequestAt = 0;
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

    const options: BottleneckOptions = {
      ...toBottleneckSettings(this.settings),
      highWater: 3,
      strategy: Bottleneck.strategy.OVERFLOW,
    };

    // steamcommunity requests the pages of an inventory back to back; only one
    // inventory at a time is in the slot, so this spaces its pages too
    botService.setPreHttpRequestHook(async (options) => {
      if (options.url.startsWith('https://steamcommunity.com/inventory/')) {
        await sleep(this.lastRequestAt + this.settings.minTime - Date.now());
        this.lastRequestAt = Date.now();
      }
    });

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
      Redis,
      clientOptions: {
        ...redisConfig,
        keyPrefix: redisConfig.keyPrefix + 'bottleneck:',
      },
    });
    this.limiter.on('error', (err) => {
      this.logger.warn(
        `Inventory rate limiter error: ${err instanceof Error ? err.message : String(err)}`,
      );
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

        const settings = await this.sharedSettings();

        await this.limiter.updateSettings(toBottleneckSettings(settings));
        this.settings = settings;
        this.logger.log(
          `Applied shared inventory rate limit "${shared.key}" ${JSON.stringify(settings)}`,
        );
      },
    );
  }

  /**
   * The strictest settings of all bots on the key. A bot that boots later with
   * stricter settings changes them, so they are read again for each inventory
   */
  private async sharedSettings(): Promise<RateLimitSettings> {
    if (!this.shared) {
      return this.settings;
    }

    const all = Object.values(
      await this.shared.redis.hgetall(this.shared.key + ':settings'),
    ).map((raw) => JSON.parse(raw) as RateLimitSettings);
    return strictestSettings([this.settings, ...all]);
  }

  async onModuleDestroy() {
    await this.limiter.disconnect();
  }

  async getInventory(
    steamid: SteamID,
    appid: number,
    contextid: number,
    tradableOnly = true,
    failFast = false,
  ): Promise<Inventory> {
    return this.limiter
      .schedule({ expiration: SLOT_EXPIRATION }, async () => {
        this.settings = await this.sharedSettings();

        // A caller that retries 429s can fail fast instead of holding the
        // slot through a block. A short rest of the backoff, such as the gap
        // to the previous request, is always waited out
        const remaining = await this.backoff.remaining();
        if (
          failFast &&
          remaining > Math.max(MAX_BACKOFF_WAIT, this.settings.minTime)
        ) {
          throw new HttpException(
            `Inventory requests are backing off for ${Math.ceil(remaining / 1000)}s`,
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        await sleep(remaining);

        // The slot is held for every page, so a started inventory finishes
        return this.fetchInventory(steamid, appid, contextid, tradableOnly)
          .then(async (inventory) => {
            await this.updateBackoff(() => this.backoff.decrease(this.gap()));
            return inventory;
          })
          .catch(async (err) => {
            if (err instanceof UnauthorizedException) {
              await this.updateBackoff(() => this.backoff.decrease(this.gap()));
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

  /**
   * Time until the next request is allowed. minTime only spaces the starts of
   * slots, so the backoff carries the gap after the last page to the next bot
   */
  private gap(): number {
    return this.lastRequestAt + this.settings.minTime - Date.now();
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
