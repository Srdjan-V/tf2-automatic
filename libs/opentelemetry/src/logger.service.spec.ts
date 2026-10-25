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
});
