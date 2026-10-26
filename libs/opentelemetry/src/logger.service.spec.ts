jest.mock('@tf2-automatic/config', () => ({
  getOtelConfig: () => ({ logs: { enabled: true } }),
}));

import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { OtelLoggerService } from './logger.service';

describe('OtelLoggerService error records', () => {
  it('exports the error message, stack, and context separately', () => {
    const emit = jest.fn();
    jest.spyOn(logs, 'getLogger').mockReturnValue({ emit } as never);
    const logger = new OtelLoggerService();
    const error = new Error('database unavailable');

    logger.error(`Error in worker: ${error.message}`, error.stack);

    const record = emit.mock.calls[0][0];

    expect(record).toEqual({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error in worker: database unavailable',
      attributes: {
        'exception.stacktrace': error.stack,
      },
    });
  });

  it('exports the stack that a warning passes before the context', () => {
    const emit = jest.fn();
    jest.spyOn(logs, 'getLogger').mockReturnValue({ emit } as never);
    const logger = new OtelLoggerService();
    const error = new Error('request failed');

    // What Nest's Logger forwards for new Logger('Ctx').warn(msg, stack)
    logger.warn('Listing request failed', error.stack, 'Ctx');

    expect(emit.mock.calls[0][0]).toEqual({
      severityNumber: SeverityNumber.WARN,
      severityText: 'WARN',
      body: 'Listing request failed',
      attributes: {
        'code.namespace': 'Ctx',
        'exception.stacktrace': error.stack,
      },
    });
  });
});
