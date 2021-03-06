import { MethodRegistry } from 'eth-method-registry';
import abi from 'human-standard-token-abi';
import { ethers } from 'ethers';
import log from 'loglevel';
import { addHexPrefix } from '../../../../app/scripts/lib/util';
import {
  TRANSACTION_CATEGORIES,
  TRANSACTION_GROUP_STATUSES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from '../../../../shared/constants/transaction';
import fetchWithCache from './fetch-with-cache';

import { addCurrencies } from './conversion-util';

const hstInterface = new ethers.utils.Interface(abi);

/**
 * @typedef EthersContractCall
 * @type object
 * @property {any[]} args - The args/params to the function call.
 * An array-like object with numerical and string indices.
 * @property {string} name - The name of the function.
 * @property {string} signature - The function signature.
 * @property {string} sighash - The function signature hash.
 * @property {EthersBigNumber} value - The ETH value associated with the call.
 * @property {FunctionFragment} functionFragment - The Ethers function fragment
 * representation of the function.
 */

/**
 * @returns {EthersContractCall | undefined}
 */
export function getTokenData(data) {
  try {
    return hstInterface.parseTransaction({ data });
  } catch (error) {
    log.debug('Failed to parse transaction data.', error, data);
    return undefined;
  }
}

async function getMethodFrom4Byte(fourBytePrefix) {
  const fourByteResponse = await fetchWithCache(
    `https://www.4byte.directory/api/v1/signatures/?hex_signature=${fourBytePrefix}`,
    {
      referrerPolicy: 'no-referrer-when-downgrade',
      body: null,
      method: 'GET',
      mode: 'cors',
    },
  );

  if (fourByteResponse.count === 1) {
    return fourByteResponse.results[0].text_signature;
  }
  return null;
}
let registry;

/**
 * Attempts to return the method data from the MethodRegistry library, the message registry library and the token abi, in that order of preference
 * @param {string} fourBytePrefix - The prefix from the method code associated with the data
 * @returns {Object}
 */
export async function getMethodDataAsync(fourBytePrefix) {
  try {
    const fourByteSig = getMethodFrom4Byte(fourBytePrefix).catch((e) => {
      log.error(e);
      return null;
    });

    if (!registry) {
      registry = new MethodRegistry({ provider: global.ethereumProvider });
    }

    let sig = await registry.lookup(fourBytePrefix);

    if (!sig) {
      sig = await fourByteSig;
    }

    if (!sig) {
      return {};
    }

    const parsedResult = registry.parse(sig);

    // fix bad methodName 
    let parts = parsedResult.name.split(" ");
    parts = parts.reduce((result, cur) => {
      if (result[0] && /^[A-Z]+$/.test(result[0]) && /^[A-Z]{1}$/.test(cur)) {
        result[0] += cur
        return result
      } else {
        return [cur].concat(result)
      }
    }, [])

    return {
      name: parts.reverse().join(" "),
      params: parsedResult.args,
    };
  } catch (error) {
    log.error(error);
    return {};
  }
}

/**
 * Returns four-byte method signature from data
 *
 * @param {string} data - The hex data (@code txParams.data) of a transaction
 * @returns {string} The four-byte method signature
 */
export function getFourBytePrefix(data = '') {
  const prefixedData = addHexPrefix(data);
  const fourBytePrefix = prefixedData.slice(0, 10);
  return fourBytePrefix;
}

/**
 * Given an transaction category, returns a boolean which indicates whether the transaction is calling an erc20 token method
 *
 * @param {string} transactionCategory - The category of transaction being evaluated
 * @returns {boolean} whether the transaction is calling an erc20 token method
 */
export function isTokenMethodAction(transactionCategory) {
  return [
    TRANSACTION_CATEGORIES.TOKEN_METHOD_TRANSFER,
    TRANSACTION_CATEGORIES.TOKEN_METHOD_APPROVE,
    TRANSACTION_CATEGORIES.TOKEN_METHOD_TRANSFER_FROM,
  ].includes(transactionCategory);
}

export function getLatestSubmittedTxWithNonce(
  transactions = [],
  nonce = '0x0',
) {
  if (!transactions.length) {
    return {};
  }

  return transactions.reduce((acc, current) => {
    const { submittedTime, txParams: { nonce: currentNonce } = {} } = current;

    if (currentNonce === nonce) {
      if (!acc.submittedTime) {
        return current;
      }
      return submittedTime > acc.submittedTime ? current : acc;
    }
    return acc;
  }, {});
}

export async function isSmartContractAddress(address) {
  const code = await global.eth.getCode(address);
  // Geth will return '0x', and ganache-core v2.2.1 will return '0x0'
  const codeIsEmpty = !code || code === '0x' || code === '0x0';
  return !codeIsEmpty;
}

export function sumHexes(...args) {
  const total = args.reduce((acc, hexAmount) => {
    return addCurrencies(acc, hexAmount, {
      toNumericBase: 'hex',
      aBase: 16,
      bBase: 16,
    });
  });

  return addHexPrefix(total);
}

/**
 * Returns a status key for a transaction. Requires parsing the txMeta.txReceipt on top of
 * txMeta.status because txMeta.status does not reflect on-chain errors.
 * @param {Object} transaction - The txMeta object of a transaction.
 * @param {Object} transaction.txReceipt - The transaction receipt.
 * @returns {string}
 */
export function getStatusKey(transaction) {
  const {
    txReceipt: { status: receiptStatus } = {},
    type,
    status,
  } = transaction;

  // There was an on-chain failure
  if (receiptStatus === '0x0') {
    return TRANSACTION_STATUSES.FAILED;
  }

  if (
    status === TRANSACTION_STATUSES.CONFIRMED &&
    type === TRANSACTION_TYPES.CANCEL
  ) {
    return TRANSACTION_GROUP_STATUSES.CANCELLED;
  }

  return transaction.status;
}

/**
 * Returns an external block explorer URL at which a transaction can be viewed.
 * @param {number} networkId
 * @param {string} hash
 * @param {Object} rpcPrefs
 */
export function getBlockExplorerUrlForTx(networkId, hash, rpcPrefs = {}) {
  if (rpcPrefs.blockExplorerUrl) {
    return `${rpcPrefs.blockExplorerUrl.replace(/\/+$/u, '')}/tx/${hash}`;
  }
  switch (+networkId) {
    case 1: // main net
      return `https://etherscan.io/tx/${hash}`;
    case 2: // morden test net
      return `https://morden.etherscan.io/tx/${hash}`;
    case 3: // ropsten test net
      return `https://ropsten.etherscan.io/tx/${hash}`;
    case 4: // rinkeby test net
      return `https://rinkeby.etherscan.io/tx/${hash}`;
    case 42: // kovan test net
      return `https://kovan.etherscan.io/tx/${hash}`;
    case 5: // goerli test net
      return `https://goerli.etherscan.io/tx/${hash}`;
    case 128:
      return `https://hecoinfo.com/tx/${hash}`;
    case 56:
      return `https://bscscan.com/tx/${hash}`;
    case 137:
      return `https://explorer-mainnet.maticvigil.com/tx/${hash}`;
    default:
      return '';
  }
}

/**
 * Returns a title for the given transaction category.
 *
 * This will throw an error if the transaction category is unrecognized and no default is provided.
 * @param {function} t - The translation function
 * @param {TRANSACTION_CATEGORIES[keyof TRANSACTION_CATEGORIES]} transactionCategory - The transaction category constant
 * @returns {string} The transaction category title
 */
export function getTransactionCategoryTitle(t, transactionCategory) {
  switch (transactionCategory) {
    case TRANSACTION_CATEGORIES.TOKEN_METHOD_TRANSFER: {
      return t('transfer');
    }
    case TRANSACTION_CATEGORIES.TOKEN_METHOD_TRANSFER_FROM: {
      return t('transferFrom');
    }
    case TRANSACTION_CATEGORIES.TOKEN_METHOD_APPROVE: {
      return t('approve');
    }
    case TRANSACTION_CATEGORIES.SENT_ETHER: {
      return t('sentEther');
    }
    case TRANSACTION_CATEGORIES.CONTRACT_INTERACTION: {
      return t('contractInteraction');
    }
    case TRANSACTION_CATEGORIES.DEPLOY_CONTRACT: {
      return t('contractDeployment');
    }
    case TRANSACTION_CATEGORIES.SWAP: {
      return t('swap');
    }
    case TRANSACTION_CATEGORIES.SWAP_APPROVAL: {
      return t('swapApproval');
    }
    default: {
      throw new Error(
        `Unrecognized transaction category: ${transactionCategory}`,
      );
    }
  }
}
