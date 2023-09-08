import { Emitter } from "./emitter";

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id: number;
}

export interface RPCRequest extends JSONRPCMessage {
  method: string;
  params: Record<string, string>;
}

export interface RPCResponse extends JSONRPCMessage {
  result: any;
}

export abstract class JSONRPC extends Emitter {
  private _nextId: number = 0;

  private nextId(): number {
    return this._nextId++;
  }

  private timeout: number;

  constructor(timeout: number) {
    super();
    this.timeout = timeout;
  }

  protected abstract _send(
    to: string,
    data: RPCRequest | RPCResponse,
    timeout: number
  ): Promise<RPCResponse>;

  /**
   * Send a message to a peer
   *
   * @param {string} to
   * @param {*} data
   */
  protected send(
    to: string,
    data: RPCRequest | RPCResponse,
    timeout: number = this.timeout
  ): Promise<RPCResponse> {
    return this._send(to, data, timeout);
  }

  /**
   * Send a JSON-RPC message and retrieve a response
   * @param {string} to
   * @param {string} method
   * @param {*} [params]
   * @returns {Promise}
   */
  async rpc(
    to: string,
    method: string,
    params: Record<string, string> = {}
  ): Promise<RPCResponse> {
    let id = this.nextId();
    try {
      return (await this.send(
        to,
        {
          jsonrpc: "2.0",
          id: id,
          method: method,
          params: params,
        },
        this.timeout
      )).result;
    } catch (err: any) {
      throw new Error(`Failed sending request to ${to} (${id}): ${typeof err?.message == "string" ? err.message : err}`);
    }
  }

  protected abstract receive(from: string, data: RPCResponse | RPCRequest): void;
}
