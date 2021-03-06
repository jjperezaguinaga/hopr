'use strict'

const EventEmitter = require('events').EventEmitter
const SimplePeer = require('simple-peer')
const toPull = require('stream-to-pull-stream')
const { establishConnection, match } = require('../../utils')
const { PROTOCOL_WEBRTC_SIGNALING } = require('../../constants')
const withIs = require('class-is')
const rlp = require('rlp')
const PeerId = require('peer-id')
const pull = require('pull-stream')
const lp = require('pull-length-prefixed')
const Pushable = require('pull-pushable')
const once = require('once')
const bs58 = require('bs58')
const Connection = require('interface-connection').Connection

const register = require('./register')
const handler = require('./handler')

const { waterfall, groupBy } = require('neo-async')
const wrtc = require('wrtc')

class WebRTC {
    constructor(options, sw, peerRouting) {
        this.sw = sw
        this.options = options

        if (peerRouting)
            this.peerRouting = peerRouting

        this.className = 'WebRTCStar'

        this.sw.handle(PROTOCOL_WEBRTC_SIGNALING, handler(this))
        this.sw.on('peer-mux-established', register(this))

        this.addrs = []
        this.listener = new EventEmitter()

        this.channels = []
        this.listener.listen = (multiaddrs, cb) => {
            if (Array.isArray(multiaddrs)) {
                this.addrs.push(...multiaddrs)
            } else {
                this.addrs.push(multiaddrs)
            }

            groupBy(this.addrs, (addr, cb) => {
                const toDial = addr.decapsulate('p2p-webrtc-star').getPeerId()

                // Big TODO!!!
                establishConnection(this.sw, toDial, { peerRouting: this.peerRouting }, (err) => {
                    if (err)
                        return cb(null, 'offline')

                    cb(null, 'online')
                })
            }, (err, { online, offline }) => {
                this.sw._peerInfo.multiaddrs.replace(offline, online)

                // if (err)
                //     return setImmediate(() => {
                //         listener.emit('error')
                //         cb(err)
                //     })

                const self = this
                setImmediate(() => {
                    self.listener.emit('listening')
                    cb()
                })

            })
        }

        this.listener.getAddrs = (cb) => cb(null, this.addrs)
        this.listener.close = (options, cb) => {
            if (typeof options === 'function') {
                cb = options
            }

            cb = cb ? once(cb) : noop

            this.channels.forEach((channel) => channel.destroy())

            this.sw.unhandle(PROTOCOL_WEBRTC_SIGNALING)

            setImmediate(() => {
                this.listener.emit('close')
                cb()
            })
        }
    }

    dial(multiaddr, callback) {
        if (typeof options === 'function') {
            callback = options
            options = {}
        }

        callback = callback ? once(callback) : noop

        const channel = SimplePeer({
            initiator: true,
            //channelConfig: {},
            //channelName: '<random string>',
            //config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }] },
            //constraints: {},
            //offerConstraints: {},
            //answerConstraints: {},
            //sdpTransform: function (sdp) { return sdp },
            //stream: false,
            //streams: [],
            trickle: false,
            allowHalfTrickle: true,
            wrtc: wrtc,
        })

        const conn = new Connection(toPull.duplex(channel))

        const peerId = PeerId.createFromB58String(multiaddr.decapsulate('p2p-webrtc-star').getPeerId())

        waterfall([
            (cb) => establishConnection(this.sw, peerId, {
                protocol: PROTOCOL_WEBRTC_SIGNALING,
                // another big TODO!!!
                peerRouting: this.peerRouting
            }, cb),
            (conn, cb) => {
                function foo() {
                    let ended = false
                    const messages = []
                    let next = () => { }

                    const end = (err) => {
                        ended = true
                        if (!next.called)
                            return next(err ? err : true)
                    }

                    channel.on('close', end)
                    channel.on('connect', () => {
                        end()
                        cb()
                    })
                    channel.on('error', (err) => {
                        console.log(err)
                        end()
                    })

                    channel.on('signal', (signalingData) => {
                        console.log(JSON.stringify(signalingData))
                        if (ended)
                            return

                        if (!next.called)
                            return next(null, rlp.encode([
                                Buffer.from(bs58.decode(match.WebRTC_DESTINATION(multiaddr).getPeerId())),
                                JSON.stringify(signalingData)
                            ]))

                        messages.push(signalingData)
                    })

                    return (end, cb) => {
                        if (ended || end)
                            return cb(end ? end : true)

                        next = cb

                        if (messages.length > 0)
                            return cb(null, rlp.encode([
                                Buffer.from(bs58.decode(match.WebRTC_DESTINATION(multiaddr).getPeerId())),
                                JSON.stringify(messages.shift())
                            ]))
                    }
                }

                pull(
                    foo(),
                    lp.encode(),
                    conn,
                    lp.decode(),
                    pull.drain((data) => {
                        console.log(JSON.parse(data))
                        channel.signal(JSON.parse(data))
                    })
                )
            }
        ], (err) => {
            if (err)
                return callback(err)

            console.log('finally connected')

            conn.getObservedAddrs = () => { }

            callback(null)
        })

        return conn
    }

    createListener(options, connHandler) {
        if (typeof options === 'function') {
            connHandler = options
            options = {}
        }

        this.listener.on('connection', connHandler)

        return this.listener
    }

    filter(multiaddrs) {
        if (!Array.isArray(multiaddrs)) {
            multiaddrs = [multiaddrs]
        }

        return multiaddrs.filter(match.WebRTC)
    }
}

module.exports = withIs(WebRTC, {
    className: 'WebRTC',
    symbolName: '@validitylabs/hopr/WebRTC'
})