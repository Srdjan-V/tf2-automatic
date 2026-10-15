import {
  EventsConfig,
  getEnv,
  getEnvOrThrow,
  getEnvWithDefault,
  getEventsConfig,
  getStorageConfig,
  Redis,
  StorageConfig,
} from '@tf2-automatic/config';

export interface Config {
  port: number;
  keepAliveTimeout: number;
  ip?: string;
  host?: string;
  webSessionRefreshInterval: number;
  steam: SteamAccountConfig;
  trade: SteamTradeConfig;
  tf2: TF2Config;
  events: EventsConfig;
  storage: StorageConfig;
  manager: ManagerConfig;
  cache: CacheConfig;
  inventory: InventoryConfig;
  /** Unset when the bot runs without Redis */
  redis?: Redis.Config;
}

export interface SteamAccountConfig {
  username: string;
  password: string;
  sharedSecret: string;
  identitySecret: string;
  proxyUrl?: string;
  apiKey?: string;
  defaultGame?: number;
}

export interface SteamTradeConfig {
  cancelTime?: number;
  pendingCancelTime?: number;
  pollInterval: number;
  pollFullUpdateInterval: number;
  pollDataForgetTime: number;
}

export interface TF2Config {
  enabled: boolean;
}

export interface ManagerConfig {
  enabled: boolean;
  url?: string;
  heartbeatInterval?: number;
}

export interface CacheConfig {
  recentThreshold: number;
}

export interface InventoryConfig {
  /**
   * When Redis is configured, bots with the same key share one Steam inventory
   * rate limit through it; give a group of bots behind its own egress IP (a
   * proxy) its own key. Without Redis each bot limits itself.
   */
  rateLimitKey: string;
  minTime: number;
}

/** Redis is optional for the bot; it only enables the shared inventory limit */
export function isRedisConfigured(): boolean {
  return Boolean(
    getEnv('REDIS_HOST', 'string') || getEnv('REDIS_SENTINELS', 'string'),
  );
}

export default (): Config => {
  return {
    port: getEnvOrThrow('PORT', 'integer'),
    // The bot has long lived requests so we don't want to timeout
    keepAliveTimeout: getEnvWithDefault('KEEP_ALIVE_TIMEOUT', 'integer', 0),
    // FIXME: This is deprecated, use host instead
    ip: getEnv('IP_ADDRESS', 'string'),
    host: getEnv('HOST', 'string'),
    webSessionRefreshInterval: getEnvWithDefault(
      'WEB_SESSION_REFRESH_INTERVAL',
      'integer',
      10 * 60 * 1000,
    ),
    steam: {
      username: getEnvOrThrow('STEAM_USERNAME', 'string'),
      password: getEnvOrThrow('STEAM_PASSWORD', 'string'),
      sharedSecret: getEnvOrThrow('STEAM_SHARED_SECRET', 'string'),
      identitySecret: getEnvOrThrow('STEAM_IDENTITY_SECRET', 'string'),
      proxyUrl: getEnv('STEAM_PROXY_URL', 'string'),
      apiKey: getEnv('STEAM_API_KEY', 'string'),
      defaultGame: getEnv('STEAM_DEFAULT_GAME', 'integer'),
    },
    trade: {
      cancelTime: getEnv('TRADE_CANCEL_TIME', 'integer'),
      pendingCancelTime: getEnv('TRADE_PENDING_CANCEL_TIME', 'integer'),
      pollInterval: getEnvWithDefault(
        'TRADE_POLL_INTERVAL',
        'integer',
        30 * 1000,
      ),
      pollFullUpdateInterval: getEnvWithDefault(
        'TRADE_POLL_FULL_UPDATE_INTERVAL',
        'integer',
        2 * 60 * 1000,
      ),
      pollDataForgetTime: getEnvWithDefault(
        'TRADE_POLL_DATA_FORGET_TIME',
        'integer',
        14 * 24 * 60 * 60 * 1000,
      ),
    },
    tf2: {
      enabled: getEnvWithDefault('TF2_ENABLED', 'boolean', true),
    },
    events: getEventsConfig(),
    storage: getStorageConfig(),
    manager: {
      enabled: getEnvWithDefault('BOT_MANAGER_ENABLED', 'boolean', false),
      url: getEnv('BOT_MANAGER_URL', 'string'),
      heartbeatInterval: getEnvWithDefault(
        'BOT_MANAGER_HEARTBEAT_INTERVAL',
        'integer',
        20000,
      ),
    },
    cache: {
      recentThreshold: getEnvWithDefault(
        'CACHE_RECENT_THRESHOLD',
        'integer',
        5000,
      ),
    },
    inventory: {
      rateLimitKey: getEnvWithDefault(
        'INVENTORY_RATE_LIMIT_KEY',
        'string',
        'default',
      ),
      // About one request every 4 seconds per IP is the community-reported
      // safe pace for steamcommunity.com/inventory
      minTime: getEnvWithDefault(
        'INVENTORY_RATE_LIMIT_MIN_TIME',
        'integer',
        4000,
      ),
    },
    redis: isRedisConfigured() ? Redis.getConfig() : undefined,
  };
};
