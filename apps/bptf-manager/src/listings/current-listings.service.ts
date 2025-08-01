import { RedisService } from '@liaoliaots/nestjs-redis';
import {
  Listing,
  ListingDto,
  ListingError,
  Token,
  ListingLimits,
} from '@tf2-automatic/bptf-manager-data';
import { Redis } from 'ioredis';
import {
  BatchCreateListingResponse,
  BatchDeleteListingResponse,
  BatchUpdateListingResponse,
  DeleteAllListingsResponse,
  DeleteListingsResponse,
  GetListingsResponse,
  UpdateListingBody,
} from './interfaces/bptf.interface';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import SteamID from 'steamid';
import {
  CurrentListingsCreateFailedEvent,
  CurrentListingsCreatedEvent,
  CurrentListingsDeletedEvent,
} from './interfaces/events.interface';
import { Logger } from '@nestjs/common';
import { ListingLimitsService } from './listing-limits.service';
import { FlowProducer, Job, Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import {
  JobData,
  JobName,
  JobType,
} from './interfaces/get-listings.queue.interface';
import { DesiredListing } from './classes/desired-listing.class';
import { pack, unpack } from 'msgpackr';
import assert from 'assert';

export class CurrentListingsService {
  private readonly logger = new Logger(CurrentListingsService.name);

  private readonly producer: FlowProducer = new FlowProducer(this.queue.opts);

  private readonly redis: Redis = this.redisService.getOrThrow();

  constructor(
    private readonly redisService: RedisService,
    private readonly httpService: HttpService,
    private readonly eventEmitter: EventEmitter2,
    private readonly listingLimitsService: ListingLimitsService,
    @InjectQueue('get-listings')
    private readonly queue: Queue<JobData, unknown, JobName>,
  ) {}

  @OnEvent('agents.registered')
  private async agentsRegistered(steamid: SteamID): Promise<void> {
    return this.refreshListings(steamid);
  }

  async refreshListings(steamid: SteamID): Promise<void> {
    const time = Date.now();

    await this.producer.add(
      {
        name: JobType.Done,
        queueName: this.queue.name,
        data: {
          steamid64: steamid.getSteamID64(),
          start: time,
        },
        children: [
          {
            name: JobType.Active,
            queueName: this.queue.name,
            data: {
              steamid64: steamid.getSteamID64(),
              start: time,
            },
          },
          {
            name: JobType.Archived,
            queueName: this.queue.name,
            data: {
              steamid64: steamid.getSteamID64(),
              start: time,
            },
          },
        ],
      },
      {
        queuesOptions: {
          [this.queue.name]: {
            defaultJobOptions: this.queue.defaultJobOptions,
          },
        },
      },
    );
  }

  private async createJob(
    job: Job<JobData, unknown, JobType>,
    skip?: number,
    limit?: number,
    delay?: number,
  ): Promise<void> {
    assert(job.parent, 'Job has no parent');
    assert(job.parent.id, 'Parent has no id');

    await this.queue.add(
      job.name,
      {
        steamid64: job.data.steamid64,
        start: job.data.start,
        skip,
        limit,
      },
      {
        jobId:
          job.data.steamid64 +
          ':' +
          job.name +
          ':' +
          job.data.start +
          ':' +
          skip +
          ':' +
          limit,
        delay,
        parent: {
          id: job.parent.id,
          queue: job.queueQualifiedName,
        },
      },
    );
  }

  async getAllCurrent(steamid: SteamID): Promise<Listing[]> {
    const values = await this.redis.hvalsBuffer(this.getCurrentKey(steamid));

    return values.map((raw) => {
      return unpack(raw) as Listing;
    });
  }

  async getListingsByIds(
    steamid: SteamID,
    ids: string[],
  ): Promise<Map<string, Listing>> {
    const result = new Map<string, Listing>();

    if (ids.length === 0) {
      return result;
    }

    const values = await this.redis.hmgetBuffer(
      this.getCurrentKey(steamid),
      ...ids,
    );

    values.forEach((raw) => {
      if (raw === null) {
        return;
      }

      const listing = unpack(raw) as Listing;

      result.set(listing.id, listing);
    });

    return result;
  }

  async deleteListings(token: Token, ids: string[]) {
    const steamid = new SteamID(token.steamid64);

    this.logger.log(
      'Deleting ' +
        ids.length +
        ' active listing(s) for ' +
        steamid.getSteamID64() +
        '...',
    );

    // Figure out what listings should be deleted from the database
    const exists = await this.redis.smismember(
      this.getCurrentShouldNotDeleteEntryKey(steamid),
      ...ids,
    );

    const limits = await this.listingLimitsService.getLimits(steamid);

    const result = await this._deleteListings(token, ids);

    this.logger.log('Deleted ' + result.deleted + ' active listing(s)');

    await this.deleteTempListings(steamid, ids);

    // Filter out listings that should not be deleted (for example, when deleting active listing because newest was archived)
    const remove =
      exists.length === 0 ? ids : ids.filter((id, index) => !exists[index]);

    // Delete current listings in database
    const transaction = this.redis.multi();

    if (remove.length > 0) {
      // Remove listings from database
      transaction.hdel(this.getCurrentKey(steamid), ...remove);
    }

    // Remove flag that listings should not be deleted
    transaction.srem(this.getCurrentShouldNotDeleteEntryKey(steamid), ...ids);

    if (result.deleted > 0) {
      // Remove old listings from old limits
      this.listingLimitsService.chainableSaveLimits(transaction, steamid, {
        used: Math.max(limits.used - result.deleted, 0),
      });
    }

    await transaction.exec();

    // Publish that the listings have been deleted
    this.eventEmitter.emit('current-listings.deleted', {
      steamid,
      ids,
      isActive: true,
    } satisfies CurrentListingsDeletedEvent);

    return result;
  }

  async deleteArchivedListings(token: Token, ids: string[]) {
    const steamid = new SteamID(token.steamid64);

    this.logger.log(
      'Deleting ' +
        ids.length +
        ' archived listing(s) for ' +
        steamid.getSteamID64() +
        '...',
    );

    const result = await this._deleteArchivedListings(token, ids);

    this.logger.log('Deleted ' + result.deleted + ' archived listing(s)');

    // Delete current listings in database
    await this.redis.hdel(this.getCurrentKey(steamid), ...ids);

    // Publish that the listings have been deleted
    this.eventEmitter.emit('current-listings.deleted', {
      steamid,
      ids,
      isActive: false,
    } satisfies CurrentListingsDeletedEvent);

    return result;
  }

  async createListings(token: Token, desired: DesiredListing[]) {
    const listings: ListingDto[] = [];
    const hashes: string[] = [];

    desired.forEach((d) => {
      listings.push(d.getListing());
      hashes.push(d.getHash());
    });

    const steamid = new SteamID(token.steamid64);

    this.logger.log(
      'Creating ' +
        listings.length +
        ' listing(s) for ' +
        token.steamid64 +
        '...',
    );

    const limits = await this.listingLimitsService.getLimits(steamid);

    const result = await this._createListings(token, listings);

    const ids = new Set<string>();
    for (const listing of result) {
      if (listing.result !== undefined) {
        ids.add(listing.result.id);
      }
    }

    this.logger.log(
      'Created ' + ids.size + ' listing(s) for ' + token.steamid64,
    );

    const mapped: { hash: string; response: BatchCreateListingResponse }[] = [];
    for (const index in result) {
      const hash = hashes[index];
      mapped.push({ hash, response: result[index] });
    }

    await this.handleCreatedListings(steamid, mapped, limits);

    return result;
  }

  private async handleCreatedListings(
    steamid: SteamID,
    responses: { hash: string; response: BatchCreateListingResponse }[],
    limits: ListingLimits,
  ): Promise<void> {
    // Hash -> Listing
    const created: Record<string, Listing> = {};
    // Hash -> Error
    const failed: Record<string, ListingError> = {};

    // Listing ID -> Hash
    const ids: Record<string, string> = {};

    let cap: number | undefined = undefined;

    for (let i = 0; i < responses.length; i++) {
      const hash = responses[i].hash;
      const response = responses[i].response;

      if (response.result !== undefined) {
        const result = response.result;

        const previousHash = ids[result.id];
        const duplicate = previousHash !== undefined;
        if (duplicate) {
          // Listing ID already exists
          // Set the id to point to the newest hash
          ids[result.id] = hash;
          // Remove the previous listing
          delete created[previousHash];
          // Add the previous listing to failed
          failed[previousHash] = ListingError.DuplicateListing;
        }

        created[hash] = result;
      } else {
        const errorMessage = response.error?.message ?? null;

        let error: ListingError = ListingError.Unknown;

        const listingCapMatch = errorMessage?.match(
          /\((\d+)\/(\d+)\slistings\)/,
        );

        if (listingCapMatch) {
          error = ListingError.CapExceeded;

          const [, , capStr] = listingCapMatch;
          cap = parseInt(capStr);
        } else if (
          errorMessage ===
          'Listing cap reached; short-circuiting this attempt to create a listing.'
        ) {
          error = ListingError.CapExceeded;
        } else if (
          errorMessage === 'Item is invalid.' ||
          errorMessage?.startsWith('Warning: ')
        ) {
          error = ListingError.InvalidItem;
        } else if (errorMessage === '') {
          error = ListingError.ItemDoesNotExist;
        } else if (
          errorMessage === 'Listing value cannot be zero.' ||
          errorMessage === 'Cyclic currency value'
        ) {
          error = ListingError.InvalidCurrencies;
        }

        failed[hash] = error;
      }
    }

    const createdHashes = Object.keys(created);

    const mapped = this.mapListings(Object.values(created));
    await this.saveTempListings(steamid, mapped);

    const transaction = this.redis.multi();

    // Save current listings to database
    if (createdHashes.length > 0) {
      // Check for listings that already existed
      const existing = await this.getListingsByIds(
        steamid,
        createdHashes.map((hash) => created[hash].id),
      );

      const existingListings = new Set();

      Array.from(existing.values()).forEach((l) => {
        if (l.archived !== true) {
          existingListings.add(l.id);
        }
      });

      const newListings = createdHashes.length - existingListings.size;

      if (newListings > 0) {
        // Add new listings to old limit
        this.listingLimitsService.chainableSaveLimits(transaction, steamid, {
          used: Math.max(newListings + limits.used, 0),
        });
      }

      transaction.hmset(
        this.getCurrentKey(steamid),
        ...createdHashes.flatMap((hash) => [
          created[hash].id,
          pack(created[hash]),
        ]),
      );
    }

    if (cap !== undefined) {
      this.listingLimitsService.chainableSaveLimits(transaction, steamid, {
        cap,
      });

      // Queue limits to be refreshed
      await this.listingLimitsService.refreshLimits(steamid);
    }

    await transaction.exec();

    const promises: Promise<unknown>[] = [];

    if (Object.keys(failed).length > 0) {
      promises.push(
        this.eventEmitter.emitAsync('current-listings.failed', {
          steamid,
          errors: failed,
        } satisfies CurrentListingsCreateFailedEvent),
      );
    }

    if (Object.keys(created).length > 0) {
      promises.push(
        this.eventEmitter.emitAsync('current-listings.created', {
          steamid,
          listings: created,
        } satisfies CurrentListingsCreatedEvent),
      );
    }

    await Promise.all(promises);
  }

  async updateListings(
    token: Token,
    desired: DesiredListing[],
  ): Promise<BatchUpdateListingResponse> {
    const listings: UpdateListingBody[] = [];

    const idToHash = new Map<string, string>();

    desired.forEach((d) => {
      const id = d.getID();
      if (!id) {
        return;
      }

      const listing = d.getListing();

      idToHash.set(id, d.getHash());
      listings.push({
        id,
        body: {
          currencies: listing.currencies,
          details: listing.details,
        },
      });
    });

    const steamid = new SteamID(token.steamid64);

    this.logger.log(
      'Updating ' +
        listings.length +
        ' listing(s) for ' +
        steamid.getSteamID64() +
        '...',
    );

    const result = await this._updateListings(token, listings);

    this.logger.log(
      'Updated ' + result.updated.length + ' listing(s) for ' + token.steamid64,
    );

    const updated = new Map<string, Listing>();
    result.updated.forEach((listing) => {
      updated.set(listing.id, listing);
    });

    if (updated.size !== 0) {
      // Update current listings in database
      const current = await this.getListingsByIds(
        steamid,
        Array.from(updated.keys()),
      );

      // Loop through the current listings and overwrite properties with the updated listing
      const overwritten: Listing[] = [];

      for (const id in current.keys()) {
        overwritten.push({ ...current[id], ...updated.get(id) });
      }

      if (overwritten.length > 0) {
        const mapped = this.mapListings(overwritten);

        await this.saveTempListings(steamid, mapped);

        await this.redis.hmset(this.getCurrentKey(steamid), mapped);
      }
    }

    const mapped = result.updated.reduce(
      (acc, cur) => {
        const hash = idToHash.get(cur.id);
        if (hash) {
          acc[hash] = cur;
        }
        return acc;
      },
      {} as Record<string, Listing>,
    );

    await this.eventEmitter.emitAsync('current-listings.updated', {
      steamid,
      listings: mapped,
    } satisfies CurrentListingsCreatedEvent);

    return result;
  }

  async deleteAllListings(token: Token): Promise<number> {
    this.logger.log('Deleting all listings for ' + token.steamid64 + '...');

    const [active, archived] = await Promise.all([
      this._deleteAllActiveListings(token),
      this._deleteAllArchivedListings(token),
    ]);

    this.logger.log(
      'Deleted ' +
        active.deleted +
        ' active and ' +
        archived.deleted +
        ' archived listing(s) for ' +
        token.steamid64,
    );

    const steamid = new SteamID(token.steamid64);

    const transaction = this.redis.multi();

    // Delete all listings in database
    transaction.del(this.getCurrentKey(steamid));

    // Clear used listings
    this.listingLimitsService.chainableClearUsed(transaction, steamid);

    await transaction.exec();

    this.eventEmitter.emitAsync('current-listings.deleted-all', steamid);

    return active.deleted + archived.deleted;
  }

  async handleListingsResponse(
    job: Job<JobData, unknown, JobType>,
    response: GetListingsResponse,
  ): Promise<void> {
    const steamid = new SteamID(job.data.steamid64);

    if (job.name === JobType.Active) {
      // Update used listings using total returned in the response
      await this.listingLimitsService.saveLimits(steamid, {
        used: response.cursor.total,
      });
    }

    const tempKey = this.getTempCurrentKey(steamid, job.data.start);

    if (response.results.length > 0) {
      const mapped = this.mapListings(response.results);
      await this.saveTempListings(steamid, mapped);

      // Add listings to current temp key
      await this.redis
        .multi()
        .hmset(tempKey, this.mapListings(response.results))
        // Make sure it expires after 5 minutes
        .expire(tempKey, 5 * 60)
        .exec();
    }

    if (response.cursor.skip + response.cursor.limit < response.cursor.total) {
      // Fetch more listings
      return this.createJob(
        job,
        response.cursor.skip + response.cursor.limit,
        response.cursor.limit,
      );
    }
  }

  async handleListingsFetched(steamid: SteamID, time: number): Promise<void> {
    const tempKey = this.getTempCurrentKey(steamid, time);

    // Check if a temp key exists
    const exists = await this.redis.exists(tempKey);

    const transaction = this.redis.multi();

    if (exists) {
      // It exists, copy it to the current key and remove expiration
      transaction
        .copy(tempKey, this.getCurrentKey(steamid), 'REPLACE')
        .persist(this.getCurrentKey(steamid));
    } else {
      // It does not exist, delete current key
      transaction.del(this.getCurrentKey(steamid));
    }

    await transaction.exec();

    // Publish that the listings have been refreshed (we don't delete temp key because it will expire anyway)
    await this.eventEmitter.emitAsync('current-listings.refreshed', steamid);
  }

  private async saveTempListings(
    steamid: SteamID,
    listings: Record<string, Buffer>,
  ): Promise<void> {
    if (Object.keys(listings).length === 0) {
      return;
    }

    const keys = await this.redis.keys(this.getTempCurrentKey(steamid, '*'));

    const transaction = this.redis.multi();

    // Add listings to all temp keys for this steamid
    keys.forEach((key) => {
      transaction.hmset(key, listings);
    });

    await transaction.exec();
  }

  private async deleteTempListings(
    steamid: SteamID,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const keys = await this.redis.keys(this.getTempCurrentKey(steamid, '*'));

    const transaction = this.redis.multi();

    // Add listings to all temp keys for this steamid
    keys.forEach((key) => {
      transaction.hdel(key, ...ids);
    });

    await transaction.exec();
  }

  private mapListings(listings: Listing[]): Record<string, Buffer> {
    const mapped: Record<string, Buffer> = {};

    listings.forEach((listing) => {
      mapped[listing.id] = pack(listing);
    });

    return mapped;
  }

  private _createListings(
    token: Token,
    listings: ListingDto[],
  ): Promise<BatchCreateListingResponse[]> {
    return firstValueFrom(
      this.httpService.post<BatchCreateListingResponse[]>(
        'https://api.backpack.tf/api/v2/classifieds/listings/batch',
        listings,
        {
          headers: {
            'X-Auth-Token': token.value,
          },
          timeout: 60000,
        },
      ),
    ).then((response) => {
      return response.data;
    });
  }

  private _updateListings(
    token: Token,
    listings: UpdateListingBody[],
  ): Promise<BatchUpdateListingResponse> {
    return firstValueFrom(
      this.httpService.patch<BatchUpdateListingResponse>(
        'https://api.backpack.tf/api/v2/classifieds/listings/batch',
        listings,
        {
          headers: {
            'X-Auth-Token': token.value,
          },
          timeout: 60000,
        },
      ),
    ).then((response) => {
      return response.data;
    });
  }

  private _deleteListings(
    token: Token,
    ids: string[],
  ): Promise<DeleteListingsResponse> {
    return firstValueFrom(
      this.httpService.delete<DeleteListingsResponse>(
        'https://api.backpack.tf/api/classifieds/delete/v1',
        {
          data: {
            listing_ids: ids,
          },
          headers: {
            'X-Auth-Token': token.value,
          },
          timeout: 60000,
        },
      ),
    ).then((response) => {
      return response.data;
    });
  }

  private _deleteArchivedListings(
    token: Token,
    ids: string[],
  ): Promise<BatchDeleteListingResponse> {
    return firstValueFrom(
      this.httpService.delete<BatchDeleteListingResponse>(
        'https://api.backpack.tf/api/v2/classifieds/archive/batch',
        {
          data: {
            ids,
          },
          headers: {
            'X-Auth-Token': token.value,
          },
          timeout: 60000,
        },
      ),
    ).then((response) => {
      return response.data;
    });
  }

  private _deleteAllActiveListings(
    token: Token,
  ): Promise<DeleteAllListingsResponse> {
    return firstValueFrom(
      this.httpService.delete<DeleteAllListingsResponse>(
        'https://api.backpack.tf/api/v2/classifieds/listings',
        {
          headers: {
            'X-Auth-Token': token.value,
          },
          timeout: 60000,
        },
      ),
    ).then((response) => {
      return response.data;
    });
  }

  private _deleteAllArchivedListings(
    token: Token,
  ): Promise<DeleteAllListingsResponse> {
    return firstValueFrom(
      this.httpService.delete<DeleteAllListingsResponse>(
        'https://api.backpack.tf/api/v2/classifieds/archive',
        {
          headers: {
            'X-Auth-Token': token.value,
          },
          timeout: 60000,
        },
      ),
    ).then((response) => {
      return response.data;
    });
  }

  fetchActiveListings(
    token: Token,
    skip?: number,
    limit = 1000,
  ): Promise<GetListingsResponse> {
    return firstValueFrom(
      this.httpService.get<GetListingsResponse>(
        'https://api.backpack.tf/api/v2/classifieds/listings',
        {
          params: {
            skip,
            limit,
          },
          headers: {
            'X-Auth-Token': token.value,
          },
          timeout: 60000,
        },
      ),
    ).then((response) => {
      return response.data;
    });
  }

  fetchArchivedListings(
    token: Token,
    skip?: number,
    limit = 1000,
  ): Promise<GetListingsResponse> {
    return firstValueFrom(
      this.httpService.get<GetListingsResponse>(
        'https://api.backpack.tf/api/v2/classifieds/archive',
        {
          params: {
            skip,
            limit,
          },
          headers: {
            'X-Auth-Token': token.value,
          },
          timeout: 60000,
        },
      ),
    ).then((response) => {
      return response.data;
    });
  }

  private getCurrentKey(steamid: SteamID): string {
    return `listings:current:${steamid.getSteamID64()}`;
  }

  private getTempCurrentKey(steamid: SteamID, time: number | '*'): string {
    return this.getCurrentKey(steamid) + ':' + time;
  }

  getCurrentShouldNotDeleteEntryKey(steamid: SteamID): string {
    return `listings:current:keep:${steamid.getSteamID64()}`;
  }
}
