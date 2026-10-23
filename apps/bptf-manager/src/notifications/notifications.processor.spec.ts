import { AxiosError, AxiosHeaders } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { failOnClientError } from './notifications.processor';

function axiosError(status: number): AxiosError {
  return new AxiosError('Request failed', undefined, undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {},
  });
}

describe('failOnClientError', () => {
  it.each([400, 401, 403, 404])('makes %i unrecoverable', (status) => {
    expect(() => failOnClientError(axiosError(status))).toThrow(
      UnrecoverableError,
    );
  });

  it.each([429, 500, 503])('rethrows %i for a retry', (status) => {
    const err = axiosError(status);

    expect(() => failOnClientError(err)).toThrow(err);
    expect(() => failOnClientError(err)).not.toThrow(UnrecoverableError);
  });

  it('rethrows errors without a response', () => {
    const err = new Error('socket hang up');

    expect(() => failOnClientError(err)).toThrow(err);
  });
});
