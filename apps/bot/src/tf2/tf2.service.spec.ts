import { EventEmitter } from 'events';
import { TF2Service } from './tf2.service';
import { BotService } from '../bot/bot.service';
import { EventsService } from '../events/events.service';

describe('TF2Service', () => {
  let botService: { getClient: jest.Mock; joinGame: jest.Mock };
  let service: TF2Service;
  // The node-tf2 instance the service wraps
  let tf2: EventEmitter & { haveGCSession: boolean; backpack?: unknown[] };

  beforeEach(() => {
    // node-tf2 only accepts a client that names itself steam-user
    const client = Object.assign(new EventEmitter(), {
      packageName: 'steam-user',
      packageVersion: '5.0.0',
    });
    botService = {
      getClient: jest.fn().mockReturnValue(client),
      joinGame: jest.fn().mockReturnValue(true),
    };
    service = new TF2Service(
      botService as unknown as BotService,
      {} as EventsService,
    );
    tf2 = (service as unknown as { tf2: typeof tf2 }).tf2;
  });

  it('returns the backpack without joining again when connected', async () => {
    tf2.haveGCSession = true;
    tf2.backpack = [{ id: '1' }];

    await expect(service.getBackpack()).resolves.toEqual([{ id: '1' }]);
    // Only the join from the constructor
    expect(botService.joinGame).toHaveBeenCalledTimes(1);
  });

  it('joins the game again and loads a fresh backpack without a GC session', async () => {
    // A backpack kept from an earlier session, while Steam ignored the join
    tf2.haveGCSession = false;
    tf2.backpack = [{ id: 'stale' }];

    const backpack = service.getBackpack();
    expect(botService.joinGame).toHaveBeenCalledTimes(2);

    tf2.haveGCSession = true;
    tf2.emit('connectedToGC');
    tf2.backpack = [{ id: 'fresh' }];
    tf2.emit('backpackLoaded');

    await expect(backpack).resolves.toEqual([{ id: 'fresh' }]);
  });
});
