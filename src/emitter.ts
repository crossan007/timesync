type Callback = (data: any) => void;

export class Emitter {
  private _callbacks: Record<string, Callback[]> = {};

  emit(event: string, data: any): void {
    const callbacks = this._callbacks[event];
    callbacks && callbacks.forEach((callback) => callback(data));
  }

  /**
   * Emit an error message. If there are no listeners, the error is outputted
   * to the console.
   * @param {Error} err
   */
  emitError(err: string) {
    if (this.list("error").length > 0) {
      this.emit("error", err);
    } else {
      console.log("Error", err);
    }
  }

  on(event: string, callback: Callback): this {
    const callbacks = this._callbacks[event] || (this._callbacks[event] = []);
    callbacks.push(callback);
    return this;
  }

  off(event: string, callback?: Callback): this {
    if (callback) {
      const callbacks = this._callbacks[event];
      const index = callbacks?.indexOf(callback);
      if (index !== -1) {
        callbacks?.splice(index, 1);
      }
      if (callbacks?.length === 0) {
        delete this._callbacks[event];
      }
    } else {
      delete this._callbacks[event];
    }
    return this;
  }

  list(event: string): Callback[] {
    return this._callbacks[event] || [];
  }
}
