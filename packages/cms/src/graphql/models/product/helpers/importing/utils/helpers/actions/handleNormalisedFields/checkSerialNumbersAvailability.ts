import { handleError } from './../../../../../../../../../graphql/helpers/errors';

export const checkSerialNumbersAvailability = async ({
  serialNumbers,
  tenantFilter,
}) => {
  if (!serialNumbers || serialNumbers?.length === 0)
    return { isAllSerialNumbersAvailable: true, existedSerialNumbers: [] };

  try {
    // take all serial numbers
    const existedSerialNumbers = await strapi.entityService.findMany(
      'api::inventory-serialize.inventory-serialize',
      {
        filters: {
          ...tenantFilter,
          name: { $in: serialNumbers },
        },
        fields: ['id'],
        populate: {
          sellingProductOrderItem: {
            fields: ['id'],
          },
          returnItem: {
            fields: ['id'],
          },
          inventoryAdjustmentItem: {
            fields: ['id'],
          },
          transferOrderItem: {
            fields: ['id'],
          },
          productInventoryItem: {
            fields: ['id'],
          },
        },
      },
    );

    const isAllSerialNumbersAvailable = existedSerialNumbers.every(
      (serialNumber) => {
        const hasRelations =
          serialNumber?.sellingProductOrderItem?.id ||
          serialNumber?.returnItem?.id ||
          serialNumber?.inventoryAdjustmentItem?.id ||
          serialNumber?.transferOrderItem?.id ||
          serialNumber?.productInventoryItem?.id;

        return !hasRelations;
      },
    );
    // check that none of these serial numbers has relations
    return { isAllSerialNumbersAvailable, existedSerialNumbers };
  } catch (e) {
    handleError('checkSerialNumbersAvailability', undefined, e);
  }
};

export const checkSerialNumbersAvailabilityBulk = async ({
  serialNumbers,
  tenantFilter,
}: {
  serialNumbers: string[];
  tenantFilter: any;
}) => {
  const unique = Array.from(
    new Set(serialNumbers.filter(Boolean).map((s) => String(s).trim())),
  );

  if (unique.length === 0) {
    return { busySerials: new Set<string>() };
  }

  const existed = await strapi.entityService.findMany(
    'api::inventory-serialize.inventory-serialize',
    {
      filters: {
        ...tenantFilter,
        name: { $in: unique },
      },
      fields: ['name'],
      populate: {
        sellingProductOrderItem: { fields: ['id'] },
        returnItem: { fields: ['id'] },
        inventoryAdjustmentItem: { fields: ['id'] },
        transferOrderItem: { fields: ['id'] },
        productInventoryItem: { fields: ['id'] },
      },
    },
  );

  const busySerials = new Set<string>();

  for (const sn of existed as any[]) {
    const name = String(sn?.name ?? '').trim();
    if (!name) continue;

    const hasRelations =
      sn?.sellingProductOrderItem?.id ||
      sn?.returnItem?.id ||
      sn?.inventoryAdjustmentItem?.id ||
      sn?.transferOrderItem?.id ||
      sn?.productInventoryItem?.id;

    if (hasRelations) busySerials.add(name);
  }

  return { busySerials };
};
