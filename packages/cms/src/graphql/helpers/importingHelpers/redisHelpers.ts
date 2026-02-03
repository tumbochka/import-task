import {
  completedImportingData,
  importingMetadata,
  importingProcessedFieldsCount,
  importingTotalFieldsCount,
  spoiledImportingData,
  updatingImportingData,
} from './../../../api/redis/helpers/variables/importingVariables';
import redis from './../../../api/redis/redis';

export const setImportingTotalFieldsCount = async (
  regexedId,
  tenantId,
  parsedRowsLength,
  importIdentifier,
) => {
  const key = importingTotalFieldsCount(regexedId, tenantId, importIdentifier);
  await redis.set(key, parsedRowsLength - 1 ?? 0);
};

export const updateRedisImportData = async (
  generatedRegex,
  tenantFilter,
  updatedJson,
  importIdentifier,
  importingDataGenerator,
) => {
  const tenant = tenantFilter?.tenant;
  await redis.lpush(
    importingDataGenerator(generatedRegex, tenant, importIdentifier),
    updatedJson,
  );

  await redis.incr(
    importingProcessedFieldsCount(generatedRegex, tenant, importIdentifier),
  );
};

export const updateImportingMetadata = async (
  regexedId,
  tenantId,
  spoiledFields,
  metadata,
  importIdentifier,
) => {
  await redis.hset(
    importingMetadata(regexedId, tenantId, importIdentifier),
    metadata,
  );

  for (let i = 0; i < spoiledFields?.length; i++) {
    const spoiledFieldJSON = JSON.stringify(spoiledFields?.[i] ?? []);
    await updateRedisImportData(
      regexedId,
      { tenant: tenantId },
      spoiledFieldJSON,
      importIdentifier,
      spoiledImportingData,
    );
  }
};

const safeJsonParse = <T,>(s: string): T | null => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export const loadImportingList = async <T,>(
  generatedRegex: string,
  tenantId: number | string,
  importIdentifier: string,
  generator: (generatedRegex: string, tenantId: number | string, importIdentifier: string) => string,
): Promise<T[]> => {
  const key = generator(generatedRegex, tenantId, importIdentifier);
  const raw = await redis.lrange(key, 0, -1);
  // LPUSH => порядок зворотній, але для репорту не критично.
  // Якщо хочеш "як у CSV" — зроби raw.reverse().
  return raw
    .map((x) => safeJsonParse<T>(x))
    .filter((x): x is T => Boolean(x));
};

export const loadAllImportingResults = async (
  generatedRegex: string,
  tenantId: number | string,
  importIdentifier: string,
) => {
  const [spoiled, completed, updating] = await Promise.all([
    loadImportingList<any>(generatedRegex, tenantId, importIdentifier, spoiledImportingData),
    loadImportingList<any>(generatedRegex, tenantId, importIdentifier, completedImportingData),
    loadImportingList<any>(generatedRegex, tenantId, importIdentifier, updatingImportingData),
  ]);

  return { spoiled, completed, updating };
};
