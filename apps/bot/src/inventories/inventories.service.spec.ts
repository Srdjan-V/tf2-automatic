import { ConfigService } from '@nestjs/config';
import SteamCommunity from 'steamcommunity';
import SteamID from 'steamid';
import { BotService, PreHttpRequestHook } from '../bot/bot.service';
import { Config } from '../common/config/configuration';
import { InventoriesService } from './inventories.service';

// A real SteamCommunity against a fake Steam inventory of 2500 items, 1000 per
// page; every second item is tradable
function fakeCommunity(status = 200) {
  const requests: { start?: string; at: number }[] = [];
  const community = new SteamCommunity();

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore the typings do not include the request function
  community.request = (
    options: { qs: { start_assetid?: string; count: number } },
    callback: (err: Error | null, response: unknown, body: unknown) => void,
  ) => {
    requests.push({ start: options.qs.start_assetid, at: Date.now() });
    if (status !== 200) {
      return callback(null, { statusCode: status }, null);
    }

    const first = Number(options.qs.start_assetid ?? 0) + 1;
    const last = Math.min(first + options.qs.count - 1, 2500);
    const assets: { assetid: string; classid: string }[] = [];
    for (let id = first; id <= last; id++) {
      assets.push({ assetid: String(id), classid: String(id % 2) });
    }

    callback(
      null,
      { statusCode: 200 },
      {
        success: 1,
        assets,
        descriptions: [
          { classid: '0', tradable: 1 },
          { classid: '1', tradable: 0 },
        ],
        more_items: last < 2500 ? 1 : undefined,
        last_assetid: String(last),
      },
    );
  };

  return { community, requests };
}

function service(community: SteamCommunity, minTime: number) {
  const botService = {
    setPreHttpRequestHook: (hook: PreHttpRequestHook) => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore the typings do not include the hook
      community.onPreHttpRequest = (_, __, options, continueRequest) => {
        hook(options).then(() => continueRequest());
        return true;
      };
    },
    getSteamID64: () => '76561198000000000',
    getManager: () => ({
      getUserInventoryContents: (
        ...args: Parameters<SteamCommunity['getUserInventoryContents']>
      ) => community.getUserInventoryContents(...args),
    }),
  } as unknown as BotService;
  const configService = {
    getOrThrow: () => ({ minTime, rateLimitKey: 'test' }),
  } as unknown as ConfigService<Config>;

  return new InventoriesService(botService, configService);
}

describe('InventoriesService', () => {
  it('finishes a started inventory and spaces every page', async () => {
    const { community, requests } = fakeCommunity();
    const inventories = service(community, 50);

    const [first] = await Promise.all([
      inventories.getInventory(new SteamID('76561198000000001'), 440, 2),
      inventories.getInventory(new SteamID('76561198000000002'), 440, 2),
    ]);

    expect(first).toHaveLength(1250);
    expect(requests.map((request) => request.start)).toEqual([
      undefined,
      '1000',
      '2000',
      undefined,
      '1000',
      '2000',
    ]);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].at - requests[i - 1].at).toBeGreaterThanOrEqual(49);
    }
  });

  it('fails fast while backing off only when asked to', async () => {
    const { community, requests } = fakeCommunity(429);
    const inventories = service(community, 0);
    const steamid = new SteamID('76561198000000001');

    await expect(inventories.getInventory(steamid, 440, 2)).rejects.toThrow(
      'Steam returned HTTP error 429',
    );
    await expect(
      inventories.getInventory(steamid, 440, 2, true, true),
    ).rejects.toThrow('backing off');
    expect(requests).toHaveLength(1);
  });
});
