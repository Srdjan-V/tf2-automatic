import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { AccountWorkerHost } from '../common/account-worker-host';
import { bullWorkerSettings } from '@tf2-automatic/queue';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { TokensService } from '../tokens/tokens.service';
import SteamID from 'steamid';
import { AxiosError } from 'axios';
import { NotificationsService } from './notifications.service';
import { JobData } from './interfaces/queue';
import { RateLimitsService } from '../rate-limits/rate-limits.service';

// A client error from backpack.tf won't change on a retry. 429 is handled by
// the rate limiter before this
export function failOnClientError(err: unknown): never {
  const status = err instanceof AxiosError ? err.response?.status : undefined;

  if (status !== undefined && [400, 401, 403, 404].includes(status)) {
    throw new UnrecoverableError(
      `Backpack.tf returned non-retryable status ${status}`,
    );
  }

  throw err;
}

@Processor('notifications', {
  settings: bullWorkerSettings,
})
export class NotificationsProcessor extends AccountWorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly tokensService: TokensService,
    private readonly rateLimitsService: RateLimitsService,
    cls: ClsService,
  ) {
    super(cls);
  }

  async processJob(job: Job<JobData>, lockToken?: string): Promise<void> {
    switch (job.name) {
      case 'done':
        await this.done(job);
        break;
      case 'fetch':
        await this.getNotifications(job, lockToken);
        break;
    }
  }

  private async done(job: Job<JobData>): Promise<void> {
    await this.notificationsService.handleNotificationsFetched(job);
  }

  private async getNotifications(
    job: Job<JobData>,
    lockToken?: string,
  ): Promise<void> {
    const steamid = new SteamID(job.data.steamid64);

    const token = await this.tokensService.getToken(steamid);

    const key = steamid.getSteamID64();

    let start = 0;

    const response = await this.rateLimitsService.scheduleOrDelay(
      job,
      lockToken,
      'notificationsGet',
      key,
      () => {
        start = Date.now();

        return this.notificationsService
          .fetchNotifications(token, job.data.skip, job.data.limit)
          .catch((err) =>
            this.rateLimitsService.handleError('notificationsGet', key, err),
          )
          .catch(failOnClientError);
      },
    );

    const duration = Date.now() - start;

    this.logger.debug(
      `Got ${response.results.length} notification(s) (${response.cursor.skip + response.results.length} of ${response.cursor.total}) in ${duration}ms`,
    );

    await this.notificationsService.handleNotifications(job, response);
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.logger.error('Error in worker');
    console.error(err);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.warn(
      `Failed to get notifications for job ${job.id}: ${err.message}`,
    );

    if (err instanceof AxiosError) {
      console.error('Status code ' + err.response?.status);
      console.error(err.response?.data);
    } else {
      console.error(err);
    }
  }
}
