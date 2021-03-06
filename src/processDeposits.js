require('dotenv').config()
const fs = require('fs')
const Web3 = require('web3')
const Web3Utils = require('web3-utils')
const { sendRawTx, sendTx } = require('./tx/sendTx')
const { createMessage } = require('./message')
const { getNonce } = require('./tx/web3')
const { getGasPrices } = require('./gasPrice')
const { asyncForEach } = require('./utils')

const {
  HOME_RPC_URL,
  HOME_BRIDGE_ADDRESS,
  VALIDATOR_ADDRESS,
  VALIDATOR_ADDRESS_PRIVATE_KEY
} = process.env

const homeProvider = new Web3.providers.HttpProvider(HOME_RPC_URL)
const web3Home = new Web3(homeProvider)
const HomeABI = require('../abis/HomeBridge.abi')

const homeBridge = new web3Home.eth.Contract(HomeABI, HOME_BRIDGE_ADDRESS)
const DB_FILE_NAME = 'home_deposits.json'
const db = require(`../db/${DB_FILE_NAME}`)
const dbNonce = require(`../db/nonce.json`)

async function processDeposits(homeChainId) {
  if (!homeChainId) {
    throw new Error('Chain id is not specified')
  }
  try {
    let homeBlockNumber = await sendRawTx({
      url: HOME_RPC_URL,
      params: [],
      method: 'eth_blockNumber'
    })
    if (homeBlockNumber === undefined) {
      return
    }
    homeBlockNumber = Web3Utils.hexToNumber(homeBlockNumber)
    if (homeBlockNumber === db.processedBlock) {
      return
    }

    const deposits = await homeBridge.getPastEvents('Deposit', {
      fromBlock: db.processedBlock + 1,
      toBlock: homeBlockNumber
    })
    console.log(`Found ${deposits.length} Deposits on Home Network`)

    if (deposits.length > 0) {
      await processHomeDeposits(deposits, homeChainId)
    }

    db.processedBlock = homeBlockNumber
    console.log('writing db deposits', homeBlockNumber)
    fs.writeFileSync(`${__dirname}/../db/${DB_FILE_NAME}`, JSON.stringify(db, null, 4))
  } catch (e) {
    console.error(e)
  }
}

async function processHomeDeposits(deposits, homeChainId) {
  try {
    let nonce = await getNonce(web3Home, VALIDATOR_ADDRESS)
    nonce = Math.max(dbNonce.home, nonce)
    await asyncForEach(deposits, async (deposit, index) => {
      const { recipient, value } = deposit.returnValues

      const message = createMessage({
        recipient,
        value,
        transactionHash: deposit.transactionHash
      })
      const signature = web3Home.eth.accounts.sign(message, `0x${VALIDATOR_ADDRESS_PRIVATE_KEY}`)
      let gasEstimate
      try {
        gasEstimate = await homeBridge.methods
          .submitSignature(signature.signature, message)
          .estimateGas({ from: VALIDATOR_ADDRESS })
      } catch (e) {
        console.log(index + 1, '# already processed deposit ', deposit.transactionHash)
        return
      }
      const data = await homeBridge.methods
        .submitSignature(signature.signature, message)
        .encodeABI({ from: VALIDATOR_ADDRESS })
      const gasPrice = await getGasPrices()
      const txHash = await sendTx({
        rpcUrl: HOME_RPC_URL,
        data,
        nonce,
        gasPrice: gasPrice.toString(10),
        amount: '0',
        gasLimit: gasEstimate + 200000,
        privateKey: VALIDATOR_ADDRESS_PRIVATE_KEY,
        to: HOME_BRIDGE_ADDRESS,
        chainId: homeChainId,
        web3: web3Home
      })
      console.log(index + 1, '# processing deposit', deposit.transactionHash, txHash)
      nonce += 1
    })
    dbNonce.home = nonce
    fs.writeFileSync(`${__dirname}/../db/nonce.json`, JSON.stringify(dbNonce, null, 4))
  } catch (e) {
    console.error(e)
    throw new Error(e)
  }
}

module.exports = processDeposits
