'use strict'

const { isPartyA, pubKeyToEthereumAddress, log, bufferToNumber } = require('../utils')
const { waterfall } = require('neo-async')
const BN = require('bn.js')

module.exports = (self) => (channelId, useRestoreTx = false, cb = () => { }) => {
    if (typeof useRestoreTx === 'function') {
        cb = useRestoreTx
        useRestoreTx = false
    }

    waterfall([
        (cb) => self.getChannel(channelId, cb),
        (record, cb) => {
            if (typeof record === 'function')
                return cb(null, new BN('0'))

            const lastTx = useRestoreTx ? record.restoreTx : record.tx

            log(self.node.peerInfo.id, `Trying to close payment channel \x1b[33m${channelId.toString('hex')}\x1b[0m. Nonce is ${self.nonce}`)

            const lastValue = new BN(lastTx.value)

            self.contractCall(self.contract.methods.closeChannel(
                lastTx.index,
                lastTx.nonce,
                lastValue.toString(),
                lastTx.signature.slice(0, 32),
                lastTx.signature.slice(32, 64),
                bufferToNumber(lastTx.recovery) + 27
            ), cb)
        }, 
        (receipt, cb) => {
            self.closingRequests.add(channelId.toString('base64'))

            let receivedMoney

            const initialValue = new BN(record.restoreTx.value)
            if (isPartyA(
                pubKeyToEthereumAddress(self.node.peerInfo.id.pubKey.marshal()),
                pubKeyToEthereumAddress(record.restoreTx.counterparty))) {
                receivedMoney = lastValue.isub(initialValue)
            } else {
                receivedMoney = initialValue.isub(lastValue)
            }

            log(self.node.peerInfo.id, `Settled channel \x1b[33m${channelId.toString('hex')}\x1b[0m with txHash \x1b[32m${receipt.transactionHash}\x1b[0m. Nonce is now \x1b[31m${self.nonce}\x1b[0m`)

            cb(null, receivedMoney)
        }
    ], cb)
}