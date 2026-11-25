import { DataTypes } from 'sequelize';
import { db, ChannelChangeTicket, ChannelChangeRecord } from '../models.js';

export async function migrateChannelChangeTickets() {
  await ChannelChangeTicket.sync();
  await ChannelChangeRecord.sync();
  const query = db.getQueryInterface();
  const ticketColumns = await query.describeTable('channel_change_tickets');
  for (const key of ['beforePurchase', 'targetPurchase', 'executedBefore', 'executedAfter']) {
    if (!ticketColumns[key])
      await query.addColumn('channel_change_tickets', key, {
        type: DataTypes.JSON,
        allowNull: true,
      });
  }
  const columns = await query.describeTable('after_sale_notifications');
  if (!columns.channelChangeRecordId) {
    await query.addColumn('after_sale_notifications', 'channelChangeRecordId', {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      unique: true,
    });
  }
  if (!columns.recordId.allowNull) {
    await query.changeColumn('after_sale_notifications', 'recordId', {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    });
  }
}
