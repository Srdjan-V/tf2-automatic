import { OtelLoggerService } from '@tf2-automatic/opentelemetry';
import { ClsServiceManager } from 'nestjs-cls';

// Adds the account being worked on to the context, e.g. [Context<steamid64>]
export class AccountLogger extends OtelLoggerService {
  protected override getAdditionalContext(): Record<string, string> {
    const steamid64 = this.getSteamId64();

    return steamid64 ? { steamid64: String(steamid64) } : {};
  }

  protected override formatContext(context: string): string {
    const steamid64 = this.getSteamId64();

    return super.formatContext(
      context && steamid64 ? `${context}<${steamid64}>` : context,
    );
  }

  private getSteamId64(): string | undefined {
    const cls = ClsServiceManager.getClsService();
    const steamid64 = cls.isActive() ? cls.get('steamid64') : undefined;

    return steamid64 === undefined || steamid64 === null
      ? undefined
      : String(steamid64);
  }
}
