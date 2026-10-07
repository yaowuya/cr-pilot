import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskQueue } from "../../src/shared/queue.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("任务按入队顺序串行执行", async () => {
  const queue = createTaskQueue();
  const order: number[] = [];
  const done1 = new Promise<void>((resolve) => {
    queue.push(async () => {
      order.push(1);
      await tick();
      await tick();
      order.push(2);
      resolve();
    });
  });
  const done2 = new Promise<void>((resolve) => {
    queue.push(async () => {
      order.push(3);
      resolve();
    });
  });
  await Promise.all([done1, done2]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("任务抛错不阻塞后续任务", async () => {
  const queue = createTaskQueue();
  let secondRan = false;
  queue.push(async () => {
    throw new Error("boom");
  });
  queue.push(async () => {
    secondRan = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondRan, true);
});

test("pending 计数反映排队与完成", async () => {
  const queue = createTaskQueue();
  assert.equal(queue.pending, 0);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.push(async () => {
    await gate;
  });
  await tick();
  assert.equal(queue.pending, 1);
  release();
  await tick();
  assert.equal(queue.pending, 0);
});
