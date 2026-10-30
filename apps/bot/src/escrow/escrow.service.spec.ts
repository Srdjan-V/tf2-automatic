import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import SteamID from 'steamid';
import { ETradeOfferState } from 'steam-user';
import { EscrowService } from './escrow.service';
import { BotService } from '../bot/bot.service';
import { FriendsService } from '../friends/friends.service';
import { TradesService } from '../trades/trades.service';

describe('EscrowService', () => {
  let service: EscrowService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: EscrowService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<EscrowService>(EscrowService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('EscrowService with an offer id', () => {
  const partner = new SteamID('76561198120070906');

  function createService(state: ETradeOfferState) {
    const getUserDetails = jest.fn();
    const service = new EscrowService(
      { getManager: () => ({}) } as unknown as BotService,
      {
        isFriend: jest.fn().mockResolvedValue(false),
      } as unknown as FriendsService,
      {
        getActualOffer: jest
          .fn()
          .mockResolvedValue({ isOurOffer: false, partner, state }),
        getUserDetails,
      } as unknown as TradesService,
    );
    return { service, getUserDetails };
  }

  it('rejects an offer that is no longer active without asking Steam', async () => {
    const { service, getUserDetails } = createService(
      ETradeOfferState.Declined,
    );

    await expect(
      service.getEscrowDuration(partner, undefined, '1001'),
    ).rejects.toThrow(new BadRequestException('Offer is no longer active'));
    expect(getUserDetails).not.toHaveBeenCalled();
  });
});
