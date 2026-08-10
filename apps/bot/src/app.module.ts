import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BotModule } from './bot/bot.module';
import configuration, {
  Config,
  isRedisConfigured,
} from './common/config/configuration';
import { validation } from './common/config/validation';
import { NestStorageModule } from '@tf2-automatic/nestjs-storage';
import { HealthModule } from './health/health.module';
import { FriendsModule } from './friends/friends.module';
import { InventoriesModule } from './inventories/inventories.module';
import { TF2Module } from './tf2/tf2.module';
import { TradesModule } from './trades/trades.module';
import { ProfileModule } from './profile/profile.module';
import { EventsModule } from './events/events.module';
import { MetadataModule } from './metadata/metadata.module';
import { EscrowModule } from './escrow/escrow.module';
import { NotificationModule } from './notification/notification.module';
import { ShutdownModule } from './shutdown/shutdown.module';
import { ManagerModule } from './manager/manager.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import {
  getStorageConfig,
  getUserAgent,
  Redis as RedisConfig,
} from '@tf2-automatic/config';
import { RedisModule } from '@liaoliaots/nestjs-redis';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  IdempotencyInterceptor,
  UserAgentInterceptor,
} from '@tf2-automatic/nestjs';
import { HttpModule } from '@nestjs/axios';
import { ClsModule } from 'nestjs-cls';
import { OpenTelemetryModule } from '@tf2-automatic/opentelemetry';

@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: UserAgentInterceptor,
    },
  ],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: true,
      load: [configuration],
      validationSchema: validation,
    }),
    OpenTelemetryModule.forRoot(),
    EventEmitterModule.forRoot(),
    BotModule,
    NestStorageModule.registerAsync({
      inject: [ConfigService],
      useFactory: () => {
        return getStorageConfig();
      },
    }),
    HealthModule,
    FriendsModule,
    InventoriesModule,
    TF2Module.register(),
    TradesModule,
    ProfileModule,
    EventsModule,
    MetadataModule,
    EscrowModule,
    NotificationModule,
    ShutdownModule,
    ManagerModule,
    HttpModule.registerAsync({
      global: true,
      useFactory: () => {
        const headers: Record<string, string> = {};

        const agent = getUserAgent();
        if (agent) {
          headers['User-Agent'] = agent;
        }

        return {
          headers,
        };
      },
    }),
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
    ...(isRedisConfigured()
      ? [
          RedisModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService<Config>) => {
              const redisConfig =
                configService.getOrThrow<RedisConfig.Config>('redis');
              return {
                readyLog: true,
                config: {
                  ...redisConfig,
                  keyPrefix: redisConfig.keyPrefix + 'data:',
                },
              };
            },
          }),
        ]
      : []),
  ],
})
export class AppModule {}
