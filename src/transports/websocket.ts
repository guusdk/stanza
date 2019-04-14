import { AsyncQueue, queue } from '../lib/async';
import WildEmitter from '../WildEmitter';

import WSNode from 'ws';
import { Transport, TransportConfig } from '../Definitions';
import { ParsedData, Registry, StreamParser } from '../jxt';
import { Stream } from '../protocol/stanzas';
import StreamManagement from '../StreamManagement';

let WS: typeof WSNode | typeof WebSocket;
if (typeof WSNode !== 'function') {
    WS = WebSocket;
} else {
    WS = WSNode;
}
const WS_OPEN = 1;

export default class WSConnection extends WildEmitter implements Transport {
    public hasStream?: boolean;
    public stream?: Stream;

    private config!: TransportConfig;
    private sm: StreamManagement;
    private stanzas: Registry;
    private closing: boolean;
    private sendQueue: AsyncQueue<string>;
    private conn?: WSNode | WebSocket;
    private parser?: StreamParser;

    constructor(sm: StreamManagement, stanzas: Registry) {
        super();

        this.sm = sm;
        this.stanzas = stanzas;
        this.closing = false;

        this.sendQueue = queue((data, cb) => {
            if (this.conn) {
                data = Buffer.from(data, 'utf8').toString();
                this.emit('raw:outgoing', data);
                if (this.conn.readyState === WS_OPEN) {
                    this.conn.send(data);
                }
            }
            cb();
        }, 1);

        this.on('connected', () => {
            this.send(this.startHeader());
        });

        this.on('raw:incoming', (data: string) => {
            if (this.parser) {
                this.parser.write(data);
            }
        });
    }

    public connect(opts: TransportConfig) {
        this.config = opts;
        this.hasStream = false;
        this.closing = false;

        this.parser = new StreamParser({
            acceptLanguages: this.config.acceptLanguages,
            allowComments: false,
            lang: this.config.lang,
            registry: this.stanzas,
            wrappedStream: false
        });

        this.parser.on('data', (e: ParsedData) => {
            const name = e.kind;
            const stanzaObj = e.stanza;

            if (name === 'stream') {
                if (stanzaObj.type === 'open') {
                    this.hasStream = true;
                    this.stream = stanzaObj;
                    return this.emit('stream:start', stanzaObj);
                }
                if (stanzaObj.type === 'close') {
                    this.emit('stream:end');
                    return this.disconnect();
                }
            }
            this.emit('stream:data', stanzaObj, name);
        });

        this.parser.on('error', (err: any) => {
            const streamError = {
                error: {
                    condition: 'invalid-xml'
                }
            };
            this.emit('stream:error', streamError, err);
            this.send(this.stanzas.export('error', streamError)!.toString());
            return this.disconnect();
        });

        this.conn = new WS(opts.url, 'xmpp');
        this.conn.onerror = (e: any) => {
            if (e.preventDefault) {
                e.preventDefault();
            }
            this.emit('disconnected');
        };
        this.conn.onclose = () => {
            this.emit('disconnected');
        };
        this.conn.onopen = () => {
            this.sm.started = false;
            this.emit('connected');
        };
        this.conn.onmessage = (wsMsg: MessageEvent) => {
            this.emit('raw:incoming', Buffer.from(wsMsg.data, 'utf8').toString());
        };
    }

    public disconnect() {
        if (this.conn && !this.closing && this.hasStream) {
            this.closing = true;
            this.send(this.closeHeader());
        } else {
            this.hasStream = false;
            this.stream = undefined;
            if (this.conn && this.conn.readyState === WS_OPEN) {
                this.conn.close();
            }
            this.conn = undefined;
        }
    }

    public send(dataOrName: string, data?: object): void {
        if (data) {
            const output = this.stanzas.export(dataOrName, data);
            if (output) {
                this.sendQueue.push(output.toString());
            }
        } else {
            this.sendQueue.push(dataOrName);
        }
    }

    public restart() {
        this.hasStream = false;
        this.send(this.startHeader());
    }

    private startHeader() {
        const header = this.stanzas.export('stream', {
            action: 'open',
            lang: this.config.lang,
            to: this.config.server,
            version: '1.0'
        })!;
        return header.toString();
    }

    private closeHeader() {
        const header = this.stanzas.export('stream', {
            action: 'close'
        })!;
        return header.toString();
    }
}
