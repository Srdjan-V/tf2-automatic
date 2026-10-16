import { Controller, Get, Param, ParseBoolPipe, Query } from '@nestjs/common';
import { InventoriesService } from './inventories.service';
import { INVENTORIES_BASE_URL, INVENTORY_PATH } from '@tf2-automatic/bot-data';
import { ParseSteamIDPipe } from '@tf2-automatic/nestjs-steamid-pipe';
import SteamID from 'steamid';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ItemModel, ApiParamSteamID } from '@tf2-automatic/swagger';

@ApiTags('Inventories')
@Controller(INVENTORIES_BASE_URL)
export class InventoriesController {
  constructor(private readonly inventoriesService: InventoriesService) {}

  @Get(INVENTORY_PATH)
  @ApiOperation({
    summary: 'Get inventory',
    description: 'Get the inventory of a Steam account',
  })
  @ApiParamSteamID()
  @ApiParam({
    name: 'appid',
    description: 'The appid of the game',
    example: 440,
  })
  @ApiParam({
    name: 'contextid',
    description: 'The contextid of the inventory',
    example: 2,
  })
  @ApiQuery({
    name: 'tradableOnly',
    description:
      'Set to false to include non-tradable items in the response. Defaults to true',
    example: true,
    required: false,
  })
  @ApiQuery({
    name: 'failFast',
    description:
      'Set to true to get a 429 instead of waiting while inventory requests back off. Defaults to false',
    example: false,
    required: false,
  })
  @ApiOkResponse({
    type: [ItemModel],
  })
  getInventory(
    @Param('steamid', new ParseSteamIDPipe()) steamid: SteamID,
    @Param('appid') appid: number,
    @Param('contextid') contextid: number,
    @Query('tradableOnly', new ParseBoolPipe({ optional: true }))
    tradableOnly?: boolean,
    @Query('failFast', new ParseBoolPipe({ optional: true }))
    failFast?: boolean,
  ) {
    return this.inventoriesService.getInventory(
      steamid,
      appid,
      contextid,
      tradableOnly,
      failFast,
    );
  }
}
