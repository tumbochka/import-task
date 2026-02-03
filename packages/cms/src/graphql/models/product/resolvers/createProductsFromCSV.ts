import {errors} from '@strapi/utils';
import {GraphQLFieldResolver} from 'graphql';
import {
  checkRedisConnection
} from '../../../../api/redis/redis/utils/checkRedisConnection';
import {
  csvProductsToJSON
} from '../helpers/importing/utils/helpers/csvProductsToJSON';
import {
  PRODUCTS_IMPORT_IDENTIFIER
} from './../../../../api/redis/helpers/variables/importingVariables';
import {redisConfig} from './../../../../api/redis/redis';
import {NexusGenInputs} from './../../../../types/generated/graphql';
import {generateId} from './../../../../utils/randomBytes';
import {handleError, handleLogger} from './../../../helpers/errors';
import {parseAndProcessCSV} from './../../../helpers/importingHelpers/utils';
import {getTenantFilter} from './../../dealTransaction/helpers/helpers';
import {
  handleNormalisedProductsFields
} from './../helpers/importing/utils/helpers/handleNormalisedFields';

import {Worker} from 'bullmq';
import productsImportFieldsQueue from './../../../../api/redis/bullmq/products';
import {
  updateImportingSessionJobId
} from './../../../../api/redis/helpers/utils/updateImportingSession';
import {
  handleCsvProcessingError
} from './../../../helpers/importingHelpers/errorHandler';
import {
  createImportingSession,
  handleCsvUpload, processAndUpdateImports,
} from './../../../helpers/importingHelpers/fileHelper';
import {
  loadAllImportingResults,
  setImportingTotalFieldsCount,
  updateImportingMetadata,
} from './../../../helpers/importingHelpers/redisHelpers';
import {
  processProductsImport
} from "../helpers/createProductsFromCSV/generateImportReport";
import {
  setChunksTotal,
  incrChunksDone,
  getChunksTotal,
  getChunksDone,
  addProductTimes,
  getAllProductTimes,
  clearProductTimes,
} from './../../../../api/redis/helpers/utils/importChunksCounter';


const {ApplicationError} = errors;

const chunkArray = <T, >(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const worker = new Worker(
  PRODUCTS_IMPORT_IDENTIFIER,
  async (job) => {
    if (job.name === 'products-chunk') {
      const {
        normalizedFields,
        meta: {tenantFilter, userId, generatedRegex, customFieldsArr},
        maxCounts: {maxProductsCount, maxImagesCount, maxSerialNumbersCount},
        config,
        currentSessionId,
        chunkIndex,
        chunksTotal,
        totalProducts,
      } = job.data;

      await updateImportingSessionJobId(currentSessionId, job.id);
      console.log(
        `IMPORT_CHUNK_START: chunk=${chunkIndex + 1}/${chunksTotal}, size=${normalizedFields.length}, totalProducts=${totalProducts}`,
      );
      const result = await handleNormalisedProductsFields(
        normalizedFields,
        {
          spoiledCreations: [],
          completedCreations: [],
          needChangeCreations: [],
        },
        {tenantFilter, userId, isRedis: true, generatedRegex},
        {
          maxImagesCount,
          customFieldsArr,
          maxProductsCount,
          maxSerialNumbersCount,
        },
        config,
        currentSessionId,
        {
          skipFinalize: true,
          skipLogs: true,
          totalProducts,
        },
      );

      const tenantId = tenantFilter?.tenant;
      if (result?.productTimes && result.productTimes.length > 0) {
        await addProductTimes(generatedRegex, tenantId, result.productTimes);
      }
      const chunksDone = await incrChunksDone(generatedRegex, tenantId);
      const approxProcessed = Math.min(
        (chunksDone * normalizedFields.length),
        totalProducts,
      );
      console.log(
        `IMPORT_CHUNK_COMPLETE: chunk=${chunkIndex + 1}/${chunksTotal}`,
      );

      console.log(
        `IMPORT_SESSION_PROGRESS: processed≈${approxProcessed}/${totalProducts}`,
      );

      return;
    }

    if (job.name === 'products-finalize') {
      const {
        meta: {tenantFilter, userId, generatedRegex, customFieldsArr},
        maxCounts: {maxProductsCount, maxImagesCount, maxSerialNumbersCount},
        config,
        currentSessionId,
        chunksTotal,
        totalProducts,
      } = job.data;

      await updateImportingSessionJobId(currentSessionId, job.id);

      const tenantId = tenantFilter?.tenant;
      const chunksDone = await getChunksDone(generatedRegex, tenantId);
      const totalChunks = chunksTotal || await getChunksTotal(generatedRegex, tenantId);

      if (chunksDone < totalChunks) {
        console.log(
          'info',
          'products-finalize',
          `Waiting for chunks to complete: ${chunksDone}/${totalChunks}. Rescheduling...`,
        );

        await productsImportFieldsQueue.add(
          'products-finalize',
          job.data,
          {
            delay: 2000,
            attempts: job.attemptsMade ? job.attemptsMade + 1 : 1,
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
        return;
      }

      console.log(
        'info',
        'products-finalize',
        `All chunks completed (${chunksDone}/${totalChunks}). Starting finalization...`,
      );

      const {spoiled, completed, updating} = await loadAllImportingResults(
        generatedRegex,
        tenantId,
        PRODUCTS_IMPORT_IDENTIFIER,
      );

      const finalizeOptions = {
        maxImagesCount,
        maxProductsCount,
        customFieldsArr,
        maxSerialNumbersCount,
        userId,
      };

      await processAndUpdateImports(
        processProductsImport,
        currentSessionId,
        spoiled,
        completed,
        updating,
        finalizeOptions,
        config,
        tenantFilter,
      );
      const allProductTimes = await getAllProductTimes(generatedRegex, tenantId);
      if (allProductTimes.length > 0) {
        const avgTime = (
          allProductTimes.reduce((a, b) => a + b, 0) /
          allProductTimes.length /
          1000
        ).toFixed(2);
        const minTime = (Math.min(...allProductTimes) / 1000).toFixed(2);
        const maxTime = (Math.max(...allProductTimes) / 1000).toFixed(2);
        console.log(
          `[IMPORT TIMING] Avg: ${avgTime}s | Min: ${minTime}s | Max: ${maxTime}s per product`,
        );
        await clearProductTimes(generatedRegex, tenantId);
      }

      return;
    }

    // unknown job
    handleLogger('info', 'Redis', `Unknown job name: ${job.name}`);
  },
  {
    connection: redisConfig,
    concurrency: 4,
  },
);

worker.on('error', (err) => {
  handleLogger('info', 'Redis', 'Product worker error');
});

export const createProductsFromCSV: GraphQLFieldResolver<
  null,
  Graphql.ResolverContext,
  { input: NexusGenInputs['CreateProductsFromCSVInput'] }
> = async (root, {input}, ctx) => {
  const userId = ctx?.state?.user?.id;
  const tenantFilter = await getTenantFilter(userId);
  try {
    const completedCreations = [];
    const needChangeCreations = [];
    let spoiledCreations = [];
    let maxProductsCount = 0;
    let maxImagesCount = 0;
    let maxSerialNumbersCount = 0;
    const isRedis = await checkRedisConnection();
    const generatedRegex = generateId();
    let customFieldsArr = [];

    const config = strapi.config.get('plugin.upload');
    const res = await handleCsvUpload(
      input?.uploadCsv,
      config,
      userId,
      PRODUCTS_IMPORT_IDENTIFIER,
    );
    const currentSession = await createImportingSession(
      generatedRegex,
      res?.id,
      PRODUCTS_IMPORT_IDENTIFIER,
      tenantFilter?.tenant,
      userId,
    );

    await new Promise<void>((outerResolve, outerReject) => {
      parseAndProcessCSV(input, async (parsedRows) => {
        if (isRedis) {
          await setImportingTotalFieldsCount(
            currentSession?.regexedId,
            tenantFilter?.tenant,
            parsedRows?.length,
            PRODUCTS_IMPORT_IDENTIFIER,
          );
        }
        try {
          const {spoiledFields, normalizedFields, errors, customFieldsNames} =
            await csvProductsToJSON(parsedRows);

          if (errors && errors.length > 0) {
            outerReject(
              new ApplicationError(
                'Custom: Please check headers and information correctness',
              ),
            );
            return;
          }

          [...normalizedFields, ...spoiledFields].forEach((item) => {
            if (item?.images?.length > maxImagesCount) {
              maxImagesCount = item.images.length;
            }

            if (item?.productItems?.length > maxProductsCount) {
              maxProductsCount = item.productItems.length;
            }

            if (item?.productItems?.length) {
              item.productItems.forEach(
                (product: { serialNumbers: string[] }) => {
                  if (
                    product.serialNumbers?.length &&
                    product.serialNumbers.length > maxSerialNumbersCount
                  ) {
                    maxSerialNumbersCount = product.serialNumbers.length;
                  }
                },
              );
            }
          });

          spoiledCreations = spoiledFields;
          customFieldsArr = customFieldsNames;

          if (isRedis) {
            await updateImportingMetadata(
              currentSession?.regexedId,
              tenantFilter?.tenant,
              spoiledFields,
              {
                maxProductsCount,
                maxImagesCount,
                maxSerialNumbersCount,
                customFieldsArr,
              },
              PRODUCTS_IMPORT_IDENTIFIER,
            );
            const CHUNK_SIZE = 50;
            const chunks = chunkArray(normalizedFields, CHUNK_SIZE);
            const totalProducts = normalizedFields.length;
            console.log(
              `IMPORT_SESSION_START: totalProducts=${totalProducts}, chunkSize=${CHUNK_SIZE}, chunksTotal=${chunks.length}`,
            );
            await setChunksTotal(
              generatedRegex,
              tenantFilter?.tenant,
              chunks.length,
            );

            await productsImportFieldsQueue.addBulk(
              chunks.map((fieldsChunk, idx) => ({
                name: 'products-chunk',
                data: {
                  normalizedFields: fieldsChunk,
                  meta: {
                    tenantFilter,
                    userId,
                    isRedis: true,
                    generatedRegex,
                    customFieldsArr,
                  },
                  maxCounts: {
                    maxProductsCount,
                    maxImagesCount,
                    maxSerialNumbersCount,
                  },
                  config,
                  currentSessionId: currentSession?.id,
                  chunkIndex: idx,
                  chunksTotal: chunks.length,
                  totalProducts,
                },
                opts: {
                  removeOnComplete: true,
                  removeOnFail: false,
                },
              })),
            );

            await productsImportFieldsQueue.add(
              'products-finalize',
              {
                meta: {
                  tenantFilter,
                  userId,
                  isRedis: true,
                  generatedRegex,
                  customFieldsArr,
                },
                maxCounts: {
                  maxProductsCount,
                  maxImagesCount,
                  maxSerialNumbersCount,
                },
                config,
                currentSessionId: currentSession?.id,
                chunksTotal: chunks.length,
                totalProducts,
              },
              {
                removeOnComplete: true,
                removeOnFail: false,
                delay: 1000,
              },
            );
          }
          outerResolve();
        } catch (error) {
          outerReject(error);
        }
      });
    })
      .then(() => {
        handleLogger(
          'info',
          'createProductsFromCSV',
          'CSV file processing completed successfully.',
        );
      })
      .catch((error) => {
        handleError('createProductsFromCSV', undefined, error);
      });

    return JSON.stringify({success: true});
  } catch (e) {
    await handleCsvProcessingError(
      e,
      tenantFilter?.tenant,
      PRODUCTS_IMPORT_IDENTIFIER,
    );
  }
};
