import redis from '../../redis';
import { PRODUCTS_IMPORT_IDENTIFIER } from '../variables/importingVariables';

const keyBase = (generatedRegex: string, tenantId: number | string) =>
  `${PRODUCTS_IMPORT_IDENTIFIER}:${tenantId}:${generatedRegex}`;

export const setChunksTotal = async (
  generatedRegex: string,
  tenantId: number | string,
  total: number,
) => {
  await redis.set(`${keyBase(generatedRegex, tenantId)}:chunksTotal`, String(total));
  await redis.set(`${keyBase(generatedRegex, tenantId)}:chunksDone`, '0');
};

export const incrChunksDone = async (
  generatedRegex: string,
  tenantId: number | string,
) => {
  const v = await redis.incr(`${keyBase(generatedRegex, tenantId)}:chunksDone`);
  return Number(v);
};

export const getChunksTotal = async (
  generatedRegex: string,
  tenantId: number | string,
) => {
  const v = await redis.get(`${keyBase(generatedRegex, tenantId)}:chunksTotal`);
  return v ? Number(v) : 0;
};

export const getChunksDone = async (
  generatedRegex: string,
  tenantId: number | string,
) => {
  const v = await redis.get(`${keyBase(generatedRegex, tenantId)}:chunksDone`);
  return v ? Number(v) : 0;
};

export const addProductTimes = async (
  generatedRegex: string,
  tenantId: number | string,
  productTimes: number[],
) => {
  if (productTimes.length === 0) return;

  const key = `${keyBase(generatedRegex, tenantId)}:productTimes`;
  const values = productTimes.map(t => String(t));
  if (values.length > 0) {
    await redis.rpush(key, ...values);
  }
};

export const getAllProductTimes = async (
  generatedRegex: string,
  tenantId: number | string,
): Promise<number[]> => {
  const key = `${keyBase(generatedRegex, tenantId)}:productTimes`;
  const raw = await redis.lrange(key, 0, -1);
  return raw.map(v => Number(v)).filter(v => !isNaN(v));
};

export const clearProductTimes = async (
  generatedRegex: string,
  tenantId: number | string,
) => {
  const key = `${keyBase(generatedRegex, tenantId)}:productTimes`;
  await redis.del(key);
};

