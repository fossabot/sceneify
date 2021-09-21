import { Scene } from "./Scene";
import { Source } from "./Source";

export function isRawScene(source: Source): source is Scene {
  return source.constructor.prototype === Scene;
}

export function isObject(item?: Record<string, any>) {
  return item && typeof item === "object" && !Array.isArray(item);
}

export function mergeDeep(
  target: Record<string, any>,
  ...sources: Record<string, any>[]
): any {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        mergeDeep(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return mergeDeep(target, ...sources);
}

export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));