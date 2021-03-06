'use strict'

const EventEmitter = require('events');
const Transaction = require('../transaction')

const BN = require('bn.js')
const toPull = require('stream-to-pull-stream')
const pull = require('pull-stream')

const { CONTRACT_ADDRESS } = require('../constants')
const Web3 = require('web3')
const { parallel } = require('neo-async')
const { resolve } = require('path')

const { isPartyA, pubKeyToEthereumAddress, sendTransaction, log, compileIfNecessary } = require('../utils')

const open = require('./open')
const close = require('./eventListeners/close')
const transfer = require('./transfer')
const requestClose = require('./requestClose')
const closeChannels = require('./closeChannels')
const registerHandlers = require('./handlers')

const HASH_LENGTH = 32
const CHANNEL_ID_BYTES = HASH_LENGTH

class PaymentChannel extends EventEmitter {
    constructor(options) {
        super()

        this.nonce = options.nonce
        this.contract = options.contract
        this.contractAddress = options.contractAddress
        this.node = options.node
        this.web3 = options.web3

        this.open = open(this)
        this.close = close(this)
        this.transfer = transfer(this)
        this.requestClose = requestClose(this)
        this.closeChannels = closeChannels(this)

        this.closingRequests = new Set()
    }

    /**
     * Creates and initializes a new PaymentChannel instance.
     * It will check whether there is a up-to-date ABI of the contract
     * and compiles the contract if that isn't the case.
     * 
     * @param {Object} options.node a libp2p node instance
     * @param {Object} options.provider a web3.js provider instance, otherwise if will use `ws://localhost:8545`
     * @param {Function} cb a function the is called with `(err, this)` afterwards
     */
    static create(options, cb) {
        const web3 = new Web3(options.provider || 'ws://localhost:8545')

        parallel({
            nonce: (cb) => web3.eth.getTransactionCount(pubKeyToEthereumAddress(options.node.peerInfo.id.pubKey.marshal()), 'latest', cb),
            compiledContract: (cb) => compileIfNecessary([resolve(__dirname, '../../contracts/HoprChannel.sol')], [resolve(__dirname, '../../build/contracts/HoprChannel.json')], cb)
        }, (err, results) => {
            if (err)
                return cb(err)

            registerHandlers(options.node)

            const abi = require('../../build/contracts/HoprChannel.json').abi

            return cb(null, new PaymentChannel({
                node: options.node,
                nonce: results.nonce,
                contract: new web3.eth.Contract(abi, options.contractAddress || CONTRACT_ADDRESS, {
                    from: pubKeyToEthereumAddress(options.node.peerInfo.id.pubKey.marshal())
                }),
                web3: web3,
                contractAddress: options.contractAddress
            }))

        })
    }

    setSettlementListener(channelId, listener = this.close) {
        if (!Buffer.isBuffer(channelId) || channelId.length !== HASH_LENGTH)
            throw Error(`Invalid input parameter. Expected a Buffer of size ${HASH_LENGTH} but got ${typeof channelId}.`)

        log(this.node.peerInfo.id, `Listening to channel \x1b[33m${channelId.toString('hex')}\x1b[0m`)

        this.contract.once('ClosedChannel', {
            topics: [`0x${channelId.toString('hex')}`]
        }, listener)
    }

    getEmbeddedMoney(receivedTx, counterparty, currentValue) {
        currentValue = new BN(currentValue)
        const newValue = new BN(receivedTx.value)

        const self = pubKeyToEthereumAddress(this.node.peerInfo.id.pubKey.marshal())
        const otherParty = pubKeyToEthereumAddress(counterparty.pubKey.marshal())

        if (isPartyA(self, otherParty)) {
            return newValue.isub(currentValue)
        } else {
            return currentValue.isub(newValue)
        }
    }

    setChannel(newRecord, options, cb) {
        if (typeof options === 'function') {
            cb = options
            options = {}
        }

        if (!options.channelId || !Buffer.isBuffer(options.channelId)) {
            if (!newRecord.restoreTx)
                return cb(Error('Unable to compute channelId.'))

            options.channelId = newRecord.tx.getChannelId(this.node.peerInfo.id)
        }

        if (!options.channelId || !Buffer.isBuffer(options.channelId) || options.channelId.length !== CHANNEL_ID_BYTES)
            return cb(Error('Unable to determine channelId.'))

        const key = this.getKey(options.channelId)

        this.node.db.get(key, (err, record) => {
            if (err && !err.notFound)
                return cb()

            if (err && err.notFound) {
                record = {}
            } else {
                record = this.fromBuffer(record)
            }

            this.node.db.put(key, this.toBuffer(Object.assign(record, newRecord)), options, cb)
        })
    }

    getKey(channelId) {
        return Buffer.concat([Buffer.from('payments-channel-'), channelId], 17 + 32)
    }

    toBuffer(record) {
        return Buffer.concat([
            record.tx ? record.tx.toBuffer() : Buffer.alloc(Transaction.SIZE, 0),
            record.restoreTx ? record.restoreTx.toBuffer() : Buffer.alloc(Transaction.SIZE, 0),
            record.index ? record.index : Buffer.alloc(Transaction.INDEX_LENGTH, 0),
            record.currentValue ? record.currentValue : Buffer.alloc(Transaction.VALUE_LENGTH, 0),
            record.totalBalance ? record.totalBalance : Buffer.alloc(Transaction.VALUE_LENGTH, 0)
        ], Transaction.SIZE + Transaction.SIZE + Transaction.INDEX_LENGTH + Transaction.VALUE_LENGTH + Transaction.VALUE_LENGTH)
    }
    fromBuffer(buf) {
        return {
            tx: Transaction.fromBuffer(buf.slice(0, Transaction.SIZE)),
            restoreTx: Transaction.fromBuffer(buf.slice(Transaction.SIZE, Transaction.SIZE + Transaction.SIZE)),
            index: buf.slice(Transaction.SIZE + Transaction.SIZE, Transaction.SIZE + Transaction.SIZE + Transaction.INDEX_LENGTH),
            currentValue: buf.slice(Transaction.SIZE + Transaction.SIZE + Transaction.INDEX_LENGTH, Transaction.SIZE + Transaction.SIZE + Transaction.INDEX_LENGTH + Transaction.VALUE_LENGTH),
            totalBalance: buf.slice(Transaction.SIZE + Transaction.SIZE + Transaction.INDEX_LENGTH + Transaction.VALUE_LENGTH, Transaction.SIZE + Transaction.SIZE + Transaction.INDEX_LENGTH + Transaction.VALUE_LENGTH + Transaction.VALUE_LENGTH)
        }
    }

    getChannel(channelId, cb) {
        const key = this.getKey(channelId)

        this.node.db.get(key, (err, record) => {
            if (err)
                return cb(err.notFound ? null : err)

            cb(null, this.fromBuffer(record))
        })
    }

    deleteChannel(channelId, cb) {
        const key = this.getKey(channelId)

        this.node.db.del(key, {
            sync: true
        }, cb)
    }

    getChannels() {
        return pull(
            toPull(this.node.db.createReadStream({
                // payments-channel-\000...\000
                gt: this.getKey(Buffer.alloc(32, 0)),
                // payments-channel-\255...\255
                lt: this.getKey(Buffer.alloc(46, 255))
            })),
            pull.map(record => Object.assign(record, {
                value: this.fromBuffer(record.value)
            }))
        )
    }

    /**
     * Takes a transaction object generetad by web3.js and publishes it in the
     * network. It automatically determines the necessary amount of gas i
     * 
     * @param {Object} txObject the txObject generated by web3.js
     * @param {Web3} web3 a web3.js instance
     * @param {Function} cb the function to be called afterwards
     */
    async contractCall(txObject, value, cb = () => { }) {
        if (typeof value === 'function') {
            cb = value
            value = '0'
        }

        const estimatedGas = await txObject.estimateGas({
            from: pubKeyToEthereumAddress(this.node.peerInfo.id.pubKey.marshal())
        })

        this.nonce = this.nonce + 1

        sendTransaction({
            to: this.contractAddress,
            nonce: this.nonce - 1,
            gas: estimatedGas,
            data: txObject.encodeABI()
        }, this.node.peerInfo.id, this.web3, (err, receipt) => {
            if (err)
                return cb(err)

            return cb(null, receipt)
        })
    }
}

module.exports = PaymentChannel