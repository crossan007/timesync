/**
 * timesync
 *
 * Time synchronization between peers
 *
 * https://github.com/enmasseio/timesync
 */

import { Emitter } from "./emitter";
import { mean, median, std } from "./stat";
import { wait } from "./util";

type eventCallback =
  | ((event: "change", callback: (offset: number) => void) => void)
  | ((event: "error", callback: (err: any) => void) => void)
  | ((event: "sync", callback: (value: "start" | "end") => void) => void);


interface jsonrpc {
  jsonrpc: "2.0";
  id: number;
}

export interface TimeSyncRequest extends jsonrpc {
  method: string;
  params: Record<string, string>;
}

export interface TimeSyncResponse extends jsonrpc {
  result: number;
}

type PeerOffset = {
  roundtrip: number,
  offset: number,
}

export interface TimeSyncOptions {
  /**  interval for doing synchronizations in ms. Set to null to disable auto sync */
  interval: number;
  /** timeout for requests to fail in ms */
  timeout: number;
  /** delay between requests in ms */
  delay: number;
  /** number of times to do a request to one peer */
  repeat: number;
  /** uri's or id's of the peers */
  peers: string[]; // Change this line to use an array of strings
  /** uri of a single server (master/slave configuration) */
  server: string | null;
  /** function returning the system time */
  now: () => number;
}

export abstract class TimeSync extends Emitter {
  /** The current offset from system time  in ms*/
  public offset: number = 0;
  private options: TimeSyncOptions;
  /** @type {number} Contains the timeout for the next synchronization */
  private _timeout?: NodeJS.Timer ;

  /** Contains a map with requests in progress */
  private _inProgress: Record<string, (data: any) => void> = {};

  /**
   * @type {boolean}
   * This property used to immediately apply the first ever received offset.
   * After that, it's set to false and not used anymore.
   */
  private _isFirst = true;

  private _nextId: number = 0;

  private nextId(): number {
    return this._nextId++;
  }

  constructor(options: Partial<TimeSyncOptions & { peers: string }>) {
    super();
    this.options = {
      interval: 60 * 60 * 1000,
      timeout: 10000,
      delay: 1000,
      repeat: 5,
      server: null,
      now: ()=> Date.now(),
      peers: [],
    };

    // apply provided options
    if (options) {
      if (options.server && options.peers) {
        throw new Error(
          'Configure either option "peers" or "server", not both.'
        );
      }

      this.options = {
        ...this.options,
        ...options,
      };

      if ("peers" in options) {
        if (typeof options.peers === "string") {
          // split a comma separated string with peers into an array
          this.options.peers = options.peers
            .split(",")
            .map((peer) => peer.trim())
            .filter((peer) => peer !== "");
        } else if (Array.isArray(options.peers)) {
          this.options.peers = options.peers;
        }
      }
    }

    if (this.options.interval !== null) {
      // start an interval to automatically run a synchronization once per interval
      this._timeout = setInterval(this.sync.bind(this), this.options.interval);

      // synchronize immediately on the next tick (allows to attach event
      // handlers before the timesync starts).
      setTimeout(() => {
        this.sync().catch((err) => this.emitError(err));
      }, 0);
    }
  }

  /**
   * Send a message to a peer
   *
   * @param {string} to
   * @param {*} data
   */
  private async send(
    to: string,
    data: TimeSyncRequest | TimeSyncResponse,
    timeout: number
  ): Promise<void> {
    let r: TimeSyncResponse;
    r = await this._send(to, data, timeout);
    this.receive(to, r);
  }

  protected abstract _send(
    to: string,
    data: TimeSyncRequest | TimeSyncResponse,
    timeout: number
  ): Promise<TimeSyncResponse>;

  /**
   * Receive method to be called when a reply comes in
   * @param {string | undefined} [from]
   * @param {*} data
   */
  public receive(from: string, data: TimeSyncRequest | TimeSyncResponse): void {
    if (data && "result" in data && data.id in this._inProgress) {
      // this is a reply
      this._inProgress[data.id](data.result);
    } else if (data && "method" in data && data.id !== undefined) {
      // this is a request from an other peer
      // reply with our current time
      this.send(
        from,
        {
          jsonrpc: "2.0",
          id: data.id,
          result: this.options.now(),
        },
        this.options.timeout
      );
    }
  }

  _handleRPCSendError(id: number, reject:(reason?: any) => void, err: any) {
    delete this._inProgress[id];
    reject(new Error("Send failure"));
  }

  /**
   * Send a JSON-RPC message and retrieve a response
   * @param {string} to
   * @param {string} method
   * @param {*} [params]
   * @returns {Promise}
   */
  async rpc<T>(to: string, method: string, params: Record<string, string> = {}) {
    let id = this.nextId();
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;

    var deferred = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this._inProgress[id] = (data) => {
      delete this._inProgress[id];
      resolve(data);
    };

    try {
      this.send(
        to,
        {
          jsonrpc: "2.0",
          id: id,
          method: method,
          params: params,
        },
        this.options.timeout
      );
    } catch (err: any) {
      this._handleRPCSendError(id, reject, err);
    }

    return deferred;
  }

  /**
   * Synchronize now with all configured peers
   * Docs: http://www.mine-control.com/zack/timesync/timesync.html
   */
  async sync() {
    this.emit("sync", "start");

    const peers = this.options.server
      ? [this.options.server]
      : [...this.options.peers];
    const all = await Promise.all(
      peers.map((peer) => this.syncWithPeer(peer))
    );

    const offsets = all.filter(
      (offset) =>
        typeof offset === "number" &&
        offset !== null &&
        !isNaN(offset) &&
        isFinite(offset)
    ) as number[];

    if (offsets.length > 0) {
      // take the average of all peers (excluding self) as new offset
      this.offset = mean(offsets);
      this.emit("change", this.offset);
    }
    this.emit("sync", "end");
  }

  /**
   * Sync one peer
   * @param {string} peer
   * @return {Promise.<number | null>}  Resolves with the offset to this peer,
   *                                    or null if failed to sync with this peer.
   * @private
   */
  private async syncWithPeer(peer: string): Promise<number | null> {
    // retrieve the offset of a peer, then wait 1 sec
    let all: Promise<PeerOffset | null>[] = [];

    all.push(this.getPeerOffset(peer))

    while(all.length < this.options.repeat){
      await wait(this.options.delay)
      all.push(this.getPeerOffset(peer))
    }
      
    // filter out null results
    var results = (await Promise.all(all)).filter((result) => result !== null) as PeerOffset[];

    // calculate the limit for outliers
    var roundtrips = results.map((result) => result.roundtrip);
    var limit = median(roundtrips) + std(roundtrips);

    // filter all results which have a roundtrip smaller than the mean+std
    var filtered = results.filter((result) => result.roundtrip < limit);
    var offsets = filtered.map((result) => result.offset);

    // return the new offset
    return offsets.length > 0 ? mean(offsets) : null;
  
  }

  /**
   * Retrieve the offset from one peer by doing a single call to the peer
   * @param {string} peer
   * @returns {Promise.<{roundtrip: number, offset: number} | null>}
   * @private
   */
  private async getPeerOffset(peer: string): Promise<PeerOffset | null> {
    var start = this.options.now(); // local system time

    try {
      const timestamp = (await this.rpc<TimeSyncResponse>(peer, "timesync"));
      if (typeof timestamp != "number") {
        throw new Error(`Invalid result recieved: ${timestamp}`);
      }
      var end = this.options.now(); // local system time
      var roundtrip = end - start;
      var offset = timestamp - end + roundtrip / 2; // offset from local system time

      // apply the first ever retrieved offset immediately.
      if (this._isFirst) {
        this._isFirst = false;
        this.offset = offset;
        this.emit("change", offset);
      }

      return {
        roundtrip: roundtrip,
        offset: offset,
      };
    } catch (err: any) {
      this.emitError(err?.message || "Error in getPeerOffset")
      return null;
    }
  }

  /**
   * Get the current time
   * @returns {number} Returns a timestamp
   */
  now() {
    return this.options.now() + this.offset;
  }

  /**
   * Destroy the timesync instance. Stops automatic synchronization.
   * If timesync is currently executing a synchronization, this
   * synchronization will be finished first.
   */
  destroy() {
    if (typeof this._timeout == "number") {
      clearTimeout(this._timeout);
    }
  }
}