import { existsSync, readFileSync } from "fs";
import { writeFile, rename, rm } from "fs/promises";

export class Mutex {
  constructor() {
  }

  private _locked = false;
  private _waiting: (() => void)[] = [];

  async guard(fn) {
    return await this.lockGuard(fn);
  }

  lock() {
    return new Promise<void>((rs) => {
      if (!this._locked) {
        this._locked = true;
        rs();
      } else {
        this._waiting.push(rs);
      }
    })
  }

  unlock() {
    if (this._waiting.length > 0) {
      const next = this._waiting.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }

  async lockGuard(fn) {
    await this.lock();
    try {
      return await fn();
    } finally {
      this.unlock();
    }
  }
}


export const createTextStore = (name: string, defaultv?: any) => {
  let content = defaultv;
  if (existsSync(name))
    content = JSON.parse(readFileSync(name, 'utf-8'));

  if (content instanceof Object) {
    for (const key in defaultv) {
      if (!(key in content)) {
        content[key] = defaultv[key];
      }
    }
  }

  let lock = new Mutex();
  return [
    content,
    () => {
      return lock.lockGuard(async () => {
        await writeFile(name + ".tmp", JSON.stringify(content, null, 4));
        if (existsSync(name + ".bak")) await rm(name + ".bak");
        if (existsSync(name)) {
          try {
            await rename(name, name + ".bak");
          } catch (e) {
            console.error(e)
          }
        }
        await rename(name + ".tmp", name);
      })
    }
  ] as const
}
