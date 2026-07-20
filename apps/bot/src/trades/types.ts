import TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer';
import SteamUser from 'steam-user';

export interface TradeOfferData {
  published?: SteamUser.ETradeOfferState;
  conf?: number;
  accept?: number;
  missing?: number;
  // Last non-None confirmationMethod Steam reported for this offer. Persisted here (in
  // pollData.offerData, which survives every re-fetch) so a later poll that omits the field
  // cannot silently downgrade the cached confirmationMethod to None while a confirmation is
  // still outstanding. See reconcileConfirmationMethod in trades.service.
  lastConfirmationMethod?: SteamUser.ETradeOfferConfirmationMethod;
}

export type CreatedTradeOffer = TradeOffer & {
  id: string;
};

export type ActiveTradeOffer = CreatedTradeOffer & {
  state: SteamUser.ETradeOfferState.Active;
};

export type TheirTradeOffer = CreatedTradeOffer & {
  isOurOffer: false;
};
