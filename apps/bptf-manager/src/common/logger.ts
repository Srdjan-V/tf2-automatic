import { OtelLoggerService } from '@tf2-automatic/opentelemetry';
import { ClsServiceManager } from 'nestjs-cls';

// Adds the account being worked on to the context, e.g. [Context<steamid64>]
export class AccountLogger extends OtelLoggerService {
  protected override formatContext(context: string): string {
    const cls = ClsServiceManager.getClsService();
    const steamid64 = cls.isActive() ? cls.get('steamid64') : undefined;

    return super.formatContext(
      context && steamid64 ? `${context}<${steamid64}>` : context,
    );
  }
}
