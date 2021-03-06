'use strict'

const pull = require('pull-stream')
const paramap = require('pull-paramap')

const lp = require('pull-length-prefixed')
const { waterfall } = require('neo-async')
const { log, pubKeyToPeerId, hash, bufferXOR } = require('../utils')

const { PROTOCOL_STRING } = require('../constants')
const Packet = require('../packet')
const Acknowledgement = require('../acknowledgement')

const Multihash = require('multihashes')
const rlp = require('rlp')

module.exports = (node, options) => {
    // Registers the packet handlers if the node started as a
    // relay node.
    // This disables the relay functionality for bootstrap
    // nodes.
    if (options['bootstrap-node'])
        return

    function forwardPacket(packet) {
        if (node.peerInfo.id.isEqual(packet._targetPeerId))
            return options.output(demo(packet.message.plaintext))

        log(node.peerInfo.id, `Forwarding to node \x1b[34m${packet._targetPeerId.toB58String()}\x1b[0m.`)

        waterfall([
            (cb) => node.peerRouting.findPeer(packet._targetPeerId, cb),
            (targetPeerInfo, cb) => node.dialProtocol(targetPeerInfo, PROTOCOL_STRING, cb),
            (conn, cb) => pull(
                pull.once(packet.toBuffer()),
                lp.encode(),
                conn,
                lp.decode({ maxLength: Acknowledgement.SIZE }),
                pull.filter((data) => data.length === Acknowledgement.SIZE),
                pull.take(1),
                pull.map(data => Acknowledgement.fromBuffer(data)),
                pull.drain((data) => cb(null, data))
            ),
            (ack, cb) => handleAcknowledgement(ack, cb)
        ], (err) => {
            if (err)
                log(node.peerInfo.id, `Error: ${err.message}`)
        })
    }

    function handleAcknowledgement(ack, cb) {
        if (!ack.challengeSigningParty.equals(node.peerInfo.id.pubKey.marshal()))
            throw Error('General error.')

        let record, channelId
        waterfall([
            (cb) => node.pendingTransactions.getEncryptedTransaction(ack.hashedKey, cb),
            (_record, cb) => {
                if (typeof record === 'function') {
                    cb = record
                    return cb(Error('General error.'))
                }

                record = _record

                pubKeyToPeerId(ack.responseSigningParty, cb)
            },
            (peerId, cb) => {
                if (!Multihash.decode(peerId.toBytes()).digest.equals(record.hashedPubKey))
                    return cb(Error('General error.'))

                record.tx.decrypt(hash(bufferXOR(record.ownKeyHalf, ack.key)))

                channelId = record.tx.getChannelId(node.peerInfo.id)

                node.paymentChannels.getChannel(channelId, cb)
            },
            (channelRecord, cb) => {
                if (typeof channelRecord === 'function') {
                    cb = channelRecord
                    return cb(Error('General error.'))
                }

                node.paymentChannels.setChannel({
                    currentValue: record.tx.value,
                    //index: tx.index,
                    tx: record.tx
                }, { channelId: channelId })
            }
        ], cb)
    }

    node.handle(PROTOCOL_STRING, (protocol, conn) => {
        pull(
            conn,
            lp.decode({
                maxLength: Packet.SIZE
            }),
            pull.filter(data => data.length == Packet.SIZE),
            paramap((data, cb) => {
                const packet = Packet.fromBuffer(data)

                packet.forwardTransform(node, (err) => {
                    if (err) {
                        log(node.peerInfo.id, err.message)
                        return cb(null, Buffer.alloc(0))
                    }

                    forwardPacket(packet)

                    return cb(null, Acknowledgement.create(
                        packet.oldChallenge,
                        packet.header.derivedSecret,
                        node.peerInfo.id
                    ).toBuffer())
                })

            }),
            lp.encode(),
            conn
        )
    })

    function demo(plaintext) {
        const message = rlp.decode(plaintext)

        return `\n\n---------- New Message ----------\nMessage "${message[0].toString()}" latency ${Date.now() - Number(message[1].toString())} ms.\n---------------------------------\n\n`
    }
}
